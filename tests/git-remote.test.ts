import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRemote, GitRemoteError, ZERO_OID } from "../apps/runner/src/git-remote.js";
import { startGitHttpServer } from "./helpers/git-http.js";

const gitAvailable = { skip: spawnSync("git", ["--version"]).status !== 0 };
const AUTH = "Basic cGlzdGVhZDp0b2tlbg==";

function git(cwd: string, args: string[], input?: Buffer | string): string {
  const result = spawnSync("git", args, { cwd, input, encoding: "buffer", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_NOSYSTEM: "1", HOME: cwd } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}
function exists(cwd: string, object: string): boolean {
  return spawnSync("git", ["cat-file", "-e", object], { cwd }).status === 0;
}
async function collect(pack: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of pack) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

async function fixture(t: TestContext, options: { protocolV2?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pistead-git-remote-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = join(root, "upstream.git"), work = join(root, "work");
  git(root, ["init", "--bare", "-b", "main", upstream]);
  for (const [key, value] of [["uploadpack.allowFilter", "true"], ["uploadpack.allowAnySHA1InWant", "true"], ["http.receivepack", "true"], ["receive.denyDeletes", "true"]]) git(upstream, ["config", key!, value!]);
  git(root, ["init", "-b", "main", work]);
  const commits: string[] = [];
  for (const n of [1, 2, 3]) {
    await writeFile(join(work, `file${n}.txt`), `content ${n}\n`);
    git(work, ["add", "."]);
    git(work, ["commit", "-m", `commit ${n}`]);
    commits.push(git(work, ["rev-parse", "HEAD"]));
  }
  git(work, ["push", upstream, "main"]);
  const server = await startGitHttpServer(root, { ...options, authorization: AUTH });
  t.after(() => server.close());
  return { root, upstream, work, commits, server, remote: new GitRemote({ url: server.url("upstream.git"), authorization: AUTH }) };
}

test("push creates a branch from a pack-objects pack", gitAvailable, async (t) => {
  const { upstream, work, commits, remote } = await fixture(t);
  await writeFile(join(work, "file4.txt"), "content 4\n");
  git(work, ["add", "."]);
  git(work, ["commit", "-m", "commit 4"]);
  const tip = git(work, ["rev-parse", "HEAD"]);
  const { refs, capabilities } = await remote.receivePackAdvertisement();
  assert.equal(refs.get("refs/heads/main"), commits[2]);
  assert.ok(capabilities.has("report-status"));
  const pack = spawnSync("git", ["pack-objects", "--revs", "--stdout"], { cwd: work, input: `${tip}\n^${commits[2]}\n` }).stdout;
  const result = await remote.push({ ref: "refs/heads/pistead/feature", old: ZERO_OID, new: tip }, (async function* () { yield new Uint8Array(pack); })(), capabilities);
  assert.deepEqual(result, { unpack: "ok", status: "ok" });
  assert.equal(git(upstream, ["rev-parse", "refs/heads/pistead/feature"]), tip);
});

test("push surfaces a server-side rejection as ng with reason", gitAvailable, async (t) => {
  const { upstream, commits, remote } = await fixture(t);
  const { capabilities } = await remote.receivePackAdvertisement();
  const result = await remote.push({ ref: "refs/heads/main", old: commits[2]!, new: ZERO_OID }, (async function* () {})(), capabilities);
  assert.equal(result.status, "ng");
  assert.equal(result.unpack, "ok");
  assert.match(result.reason ?? "", /deletion prohibited/);
  assert.equal(git(upstream, ["rev-parse", "refs/heads/main"]), commits[2]);
});

test("wrong Authorization is rejected with GitRemoteError 401", gitAvailable, async (t) => {
  const { server } = await fixture(t);
  const remote = new GitRemote({ url: server.url("upstream.git"), authorization: "Basic d3Jvbmc=" });
  await assert.rejects(remote.receivePackAdvertisement(), (error: unknown) => error instanceof GitRemoteError && error.status === 401);
});

test("redirects are refused and non-https remotes rejected", async (t) => {
  let hits = 0;
  const server = createServer((_request, response) => { hits++; response.writeHead(302, { Location: "http://127.0.0.1:1/elsewhere" }).end(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const remote = new GitRemote({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git`, authorization: AUTH });
  await assert.rejects(remote.receivePackAdvertisement(), (error: unknown) => error instanceof GitRemoteError && /redirect/.test(error.message));
  assert.equal(hits, 1);
  assert.throws(() => new GitRemote({ url: "http://example.com/repo.git", authorization: AUTH }), GitRemoteError);
});
