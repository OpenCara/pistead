import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { crc32, deflateSync } from "node:zlib";
import { sha256 } from "../packages/shared/src/crypto.js";
import type { AuthorizationRequest, RunnerBinding, RunnerTicket, SubmitInput } from "../packages/shared/src/types.js";
import { RunnerService } from "../apps/runner/src/server.js";
import { RunnerError } from "../apps/runner/src/protocol.js";
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

const base64 = (bytes: Buffer) => bytes.toString("base64");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Sends a shared message as the owner. */
async function send(session: RunnerSession, input: Omit<SubmitInput, "requestId"> & { requestId?: string }) {
  return session.submit(await ticket("images", "submit"), { requestId: randomUUID(), ...input }, "write");
}
async function settle(session: RunnerSession) {
  for (let count = 0; count < 500 && (await session.view()).busy; count++) await delay(20);
  const view = await session.view();
  assert.equal(view.busy, false, "runner did not settle");
  return view;
}
/** The images of queued messages that wait on the host. */
const waiting = (session: RunnerSession) => readdir(join(session.directory, "inputs")).catch(() => [] as string[]);
const refused = (status: number, message: RegExp) => (error: unknown) => error instanceof RunnerError && error.status === status && message.test(error.message);

test("pasted images reach the model after the message's text, prepared to fit, and the transcript only notes them", hostMode, async t => {
  const session = await service(t, true);
  const small = png(3, 2);
  const wide = png(2400, 30);
  await send(session, { content: "What do these show?", images: [{ mimeType: "image/png", data: base64(small) }, { mimeType: "image/png", data: base64(wide) }] });
  const view = await settle(session);
  const seen = view.entries.findLast(entry => entry.role === "assistant")!.text.split("\n");
  // Within the limits the model gets these exact bytes; beyond them, the image prepared to fit.
  assert.deepEqual(seen.slice(0, 3), ["Deterministic test provider saw:", "What do these show?", `image image/png sha256:${digest(small)}`]);
  assert.match(seen[3]!, /^image image\/png sha256:[0-9a-f]{64}$/);
  assert.notEqual(seen[3], `image image/png sha256:${digest(wide)}`);
  assert.equal(seen.length, 4);
  assert.equal(view.entries.findLast(entry => entry.role === "user")!.text, "What do these show?\n[image image/png]\n[image image/png]");
  assert.equal(JSON.stringify(view).includes(base64(small)), false, "image data must not reach the web view");
  // Pi's transcript holds them once the message reached it.
  assert.deepEqual(await waiting(session), []);

  // A message can be images alone.
  await send(session, { content: "", images: [{ mimeType: "image/png", data: base64(small) }] });
  const alone = await settle(session);
  assert.deepEqual(alone.entries.findLast(entry => entry.role === "assistant")!.text.split("\n"), ["Deterministic test provider saw:", `image image/png sha256:${digest(small)}`]);
  assert.equal(alone.entries.findLast(entry => entry.role === "user")!.text, "[image image/png]");
});

test("pasted images the host can't read or take are refused before anything is queued, and a request ID binds its images", hostMode, async t => {
  const session = await service(t, true);
  const image = { mimeType: "image/png" as const, data: base64(png(3, 2)) };
  // The host decodes every image itself: a broken one, or one whose bytes aren't the type it names, gets a reason for its sender.
  await assert.rejects(send(session, { content: "Broken", images: [{ mimeType: "image/png", data: base64(Buffer.concat([PNG_SIGNATURE, header(3, 2)])) }] }), refused(422, /cannot be decoded/));
  await assert.rejects(send(session, { content: "Mislabelled", images: [{ mimeType: "image/jpeg", data: image.data }] }), refused(422, /cannot be decoded/));
  await assert.rejects(send(session, { content: "Mislabelled", images: [{ mimeType: "image/gif", data: image.data }] }), refused(422, /cannot be decoded/));
  for (const images of [Array(5).fill(image), [{ ...image, mimeType: "image/bmp" }], [{ ...image, data: "not base64!" }], [{ ...image, name: "screenshot.png" }], {}]) {
    await assert.rejects(send(session, { content: "Invalid", images: images as never }), refused(400, /images/));
  }
  await assert.rejects(send(session, { content: " ", images: [] }), refused(400, /Invalid submission/));
  assert.deepEqual((await session.view()).queue, []);
  assert.deepEqual(await waiting(session), []);

  const requestId = randomUUID();
  const first = await send(session, { content: "Same", images: [image], requestId });
  assert.equal((await send(session, { content: "Same", images: [image], requestId })).submissionId, first.submissionId);
  await assert.rejects(send(session, { content: "Same", images: [{ mimeType: "image/png", data: base64(png(2, 3)) }], requestId }), refused(409, /different content/));
  await assert.rejects(send(session, { content: "Same", requestId }), refused(409, /different content/));
  await settle(session);
});

test("a queued message's images wait on the host, outside the run ledger, until it runs, and go when it is stopped", hostMode, async t => {
  const session = await service(t, true);
  const small = png(3, 2);
  // The first image a process prepares starts its image worker; later ones are quick.
  await send(session, { content: "Warm up", images: [{ mimeType: "image/png", data: base64(small) }] });
  await settle(session);

  await send(session, { content: "TEST_HOLD 3000" });
  const later = png(4, 2);
  const queued = await send(session, { content: "Later", images: [{ mimeType: "image/png", data: base64(later) }] });
  assert.deepEqual(await waiting(session), [`${queued.submissionId}.json`]);
  // Every change rewrites the run ledger whole, so a queued message's images are kept out of the database until it runs.
  const database = await Promise.all(["session.sqlite", "session.sqlite-wal"].map(name => readFile(join(session.directory, name)).catch(() => Buffer.alloc(0))));
  assert.equal(database.some(bytes => bytes.includes(base64(later))), false, "queued images stay out of the session database");
  const view = await settle(session);
  assert.equal(view.entries.findLast(entry => entry.role === "assistant")!.text, `Deterministic test provider saw:\nLater\nimage image/png sha256:${digest(later)}`);
  assert.deepEqual(await waiting(session), []);

  await send(session, { content: "TEST_HOLD 3000" });
  await send(session, { content: "Never", images: [{ mimeType: "image/png", data: base64(small) }] });
  assert.equal((await waiting(session)).length, 1);
  assert.equal((await session.stop(await ticket("images", "submit"))).stopped, 2);
  assert.deepEqual(await waiting(session), []);
  await settle(session);
});

test("sandboxed read_file gives the model images by signature, prepared to fit, and keeps other files text", linux, t => readsImagesAsTheModelSeesThem(t, false));
