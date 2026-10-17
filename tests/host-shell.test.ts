import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { runHostShell } from '../apps/runner/src/host-shell.js';
import { SandboxProcessError } from '../apps/runner/src/process-output.js';
import { validHostOperation, validRepinRef } from '../packages/shared/src/host-operations.js';

const host = { kind: 'host.bash' as const, command: 'printf ok', timeoutSeconds: 5 };
const repin = { kind: 'git.repin' as const, repository: 'owner/repo', ref: 'feature/next' };

test('host command and repin approvals require exact, bounded payloads', () => {
  for (const op of [host, repin]) {
    assert.equal(validHostOperation(op), true);
    assert.equal(validHostOperation({ ...op, extra: true }), false);
  }
  for (const timeoutSeconds of [0, -1, 1.5, 3601, Infinity, '30', null]) {
    assert.equal(validHostOperation({ ...host, timeoutSeconds }), false);
  }
  for (const command of ['', ' ', 'x\0y', 'x'.repeat(8193)]) assert.equal(validHostOperation({ ...host, command }), false);
  for (const repository of ['../repo', 'owner/.git', '/owner/repo', 'owner/repo/..', 'https://github.com/owner/repo']) {
    assert.equal(validHostOperation({ ...repin, repository }), false);
  }
  for (const ref of ['main', 'refs/heads/feature/next', 'v1.0', 'a'.repeat(40)]) assert.equal(validRepinRef(ref), true);
  for (const ref of ['', 'a b', 'main\n', '../main', 'a..b', 'a@{b', 'a.lock', 'a\\b', 'a:b', 'a*', '\ud800']) {
    assert.equal(validRepinRef(ref), false, ref);
    assert.equal(validHostOperation({ ...repin, ref }), false);
  }
});

test('host shell uses the host tools/home and session cwd without inheriting runner secrets', { skip: !['linux', 'darwin'].includes(process.platform) }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'host-shell-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { worktree: root, git: join(root, '.git'), gitConfig: join(root, 'owner.gitconfig'), gitName: 'Owner', gitEmail: 'owner@example.test', signal: new AbortController().signal };
  await writeFile(options.gitConfig, '[user]\nname = Owner\nemail = owner@example.test\n');
  const original = process.env.PISTEAD_TEST_SECRET;
  process.env.PISTEAD_TEST_SECRET = 'must-not-inherit';
  t.after(() => { if (original === undefined) delete process.env.PISTEAD_TEST_SECRET; else process.env.PISTEAD_TEST_SECRET = original; });
  const output = await runHostShell({ ...host, command: 'printf "%s\\n" "$HOME" "$PWD" "${PISTEAD_TEST_SECRET-unset}"; command -v bash; printf built > result.txt' }, options);
  assert.ok(output.startsWith(`${homedir()}\n${root}\nunset\n`), output);
  assert.equal(await readFile(join(root, 'result.txt'), 'utf8'), 'built');
  await assert.rejects(runHostShell({ ...host, command: 'printf partial; printf bad >&2; exit 7' }, options), (error: unknown) => {
    assert.ok(error instanceof SandboxProcessError);
    assert.equal(error.exitCode, 7);
    assert.equal(error.stdout, 'partial');
    assert.equal(error.stderr, 'bad');
    return true;
  });
  await assert.rejects(runHostShell({ ...host, command: 'sleep 10 & wait', timeoutSeconds: 1 }, options), /time limit/);
  await assert.rejects(runHostShell({ ...host, command: 'head -c 5000000 /dev/zero' }, options), /output limit/);
  const controller = new AbortController();
  const waiting = runHostShell({ ...host, command: 'sleep 10' }, { ...options, signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, /cancelled/);
  await assert.rejects(runHostShell(host, { ...options, signal: AbortSignal.abort() }));
});
