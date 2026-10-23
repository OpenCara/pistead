import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { crc32, deflateRawSync, gunzipSync, gzipSync } from 'node:zlib';
import { HTTPException } from 'hono/http-exception';
import { app } from '../apps/server/src/index.js';
import type { ConnectorRelayEnvelope } from '../apps/server/src/connector-transport.js';
import { boundedRepositoryBody } from '../apps/server/src/repositories.js';
import { parseManifest } from '../apps/server/src/connectors.js';
import { gitProviderAdapters } from '../apps/server/src/git/providers.js';
import type { Env } from '../apps/server/src/types.js';
import { encryptToken } from '../apps/server/src/vault.js';
import { fakeHub, testDatabase } from './helpers/control-plane.js';
import type { ConnectorCredentials, ConnectorPairing } from '../packages/shared/src/connector.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import { repositoryLimits, type GitAccount, type ProviderRepository, type ProviderRepositoryList, type SessionRepository, type WorkspaceRepository, type WorkspaceRepositoryList } from '../packages/shared/src/repositories.js';
import type { AgentVersion, ModelDefinition, RunnerBinding, SessionRecord } from '../packages/shared/src/types.js';

const origin = 'http://localhost:8787';
const testSecret = 'repositories-test-secret-not-for-deployment';
const internalSecret = 'repositories-internal-secret-not-for-deployment';
const commitA = 'a'.repeat(40);
const commitB = 'b'.repeat(40);
const metadata = { id: 1701, full_name: 'acme/private-repo', default_branch: 'main', private: true };
const repositoryInput = { provider: 'github', host: 'github.com', repositoryId: String(metadata.id), fullName: metadata.full_name, ref: 'release/stable' };
const githubPicker = '/api/git/accounts/github/repositories';
const manifest = {
  models: [{ provider: 'local-native', modelId: 'local/model-v1', name: 'Local model' }],
  capabilities: { platform: 'linux', sandbox: true, productionShell: false, plainGit: true },
};
// A small, valid gzip of an empty tar, not a multi-megabyte archive fixture.
const archiveBytes = new Uint8Array(gzipSync(Buffer.alloc(1024)));
const token = () => Buffer.from(randomBytes(32)).toString('base64url');
type ApiRequest = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
interface Client { user: { id: string }; cookie: string; csrf: string; githubToken: string; request: ApiRequest }
interface Fixture {
  sqlite: DatabaseSync;
  env: Env;
  request: ApiRequest;
  client(name: string, production?: boolean): Promise<Client>;
}
type Connected = ConnectorCredentials & { connectionToken: string };

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body as T;
}
async function denied(response: Response, status: number, code: string) {
  assert.equal((await json<{ code: string }>(response, status)).code, code);
}

async function repositoryFailure(operation: Promise<unknown>, code: string) {
  let response: Response | undefined;
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof HTTPException);
    response = error.getResponse();
    return true;
  });
  assert.ok(response);
  await denied(response, 502, code);
}

async function fixture(t: TestContext): Promise<Fixture> {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true',
    TEST_AUTH_SECRET: testSecret, TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    RUNNER_SHARED_SECRET: internalSecret, VAULT_KEY: Buffer.alloc(32, 7).toString('base64url') };
  const request: ApiRequest = async (method, path, body, headers = {}) => app.request(`${origin}${path}`, {
    method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env);
  let nextGithubId = 100;
  async function client(name: string, production = true): Promise<Client> {
    const response = await request('POST', '/api/auth/test', { id: name, displayName: name, gitName: name,
      gitEmail: `${name}@example.test` }, { Authorization: `Bearer ${testSecret}` });
    const { user } = await json<{ user: { id: string } }>(response);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const githubToken = `github-secret-for-${name}`;
    if (production) {
      const githubId = String(nextGithubId++); const userId = `github:${githubId}`;
      // Keep the login-issued cookie/CSRF, but use the production identity namespace and vault path.
      sqlite.exec('BEGIN; PRAGMA defer_foreign_keys = ON');
      try {
        sqlite.prepare("UPDATE users SET id = ?, auth_kind = 'github', github_id = ? WHERE id = ?").run(userId, githubId, user.id);
        sqlite.prepare('UPDATE auth_sessions SET user_id = ? WHERE user_id = ?').run(userId, user.id);
        sqlite.exec('COMMIT');
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      user.id = userId;
      sqlite.prepare('INSERT INTO github_tokens (user_id,ciphertext,updated_at) VALUES (?,?,?)')
        .run(user.id, await encryptToken(env, user.id, githubToken), new Date().toISOString());
    }
    const { csrfToken } = await json<{ csrfToken: string }>(await request('GET', '/api/auth/csrf', undefined, { Cookie: cookie }));
    return { user, cookie, csrf: csrfToken, githubToken,
      request(method, path, body, headers = {}) { return request(method, path, body, { Cookie: cookie, 'X-CSRF-Token': csrfToken, ...headers }); } };
  }
  return { sqlite, env, request, client };
}

function beforeStatement(t: TestContext, f: Fixture, pattern: RegExp, change: () => void) {
  const query = f.env.DB.query.bind(f.env.DB);
  let changed = false;
  t.mock.method(f.env.DB, 'query', (sql: string) => {
    if (!changed && pattern.test(sql)) { changed = true; change(); }
    return query(sql);
  });
  t.after(() => assert.ok(changed, 'The test must reach the guarded write'));
}

async function workspace(owner: Client) {
  return (await json<{ workspace: { id: string } }>(await owner.request('POST', '/api/workspaces', { name: 'Repositories' }), 201)).workspace;
}
async function member(owner: Client, workspaceId: string, client: Client, role = 'member') {
  await json(await owner.request('POST', `/api/workspaces/${workspaceId}/members`, { userId: client.user.id, role }));
}
async function bindRepository(actor: Client, workspaceId: string, input = repositoryInput) {
  return (await json<{ repository: WorkspaceRepository }>(await actor.request('POST', `/api/workspaces/${workspaceId}/repositories`, input), 201)).repository;
}
async function pair(host: Client, workspaceId: string) {
  return (await json<{ pairing: ConnectorPairing }>(await host.request('POST', '/api/connectors/pairings', { name: 'Repository host', workspaceId }), 201)).pairing;
}
async function connect(f: Fixture, host: Client, workspaceId: string, claim: object = manifest): Promise<Connected> {
  const pending = await pair(host, workspaceId);
  const { credentials } = await json<{ credentials: ConnectorCredentials }>(await f.request('POST',
    `/api/connectors/pairings/${pending.id}/claim`, { code: pending.code, ...claim }), 201);
  const connectionToken = token();
  // Only the WebSocket generation is seeded; pairing, sharing and catalog import use real routes.
  f.sqlite.prepare('UPDATE connectors SET connection_hash = ? WHERE id = ?').run(await sha256(connectionToken), credentials.connectorId);
  return { ...credentials, connectionToken };
}
function provisionHub(f: Fixture) {
  const requests: ConnectorRelayEnvelope[] = [];
  f.env.CONNECTOR_HUB = fakeHub({ rpc(connectorId, envelope) {
    assert.equal(envelope.connectorId, connectorId);
    assert.equal(envelope.request.ticket.action, 'create');
    requests.push(envelope);
    return Response.json({ ok: true }, { status: 201 });
  } });
  return requests;
}

function github(t: TestContext) {
  const calls: { url: string; authorization: string | null; accept: string | null; redirect: RequestRedirect | undefined }[] = [];
  const unexpected: string[] = [];
  const state = {
    // The sha media type answer for one exact commit id.
    pinned: async (url: string): Promise<Response> => new Response(url.slice(-40), { headers: { 'Content-Type': 'application/vnd.github.sha' } }),
    commit: commitA,
    ref: repositoryInput.ref,
    metadata: async (): Promise<Response> => Response.json(metadata),
    resolve: async (): Promise<Response> => Response.json({ sha: state.commit }),
    picker: async (_url: string): Promise<Response> => Response.json([metadata]),
    redirect: (): Response => new Response(null, { status: 302,
      headers: { Location: `https://codeload.github.com/${metadata.full_name}/legacy.tar.gz/${state.commit}` } }),
    archive: async (): Promise<Response> => new Response(archiveBytes, { headers: { 'Content-Type': 'application/gzip' } }),
    // Git smart HTTP on github.com itself, which the egress relay reads with the session owner's credential.
    git: async (url: string, _init?: RequestInit): Promise<Response> => new Response(`unexpected ${url}`, { status: 500 }),
  };
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization'), accept: new Headers(init?.headers).get('accept'), redirect: init?.redirect });
    if (url === `https://api.github.com/repos/${metadata.full_name}`) return state.metadata();
    if (url === `https://api.github.com/repos/${metadata.full_name}/commits/${encodeURIComponent(state.ref)}` ||
        url === `https://api.github.com/repos/${metadata.full_name}/commits/main`) return state.resolve();
    if (url === `https://api.github.com/repos/${metadata.full_name}/commits/${commitA}` ||
        url === `https://api.github.com/repos/${metadata.full_name}/commits/${commitB}`) return state.pinned(url);
    if (/^https:\/\/api\.github\.com\/user\/repos\?per_page=100&page=\d+&sort=full_name&direction=asc$/.test(url)) return state.picker(url);
    if (url === `https://api.github.com/repos/${metadata.full_name}/tarball/${commitA}` ||
        url === `https://api.github.com/repos/${metadata.full_name}/tarball/${commitB}`) return state.redirect();
    if (url.startsWith(`https://codeload.github.com/${metadata.full_name}/legacy.tar.gz/`)) return state.archive();
    if (url.startsWith(`https://github.com/${metadata.full_name}.git/`)) return state.git(url, init);
    unexpected.push(url);
    throw new Error('Unexpected outbound repository request');
  });
  t.after(() => {
    assert.deepEqual(unexpected, []);
    for (const call of calls) {
      assert.equal(call.redirect, 'manual');
      if (call.url.startsWith(`https://github.com/${metadata.full_name}.git/`)) assert.match(call.authorization ?? '', /^Basic /, 'Git reads carry the owner credential');
      else if (new URL(call.url).origin !== 'https://api.github.com') assert.equal(call.authorization, null, 'Never forward OAuth across origins');
    }
  });
  return { state, calls };
}

async function connectedSetup(t: TestContext) {
  const f = await fixture(t); const remote = github(t);
  const admin = await f.client('admin'); const host = await f.client('host'); const owner = await f.client('owner');
  const team = await workspace(admin);
  await member(admin, team.id, host); await member(admin, team.id, owner);
  const repository = await bindRepository(admin, team.id);
  const connector = await connect(f, host, team.id);
  // This fixture intentionally runs another member's session on the host.
  await json(await host.request('PUT', `/api/connectors/${connector.connectorId}/shares/${team.id}`));
  const { models } = await json<{ models: ModelDefinition[] }>(await owner.request('GET', `/api/workspaces/${team.id}/models`));
  assert.equal(models.length, 1);
  const { agent: draft } = await json<{ agent: AgentVersion }>(await host.request('POST', '/api/agents', {
    name: 'Repository agent', description: '', instructions: '', tools: ['identity'], modelId: models[0].id,
  }), 201);
  const { agent } = await json<{ agent: AgentVersion }>(await host.request('POST', `/api/agents/${draft.agentId}/publish`, { workspaceId: team.id }), 201);
  const provisions = provisionHub(f);
  const input = { workspaceId: team.id, agentVersionId: agent.id, trustedConnectorId: connector.connectorId, title: 'Pinned repositories' };
  const start = async () => (await json<{ session: SessionRecord }>(await owner.request('POST', '/api/sessions', input), 201)).session;
  remote.calls.length = 0;
  return { f, remote, admin, host, owner, team, repository, connector, agent, provisions, input, start };
}
function download(f: Fixture, session: SessionRecord, pin: SessionRepository, connector?: Connected, body: unknown = { sessionId: session.id, commit: pin.commit }) {
  return f.request('POST', connector ? `/api/connectors/self/repositories/${pin.bindingId}/download` : `/api/internal/repositories/${pin.bindingId}/download`,
    body, connector ? { Authorization: `Bearer ${connector.token}`, 'X-Connection-Token': connector.connectionToken } : { Authorization: `Bearer ${internalSecret}` });
}
function authorizeCache(f: Fixture, session: SessionRecord, pin: SessionRepository, connector?: Connected, body: unknown = { sessionId: session.id, commit: pin.commit }) {
  return f.request('POST', connector ? `/api/connectors/self/repositories/${pin.bindingId}/authorize` : `/api/internal/repositories/${pin.bindingId}/authorize`,
    body, connector ? { Authorization: `Bearer ${connector.token}`, 'X-Connection-Token': connector.connectionToken } : { Authorization: `Bearer ${internalSecret}` });
}

// Existing legacy rows must remain downloadable, but new production sessions cannot create them.
async function legacySetup(t: TestContext) {
  const f = await fixture(t); const remote = github(t); const owner = await f.client('legacy-owner');
  const team = await workspace(owner); const repository = await bindRepository(owner, team.id);
  const { model } = await json<{ model: ModelDefinition }>(await owner.request('POST', `/api/workspaces/${team.id}/models`, {
    name: 'Legacy model', provider: 'openai', modelId: 'legacy-model',
  }), 201);
  const { agent } = await json<{ agent: AgentVersion }>(await owner.request('POST', '/api/agents', {
    name: 'Legacy agent', description: '', instructions: '', tools: ['identity'], modelId: model.id,
  }), 201);
  const pin: SessionRepository = { bindingId: repository.id, repositoryId: metadata.id, fullName: metadata.full_name,
    ref: repository.ref, commit: commitA, path: metadata.full_name };
  const session: SessionRecord = { id: 'legacy-session', workspaceId: team.id, ownerId: owner.user.id, agentVersionId: agent.id,
    title: 'Existing session', policyVersion: 1, status: 'ready', createdAt: new Date().toISOString(), repositories: [pin] };
  f.sqlite.prepare(`INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,policy_version,status,created_at,repositories_json)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(session.id, team.id, owner.user.id, agent.id, session.title, 1, 'ready', session.createdAt, JSON.stringify([pin]));
  remote.calls.length = 0;
  return { f, remote, owner, team, repository, session, pin };
}

test('repository API separates cookie/CSRF authentication, administrator writes, and member reads', async t => {
  const f = await fixture(t); const remote = github(t);
  const owner = await f.client('owner'); const admin = await f.client('admin'); const reader = await f.client('reader'); const outsider = await f.client('outsider');
  const team = await workspace(owner); const path = `/api/workspaces/${team.id}/repositories`;
  await member(owner, team.id, admin, 'admin'); await member(owner, team.id, reader);
  for (const path of [githubPicker, '/api/git/accounts', `/api/workspaces/${team.id}/repositories`]) {
    await denied(await f.request('GET', path), 401, 'unauthorized');
    await denied(await f.request('GET', path, undefined, { Authorization: `Bearer ${internalSecret}` }), 401, 'unauthorized');
  }
  await denied(await outsider.request('GET', path), 404, 'not_found');
  await denied(await outsider.request('POST', path, repositoryInput), 404, 'not_found');
  await denied(await reader.request('POST', path, repositoryInput), 403, 'forbidden');
  await denied(await owner.request('POST', path, repositoryInput, { 'X-CSRF-Token': '' }), 403, 'invalid_csrf');
  assert.equal((await owner.request('POST', path, repositoryInput, { Origin: 'https://evil.example' })).status, 403);
  assert.equal(remote.calls.length, 0);
  const binding = await bindRepository(admin, team.id);
  assert.equal(remote.calls[0].authorization, `Bearer ${admin.githubToken}`);
  assert.deepEqual((await json<{ repositories: WorkspaceRepository[] }>(await reader.request('GET', path))).repositories, [binding]);
  const remove = `${path}/${binding.id}`;
  await denied(await reader.request('DELETE', remove), 403, 'forbidden');
  await denied(await outsider.request('DELETE', remove), 404, 'not_found');
  await denied(await admin.request('DELETE', remove, undefined, { 'X-CSRF-Token': '' }), 403, 'invalid_csrf');
  assert.equal((await admin.request('DELETE', remove, undefined, { Origin: 'https://evil.example' })).status, 403);
  const other = await workspace(owner);
  assert.equal((await owner.request('DELETE', `/api/workspaces/${other.id}/repositories/${binding.id}`)).status, 204);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_repositories').get()!.n, 1);
  assert.equal((await admin.request('DELETE', remove)).status, 204);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_repositories').get()!.n, 0);
  assert.equal(remote.calls.length, 1);
});

test('picker uses the acting GitHub token, projects safe metadata and lists every page up to the limit', async t => {
  const f = await fixture(t); const remote = github(t); const alice = await f.client('alice'); const bob = await f.client('bob');
  remote.state.picker = async () => Response.json([{ ...metadata, token: alice.githubToken, clone_url: 'credential-bearing upstream field' }]);
  for (const actor of [alice, bob]) {
    const result = await json(await actor.request('GET', githubPicker));
    assert.deepEqual(result, { repositories: [{ id: String(metadata.id), fullName: metadata.full_name, defaultBranch: 'main', private: true }], truncated: false });
    assert.equal(remote.calls.at(-1)!.authorization, `Bearer ${actor.githubToken}`);
  }
  const pageOf = (url: string) => Number(new URL(url).searchParams.get('page'));
  const repos = (page: number, length: number) =>
    Array.from({ length }, (_, index) => ({ ...metadata, id: page * 1000 + index, full_name: `acme/repo-${page}-${index}` }));
  const pickerCalls = () => remote.calls.filter(call => call.url.startsWith('https://api.github.com/user/repos?'));
  let before = pickerCalls().length;
  remote.state.picker = async url => Response.json(repos(pageOf(url), pageOf(url) === 1 ? 100 : 1));
  const two = await json<ProviderRepositoryList>(await alice.request('GET', githubPicker));
  assert.equal(two.repositories.length, 101);
  assert.equal(two.truncated, false);
  assert.deepEqual(pickerCalls().slice(before).map(call => pageOf(call.url)), [1, 2]);
  before = pickerCalls().length;
  remote.state.picker = async url => Response.json(repos(pageOf(url), 100));
  const full = await json<ProviderRepositoryList>(await alice.request('GET', githubPicker));
  assert.equal(full.repositories.length, 3000);
  assert.equal(full.truncated, true);
  assert.deepEqual(pickerCalls().slice(before).map(call => pageOf(call.url)), Array.from({ length: 30 }, (_, index) => index + 1));
  remote.state.picker = async () => Response.json(repos(1, 101));
  await denied(await alice.request('GET', githubPicker), 502, 'invalid_github_response');
});

test('shared repository configuration never lends another member a GitHub token', async t => {
  const f = await fixture(t); const remote = github(t); const owner = await f.client('owner'); const admin = await f.client('admin');
  const synthetic = await f.client('synthetic', false); const team = await workspace(owner);
  await member(owner, team.id, admin, 'admin'); await member(owner, team.id, synthetic, 'admin');
  await bindRepository(owner, team.id);
  f.sqlite.prepare('DELETE FROM github_tokens WHERE user_id = ?').run(admin.user.id);
  remote.calls.length = 0;
  for (const [actor, status] of [[admin, 409], [synthetic, 403]] as const) {
    await denied(await actor.request('GET', githubPicker), status, 'github_not_connected');
    await denied(await actor.request('POST', `/api/workspaces/${team.id}/repositories`, repositoryInput), status, 'github_not_connected');
    assert.equal((await actor.request('GET', `/api/workspaces/${team.id}/repositories`)).status, 200);
  }
  assert.equal(remote.calls.length, 0);
});

for (const changed of [{ id: metadata.id + 1 }, { full_name: 'acme/renamed' }, { full_name: 'Acme/private-repo' }]) {
  test(`binding rejects exact numeric/name identity mismatch: ${JSON.stringify(changed)}`, async t => {
    const f = await fixture(t); const remote = github(t); const actor = await f.client('actor'); const team = await workspace(actor);
    remote.state.metadata = async () => Response.json({ ...metadata, ...changed });
    await denied(await actor.request('POST', `/api/workspaces/${team.id}/repositories`, repositoryInput), 409, 'repository_identity_changed');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_repositories').get()!.n, 0);
    assert.equal(remote.calls.length, 1);
    assert.equal(remote.calls[0].authorization, `Bearer ${actor.githubToken}`);
  });
}

test('binding validates numeric IDs and allowed fields before fetching, defaults the ref, and rejects duplicates', async t => {
  const f = await fixture(t); const remote = github(t); const actor = await f.client('actor'); const team = await workspace(actor);
  const path = `/api/workspaces/${team.id}/repositories`;
  for (const repositoryId of [metadata.id, '0', '-1', '1.5', '01', String(Number.MAX_SAFE_INTEGER + 1), 'acme', null]) {
    await denied(await actor.request('POST', path, { ...repositoryInput, repositoryId }), 400, 'invalid_repository');
  }
  for (const extra of [{ token: actor.githubToken }, { path: '../escape' }, { commit: commitA }, { provider: 'svn' }, { host: 'evil.example.com' }]) {
    await denied(await actor.request('POST', path, { ...repositoryInput, ...extra }), 400, extra.host ? 'invalid_git_host' : 'invalid_repository');
  }
  assert.equal(remote.calls.length, 0);
  const { repository } = await json<{ repository: WorkspaceRepository }>(await actor.request('POST', path, {
    provider: 'github', repositoryId: String(metadata.id), fullName: metadata.full_name,
  }), 201);
  assert.equal(repository.ref, 'main');
  assert.equal(repository.private, true);
  await denied(await actor.request('POST', path, repositoryInput), 409, 'repository_binding_conflict');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_repositories').get()!.n, 1);
});

for (const route of ['picker', 'binding'] as const) {
  test(`${route} rechecks the acting token after asynchronous metadata`, async t => {
    const f = await fixture(t); const remote = github(t); const actor = await f.client('actor'); const team = await workspace(actor);
    const revoke = async () => {
      f.sqlite.prepare('DELETE FROM github_tokens WHERE user_id = ?').run(actor.user.id);
      return Response.json(route === 'picker' ? [metadata] : metadata);
    };
    if (route === 'picker') remote.state.picker = revoke; else remote.state.metadata = revoke;
    const response = route === 'picker' ? await actor.request('GET', githubPicker) :
      await actor.request('POST', `/api/workspaces/${team.id}/repositories`, repositoryInput);
    await denied(response, 403, 'github_access_changed');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_repositories').get()!.n, 0);
  });
}

test('sessions clone: creation pins nothing, reads no repository and lends the host no token', async t => {
  const s = await connectedSetup(t); const session = await s.start();
  assert.equal(session.status, 'ready');
  assert.equal(session.ownerId, s.owner.user.id);
  assert.equal(session.connectorOwnerId, s.host.user.id);
  assert.deepEqual(session.repositories, []);
  assert.equal(session.repositoryMode, 'clone');
  assert.equal(session.frozen, undefined);
  assert.deepEqual(s.remote.calls, []);
  assert.equal(s.provisions.length, 1);
  const binding = JSON.parse(s.provisions[0].request.body) as RunnerBinding;
  assert.deepEqual(binding.session.repositories, []);
  assert.equal(binding.session.repositoryMode, 'clone');
  assert.equal(binding.owner.id, s.owner.user.id);
  const persisted = s.f.sqlite.prepare('SELECT repositories_json, repository_mode FROM sessions WHERE id = ?').get(session.id)!;
  assert.deepEqual([JSON.parse(String(persisted.repositories_json)), persisted.repository_mode], [[], 'clone']);
  for (const secret of [s.owner.githubToken, s.admin.githubToken, s.host.githubToken, s.connector.token, s.connector.connectionToken]) {
    assert.ok(!JSON.stringify(s.provisions).includes(secret));
    assert.ok(!JSON.stringify(session).includes(secret));
  }
});

test('session repositories are server-owned and immutable', async t => {
  const s = await connectedSetup(t);
  for (const field of ['repositories', 'repositories_json', 'pins']) {
    await denied(await s.owner.request('POST', '/api/sessions', { ...s.input, [field]: [] }), 400, 'server_owned_identity');
  }
  const first = await s.start();
  assert.throws(() => s.f.sqlite.prepare('UPDATE sessions SET repositories_json = ? WHERE id = ?').run('[{}]', first.id), /immutable/);
  assert.equal(s.remote.calls.length, 0);
});

test('a GitHub-connected host runs its unpublished agent privately, cloning, with no host trust', async t => {
  const s = await connectedSetup(t);
  assert.equal((await s.host.request('DELETE', `/api/connectors/${s.connector.connectorId}/shares/${s.team.id}`)).status, 204);
  const { agent } = await json<{ agent: AgentVersion }>(await s.host.request('POST', '/api/agents', {
    name: 'Private repository agent', description: '', instructions: '', tools: ['identity'], modelId: s.agent.modelId,
  }), 201);
  assert.equal(agent.workspaceId, null);
  const input = { workspaceId: s.team.id, agentVersionId: agent.id, title: 'Host-owned session' };
  const { session } = await json<{ session: SessionRecord }>(await s.host.request('POST', '/api/sessions', input), 201);
  assert.equal(session.ownerId, s.host.user.id);
  assert.equal(session.connectorOwnerId, s.host.user.id);
  assert.equal(session.visibility, 'workspace');
  assert.equal(session.repositoryMode, 'clone');
  assert.equal(s.provisions.length, 1);
  assert.equal(s.remote.calls.length, 0);
});

for (const change of ['association-removed', 'share-removed', 'revoked', 'model-unavailable'] as const) {
  test(`session admission atomically rechecks connector ${change} in its insert`, async t => {
    const s = await connectedSetup(t);
    const actor = change === 'share-removed' ? s.owner : s.host;
    if (actor === s.host) {
      assert.equal((await s.host.request('DELETE', `/api/connectors/${s.connector.connectorId}/shares/${s.team.id}`)).status, 204);
    }
    beforeStatement(t, s.f, /^INSERT INTO sessions\b/, () => {
      if (change === 'association-removed') s.f.sqlite.prepare('DELETE FROM connector_workspaces WHERE connector_id = ?').run(s.connector.connectorId);
      if (change === 'share-removed') s.f.sqlite.prepare('DELETE FROM connector_shares WHERE connector_id = ?').run(s.connector.connectorId);
      if (change === 'revoked') s.f.sqlite.prepare("UPDATE connectors SET revoked_at = '2026-01-02' WHERE id = ?").run(s.connector.connectorId);
      if (change === 'model-unavailable') s.f.sqlite.prepare('UPDATE models SET available = 0 WHERE id = ?').run(s.agent.modelId);
    });
    await denied(await actor.request('POST', '/api/sessions', s.input), 409, 'session_configuration_changed');
    assert.equal(s.f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
    assert.equal(s.provisions.length, 0);
    assert.equal(s.remote.calls.length, 0);
  });
}

for (const change of ['token-deleted', 'token-rotated', 'github-identity', 'auth-kind'] as const) {
  test(`repository binding rechecks ${change} in its final write`, async t => {
    const f = await fixture(t); const remote = github(t); const owner = await f.client('owner');
    const team = await workspace(owner);
    const rotated = await encryptToken(f.env, owner.user.id, 'rotated-owner-token');
    beforeStatement(t, f, /^INSERT INTO workspace_repositories\b/, () => {
      if (change === 'token-deleted') f.sqlite.prepare('DELETE FROM github_tokens WHERE user_id = ?').run(owner.user.id);
      if (change === 'token-rotated') f.sqlite.prepare('UPDATE github_tokens SET ciphertext = ? WHERE user_id = ?').run(rotated, owner.user.id);
      if (change === 'github-identity') f.sqlite.prepare('UPDATE users SET github_id = ? WHERE id = ?').run('999', owner.user.id);
      if (change === 'auth-kind') f.sqlite.prepare("UPDATE users SET auth_kind = 'test' WHERE id = ?").run(owner.user.id);
    });
    await denied(await owner.request('POST', `/api/workspaces/${team.id}/repositories`, repositoryInput), 409, 'repository_binding_conflict');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_repositories').get()!.n, 0);
    assert.equal(remote.calls.length, 1);
  });
}

for (const change of ['identity', 'test-mode'] as const) {
  test(`legacy empty repository session admission rechecks fixture ${change}`, async t => {
    const f = await fixture(t); const owner = await f.client('synthetic', false); const team = await workspace(owner);
    const { model } = await json<{ model: ModelDefinition }>(await owner.request('POST', `/api/workspaces/${team.id}/models`, {
      name: 'Faux', provider: 'faux', modelId: 'faux',
    }), 201);
    const { agent } = await json<{ agent: AgentVersion }>(await owner.request('POST', '/api/agents', {
      name: 'Faux agent', description: '', instructions: '', tools: ['identity'], modelId: model.id,
    }), 201);
    beforeStatement(t, f, /^INSERT INTO sessions\b/, () => {
      if (change === 'identity') f.sqlite.prepare("UPDATE users SET auth_kind = 'github', github_id = '999' WHERE id = ?").run(owner.user.id);
      else f.env.TEST_AUTH_ENABLED = 'false';
    });
    await denied(await owner.request('POST', '/api/sessions', { workspaceId: team.id, agentVersionId: agent.id }), 409, 'session_configuration_changed');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
  });
}

test('real users still require configured workspaces for pairing, claim, share and session creation in testMode', async t => {
  const s = await connectedSetup(t); const empty = await workspace(s.owner);
  const health = await json<{ testMode: boolean }>(await s.f.request('GET', '/api/health'));
  assert.equal(health.testMode, true);
  await denied(await s.owner.request('POST', '/api/connectors/pairings', { name: 'Empty workspace', workspaceId: empty.id }), 409, 'workspace_repositories_required');
  const hostEmpty = await workspace(s.host);
  await denied(await s.host.request('PUT', `/api/connectors/${s.connector.connectorId}/shares/${hostEmpty.id}`), 409, 'workspace_repositories_required');
  const pending = await pair(s.host, s.team.id);
  assert.equal((await s.admin.request('DELETE', `/api/workspaces/${s.team.id}/repositories/${s.repository.id}`)).status, 204);
  await denied(await s.f.request('POST', `/api/connectors/pairings/${pending.id}/claim`, { code: pending.code, ...manifest }), 409, 'workspace_repositories_required');
  assert.equal(s.f.sqlite.prepare('SELECT claimed_at FROM connector_pairings WHERE id = ?').get(pending.id)!.claimed_at, null);
  await denied(await s.owner.request('POST', '/api/sessions', s.input), 409, 'workspace_repositories_required');
  assert.equal(s.f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
  assert.equal(s.provisions.length, 0);
  assert.equal(s.remote.calls.length, 0);
});

test('the repository listing tells real users they need a repository, even in testMode, and synthetic test users that they do not', async t => {
  const f = await fixture(t); const real = await f.client('real'); const synthetic = await f.client('synthetic', false);
  const listing = async (client: Client) => json<WorkspaceRepositoryList>(await client.request('GET', `/api/workspaces/${(await workspace(client)).id}/repositories`));
  assert.deepEqual(await listing(real), { repositories: [], required: true });
  assert.deepEqual(await listing(synthetic), { repositories: [], required: false });
});

test('testMode does not let a real user start an unconnected faux-model session', async t => {
  const f = await fixture(t); const owner = await f.client('owner'); const team = await workspace(owner);
  const { model } = await json<{ model: ModelDefinition }>(await owner.request('POST', `/api/workspaces/${team.id}/models`, {
    name: 'Faux', provider: 'faux', modelId: 'faux',
  }), 201);
  const { agent } = await json<{ agent: AgentVersion }>(await owner.request('POST', '/api/agents', {
    name: 'Faux agent', description: '', instructions: '', tools: ['identity'], modelId: model.id,
  }), 201);
  await denied(await owner.request('POST', '/api/sessions', { workspaceId: team.id, agentVersionId: agent.id }), 400, 'connector_required');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
});

test('configured pairing claims privately associate and import models, but lost membership leaves a pairing unused', async t => {
  const f = await fixture(t); github(t);
  const admin = await f.client('admin'); const host = await f.client('host');
  const team = await workspace(admin);
  await member(admin, team.id, host);
  await bindRepository(admin, team.id);
  const connector = await connect(f, host, team.id);
  const s = { f, admin, host, team, connector };
  const shares = f.sqlite.prepare('SELECT workspace_id FROM connector_shares WHERE connector_id = ?').all(connector.connectorId);
  assert.deepEqual(shares, []);
  const associations = f.sqlite.prepare('SELECT workspace_id FROM connector_workspaces WHERE connector_id = ?').all(connector.connectorId);
  assert.deepEqual(associations.map(row => row.workspace_id), [team.id]);
  const models = f.sqlite.prepare('SELECT connector_owner_id, provider, model_id FROM models WHERE connector_id = ?').all(connector.connectorId);
  assert.equal(models.length, 1);
  assert.equal(models[0].connector_owner_id, host.user.id);
  assert.equal(models[0].provider, manifest.models[0].provider);
  assert.equal(models[0].model_id, manifest.models[0].modelId);
  assert.equal((await json<{ models: ModelDefinition[] }>(await host.request('GET', `/api/workspaces/${team.id}/models`))).models.length, 1);
  assert.deepEqual((await json<{ models: ModelDefinition[] }>(await admin.request('GET', `/api/workspaces/${team.id}/models`))).models, []);
  const pending = await pair(s.host, s.team.id);
  assert.equal((await s.admin.request('DELETE', `/api/workspaces/${s.team.id}/members/${s.host.user.id}`)).status, 204);
  await denied(await s.f.request('POST', `/api/connectors/pairings/${pending.id}/claim`, { code: pending.code, ...manifest }), 404, 'not_found');
  assert.equal(s.f.sqlite.prepare('SELECT claimed_at FROM connector_pairings WHERE id = ?').get(pending.id)!.claimed_at, null);
  assert.equal(s.f.sqlite.prepare('SELECT COUNT(*) AS n FROM connectors').get()!.n, 1);
});

test('only explicitly enabled synthetic fixtures can claim a legacy workspace-free pairing', async t => {
  const f = await fixture(t); const synthetic = await f.client('synthetic', false); const real = await f.client('real');
  assert.equal((await real.request('POST', '/api/connectors/pairings', { name: 'No workspace' })).status, 400);
  const pending = (await json<{ pairing: ConnectorPairing }>(await synthetic.request('POST', '/api/connectors/pairings', { name: 'Legacy fixture' }), 201)).pairing;
  const other = (await json<{ pairing: ConnectorPairing }>(await synthetic.request('POST', '/api/connectors/pairings', { name: 'Disabled fixture' }), 201)).pairing;
  await json(await f.request('POST', `/api/connectors/pairings/${pending.id}/claim`, { code: pending.code, ...manifest }), 201);
  f.env.TEST_AUTH_ENABLED = 'false';
  f.env.APP_ORIGIN = 'https://workspace.example.test';
  // HTTPS avoids testing the independent loopback transport exemption instead of the fixture gate.
  const response = await app.request(`https://workspace.example.test/api/connectors/pairings/${other.id}/claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: other.code, ...manifest }),
  }, f.env);
  await denied(response, 403, 'invalid_pairing');
  assert.equal(f.sqlite.prepare('SELECT claimed_at FROM connector_pairings WHERE id = ?').get(other.id)!.claimed_at, null);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connectors').get()!.n, 1);
});

for (const scoped of [false, true]) {
  test(`legacy ${scoped ? 'workspace-bound' : 'workspace-free'} pairing rechecks test-mode expiry at the write`, async t => {
    const f = await fixture(t); const owner = await f.client('synthetic', false); const team = await workspace(owner);
    beforeStatement(t, f, /^INSERT INTO connector_pairings\b/, () => {
      f.env.TEST_AUTH_EXPIRES_AT = new Date(Date.now() - 1000).toISOString();
    });
    await denied(await owner.request('POST', '/api/connectors/pairings', {
      name: 'Expiring fixture', ...(scoped ? { workspaceId: team.id } : {}),
    }), 429, 'pairing_limit');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_pairings').get()!.n, 0);
  });
}

test('legacy pairing claim rechecks test-mode expiry without consuming its code', async t => {
  const f = await fixture(t); const owner = await f.client('synthetic', false); const team = await workspace(owner);
  const pending = await pair(owner, team.id);
  beforeStatement(t, f, /^INSERT INTO connectors\b/, () => {
    f.env.TEST_AUTH_EXPIRES_AT = new Date(Date.now() - 1000).toISOString();
  });
  await denied(await f.request('POST', `/api/connectors/pairings/${pending.id}/claim`, { code: pending.code, ...manifest }), 403, 'invalid_pairing');
  assert.equal(f.sqlite.prepare('SELECT claimed_at FROM connector_pairings WHERE id = ?').get(pending.id)!.claimed_at, null);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connectors').get()!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_shares').get()!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_workspaces').get()!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM models').get()!.n, 0);
});

test('legacy sharing rechecks test-mode expiry before sharing an unconfigured workspace', async t => {
  const f = await fixture(t); const owner = await f.client('synthetic', false);
  const existing = await workspace(owner); const target = await workspace(owner);
  const connector = await connect(f, owner, existing.id);
  beforeStatement(t, f, /^INSERT INTO connector_shares\b/, () => {
    f.env.TEST_AUTH_EXPIRES_AT = new Date(Date.now() - 1000).toISOString();
  });
  await denied(await owner.request('PUT', `/api/connectors/${connector.connectorId}/shares/${target.id}`), 409, 'share_unavailable');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_shares WHERE workspace_id = ?').get(target.id)!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_workspaces WHERE workspace_id = ?').get(target.id)!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM models WHERE workspace_id = ?').get(target.id)!.n, 0);
});

function pausedArchive() {
  const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); let first = true;
  const response = new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (first) { first = false; controller.enqueue(archiveBytes.slice(0, 2)); return; }
      started.resolve();
      await release.promise;
      controller.enqueue(archiveBytes.slice(2));
      controller.close();
    },
  }, { highWaterMark: 0 }));
  return { response, started: started.promise, release: () => release.resolve() };
}

test('repository body bound accepts the exact byte limit and cancels streamed overflow even with a lying length', async () => {
  const exact = new Uint8Array([1, 2, 3, 4]);
  assert.deepEqual(await boundedRepositoryBody(new Response(exact, { headers: { 'Content-Length': '4' } }), 4), exact);
  for (const contentLength of [undefined, '1']) {
    let cancelled = false; let reads = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(3)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: contentLength ? { 'Content-Length': contentLength } : {} });
    await repositoryFailure(boundedRepositoryBody(response, 4), 'repository_download_failed');
    assert.equal(cancelled, true);
    assert.equal(reads, 2);
    assert.equal(response.body!.locked, false);
  }
});

test('repository body bound rejects malformed/oversized Content-Length without reading the stream', async () => {
  for (const length of ['5', '-1', 'NaN', '1.5', '1e2']) {
    let cancelled = false; let reads = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() { reads++; }, cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: { 'Content-Length': length } });
    await repositoryFailure(boundedRepositoryBody(response, 4), 'repository_size_limit');
    assert.equal(reads, 0); assert.equal(cancelled, true);
  }
  await repositoryFailure(boundedRepositoryBody(new Response(null), 4), 'invalid_github_response');
  const broken = new Response(new ReadableStream({ start(controller) { controller.error(new Error('private upstream error')); } }));
  await repositoryFailure(boundedRepositoryBody(broken, 4), 'repository_download_failed');
});

test('repository body deadline cancels a stalled stream without real-time waits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }, { highWaterMark: 0 }));
  const pending = boundedRepositoryBody(response, 4);
  const rejection = repositoryFailure(pending, 'repository_download_failed');
  t.mock.timers.tick(20001);
  await rejection;
  assert.equal(cancelled, true);
  assert.equal(response.body!.locked, false);
});

test('GitHub metadata has a separate small size bound and rejects malformed JSON/UTF-8', async t => {
  const f = await fixture(t); const remote = github(t); const owner = await f.client('owner'); let cancelled = false;
  remote.state.picker = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) },
  });
  await denied(await owner.request('GET', githubPicker), 502, 'repository_size_limit');
  assert.equal(cancelled, true);
  for (const body of [new TextEncoder().encode('{broken'), new Uint8Array([0xff])]) {
    remote.state.picker = async () => new Response(body);
    await denied(await owner.request('GET', githubPicker), 502, 'invalid_github_response');
  }
});

test('picker and bindings accept underscore and Unicode refs with hash characters', async t => {
  const s = await connectedSetup(t);
  let bindingId = s.repository.id;
  for (const ref of ['_prefix', '\u4fee\u590d/#issue']) {
    s.remote.state.picker = async () => Response.json([{ ...metadata, default_branch: ref }]);
    const picked = await json<{ repositories: { defaultBranch: string }[] }>(await s.owner.request('GET', githubPicker));
    assert.equal(picked.repositories[0].defaultBranch, ref);
    assert.equal((await s.admin.request('DELETE', `/api/workspaces/${s.team.id}/repositories/${bindingId}`)).status, 204);
    bindingId = (await bindRepository(s.admin, s.team.id, { ...repositoryInput, ref })).id;
    const bound = await json<WorkspaceRepositoryList>(await s.owner.request('GET', `/api/workspaces/${s.team.id}/repositories`));
    assert.equal(bound.repositories.find(repository => repository.id === bindingId)?.ref, ref);
  }
});

// Token providers, exercised through Gitea's real adapter HTTP calls (fetch is mocked).
const giteaHost = 'git.acme.dev';
const giteaApi = `https://${giteaHost}/api/v1`;
const giteaMetadata = { id: 42, full_name: 'acme/tools', default_branch: 'main', private: true };
const giteaInput = { provider: 'gitea', host: giteaHost, repositoryId: '42', fullName: giteaMetadata.full_name, ref: 'main' };
const giteaRepository = `${giteaApi}/repositories/42`;
const giteaCommit = `${giteaApi}/repos/acme/tools/commits?sha=main&limit=1&stat=false&verification=false&files=false`;
const giteaArchive = `${giteaApi}/repos/acme/tools/archive/${commitA}.tar.gz`;
const giteaPinnedCommit = `${giteaApi}/repos/acme/tools/commits?sha=${commitA}&limit=1&stat=false&verification=false&files=false`;
const providerManifest = { ...manifest, capabilities: { ...manifest.capabilities, gitProviders: true } };
const giteaToken = (client: Client) => `gitea-secret-for-${client.user.id}`;

function gitea(t: TestContext) {
  const calls: { url: string; authorization: string | null; redirect: RequestRedirect | undefined }[] = [];
  const unexpected: string[] = [];
  const state = {
    user: async (): Promise<Response> => Response.json({ login: 'gitea-user' }),
    picker: async (): Promise<Response> => Response.json([giteaMetadata]),
    metadata: async (): Promise<Response> => Response.json(giteaMetadata),
    resolve: async (): Promise<Response> => Response.json([{ sha: commitA }]),
    pinned: async (): Promise<Response> => Response.json([{ sha: commitA }]),
    archive: async (): Promise<Response> => new Response(archiveBytes, { headers: { 'Content-Type': 'application/gzip' } }),
    // Git smart HTTP on github.com itself, which the egress relay reads with the session owner's credential.
    git: async (url: string, _init?: RequestInit): Promise<Response> => new Response(`unexpected ${url}`, { status: 500 }),
  };
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
    if (url === `${giteaApi}/user`) return state.user();
    if (url === `${giteaApi}/user/repos?page=1&limit=30`) return state.picker();
    if (url === giteaRepository) return state.metadata();
    if (url === giteaCommit) return state.resolve();
    if (url === giteaPinnedCommit) return state.pinned();
    if (url === giteaArchive) return state.archive();
    unexpected.push(url);
    throw new Error('Unexpected outbound repository request');
  });
  t.after(() => {
    assert.deepEqual(unexpected, []);
    for (const call of calls) assert.equal(call.redirect, 'manual');
  });
  return { state, calls };
}
async function connectGitea(client: Client, input: Record<string, unknown> = {}) {
  return (await json<{ account: GitAccount }>(await client.request('POST', '/api/git/accounts', {
    provider: 'gitea', host: 'https://Git.Acme.dev/', token: giteaToken(client), ...input,
  }), 201)).account;
}
function zipArchive(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content); const packed = deflateRawSync(data); const path = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(path.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(path.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, path, packed); centrals.push(central, path);
    offset += local.length + path.length + packed.length;
  }
  const directory = Buffer.concat(centrals); const end = Buffer.alloc(22); const count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

async function providerSetup(t: TestContext, claim: object = providerManifest) {
  const f = await fixture(t); const remote = gitea(t);
  const admin = await f.client('admin'); const host = await f.client('host'); const owner = await f.client('owner');
  const team = await workspace(admin);
  await member(admin, team.id, host); await member(admin, team.id, owner);
  await connectGitea(admin); await connectGitea(owner);
  const repository = await bindRepository(admin, team.id, giteaInput);
  assert.deepEqual(remote.calls.at(-1), { url: giteaRepository, authorization: `token ${giteaToken(admin)}`, redirect: 'manual' });
  const connector = await connect(f, host, team.id, claim);
  await json(await host.request('PUT', `/api/connectors/${connector.connectorId}/shares/${team.id}`));
  const { models } = await json<{ models: ModelDefinition[] }>(await owner.request('GET', `/api/workspaces/${team.id}/models`));
  const { agent: draft } = await json<{ agent: AgentVersion }>(await host.request('POST', '/api/agents', {
    name: 'Gitea agent', description: '', instructions: '', tools: ['identity'], modelId: models[0].id,
  }), 201);
  const { agent } = await json<{ agent: AgentVersion }>(await host.request('POST', `/api/agents/${draft.agentId}/publish`, { workspaceId: team.id }), 201);
  const provisions = provisionHub(f);
  const input = { workspaceId: team.id, agentVersionId: agent.id, trustedConnectorId: connector.connectorId, title: 'Gitea session' };
  const start = async () => (await json<{ session: SessionRecord }>(await owner.request('POST', '/api/sessions', input), 201)).session;
  remote.calls.length = 0;
  return { f, remote, admin, host, owner, team, repository, connector, provisions, input, start };
}

test('token accounts are verified, stored encrypted, never returned, private to their user and replaced in place', async t => {
  const f = await fixture(t); const remote = gitea(t); const alice = await f.client('alice'); const bob = await f.client('bob');
  const account = await connectGitea(alice);
  assert.deepEqual({ ...account, id: '', createdAt: '' }, { id: '', provider: 'gitea', host: giteaHost, organization: '', login: 'gitea-user', createdAt: '' });
  assert.deepEqual(remote.calls.map(call => [call.url, call.authorization]), [[`${giteaApi}/user`, `token ${giteaToken(alice)}`]]);
  const stored = () => String(f.sqlite.prepare('SELECT ciphertext FROM git_credentials WHERE id = ?').get(account.id)!.ciphertext);
  const first = stored();
  assert.ok(!first.includes(giteaToken(alice)));
  const listed = await json<{ accounts: GitAccount[] }>(await alice.request('GET', '/api/git/accounts'));
  assert.deepEqual(listed.accounts, [{ id: 'github', provider: 'github', host: 'github.com', organization: '', login: '', createdAt: null }, account]);
  const again = await connectGitea(alice, { token: 'rotated-gitea-token' });
  assert.equal(again.id, account.id);
  assert.notEqual(stored(), first);
  assert.deepEqual((await json<{ accounts: GitAccount[] }>(await bob.request('GET', '/api/git/accounts'))).accounts.map(item => item.id), ['github']);
  await denied(await bob.request('GET', `/api/git/accounts/${account.id}/repositories`), 404, 'not_found');
  await denied(await bob.request('DELETE', `/api/git/accounts/${account.id}`), 404, 'not_found');
  remote.state.picker = async () => Response.json([{ ...giteaMetadata, clone_url: 'https://user:secret@git.acme.dev/acme/tools.git', permissions: { admin: true } }]);
  const page = await json(await alice.request('GET', `/api/git/accounts/${account.id}/repositories`));
  assert.deepEqual(page, { repositories: [{ id: '42', fullName: 'acme/tools', defaultBranch: 'main', private: true } satisfies ProviderRepository], truncated: false });
  assert.equal(remote.calls.at(-1)!.authorization, 'token rotated-gitea-token');
  await denied(await alice.request('DELETE', '/api/git/accounts/github'), 400, 'github_account_fixed');
  await denied(await alice.request('DELETE', `/api/git/accounts/${account.id}`, undefined, { 'X-CSRF-Token': '' }), 403, 'invalid_csrf');
  assert.equal((await alice.request('DELETE', `/api/git/accounts/${account.id}`)).status, 204);
  await denied(await alice.request('GET', `/api/git/accounts/${account.id}/repositories`), 404, 'not_found');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM git_credentials').get()!.n, 0);
  const audit = f.sqlite.prepare("SELECT action, detail_json FROM audit WHERE action LIKE 'git.account.%' ORDER BY created_at, action").all();
  assert.deepEqual(audit.map(row => row.action).sort(), ['git.account.connected', 'git.account.connected', 'git.account.removed']);
  for (const secret of [giteaToken(alice), 'rotated-gitea-token']) assert.ok(!JSON.stringify(audit).includes(secret));
});

test('account input is validated before any provider request and rejected tokens are not stored', async t => {
  const f = await fixture(t); const remote = gitea(t); const alice = await f.client('alice');
  const token = 'valid-token';
  for (const [input, code] of [
    [{ provider: 'github', token }, 'invalid_git_provider'],
    [{ provider: 'svn', host: giteaHost, token }, 'invalid_git_provider'],
    [{ provider: 'gitea', token }, 'invalid_git_host'],
    ...['10.0.0.1', 'localhost', 'git.internal', 'http://git.acme.dev', 'git.acme.dev/path', 'github.com', 'user@git.acme.dev']
      .map(host => [{ provider: 'gitea', host, token }, 'invalid_git_host'] as const),
    [{ provider: 'bitbucket', host: 'bitbucket.example.com', token }, 'invalid_git_host'],
    [{ provider: 'azure-devops', token }, 'invalid_git_organization'],
    [{ provider: 'azure-devops', organization: '../x', token }, 'invalid_git_organization'],
    [{ provider: 'gitea', host: giteaHost, organization: 'acme', token }, 'invalid_git_organization'],
    [{ provider: 'gitlab', username: 'me', token }, 'invalid_git_username'],
    [{ provider: 'bitbucket', username: 'me:you', token }, 'invalid_git_username'],
    [{ provider: 'gitea', host: giteaHost, token: '' }, 'invalid_git_token'],
    [{ provider: 'gitea', host: giteaHost, token: 'two words' }, 'invalid_git_token'],
    [{ provider: 'gitea', host: giteaHost, token: 'x'.repeat(4097) }, 'invalid_git_token'],
    [{ provider: 'gitea', host: giteaHost, token, password: 'x' }, 'invalid_git_account'],
  ] as const) {
    await denied(await alice.request('POST', '/api/git/accounts', input), 400, code);
  }
  assert.equal(remote.calls.length, 0);
  remote.state.user = async () => Response.json({ message: 'token is invalid' }, { status: 401 });
  const rejected = await alice.request('POST', '/api/git/accounts', { provider: 'gitea', host: giteaHost, token });
  const body = await json<{ code: string; error: string }>(rejected, 400);
  assert.equal(body.code, 'git_account_rejected');
  assert.ok(!body.error.includes('token is invalid'), 'Provider error text never reaches clients');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM git_credentials').get()!.n, 0);
});

test('token-provider bindings use each actor\'s own account, and sessions borrow none', async t => {
  const s = await providerSetup(t);
  assert.deepEqual({ ...s.repository, id: '', createdAt: '' }, { id: '', workspaceId: s.team.id, provider: 'gitea', host: giteaHost,
    repositoryId: '42', fullName: 'acme/tools', ref: 'main', private: true, createdAt: '', forbidDefaultBranchPush: false });
  assert.deepEqual((await json<{ repositories: WorkspaceRepository[] }>(await s.owner.request('GET', `/api/workspaces/${s.team.id}/repositories`))).repositories, [s.repository]);
  const session = await s.start();
  assert.deepEqual(session.repositories, []);
  assert.deepEqual(s.remote.calls.map(call => call.url), [], 'a clone session reads the repository only through the relay');
  assert.equal(s.provisions.length, 1);
  for (const secret of [giteaToken(s.owner), giteaToken(s.admin), s.owner.githubToken]) {
    assert.ok(!JSON.stringify(s.provisions).includes(secret));
    assert.ok(!JSON.stringify(session).includes(secret));
  }
  // The same repository cannot be bound twice, even by a differently cased name.
  await denied(await s.admin.request('POST', `/api/workspaces/${s.team.id}/repositories`, { ...giteaInput, fullName: 'Acme/Tools' }), 409, 'repository_identity_changed');
  await denied(await s.admin.request('POST', `/api/workspaces/${s.team.id}/repositories`, giteaInput), 409, 'repository_binding_conflict');
});

test('binding without a token account fails with git_account_required; GitHub sign-in never lends other providers', async t => {
  const s = await providerSetup(t);
  s.f.sqlite.prepare('DELETE FROM git_credentials WHERE user_id = ?').run(s.admin.user.id);
  await denied(await s.admin.request('POST', `/api/workspaces/${s.team.id}/repositories`, { ...giteaInput, repositoryId: '43', fullName: 'acme/other' }), 409, 'git_account_required');
  assert.equal(s.remote.calls.length, 0);
});

test('agents with git_push need a connector that claims gitPush, checked again inside the session insert', async t => {
  const s = await providerSetup(t);
  const { models } = await json<{ models: ModelDefinition[] }>(await s.owner.request('GET', `/api/workspaces/${s.team.id}/models`));
  const { agent: draft } = await json<{ agent: AgentVersion }>(await s.host.request('POST', '/api/agents', {
    name: 'Pushing agent', description: '', instructions: '', tools: ['identity', 'git_push'], modelId: models[0].id,
  }), 201);
  const { agent } = await json<{ agent: AgentVersion }>(await s.host.request('POST', `/api/agents/${draft.agentId}/publish`, { workspaceId: s.team.id }), 201);
  const input = { ...s.input, agentVersionId: agent.id };
  const body = await json<{ code: string; error: string }>(await s.owner.request('POST', '/api/sessions', input), 409);
  assert.deepEqual(body, { code: 'connector_update_required', error: 'Update the host\'s connector (npx pistead@latest connect) to use git_push.' });
  assert.equal(s.f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
  assert.equal(s.provisions.length, 0);
  assert.equal(s.remote.calls.length, 0);

  s.f.sqlite.prepare("UPDATE connectors SET capabilities_json = json_set(capabilities_json, '$.gitPush', json('true')) WHERE id = ?").run(s.connector.connectorId);
  beforeStatement(t, s.f, /^INSERT INTO sessions\b/, () => {
    s.f.sqlite.prepare("UPDATE connectors SET capabilities_json = json_remove(capabilities_json, '$.gitPush') WHERE id = ?").run(s.connector.connectorId);
  });
  await denied(await s.owner.request('POST', '/api/sessions', input), 409, 'session_configuration_changed');
  assert.equal(s.f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
  // Agents without git_push are unaffected by the missing capability.
  assert.equal((await s.start()).status, 'ready');
});

test('token-provider binding rechecks the acting account in its final write', async t => {
  const f = await fixture(t); const remote = gitea(t); const admin = await f.client('admin'); const team = await workspace(admin);
  await connectGitea(admin);
  const rotated = await encryptToken(f.env, admin.user.id, 'rotated-gitea-token');
  beforeStatement(t, f, /^INSERT INTO workspace_repositories\b/, () => {
    f.sqlite.prepare('UPDATE git_credentials SET ciphertext = ? WHERE user_id = ?').run(rotated, admin.user.id);
  });
  await denied(await admin.request('POST', `/api/workspaces/${team.id}/repositories`, giteaInput), 409, 'repository_binding_conflict');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_repositories').get()!.n, 0);
  assert.equal(remote.calls.length, 2);
});

test('connector manifests may advertise the repository cache, as a boolean only', () => {
  const capabilities = { platform: 'linux', sandbox: true, productionShell: false };
  assert.equal(parseManifest({ models: [], capabilities: { ...capabilities, repositoryCache: true } }, {} as Env).capabilities.repositoryCache, true);
  assert.ok(!('repositoryCache' in parseManifest({ models: [], capabilities: { ...capabilities, repositoryCache: false } }, {} as Env).capabilities));
  assert.throws(() => parseManifest({ models: [], capabilities: { ...capabilities, repositoryCache: 'yes' } }, {} as Env), HTTPException);
});

test('workspace network policies: members read, administrators write, invalid domains are refused', async t => {
  const f = await fixture(t); github(t);
  const owner = await f.client('owner'); const reader = await f.client('reader');
  const team = await workspace(owner); await member(owner, team.id, reader);
  const path = `/api/workspaces/${team.id}/network-policy`;
  const initial = await json<{ policy: { mode: string; domains: string[]; packageRegistries: boolean }; packageRegistryDomains: string[] }>(await reader.request('GET', path));
  assert.deepEqual(initial.policy, { mode: 'off', domains: [], packageRegistries: true });
  assert.ok(initial.packageRegistryDomains.includes('registry.npmjs.org'));
  const allowlist = { mode: 'allowlist', domains: ['docs.example.com', '*.cdn.example.net'], packageRegistries: false };
  await denied(await reader.request('PUT', path, allowlist), 403, 'forbidden');
  await denied(await owner.request('PUT', path, { ...allowlist, domains: ['169.254.169.254'] }), 400, 'invalid_network_policy');
  await denied(await owner.request('PUT', path, { ...allowlist, mode: 'everything' }), 400, 'invalid_network_policy');
  assert.deepEqual((await json<{ policy: unknown }>(await owner.request('PUT', path, allowlist))).policy, allowlist);
  assert.deepEqual((await json<{ policy: unknown }>(await reader.request('GET', path))).policy, allowlist);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'workspace.network_policy.updated'").get()!.n, 1);
  const outsider = await f.client('outsider');
  await denied(await outsider.request('GET', path), 404, 'not_found');
});

test('egress grants and the Git relay serve only the connector running the session, with the owner credential', async t => {
  const { f, remote, owner, repository, connector, start } = await connectedSetup(t);
  const session = await start();
  const headers = { Authorization: `Bearer ${connector.token}`, 'X-Connection-Token': connector.connectionToken };
  const grant = await json<{ policy: { mode: string }; repositories: { bindingId: string; fullName: string }[] }>(
    await f.request('POST', '/api/connectors/self/network', { sessionId: session.id }, headers));
  assert.equal(grant.policy.mode, 'off');
  assert.deepEqual(grant.repositories.map(item => [item.bindingId, item.fullName]), [[repository.id, metadata.full_name]]);
  await denied(await f.request('POST', '/api/internal/network', { sessionId: session.id }, { Authorization: `Bearer ${internalSecret}` }), 403, 'connector_scope_required');

  const relay = (service: string, init: { body?: string; headers?: Record<string, string> } = {}, sessionId = session.id, bindingId = repository.id) =>
    app.request(`${origin}/api/connectors/self/git/relay/${bindingId}/${service}?sessionId=${sessionId}`, {
      method: 'POST', headers: { ...headers, ...init.headers }, body: init.body ?? '' }, f.env);
  const seen: { url: string; authorization: string | null; protocol: string | null; body: string }[] = [];
  remote.state.git = async (url, init) => {
    const request = new Headers(init?.headers);
    seen.push({ url, authorization: request.get('authorization'), protocol: request.get('git-protocol'),
      body: init?.body ? Buffer.from(init.body as Uint8Array).toString() : '' });
    return url.endsWith('/info/refs?service=git-upload-pack')
      ? new Response('# service=git-upload-pack', { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } })
      : new Response('PACK', { headers: { 'Content-Type': 'application/x-git-upload-pack-result' } });
  };
  const verified = () => remote.calls.filter(call => call.url === `https://api.github.com/repos/${metadata.full_name}`).length;
  const before = verified();
  const refs = await relay('info-refs', { headers: { 'Git-Protocol': 'version=2', 'User-Agent': 'git/2.43.0' } });
  assert.equal(refs.status, 200);
  assert.equal(refs.headers.get('content-type'), 'application/x-git-upload-pack-advertisement');
  assert.equal(await refs.text(), '# service=git-upload-pack');
  const pack = await relay('upload-pack', { body: '0000', headers: { 'Content-Type': 'application/x-git-upload-pack-request' } });
  assert.equal(await pack.text(), 'PACK');
  const basic = `Basic ${Buffer.from(`x-access-token:${owner.githubToken}`).toString('base64')}`;
  assert.deepEqual(seen.map(call => [call.url, call.authorization, call.body]), [
    [`https://github.com/${metadata.full_name}.git/info/refs?service=git-upload-pack`, basic, ''],
    [`https://github.com/${metadata.full_name}.git/git-upload-pack`, basic, '0000'],
  ]);
  assert.equal(seen[0]!.protocol, 'version=2');
  // Every relayed request re-verifies the bound repository's identity, the fetch as much as the advertisement.
  assert.equal(verified() - before, 2);
  // Only Git's own services are relayed, and only for this connector's sessions and this workspace's repositories.
  assert.equal((await relay('send-pack')).status, 404);
  await denied(await relay('upload-pack', { body: '0000', headers: { 'Content-Type': 'text/plain' } }), 415, 'unsupported_media_type');
  await denied(await relay('info-refs', {}, session.id, 'missing-binding'), 404, 'repository_not_bound');
  await denied(await app.request(`${origin}/api/connectors/self/git/relay/${repository.id}/info-refs?sessionId=${session.id}`, {
    method: 'POST', headers: { Authorization: `Bearer ${connector.token}`, 'X-Connection-Token': token() } }, f.env), 401, 'stale_connection');
  await denied(await app.request(`${origin}/api/internal/git/relay/${repository.id}/info-refs?sessionId=${session.id}`, {
    method: 'POST', headers: { Authorization: `Bearer ${internalSecret}` } }, f.env), 403, 'connector_scope_required');
  // GitHub refusing the owner's account comes back as a fixed reason.
  remote.state.git = async () => new Response('denied', { status: 403 });
  await denied(await relay('info-refs'), 403, 'repository_unavailable');
  // An archived session has no relay.
  f.sqlite.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run(session.id);
  await denied(await relay('info-refs'), 403, 'repository_authority_changed');
  await denied(await f.request('POST', '/api/connectors/self/network', { sessionId: session.id }, headers), 403, 'session_archived');
});

test('every session clones: older connectors are refused, and a session whose agent can\'t run shell commands is told why', async t => {
  const f = await fixture(t); const remote = github(t);
  const admin = await f.client('admin'); const member_ = await f.client('member');
  const team = await workspace(admin);
  await member(admin, team.id, member_);
  await bindRepository(admin, team.id);
  provisionHub(f);
  const host = async (capabilities: Record<string, unknown>, shared: boolean) => {
    const connector = await connect(f, admin, team.id, { models: manifest.models, capabilities: { ...manifest.capabilities, ...capabilities } });
    if (shared) await json(await admin.request('PUT', `/api/connectors/${connector.connectorId}/shares/${team.id}`));
    return connector;
  };
  const start = async (actor: Client, connector: { connectorId: string }) => {
    const { models } = await json<{ models: ModelDefinition[] }>(await actor.request('GET', `/api/workspaces/${team.id}/models`));
    const model = models.find(item => item.connectorId === connector.connectorId)!;
    remote.calls.length = 0;
    return actor.request('POST', '/api/sessions', {
      workspaceId: team.id, modelId: model.id, title: 'Clone', ...(actor !== admin ? { trustedConnectorId: connector.connectorId } : {}),
    });
  };
  // The host's owner can always run their own shell commands.
  const { session: own } = await json<{ session: SessionRecord }>(await start(admin, await host({}, false)), 201);
  assert.equal(own.repositoryMode, 'clone');
  assert.deepEqual(own.repositories, []);
  assert.equal(own.cloneUnavailable, undefined);
  assert.deepEqual(remote.calls, [], 'nothing is resolved with the owner\'s account at creation');
  // Another member's session needs the host's resource limits to run shell commands; without them it starts empty, and says so.
  const unlimited = await host({}, true);
  const { session: empty } = await json<{ session: SessionRecord }>(await start(member_, unlimited), 201);
  assert.equal(empty.repositoryMode, 'clone');
  assert.match(empty.cloneUnavailable ?? '', /runs shell commands only for its owner/);
  assert.match((await json<{ session: SessionRecord }>(await member_.request('GET', `/api/sessions/${empty.id}`))).session.cloneUnavailable ?? '', /only for its owner/);
  const { session: limited } = await json<{ session: SessionRecord }>(await start(member_, await host({ productionShell: true }, true)), 201);
  assert.equal(limited.cloneUnavailable, undefined);
  // A connector from before sessions cloned can't run one.
  await denied(await start(admin, await host({ plainGit: undefined }, false)), 409, 'connector_update_required');
  // An agent without bash starts empty too.
  const { models } = await json<{ models: ModelDefinition[] }>(await admin.request('GET', `/api/workspaces/${team.id}/models`));
  const model = models.find(item => item.connectorId === unlimited.connectorId)!;
  const { agent } = await json<{ agent: AgentVersion }>(await admin.request('POST', '/api/agents', {
    name: 'Files only', description: '', instructions: '', tools: ['read_file'], modelId: model.id,
  }), 201);
  const { session: filesOnly } = await json<{ session: SessionRecord }>(await admin.request('POST', '/api/sessions', { workspaceId: team.id, agentVersionId: agent.id, title: 'Files' }), 201);
  assert.equal(filesOnly.repositoryMode, 'clone');
  assert.match(filesOnly.cloneUnavailable ?? '', /doesn't have the bash tool/);
  assert.throws(() => f.sqlite.prepare("UPDATE sessions SET repository_mode = NULL WHERE id = ?").run(own.id), /immutable/);
});

test('a session that pinned its repositories is read-only: it shows, and nothing runs or is approved in it', async t => {
  const s = await connectedSetup(t); const source = await s.start();
  // Sessions no longer pin, so a pinned one is written as it was before.
  const columns = (s.f.sqlite.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(column => column.name);
  const pins: SessionRepository[] = [{ bindingId: s.repository.id, repositoryId: metadata.id, fullName: metadata.full_name, ref: 'main', commit: commitA, path: metadata.full_name }];
  s.f.sqlite.prepare(`INSERT INTO sessions (${columns.join(',')}) SELECT ${columns.map(column =>
    column === 'id' || column === 'repositories_json' ? '?' : column === 'repository_mode' ? 'NULL' : column).join(',')} FROM sessions WHERE id = ?`)
    .run(...columns.filter(column => column === 'id' || column === 'repositories_json').map(column => column === 'id' ? 'pinned-session' : JSON.stringify(pins)), source.id);
  const { session } = await json<{ session: SessionRecord }>(await s.owner.request('GET', '/api/sessions/pinned-session'));
  assert.equal(session.frozen, true);
  assert.deepEqual(session.repositories, pins);
  assert.equal(source.frozen, undefined);
  const provisions = s.provisions.length;
  await denied(await s.owner.request('POST', '/api/sessions/pinned-session/submit', { content: 'hello', requestId: 'frozen' }), 409, 'session_frozen');
  await denied(await s.owner.request('POST', '/api/sessions/pinned-session/approvals/approval', { decision: 'approve' }), 409, 'session_frozen');
  assert.equal(s.f.sqlite.prepare("SELECT COUNT(*) AS n FROM run_admissions WHERE session_id = 'pinned-session'").get()!.n, 0);
  assert.equal(s.provisions.length, provisions);
});
