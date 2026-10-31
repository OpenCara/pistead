import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { HTTPException } from 'hono/http-exception';
import { gitProviderAdapters, plainAuthorization, plainPushAllowed, plainRepositoryId } from '../apps/server/src/git/providers.js';
import { defaultBranch, parseAdvertisement, resolveRef } from '../apps/server/src/git/smart-http.js';
import type { GitCredential } from '../apps/server/src/git/types.js';
import { branchTip, openPullRequest, ownerGitAuthorization, pushTarget } from '../apps/server/src/push/targets.js';
import type { RepositoryAccess } from '../apps/server/src/repositories.js';
import { repositoryForRemote } from '../apps/runner/src/egress.js';
import {
  bindingRemote, gitProviderHasForge, plainRepositoryPath, pushIdentityKindsByProvider, validRepositoryName,
  type ProviderSessionRepository,
} from '../packages/shared/src/repositories.js';

const main = 'a'.repeat(40);
const feature = 'b'.repeat(40);
const tagObject = 'c'.repeat(40);
const host = 'git.example.com';
const remote = `https://${host}/team/app.git`;
const credential: GitCredential = { id: 'acct', provider: 'git', host, organization: '', username: 'dev', token: 's3cret' };
const basic = `Basic ${Buffer.from('dev:s3cret').toString('base64')}`;

/** One pkt-line: four hex digits of length, then the (ASCII) payload. */
const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
/** A protocol v0 advertisement as git http-backend sends it. */
function advertisement(service: string, refs: [string, string][], capabilities = 'multi_ack symref=HEAD:refs/heads/main agent=git/2.45'): string {
  const lines = refs.map(([id, name], index) => pkt(`${id} ${name}${index === 0 ? `\0${capabilities}` : ''}\n`));
  return `${pkt(`# service=${service}\n`)}0000${lines.join('')}0000`;
}
const refs: [string, string][] = [
  [main, 'HEAD'], [main, 'refs/heads/main'], [feature, 'refs/heads/feature/x'],
  [tagObject, 'refs/tags/v1'], [feature, 'refs/tags/v1^{}'], [main, 'refs/tags/light'],
];
const smart = (service: string, body: string): () => Response =>
  () => new Response(body, { headers: { 'Content-Type': `application/x-${service}-advertisement` } });

interface Call { url: string; authorization: string | null; redirect: RequestRedirect | undefined }
/** Serves Git's advertisements by URL; `anonymous` answers requests without credentials. */
function server(t: TestContext, routes: Record<string, { authorized?: () => Response; anonymous?: () => Response }>): Call[] {
  const calls: Call[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get('authorization');
    calls.push({ url, authorization, redirect: init?.redirect });
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    const answer = authorization === null ? route.anonymous : route.authorized;
    return answer ? answer() : new Response('Authentication required', { status: 401 });
  });
  return calls;
}
async function failure(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof HTTPException, String(error));
    const body = await error.getResponse().json() as { code: string };
    return { status: error.status, code: body.code };
  }
  return assert.fail('expected the call to fail');
}

test('a smart HTTP advertisement is parsed for refs, HEAD, peeled tags and the empty repository', () => {
  const parsed = parseAdvertisement(new TextEncoder().encode(advertisement('git-upload-pack', refs)), 'git-upload-pack')!;
  assert.equal(parsed.head, 'refs/heads/main');
  assert.equal(parsed.sha256, false);
  assert.equal(parsed.refs.get('refs/heads/feature/x'), feature);
  assert.equal(defaultBranch(parsed), 'main');
  assert.equal(resolveRef(parsed, 'main'), main);
  assert.equal(resolveRef(parsed, 'feature/x'), feature);
  // Annotated tags resolve to the commit they peel to; lightweight ones to what they name.
  assert.equal(resolveRef(parsed, 'v1'), feature);
  assert.equal(resolveRef(parsed, 'light'), main);
  assert.equal(resolveRef(parsed, 'missing'), null);

  // Without a symref, HEAD's tip picks the branch; main before others sharing it.
  const plain = parseAdvertisement(new TextEncoder().encode(advertisement('git-upload-pack',
    [[feature, 'HEAD'], [main, 'refs/heads/main'], [feature, 'refs/heads/trunk']], 'multi_ack')), 'git-upload-pack')!;
  assert.equal(plain.head, null);
  assert.equal(defaultBranch(plain), 'trunk');

  const empty = parseAdvertisement(new TextEncoder().encode(advertisement('git-upload-pack', [['0'.repeat(40), 'capabilities^{}']])), 'git-upload-pack')!;
  assert.equal(empty.refs.size, 0);
  assert.equal(defaultBranch(empty), null);

  const sha256 = parseAdvertisement(new TextEncoder().encode(advertisement('git-upload-pack', [['d'.repeat(64), 'refs/heads/main']],
    'object-format=sha256')), 'git-upload-pack')!;
  assert.equal(sha256.sha256, true);

  for (const broken of ['zzzz', '0010short', `${pkt('# service=git-upload-pack\n')}0000${pkt('version 2\n')}0000`,
    `${pkt('# service=git-upload-pack\n')}0000${pkt(`${main} refs/heads/main\n`)}0000`, `${pkt(`nothex refs/heads/main\0caps\n`)}0000`]) {
    assert.equal(parseAdvertisement(new TextEncoder().encode(broken), 'git-upload-pack'), null, broken);
  }
});

test('a plain Git server is read with Git smart HTTP and Basic auth, never following redirects', async t => {
  const adapter = gitProviderAdapters.git;
  const upload = `${remote}/info/refs?service=git-upload-pack`;
  const calls = server(t, { [upload]: { authorized: smart('git-upload-pack', advertisement('git-upload-pack', refs)) } });
  const id = await plainRepositoryId('team/app.git');
  assert.match(id, /^[0-9a-f]{40}$/);
  assert.notEqual(id, await plainRepositoryId('team/app'));

  // There's no account to check: the user name is the login, and nothing is fetched.
  assert.deepEqual(await adapter.verify(credential), { login: 'dev' });
  assert.equal((await failure(adapter.verify({ ...credential, username: null }))).code, 'invalid_git_username');
  assert.equal((await failure(adapter.verify({ ...credential, host: 'localhost' }))).code, 'invalid_git_host');
  assert.deepEqual(await adapter.list(credential), { repositories: [], truncated: false });
  assert.equal(calls.length, 0);

  // Private: the server refuses the anonymous read.
  assert.deepEqual(await adapter.repository(credential, { id, fullName: 'team/app.git' }),
    { id, fullName: 'team/app.git', defaultBranch: 'main', private: true });
  assert.deepEqual(calls.map(call => [call.url, call.authorization, call.redirect]), [[upload, basic, 'manual'], [upload, null, 'manual']]);
  assert.equal(await adapter.commit(credential, { id, fullName: 'team/app.git' }, 'feature/x'), feature);
  assert.equal(await adapter.commit(credential, { id, fullName: 'team/app.git' }, 'v1'), feature);
  assert.equal(await adapter.commit(credential, { id, fullName: 'team/app.git' }, 'e'.repeat(40)), 'e'.repeat(40));
  assert.deepEqual(await failure(adapter.commit(credential, { id, fullName: 'team/app.git' }, 'missing')), { status: 403, code: 'git_repository_unavailable' });
  assert.ok(calls.every(call => call.url.startsWith(`https://${host}/`)));
});

test('a plain Git server repository readable without credentials is public', async t => {
  const upload = `https://${host}/open.git/info/refs?service=git-upload-pack`;
  const body = advertisement('git-upload-pack', refs);
  server(t, { [upload]: { authorized: smart('git-upload-pack', body), anonymous: smart('git-upload-pack', body) } });
  const id = await plainRepositoryId('open.git');
  assert.deepEqual(await gitProviderAdapters.git.repository(credential, { id, fullName: 'open.git' }),
    { id, fullName: 'open.git', defaultBranch: 'main', private: false });
});

test('plain Git server failures map to fixed errors', async t => {
  const adapter = gitProviderAdapters.git;
  const url = (path: string) => `https://${host}/${path}/info/refs?service=git-upload-pack`;
  server(t, {
    [url('denied')]: { authorized: () => new Response('no', { status: 403 }) },
    [url('moved')]: { authorized: () => new Response(null, { status: 301, headers: { location: 'https://elsewhere.example.com/x' } }) },
    [url('dumb')]: { authorized: () => new Response(`${main}\trefs/heads/main\n`, { headers: { 'Content-Type': 'text/plain' } }) },
    [url('broken')]: { authorized: () => new Response('garbage', { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } }) },
    [url('empty')]: { authorized: smart('git-upload-pack', advertisement('git-upload-pack', [['0'.repeat(40), 'capabilities^{}']])) },
    [url('sha256')]: { authorized: smart('git-upload-pack', advertisement('git-upload-pack', [['d'.repeat(64), 'refs/heads/main']], 'object-format=sha256')) },
    [url('down')]: { authorized: () => new Response('oops', { status: 500 }) },
  });
  const read = async (path: string) => failure(adapter.repository(credential, { id: await plainRepositoryId(path), fullName: path }));
  assert.deepEqual(await read('denied'), { status: 403, code: 'git_repository_unavailable' });
  assert.deepEqual(await read('moved'), { status: 409, code: 'git_repository_redirected' });
  assert.deepEqual(await read('dumb'), { status: 422, code: 'git_smart_http_required' });
  assert.deepEqual(await read('broken'), { status: 502, code: 'invalid_git_response' });
  assert.deepEqual(await read('empty'), { status: 409, code: 'git_repository_empty' });
  assert.deepEqual(await read('sha256'), { status: 422, code: 'unsupported_repository_format' });
  assert.deepEqual(await read('down'), { status: 502, code: 'git_provider_unavailable' });
  assert.equal((await failure(adapter.repository(credential, { id: 'x', fullName: '../etc' }))).code, 'invalid_repository');
});

test('plain Git server paths, remotes and push access', () => {
  assert.equal(gitProviderHasForge('git'), false);
  assert.equal(gitProviderHasForge('gitea'), true);
  assert.deepEqual(pushIdentityKindsByProvider.git, ['owner-account', 'host-credentials']);
  for (const [input, path] of [
    ['team/app.git', 'team/app.git'], ['/team/app.git/', 'team/app.git'], [`https://${host}/team/app.git`, 'team/app.git'],
    ['repo', 'repo'], [`https://${host}/a/b/c`, 'a/b/c'],
    [`https://other.example.com/team/app.git`, null], [`https://user:pw@${host}/team/app.git`, null], [`http://${host}/team/app.git`, null],
    [`https://${host}/team/app.git?x=1`, null], [`ssh://git@${host}/team/app.git`, null], ['team/../app', null], ['', null], ['team app', null],
  ] as const) assert.equal(plainRepositoryPath(host, input), path, input);
  assert.equal(validRepositoryName('git', 'a/b/c/d'), true);
  assert.equal(validRepositoryName('git', '.git'), false);
  // The clone URL is the path as given: ".git" is never added or taken away.
  assert.equal(bindingRemote({ provider: 'git', host, fullName: 'team/app.git' }), remote);
  assert.equal(bindingRemote({ provider: 'git', host: `${host}:8443`, fullName: 'repo' }), `https://${host}:8443/repo`);
  // The sandbox's remotes find the binding with or without ".git"; SSH remotes of other hosts aren't rewritten.
  const binding = { bindingId: 'b1', provider: 'git' as const, host, repositoryId: 'x', fullName: 'team/app.git', lfs: false };
  assert.equal(repositoryForRemote([binding], `https://${host}/team/app`)?.bindingId, 'b1');
  assert.equal(repositoryForRemote([binding], `https://${host}/team/app.git`)?.bindingId, 'b1');
  assert.equal(repositoryForRemote([binding], `https://${host}/team/other.git`), undefined);
});

test('pushes to a plain Git server check receive-pack with the owner account, and open no pull requests', async t => {
  const fullName = 'team/app.git';
  const id = await plainRepositoryId(fullName);
  const access: RepositoryAccess = { provider: 'git', account: { credential, ciphertext: 'c', userId: 'u' } };
  const pin: ProviderSessionRepository = { bindingId: 'b1', provider: 'git', host, repositoryId: id, fullName, ref: 'main', commit: main, path: `${host}/team/app.git` };
  let pushable = true;
  const calls = server(t, {
    [`${remote}/info/refs?service=git-upload-pack`]: { authorized: smart('git-upload-pack', advertisement('git-upload-pack', refs)) },
    [`${remote}/info/refs?service=git-receive-pack`]: {
      authorized: () => pushable ? smart('git-receive-pack', advertisement('git-receive-pack', refs.filter(([, name]) => name !== 'HEAD'), 'report-status'))()
        : new Response('forbidden', { status: 403 }),
    },
  });
  assert.equal(ownerGitAuthorization(access), basic);
  assert.equal(plainAuthorization(credential), basic);
  assert.deepEqual(await pushTarget(access, pin, 'feature/x'), { canPush: true, defaultBranch: 'main', remote });
  assert.deepEqual(await pushTarget(access, pin, 'main', 'v2'), { canPush: true, defaultBranch: 'main', remote });
  pushable = false;
  assert.equal(await plainPushAllowed(credential, fullName), false);
  assert.equal((await pushTarget(access, pin, 'feature/x')).canPush, false);
  assert.ok(calls.filter(call => call.url.endsWith('git-receive-pack')).every(call => call.authorization === basic));
  // Another host's pin never gets this account.
  assert.equal((await failure(pushTarget(access, { ...pin, host: 'other.example.com' }, 'main'))).code, 'repository_identity_changed');
  assert.equal(await branchTip(access, pin, 'feature/x'), feature);
  assert.equal(await branchTip(access, pin, 'missing'), null);
  assert.equal((await failure(branchTip(access, { ...pin, host: 'other.example.com' }, 'main'))).code, 'repository_identity_changed');
  assert.deepEqual(await failure(openPullRequest(access, pin, { head: 'feature/x', base: 'main', title: 't', body: '' })),
    { status: 422, code: 'pull_request_unsupported' });
});
