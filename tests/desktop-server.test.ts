import test from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalServerEvent } from "../apps/server/src/local/desktop-protocol.js";
import { loadLocalState } from "../apps/server/src/local/state.js";

const repository = fileURLToPath(new URL("../", import.meta.url));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** The desktop app's local server over Node's fork channel, the same protocol Electron's utilityProcess carries. */
async function launch(stateDir: string, staticDir: string) {
  const child: ChildProcess = fork(join(repository, "apps/server/src/local/desktop.ts"), ["--state-dir", stateDir, "--static-dir", staticDir], {
    cwd: repository, execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: stateDir, TMPDIR: tmpdir() },
  });
  const events: LocalServerEvent[] = [];
  const waiters: { match: (event: LocalServerEvent) => boolean; resolve: (event: LocalServerEvent) => void; reject: (error: Error) => void }[] = [];
  let exited: Error | undefined;
  child.once("exit", code => {
    exited = new Error(`The server process exited (code ${code})`);
    for (const waiter of waiters.splice(0)) waiter.reject(exited);
  });
  child.on("message", value => {
    const event = value as LocalServerEvent;
    events.push(event);
    for (const waiter of waiters.splice(0)) { if (waiter.match(event)) waiter.resolve(event); else waiters.push(waiter); }
  });
  const next = (match: (event: LocalServerEvent) => boolean, after = 0): Promise<LocalServerEvent> => {
    const found = events.slice(after).find(match);
    if (found) return Promise.resolve(found);
    if (exited) return Promise.reject(exited);
    const waiting = Promise.withResolvers<LocalServerEvent>();
    waiters.push({ match, resolve: waiting.resolve, reject: waiting.reject });
    return waiting.promise;
  };
  await next(event => event.type === "ready");
  let id = 1000;
  const request = async (message: Record<string, unknown>) => {
    const requestId = id++;
    child.send({ ...message, id: requestId });
    return next(event => event.type === "result" && event.id === requestId);
  };
  const close = async () => {
    if (child.exitCode !== null) return;
    const gone = Promise.withResolvers<void>();
    child.once("exit", () => gone.resolve());
    child.disconnect();
    await gone.promise;
  };
  return { events, next, request, close, send: (value: unknown) => child.send(value as never) };
}

test("the desktop app's local server refuses malformed requests, needs a GitHub OAuth app, then serves on loopback", async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "pistead-desktop-server-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const stateDir = join(parent, "server");
  await loadLocalState(stateDir, { port: await freePort() });
  // The built web app, which tests run without.
  const web = join(parent, "web");
  await mkdir(join(web, "assets"), { recursive: true });
  await writeFile(join(web, "index.html"), "<!doctype html><title>Pistead</title>");
  const server = await launch(stateDir, web);
  t.after(() => server.close());

  for (const malformed of [
    { type: "inspect", id: 1, extra: true },
    { type: "launch", id: 2 },
    { type: "start", id: 3, github: { clientId: "id" } },
    { type: "stop", id: -1 },
  ]) {
    server.send(malformed);
    if (malformed.id >= 0) assert.deepEqual(await server.next(event => event.type === "result" && event.id === malformed.id),
      { type: "result", id: malformed.id, ok: false, error: { message: "Refused a malformed request." } });
  }
  await server.next(event => event.type === "log" && event.level === "error");

  const unconfigured = await server.request({ type: "start", testMode: true });
  assert.deepEqual(unconfigured, { type: "result", id: unconfigured.type === "result" ? unconfigured.id : 0, ok: false,
    error: { message: "Add your GitHub OAuth app first: Pistead signs you in with it." } });

  // The GitHub app is saved with the state, and the secret never comes back.
  const count = server.events.length;
  const started = await server.request({ type: "start", testMode: true, github: { clientId: "Ov23liDesktop", clientSecret: "0123456789abcdef0123456789abcdef01234567" } });
  assert.equal(started.type === "result" && started.ok, true);
  const running = await server.next(event => event.type === "status" && event.state === "running", count);
  assert.ok(running.type === "status");
  const state = await loadLocalState(stateDir);
  assert.equal(running.origin, `http://127.0.0.1:${state.port}`);
  assert.equal(running.claimUrl, `${running.origin}/api/auth/local/claim?token=${state.claimSecret}`);
  assert.equal(state.github?.clientId, "Ov23liDesktop");
  assert.ok(!JSON.stringify(server.events).includes("0123456789abcdef0123456789abcdef01234567"));
  const health = await (await fetch(`${running.origin}/api/health`)).json() as { githubConfigured: boolean; localServer: { claimed: boolean } };
  assert.deepEqual([health.githubConfigured, health.localServer], [true, { claimed: false }]);
  assert.match(await (await fetch(running.origin!)).text(), /<title>Pistead<\/title>/);

  const again = await server.request({ type: "start" });
  assert.equal(again.type === "result" && !again.ok && again.error.message, "Pistead is already running on this computer.");

  const before = server.events.length;
  const stopped = await server.request({ type: "stop" });
  assert.equal(stopped.type === "result" && stopped.ok, true);
  await server.next(event => event.type === "status" && event.state === "stopped", before);
  await assert.rejects(fetch(`${running.origin}/api/health`));
});
