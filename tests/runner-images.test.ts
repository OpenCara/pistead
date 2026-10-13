import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { crc32, deflateSync } from "node:zlib";
import { sha256 } from "../packages/shared/src/crypto.js";
import type { AuthorizationRequest, RunnerBinding, RunnerTicket } from "../packages/shared/src/types.js";
import { RunnerService } from "../apps/runner/src/server.js";
import type { RunnerSession } from "../apps/runner/src/session.js";

const SECRET = "runner-images-test-secret-not-a-production-secret";
const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || spawnSync("git", ["--version"]).status !== 0 };
const linux = { skip: process.platform !== "linux" };

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Images", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:author", workspaceId: "workspace", version: 1, name: "Agent", description: "Test", instructions: "Use tools.", tools: ["read_file"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Explicit faux test provider", provider: "faux", modelId: "faux-1" },
  };
}
async function ticket(id: string, action: "create" | "submit"): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: id, actorId: "test:alice", ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") };
}

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}
function header(width: number, height: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8; // 8-bit RGB
  data[9] = 2;
  return chunk("IHDR", data);
}
/** A real RGB PNG: each row is filter byte 0 and a gradient. */
function png(width: number, height: number): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set([x % 256, y % 256, (x + y) % 256], y * (width * 3 + 1) + 1 + x * 3);
  return Buffer.concat([PNG_SIGNATURE, header(width, height), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
/** A GIF of `frames` frames on a 1×1 screen, each the same white pixel. */
function gif(frames: number): Buffer {
  const frame = Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00]);
  return Buffer.concat([Buffer.from("GIF89a"), Buffer.from([1, 0, 1, 0, 0x80, 0, 0, 0xff, 0xff, 0xff, 0, 0, 0]), ...Array.from({ length: frames }, () => frame), Buffer.from([0x3b])]);
}

async function service(t: TestContext, unsandboxed: boolean): Promise<RunnerSession> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "runner-images-")));
  const authorize = async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 });
  const runner = new RunnerService({ dataDir: directory, sharedSecret: SECRET, controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed, authorize });
  await runner.initialize();
  t.after(async () => { await runner.close(); await rm(directory, { recursive: true, force: true }); });
  return runner.provision(binding("images"), await ticket("images", "create"));
}

/** What the deterministic model answered to `TEST_READ path` (it lists the image blocks it received) and the tool result the transcript shows. */
async function read(session: RunnerSession, path: string) {
  await session.submit(await ticket("images", "submit"), { content: `TEST_READ ${path}`, requestId: randomUUID() }, "write");
  for (let count = 0; count < 500 && (await session.view()).busy; count++) await delay(20);
  const view = await session.view();
  assert.equal(view.busy, false, "runner did not settle");
  const reply = view.entries.findLast(entry => entry.role === "assistant");
  const result = view.entries.findLast(entry => entry.role === "toolResult");
  assert.ok(reply && result, "the model answered the tool result");
  assert.ok(reply.text.startsWith("Deterministic test provider result:\n"), reply.text);
  return { model: reply.text.split("\n").slice(1), transcript: result.text, view: JSON.stringify(view) };
}

async function readsImagesAsTheModelSeesThem(t: TestContext, unsandboxed: boolean) {
  const session = await service(t, unsandboxed);
  await session.sandbox.initialize();
  const worktree = join(session.directory, "sandbox", "worktree");
  const small = png(3, 2);
  const text = "plain text, named like an image\n";
  await writeFile(join(worktree, "pixels.dat"), small);
  await writeFile(join(worktree, "wide.png"), png(2400, 30));
  await writeFile(join(worktree, "notes.png"), text);
  await writeFile(join(worktree, "broken.png"), Buffer.concat([PNG_SIGNATURE, header(3, 2)]));
  await writeFile(join(worktree, "moving.gif"), gif(2));

  // Recognised by its signature despite the name, and passed through unchanged: the model gets these exact bytes.
  const pixels = await read(session, "pixels.dat");
  assert.equal(pixels.model.length, 2);
  assert.deepEqual(JSON.parse(pixels.model[0]!), { initiatedBy: "test:alice", actingAs: "test:alice", mode: "write", path: "pixels.dat", mimeType: "image/png", width: 3, height: 2 });
  assert.equal(pixels.model[1], `image image/png sha256:${createHash("sha256").update(small).digest("hex")}`);
  assert.equal(pixels.transcript, `${pixels.model[0]}\n[image image/png]`);
  assert.equal(pixels.view.includes(small.toString("base64")), false, "image data must not reach the web view");

  // Larger than the limits: the model gets the prepared image, at the size it reports.
  const wide = await read(session, "wide.png");
  assert.equal(wide.model.length, 2);
  assert.deepEqual(JSON.parse(wide.model[0]!), { initiatedBy: "test:alice", actingAs: "test:alice", mode: "write", path: "wide.png", mimeType: "image/png", width: 1568, height: 20 });
  assert.match(wide.model[1]!, /^image image\/png sha256:[0-9a-f]{64}$/);

  const notes = await read(session, "notes.png");
  assert.deepEqual(notes.model.map(line => JSON.parse(line)), [{ initiatedBy: "test:alice", actingAs: "test:alice", mode: "write", content: text }]);
  assert.equal(notes.transcript.includes("[image"), false);

  const broken = await read(session, "broken.png");
  assert.match(broken.transcript, /The image cannot be decoded or fitted to the model's image limits/);
  assert.equal(broken.model.some(line => line.startsWith("image ")), false);
  assert.equal(broken.transcript.includes("[image"), false);

  // An animated GIF reaches the model as a still image of its first frame.
  const moving = await read(session, "moving.gif");
  assert.deepEqual(JSON.parse(moving.model[0]!), { initiatedBy: "test:alice", actingAs: "test:alice", mode: "write", path: "moving.gif", mimeType: "image/png", width: 1, height: 1 });
}

test("host read_file gives the model images by signature, prepared to fit, and keeps other files text", hostMode, t => readsImagesAsTheModelSeesThem(t, true));

test("sandboxed read_file gives the model images by signature, prepared to fit, and keeps other files text", linux, t => readsImagesAsTheModelSeesThem(t, false));
