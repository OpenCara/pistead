import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import { HTTPException } from 'hono/http-exception';
import { gitProviderAdapters } from '../apps/worker/src/git/providers.js';
import type { GitCredential } from '../apps/worker/src/git/types.js';

const sha = 'a'.repeat(40);
const tarGz = new Uint8Array(gzipSync(Buffer.alloc(1024)));
const zipBytes = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);

interface Call { url: string; headers: Record<string, string>; redirect: RequestRedirect | undefined }
/** A fresh Response per request (cancelling a cloned tee branch would never settle). */
type Route = () => Response;

/** Serves `routes` by exact URL; unknown URLs fail the test. */
function mockFetch(t: TestContext, routes: Record<string, Route>): Call[] {
  const calls: Call[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init?.headers ?? {})) headers[key.toLowerCase()] = String(value);
    calls.push({ url, headers, redirect: init?.redirect });
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route();
  });
  return calls;
}
const json = (body: unknown, init: ResponseInit = {}): Route => () => Response.json(body, init);
const redirect = (location: string, status = 302): Route => () => new Response(null, { status, headers: { location } });
const bytes = (body: Uint8Array): Route => () => new Response(body.slice(), { status: 200 });
const text = (body: string, status = 200): Route => () => new Response(body, { status });

async function failure(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof HTTPException, String(error));
    const body: unknown = await error.getResponse().json();
    assert.ok(body && typeof body === 'object' && 'code' in body && typeof body.code === 'string');
    return { status: error.status, code: body.code };
  }
  return assert.fail('expected the provider call to fail');
}
const unavailable = { status: 403, code: 'git_repository_unavailable' };
const rejected = { status: 400, code: 'git_account_rejected' };
const malformed = { status: 502, code: 'invalid_git_response' };
const untrusted = { status: 502, code: 'invalid_archive_redirect' };

test('GitHub Enterprise Server uses /api/v3 with bearer tokens and credential-free archive redirects', async t => {
  const adapter = gitProviderAdapters['github-enterprise'];
  const credential: GitCredential = { id: 'acct', provider: 'github-enterprise', host: 'git.example.com', organization: '', username: null, token: 'ghe-token' };
  const api = 'https://git.example.com/api/v3';
  const repository = { id: 7, full_name: 'acme/app', default_branch: 'main', private: true };
  const calls = mockFetch(t, {
    [`${api}/user`]: json({ login: 'octo' }),
    [`${api}/user/repos?per_page=30&page=2&sort=full_name&direction=asc`]: json([repository], { headers: { link: `<${api}/user/repos?page=3>; rel="next"` } }),
    [`${api}/repositories/7`]: json(repository),
    [`${api}/repos/acme/app/commits/release%2F1`]: text(`${sha}\n`),
    [`${api}/repos/acme/app/tarball/${sha}`]: redirect(`https://codeload.git.example.com/acme/app/legacy.tar.gz/${sha}?token=short`),
    [`https://codeload.git.example.com/acme/app/legacy.tar.gz/${sha}?token=short`]: bytes(tarGz),
  });
  assert.deepEqual(await adapter.verify(credential), { login: 'octo' });
  const expected = { id: '7', fullName: 'acme/app', defaultBranch: 'main', private: true };
  assert.deepEqual(await adapter.list(credential, 2), { repositories: [expected], hasMore: true });
  assert.deepEqual(await adapter.repository(credential, { id: '7', fullName: 'acme/app' }), expected);
  assert.equal(await adapter.commit(credential, { id: '7', fullName: 'acme/app' }, 'release/1'), sha);
  assert.deepEqual(await adapter.archive(credential, { id: '7', fullName: 'acme/app' }, sha), { bytes: tarGz, format: 'tar.gz' });
  for (const call of calls.slice(0, 5)) {
    assert.equal(call.headers.authorization, 'Bearer ghe-token');
    assert.equal(call.redirect, 'manual');
  }
  assert.equal(calls[0]!.headers.accept, 'application/vnd.github+json');
  assert.equal(calls[3]!.headers.accept, 'application/vnd.github.sha');
  assert.equal(calls[5]!.headers.authorization, undefined);
});

test('GitHub Enterprise Server failures map to fixed errors', async t => {
  const adapter = gitProviderAdapters['github-enterprise'];
  const credential: GitCredential = { id: 'acct', provider: 'github-enterprise', host: 'git.example.com', organization: '', username: null, token: 't' };
  const api = 'https://git.example.com/api/v3';
  const calls = mockFetch(t, {
    [`${api}/user`]: json({ message: 'Bad credentials' }, { status: 401 }),
    [`${api}/repositories/7`]: json({ message: 'Not Found' }, { status: 404 }),
    [`${api}/repositories/8`]: json({ id: 8, full_name: '../evil', default_branch: 'main', private: true }),
    [`${api}/repositories/9`]: json({ id: 9, full_name: 'acme/app', default_branch: 'main', private: 'yes' }),
    [`${api}/repos/acme/app/tarball/${sha}`]: redirect('https://evil.example.net/steal'),
    [`${api}/repos/acme/other/tarball/${sha}`]: redirect('https://codeload.git.example.com.evil.net/x'),
  });
  assert.deepEqual(await failure(adapter.verify(credential)), rejected);
  assert.deepEqual(await failure(adapter.repository(credential, { id: '7', fullName: 'acme/app' })), unavailable);
  assert.deepEqual(await failure(adapter.repository(credential, { id: '8', fullName: 'acme/app' })), malformed);
  assert.deepEqual(await failure(adapter.repository(credential, { id: '9', fullName: 'acme/app' })), malformed);
  assert.deepEqual(await failure(adapter.archive(credential, { id: '7', fullName: 'acme/app' }, sha)), untrusted);
  assert.deepEqual(await failure(adapter.archive(credential, { id: '7', fullName: 'acme/other' }, sha)), untrusted);
  assert.equal(calls.filter(call => !call.url.startsWith(api)).length, 0);
  // Hosts are validated before any request; private names are never fetched.
  assert.equal((await failure(adapter.verify({ ...credential, host: 'localhost' }))).code, 'invalid_git_host');
  assert.equal((await failure(adapter.archive(credential, { id: '7', fullName: 'acme/app' }, 'main'))).code, 'invalid_repository_commit');
});

test('GitLab uses /api/v4 with bearer PATs and skips empty projects', async t => {
  const adapter = gitProviderAdapters.gitlab;
  const credential: GitCredential = { id: 'acct', provider: 'gitlab', host: 'gitlab.com', organization: '', username: null, token: 'glpat-x' };
  const api = 'https://gitlab.com/api/v4';
  const project = { id: 42, path_with_namespace: 'group/sub/app', default_branch: 'main', visibility: 'internal' };
  const calls = mockFetch(t, {
    [`${api}/user`]: json({ username: 'gl-user' }),
    [`${api}/projects?membership=true&per_page=30&page=1&order_by=path&sort=asc`]: json(
      [project, { id: 43, path_with_namespace: 'group/empty', default_branch: null, visibility: 'private' },
        { id: 44, path_with_namespace: 'group/open', default_branch: 'trunk', visibility: 'public' }],
      { headers: { 'x-next-page': '' } }),
    [`${api}/projects/42`]: json(project),
    [`${api}/projects/43`]: json({ id: 43, path_with_namespace: 'group/empty', default_branch: null, visibility: 'private' }),
    [`${api}/projects/42/repository/commits/v1.0`]: json({ id: sha }),
    [`${api}/projects/42/repository/commits/sha256`]: json({ id: 'b'.repeat(64) }),
    [`${api}/projects/42/repository/archive.tar.gz?sha=${sha}`]: bytes(tarGz),
    [`${api}/projects/45/repository/archive.tar.gz?sha=${sha}`]: redirect('https://gitlab.com/elsewhere'),
    [`${api}/projects/46`]: json({ message: '404 Project Not Found' }, { status: 404 }),
  });
  assert.deepEqual(await adapter.verify(credential), { login: 'gl-user' });
  assert.deepEqual(await adapter.list(credential, 1), {
    repositories: [{ id: '42', fullName: 'group/sub/app', defaultBranch: 'main', private: true },
      { id: '44', fullName: 'group/open', defaultBranch: 'trunk', private: false }],
    hasMore: false,
  });
  assert.deepEqual(await adapter.repository(credential, { id: '42', fullName: 'group/sub/app' }),
    { id: '42', fullName: 'group/sub/app', defaultBranch: 'main', private: true });
  assert.equal((await failure(adapter.repository(credential, { id: '43', fullName: 'group/empty' }))).code, 'git_repository_empty');
  assert.equal(await adapter.commit(credential, { id: '42', fullName: 'group/sub/app' }, 'v1.0'), sha);
  assert.deepEqual(await failure(adapter.commit(credential, { id: '42', fullName: 'group/sub/app' }, 'sha256')),
    { status: 422, code: 'unsupported_repository_format' });
  assert.deepEqual(await adapter.archive(credential, { id: '42', fullName: 'group/sub/app' }, sha), { bytes: tarGz, format: 'tar.gz' });
  assert.deepEqual(await failure(adapter.archive(credential, { id: '45', fullName: 'group/x' }, sha)), untrusted);
  assert.deepEqual(await failure(adapter.repository(credential, { id: '46', fullName: 'group/x' })), unavailable);
  assert.ok(calls.every(call => call.headers.authorization === 'Bearer glpat-x' && call.redirect === 'manual'));
  // The rejected redirect is never followed.
  assert.equal(calls.length, 9);
});

test('Gitea and Forgejo use /api/v1 with token authorization', async t => {
  const adapter = gitProviderAdapters.gitea;
  const credential: GitCredential = { id: 'acct', provider: 'gitea', host: 'code.example.org:3443', organization: '', username: null, token: 'gt' };
  const api = 'https://code.example.org:3443/api/v1';
  const repository = (id: number) => ({ id, full_name: `team/repo${id}`, default_branch: 'main', private: id % 2 === 0, empty: false });
  const calls = mockFetch(t, {
    [`${api}/user`]: json({ login: 'tea' }),
    [`${api}/user/repos?page=1&limit=30`]: json(Array.from({ length: 30 }, (_, index) => repository(index + 1))),
    [`${api}/user/repos?page=2&limit=30`]: json([repository(31), { ...repository(32), empty: true }]),
    [`${api}/repositories/5`]: json(repository(5)),
    [`${api}/repos/team/repo5/commits?sha=feature%2Fx&limit=1&stat=false&verification=false&files=false`]: json([{ sha }]),
    [`${api}/repos/team/repo5/commits?sha=missing&limit=1&stat=false&verification=false&files=false`]: json([]),
    [`${api}/repos/team/repo5/archive/${sha}.tar.gz`]: bytes(tarGz),
    [`${api}/repositories/6`]: json({ ...repository(6), default_branch: 'bad..branch' }),
  });
  assert.deepEqual(await adapter.verify(credential), { login: 'tea' });
  const first = await adapter.list(credential, 1);
  assert.equal(first.repositories.length, 30);
  assert.equal(first.hasMore, true);
  assert.deepEqual(await adapter.list(credential, 2), {
    repositories: [{ id: '31', fullName: 'team/repo31', defaultBranch: 'main', private: false }], hasMore: false,
  });
  assert.deepEqual(await adapter.repository(credential, { id: '5', fullName: 'team/repo5' }),
    { id: '5', fullName: 'team/repo5', defaultBranch: 'main', private: false });
  assert.equal(await adapter.commit(credential, { id: '5', fullName: 'team/repo5' }, 'feature/x'), sha);
  assert.deepEqual(await failure(adapter.commit(credential, { id: '5', fullName: 'team/repo5' }, 'missing')), unavailable);
  assert.deepEqual(await adapter.archive(credential, { id: '5', fullName: 'team/repo5' }, sha), { bytes: tarGz, format: 'tar.gz' });
  assert.deepEqual(await failure(adapter.repository(credential, { id: '6', fullName: 'team/repo6' })), malformed);
  assert.ok(calls.every(call => call.headers.authorization === 'token gt'));
});

test('Bitbucket Cloud lists per workspace and downloads archives with the same credentials', async t => {
  const adapter = gitProviderAdapters.bitbucket;
  const credential: GitCredential = { id: 'acct', provider: 'bitbucket', host: 'bitbucket.org', organization: '', username: 'me@example.com', token: 'api-token' };
  const api = 'https://api.bitbucket.org/2.0';
  const repo = (workspace: string, name: string, mainbranch: unknown = { name: 'main' }) =>
    ({ uuid: `{${name}-uuid}`, full_name: `${workspace}/${name}`, mainbranch, is_private: true });
  const calls = mockFetch(t, {
    [`${api}/user`]: json({ username: 'bb-user' }),
    [`${api}/user/workspaces?pagelen=100&page=1&sort=slug`]: json({ values: [{ workspace: { slug: 'alpha' } }, { workspace: { slug: 'beta' } }] }),
    [`${api}/repositories/alpha?role=member&pagelen=30&page=1&sort=full_name`]: json({ size: 2, values: [repo('alpha', 'one'), repo('alpha', 'empty', null)] }),
    [`${api}/repositories/beta?role=member&pagelen=30&page=1&sort=full_name`]: json({ size: 1, values: [repo('beta', 'two')] }),
    [`${api}/repositories/alpha/one`]: json(repo('alpha', 'one')),
    [`${api}/repositories/alpha/one/commit/release%2Fv2`]: json({ hash: sha }),
    [`https://bitbucket.org/alpha/one/get/${sha}.tar.gz`]: redirect(`https://downloads.bitbucket.org/alpha/one/${sha}.tar.gz?signature=x`),
    [`https://downloads.bitbucket.org/alpha/one/${sha}.tar.gz?signature=x`]: bytes(tarGz),
  });
  const auth = `Basic ${Buffer.from('me@example.com:api-token').toString('base64')}`;
  assert.deepEqual(await adapter.verify(credential), { login: 'bb-user' });
  assert.deepEqual(await adapter.list(credential, 1), {
    repositories: [{ id: '{one-uuid}', fullName: 'alpha/one', defaultBranch: 'main', private: true },
      { id: '{two-uuid}', fullName: 'beta/two', defaultBranch: 'main', private: true }],
    hasMore: false,
  });
  assert.deepEqual(await adapter.repository(credential, { id: '{one-uuid}', fullName: 'alpha/one' }),
    { id: '{one-uuid}', fullName: 'alpha/one', defaultBranch: 'main', private: true });
  assert.equal(await adapter.commit(credential, { id: '{one-uuid}', fullName: 'alpha/one' }, 'release/v2'), sha);
  assert.deepEqual(await adapter.archive(credential, { id: '{one-uuid}', fullName: 'alpha/one' }, sha), { bytes: tarGz, format: 'tar.gz' });
  assert.ok(calls.slice(0, -1).every(call => call.headers.authorization === auth && call.redirect === 'manual'));
  assert.equal(calls.at(-1)!.headers.authorization, undefined);
});

test('Bitbucket Cloud paging, access tokens and redirect policy', async t => {
  const adapter = gitProviderAdapters.bitbucket;
  const credential: GitCredential = { id: 'acct', provider: 'bitbucket', host: 'bitbucket.org', organization: '', username: null, token: 'access' };
  const api = 'https://api.bitbucket.org/2.0';
  const repo = (index: number) => ({ uuid: `{r${index}}`, full_name: `big/r${String(index).padStart(3, '0')}`, mainbranch: { name: 'main' }, is_private: false });
  const page = (number: number) => Array.from({ length: 30 }, (_, index) => repo((number - 1) * 30 + index));
  const calls = mockFetch(t, {
    [`${api}/user`]: json({ type: 'error' }, { status: 401 }),
    [`${api}/user/workspaces?pagelen=1`]: json({ values: [] }),
    [`${api}/user/workspaces?pagelen=100&page=1&sort=slug`]: json({ values: [{ workspace: { slug: 'big' } }, { workspace: { slug: 'zed' } }] }),
    [`${api}/repositories/big?role=member&pagelen=30&page=1&sort=full_name`]: json({ size: 75, values: page(1), next: 'x' }),
    [`${api}/repositories/big?role=member&pagelen=30&page=2&sort=full_name`]: json({ size: 75, values: page(2), next: 'x' }),
    [`${api}/repositories/big?role=member&pagelen=30&page=3&sort=full_name`]: json({ size: 75, values: page(3).slice(0, 15) }),
    [`${api}/repositories/zed?role=member&pagelen=30&page=1&sort=full_name`]: json({ size: 0, values: [] }),
    [`https://bitbucket.org/big/r001/get/${sha}.tar.gz`]: redirect('https://evil.example.com/archive.tar.gz'),
    [`https://bitbucket.org/big/r002/get/${sha}.tar.gz`]: redirect('/account/signin/?next=/big/r002/get/x'),
    [`https://bitbucket.org/big/r003/get/${sha}.tar.gz`]: text('<html>', 404),
  });
  assert.deepEqual(await adapter.verify(credential), { login: 'access token' });
  const second = await adapter.list(credential, 2);
  assert.deepEqual(second.repositories.map(item => item.fullName), page(2).map(item => item.full_name));
  assert.equal(second.hasMore, true);
  const third = await adapter.list(credential, 3);
  assert.equal(third.repositories.length, 15);
  assert.equal(third.hasMore, false);
  assert.deepEqual(await failure(adapter.archive(credential, { id: '{r1}', fullName: 'big/r001' }, sha)), untrusted);
  assert.deepEqual(await failure(adapter.archive(credential, { id: '{r2}', fullName: 'big/r002' }, sha)), unavailable);
  assert.deepEqual(await failure(adapter.archive(credential, { id: '{r3}', fullName: 'big/r003' }, sha)), unavailable);
  assert.ok(calls.every(call => call.headers.authorization === 'Bearer access'));
  assert.ok(!calls.some(call => call.url.startsWith('https://evil.example.com')));
});

test('Azure DevOps scopes every call to the organization and pages repositories locally', async t => {
  const adapter = gitProviderAdapters['azure-devops'];
  const credential: GitCredential = { id: 'acct', provider: 'azure-devops', host: 'dev.azure.com', organization: 'contoso', username: null, token: 'pat' };
  const base = 'https://dev.azure.com/contoso';
  const guid = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
  const repo = (id: string, project: string, name: string, extra: Record<string, unknown> = {}) =>
    ({ id, name, project: { name: project, visibility: 'private' }, defaultBranch: 'refs/heads/main', ...extra });
  const items = `${base}/_apis/git/repositories/${guid}/items?path=/&versionDescriptor.version=${sha}&versionDescriptor.versionType=commit&$format=zip&download=true&api-version=7.1`;
  const calls = mockFetch(t, {
    [`${base}/_apis/connectionData?api-version=7.1-preview`]: json({ authenticatedUser: { providerDisplayName: 'Ada Lovelace' } }),
    [`${base}/_apis/git/repositories?api-version=7.1`]: json({ value: [
      repo('b-id', 'Web', 'site'), repo(guid, 'Core', 'Engine Room'), repo('c-id', 'Core', 'api', { project: { name: 'Core', visibility: 'public' } }),
      repo('d-id', 'Core', 'disabled', { isDisabled: true }), repo('e-id', 'Core', 'empty', { defaultBranch: undefined }),
    ] }),
    [`${base}/_apis/git/repositories/${guid}?api-version=7.1`]: json(repo(guid, 'Core', 'Engine Room')),
    [`${base}/_apis/git/repositories/${guid}/refs?filter=heads%2Fmain&api-version=7.1`]: json({ value: [
      { name: 'refs/heads/main-old', objectId: 'c'.repeat(40) }, { name: 'refs/heads/main', objectId: sha },
    ] }),
    [`${base}/_apis/git/repositories/${guid}/refs?filter=heads%2Fv1&api-version=7.1`]: json({ value: [] }),
    [`${base}/_apis/git/repositories/${guid}/refs?filter=tags%2Fv1&peelTags=true&api-version=7.1`]: json({ value: [
      { name: 'refs/tags/v1', objectId: 'd'.repeat(40), peeledObjectId: sha },
    ] }),
    [`${base}/_apis/git/repositories/${guid}/commits/${'e'.repeat(40)}?api-version=7.1`]: json({ commitId: 'e'.repeat(40) }),
    [items]: redirect('https://vsblobprodscussu5shard1.blob.core.windows.net/b-x/zip?sv=sig'),
    'https://vsblobprodscussu5shard1.blob.core.windows.net/b-x/zip?sv=sig': bytes(zipBytes),
  });
  const auth = `Basic ${Buffer.from(':pat').toString('base64')}`;
  const ref = { id: guid, fullName: 'contoso/Core/Engine Room' };
  assert.deepEqual(await adapter.verify(credential), { login: 'Ada Lovelace' });
  assert.deepEqual(await adapter.list(credential, 1), {
    repositories: [
      { id: guid, fullName: 'contoso/Core/Engine Room', defaultBranch: 'main', private: true },
      { id: 'c-id', fullName: 'contoso/Core/api', defaultBranch: 'main', private: false },
      { id: 'b-id', fullName: 'contoso/Web/site', defaultBranch: 'main', private: true },
    ],
    hasMore: false,
  });
  assert.deepEqual((await adapter.list(credential, 2)).repositories, []);
  assert.deepEqual(await adapter.repository(credential, ref), { id: guid, fullName: 'contoso/Core/Engine Room', defaultBranch: 'main', private: true });
  assert.equal(await adapter.commit(credential, ref, 'main'), sha);
  assert.equal(await adapter.commit(credential, ref, 'v1'), sha);
  assert.equal(await adapter.commit(credential, ref, 'e'.repeat(40)), 'e'.repeat(40));
  assert.deepEqual(await adapter.archive(credential, ref, sha), { bytes: zipBytes, format: 'zip' });
  assert.ok(calls.slice(0, -1).every(call => call.headers.authorization === auth && call.redirect === 'manual'));
  assert.equal(calls.at(-1)!.headers.authorization, undefined);
});

test('Azure DevOps rejects other organizations, foreign redirects and bad tokens', async t => {
  const adapter = gitProviderAdapters['azure-devops'];
  const credential: GitCredential = { id: 'acct', provider: 'azure-devops', host: 'dev.azure.com', organization: 'contoso', username: null, token: 'pat' };
  const base = 'https://dev.azure.com/contoso';
  const guid = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
  const calls = mockFetch(t, {
    [`${base}/_apis/connectionData?api-version=7.1-preview`]: json({ message: 'unauthorized' }, { status: 401 }),
    [`${base}/_apis/git/repositories/${guid}/items?path=/&versionDescriptor.version=${sha}&versionDescriptor.versionType=commit&$format=zip&download=true&api-version=7.1`]:
      redirect('https://blob.core.windows.net.evil.example.com/zip'),
    [`${base}/_apis/git/repositories/${guid}/refs?filter=heads%2Fnope&api-version=7.1`]: json({ value: [{ name: 'refs/heads/nope-not', objectId: sha }] }),
    [`${base}/_apis/git/repositories/${guid}/refs?filter=tags%2Fnope&peelTags=true&api-version=7.1`]: json({ value: [] }),
    [`${base}/_apis/git/repositories/${guid}?api-version=7.1`]: text('<html>sign in</html>', 203),
  });
  assert.deepEqual(await failure(adapter.verify(credential)), rejected);
  const other = { id: guid, fullName: 'fabrikam/Core/app' };
  assert.deepEqual(await failure(adapter.repository(credential, other)), unavailable);
  assert.deepEqual(await failure(adapter.commit(credential, other, 'main')), unavailable);
  assert.deepEqual(await failure(adapter.archive(credential, other, sha)), unavailable);
  const ref = { id: guid, fullName: 'contoso/Core/app' };
  assert.deepEqual(await failure(adapter.archive(credential, ref, sha)), untrusted);
  assert.deepEqual(await failure(adapter.commit(credential, ref, 'nope')), unavailable);
  assert.deepEqual(await failure(adapter.repository(credential, ref)), unavailable);
  assert.ok(!calls.some(call => call.url.includes('fabrikam') || call.url.includes('evil')));
});
