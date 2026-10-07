import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { encryptToken } from '../apps/server/src/vault.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import { testDatabase } from './helpers/control-plane.js';

const internalSecret = 'push-broker-internal-secret-not-for-deployment';
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const owner = 'github:7'; const approver = 'github:8'; const viewer = 'github:9';
const sessionCommit = 'a'.repeat(40); const pinnedCommit = 'b'.repeat(40); const tip = 'c'.repeat(40);
const githubPin = { bindingId: 'binding-gh', commit: pinnedCommit, fullName: 'owner/repo', path: 'owner/repo', ref: 'main', repositoryId: 101 };
const bitbucketPin = { bindingId: 'binding-bb', commit: pinnedCommit, fullName: 'team/repo', host: 'bitbucket.org', path: 'bitbucket.org/team/repo',
  provider: 'bitbucket', ref: 'main', repositoryId: '{11111111-2222-3333-4444-555555555555}' };
const gitlabPin = { bindingId: 'binding-gl', commit: pinnedCommit, fullName: 'group/project', host: 'gitlab.com', path: 'gitlab.com/group/project',
  provider: 'gitlab', ref: 'main', repositoryId: '301' };
const giteaPin = { bindingId: 'binding-gt', commit: pinnedCommit, fullName: 'acme/tools', host: 'git.acme.dev', path: 'git.acme.dev/acme/tools',
  provider: 'gitea', ref: 'main', repositoryId: '42' };
const azureRepositoryId = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
const azureProjectId = '11111111-2222-4333-8444-555555555555';
const azurePin = { bindingId: 'binding-az', commit: pinnedCommit, fullName: 'contoso/Project/repo', host: 'dev.azure.com',
  path: 'dev.azure.com/contoso/Project/repo', provider: 'azure-devops', ref: 'main', repositoryId: azureRepositoryId };

type Route = (url: URL, init: RequestInit) => Response | undefined;
interface Call { method: string; url: string; authorization: string | null; redirect?: RequestRedirect; body?: unknown }

async function fixture(t: test.TestContext, options: { canPush?: boolean; bitbucketWrite?: boolean } = {}) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: 'http://localhost:8787', TEST_AUTH_ENABLED: 'true',
    TEST_AUTH_SECRET: 'push-broker-test-secret-not-for-deployment', TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    RUNNER_SHARED_SECRET: internalSecret, VAULT_KEY: Buffer.alloc(32, 7).toString('base64url'),
    GITHUB_APP_ID: '4242', GITHUB_APP_SLUG: 'pistead-test', GITHUB_APP_PRIVATE_KEY: privateKey } as Env;
  const createdAt = new Date().toISOString();
  for (const [userId, index] of [[owner, 7], [approver, 8], [viewer, 9]] as const) {
    sqlite.prepare('INSERT INTO users (id,github_id,github_login,display_name,git_name,git_email,auth_kind,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(userId, String(index), `user${index}`, `User ${index}`, `User ${index}`, `user${index}@example.test`, 'github', createdAt);
  }
  sqlite.prepare('INSERT INTO workspaces (id,name,owner_id,created_at) VALUES (?,?,?,?)').run('workspace', 'Workspace', owner, createdAt);
  for (const [userId, role] of [[owner, 'owner'], [approver, 'member'], [viewer, 'member']]) {
    sqlite.prepare('INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES (?,?,?,?)').run('workspace', userId, role, createdAt);
  }
  sqlite.prepare('INSERT INTO models (id,workspace_id,name,provider,model_id,created_at) VALUES (?,?,?,?,?,?)').run('model', 'workspace', 'model', 'faux', 'faux-1', createdAt);
  sqlite.prepare('INSERT INTO agents (id,author_id,created_at) VALUES (?,?,?)').run('agent', owner, createdAt);
  sqlite.prepare('INSERT INTO agent_versions (id,agent_id,author_id,version,name,description,instructions,tools_json,model_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('version', 'agent', owner, 1, 'agent', '', '', '["git_push"]', 'model', createdAt);
  for (const [bindingId, provider, host, repositoryId, fullName] of [
    ['binding-gh', 'github', 'github.com', '101', 'owner/repo'], ['binding-bb', 'bitbucket', 'bitbucket.org', bitbucketPin.repositoryId, 'team/repo'],
    ['binding-gl', 'gitlab', 'gitlab.com', '301', 'group/project'], ['binding-gt', 'gitea', 'git.acme.dev', '42', 'acme/tools'],
    ['binding-az', 'azure-devops', 'dev.azure.com', azureRepositoryId, 'contoso/Project/repo'],
  ]) {
    sqlite.prepare('INSERT INTO workspace_repositories (id,workspace_id,provider,host,repository_id,full_name,ref,private,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(bindingId, 'workspace', provider, host, repositoryId, fullName, 'main', 1, createdAt);
  }
  sqlite.prepare('INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at,repositories_json) VALUES (?,?,?,?,?,?,?,?)')
    .run('session', 'workspace', owner, 'version', 'session', 'ready', createdAt, JSON.stringify([githubPin, bitbucketPin, gitlabPin, giteaPin, azurePin]));
  // The approver may approve but not write; the viewer may only read.
  sqlite.prepare('INSERT INTO session_grants (session_id,user_id,permissions_json,created_at) VALUES (?,?,?,?)').run('session', approver, '["read","approve"]', createdAt);
  sqlite.prepare('INSERT INTO session_grants (session_id,user_id,permissions_json,created_at) VALUES (?,?,?,?)').run('session', viewer, '["read"]', createdAt);
  sqlite.prepare('INSERT INTO github_tokens (user_id,ciphertext,updated_at) VALUES (?,?,?)').run(owner, await encryptToken(env, owner, 'owner-oauth-token'), createdAt);
  sqlite.prepare(`INSERT INTO git_credentials (id,user_id,provider,host,organization,username,login,ciphertext,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('credential-bb', owner, 'bitbucket', 'bitbucket.org', '', 'owner@example.test', 'owner', await encryptToken(env, owner, 'owner-bitbucket-token'), createdAt, createdAt);
  for (const [credentialId, provider, host, organization] of [
    ['credential-gl', 'gitlab', 'gitlab.com', ''], ['credential-gt', 'gitea', 'git.acme.dev', ''], ['credential-az', 'azure-devops', 'dev.azure.com', 'contoso'],
  ]) {
    sqlite.prepare(`INSERT INTO git_credentials (id,user_id,provider,host,organization,username,login,ciphertext,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(credentialId!, owner, provider!, host!, organization!, null, 'owner', await encryptToken(env, owner, `owner-${provider}-token`), createdAt, createdAt);
  }
  sqlite.prepare(`INSERT INTO push_identities (id,workspace_id,provider,host,scope,kind,config_json,secret_ciphertext,status,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('identity-bb', 'workspace', 'bitbucket', 'bitbucket.org', 'team', 'bitbucket-client-credentials',
    JSON.stringify({ key: 'consumer-key' }), await encryptToken(env, 'push-identity:identity-bb', 'consumer-secret'), 'ready', owner, createdAt, createdAt);

  const calls: Call[] = [];
  const state = { canPush: options.canPush ?? true, bitbucketWrite: options.bitbucketWrite ?? true, githubTip: tip, githubPullExists: false, bitbucketPullExists: false,
    githubBranch: null as Record<string, unknown> | null, gitlabBranch: null as Record<string, unknown> | null,
    giteaBranch: null as Record<string, unknown> | null, azureAllow: true };
  const routes: Route[] = [
    (url, init) => {
      if (url.origin !== 'https://api.github.com') return undefined;
      const method = init.method ?? 'GET';
      if (method === 'GET' && url.pathname.startsWith('/repos/owner/repo/branches/')) {
        return state.githubBranch ? Response.json(state.githubBranch) : Response.json({ message: 'Branch not found' }, { status: 404 });
      }
      if (method === 'GET' && url.pathname === '/repos/owner/repo') {
        return Response.json({ id: 101, full_name: 'owner/repo', default_branch: 'main', private: true, permissions: { push: state.canPush } });
      }
      if (method === 'GET' && url.pathname === '/repos/owner/repo/installation') return Response.json({ id: 55 });
      if (method === 'POST' && url.pathname === '/app/installations/55/access_tokens') {
        return Response.json({ token: 'ghs_installation_token', expires_at: new Date(Date.now() + 3600000).toISOString() }, { status: 201 });
      }
      if (method === 'DELETE' && url.pathname === '/installation/token') return new Response(null, { status: 204 });
      if (method === 'GET' && url.pathname.startsWith('/repos/owner/repo/commits/')) return Response.json({ sha: state.githubTip });
      if (method === 'POST' && url.pathname === '/repos/owner/repo/pulls') {
        return state.githubPullExists ? Response.json({ message: 'exists' }, { status: 422 })
          : Response.json({ number: 5, html_url: 'https://github.com/owner/repo/pull/5' }, { status: 201 });
      }
      if (method === 'GET' && url.pathname === '/repos/owner/repo/pulls') return Response.json([{ number: 4, html_url: 'https://github.com/owner/repo/pull/4' }]);
      return undefined;
    },
    (url, init) => {
      const method = init.method ?? 'GET';
      if (url.href === 'https://bitbucket.org/site/oauth2/access_token' && method === 'POST') return Response.json({ access_token: 'bitbucket-bot-token', expires_in: 3600 });
      if (url.origin !== 'https://api.bitbucket.org') return undefined;
      if (method === 'GET' && url.pathname === '/2.0/repositories/team/repo') {
        return Response.json({ uuid: bitbucketPin.repositoryId, full_name: 'team/repo', mainbranch: { name: 'main' }, is_private: true });
      }
      if (method === 'GET' && url.pathname === '/2.0/user/permissions/repositories') return Response.json({ values: [{ permission: state.bitbucketWrite ? 'write' : 'read' }] });
      if (method === 'GET' && url.pathname.startsWith('/2.0/repositories/team/repo/commit/')) return Response.json({ hash: tip });
      if (method === 'POST' && url.pathname === '/2.0/repositories/team/repo/pullrequests') {
        return state.bitbucketPullExists ? Response.json({ error: { message: 'exists' } }, { status: 400 })
          : Response.json({ id: 7, links: { html: { href: 'https://bitbucket.org/team/repo/pull-requests/7' } } }, { status: 201 });
      }
      if (method === 'GET' && url.pathname === '/2.0/repositories/team/repo/pullrequests') {
        return Response.json({ values: [{ id: 6, links: { html: { href: 'https://bitbucket.org/team/repo/pull-requests/6' } } }] });
      }
      return undefined;
    },
    (url, init) => {
      if ((init.method ?? 'GET') !== 'GET') return undefined;
      const branch = (value: Record<string, unknown> | null) => value ? Response.json(value) : Response.json({ message: 'not found' }, { status: 404 });
      if (url.href === 'https://gitlab.com/api/v4/projects/301') {
        return Response.json({ id: 301, path_with_namespace: 'group/project', default_branch: 'main', visibility: 'private',
          permissions: { project_access: { access_level: 40 }, group_access: null } });
      }
      if (url.origin === 'https://gitlab.com' && url.pathname.startsWith('/api/v4/projects/301/repository/branches/')) return branch(state.gitlabBranch);
      if (url.href === 'https://git.acme.dev/api/v1/repositories/42') {
        return Response.json({ id: 42, full_name: 'acme/tools', default_branch: 'main', private: true, permissions: { push: true } });
      }
      if (url.origin === 'https://git.acme.dev' && url.pathname.startsWith('/api/v1/repos/acme/tools/branches/')) return branch(state.giteaBranch);
      if (url.origin === 'https://dev.azure.com' && url.pathname === `/contoso/_apis/git/repositories/${azureRepositoryId}`) {
        return Response.json({ id: azureRepositoryId, name: 'repo', defaultBranch: 'refs/heads/main', project: { id: azureProjectId, name: 'Project', visibility: 'private' } });
      }
      if (url.origin === 'https://dev.azure.com' && url.pathname === '/contoso/_apis/permissions/2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87/4') {
        return Response.json({ count: 1, value: [state.azureAllow] });
      }
      return undefined;
    },
  ];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    let body: unknown;
    try { body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    calls.push({ method: init.method ?? 'GET', url: url.href, authorization: new Headers(init.headers).get('authorization'), redirect: init.redirect, body });
    for (const route of routes) { const response = route(url, init); if (response) return response; }
    return new Response('unexpected', { status: 500 });
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  const post = (path: string, body: unknown) => app.request(path, {
    method: 'POST', headers: { Authorization: `Bearer ${internalSecret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, env);
  const operation = (extra: Record<string, unknown> = {}, repository = githubPin.path) =>
    ({ kind: 'git.push', repository, branch: 'feature', commit: sessionCommit, ...extra });
  /** A human-approved request: the review row plus the capability minted at approval time. */
  async function approve(approvalId: string, op: Record<string, unknown>, actor = owner, requestedBy = owner): Promise<string> {
    const capability = `capability-${approvalId}`;
    sqlite.prepare(`INSERT INTO approval_reviews (session_id,approval_id,requested_by,operation_json,source,admission_id,review_hash,created_at)
      VALUES (?,?,?,?, 'explicit', NULL,?,?)`).run('session', approvalId, requestedBy, JSON.stringify(op),
      await sha256(JSON.stringify({ sessionId: 'session', approvalId, requestedBy, operation: op })), createdAt);
    sqlite.prepare('INSERT INTO broker_capabilities (token_hash,session_id,approval_id,actor_id,requested_by,operation_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(await sha256(capability), 'session', approvalId, actor, requestedBy, await sha256(JSON.stringify(op)), Math.floor(Date.now() / 1000) + 60, createdAt);
    return capability;
  }
  let admissions = 0;
  function admit(access: string | null, actor = owner): string {
    const admissionId = `admission-${String(++admissions).padStart(4, '0')}`.padEnd(43, 'x');
    sqlite.prepare('INSERT INTO run_admissions (id,session_id,actor_id,mode,request_id,content_hash,expires_at,created_at,access) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(admissionId, 'session', actor, 'write', `request-${admissions}`, 'h'.repeat(43), Math.floor(Date.now() / 1000) + 600, createdAt, access);
    return admissionId;
  }
  const ledger = () => sqlite.prepare('SELECT * FROM push_credentials ORDER BY created_at').all() as Record<string, unknown>[];
  const audits = (action: string) => sqlite.prepare('SELECT * FROM audit WHERE action = ?').all(action);
  return { sqlite, env, calls, state, post, operation, approve, admit, ledger, audits };
}

const credential = '/api/internal/git/push/credential';
const complete = '/api/internal/git/push/complete';
async function code(response: Response): Promise<string> { return (await response.json() as { code: string }).code; }

test('explicit pushes need a matching capability, consume it once, and mint a GitHub App credential', async t => {
  const f = await fixture(t);
  const op = f.operation();
  const capability = await f.approve('approval-1', op);
  const request = { sessionId: 'session', approvalId: 'approval-1', actorId: owner, operation: op, capability };
  assert.equal((await f.post(credential, { ...request, operation: { ...op, branch: 'other' } })).status, 403, 'operation must match the capability');
  assert.equal((await f.post(credential, { ...request, capability: 'forged' })).status, 403);
  assert.equal((await f.post(credential, { ...request, admissionId: f.admit('auto') })).status, 400, 'capability and admission are exclusive');
  const issued = await f.post(credential, request);
  assert.equal(issued.status, 200);
  const result = await issued.json() as { credentialId: string; remote: string; authorization: string; expiresAt: string };
  assert.equal(result.remote, 'https://github.com/owner/repo.git');
  assert.equal(result.authorization, `Basic ${Buffer.from('x-access-token:ghs_installation_token').toString('base64')}`);
  assert.ok(Date.parse(result.expiresAt) > Date.now());
  const owned = f.calls.find(call => call.url === 'https://api.github.com/repos/owner/repo')!;
  assert.equal(owned.authorization, 'Bearer owner-oauth-token', 'write permission is checked with the owner credential');
  assert.ok(f.calls.every(call => call.redirect === 'manual'));
  const minted = f.calls.find(call => call.url.endsWith('/access_tokens'))!;
  assert.deepEqual(minted.body, { repository_ids: [101], permissions: { contents: 'write' } });
  const [row] = f.ledger();
  assert.equal(row!.id, result.credentialId);
  assert.equal(row!.automatic, 0);
  assert.equal(row!.kind, 'github-app');
  assert.equal(row!.identity_id, null);
  assert.equal(row!.binding_id, 'binding-gh');
  assert.equal(row!.operation_json, JSON.stringify(op));
  assert.ok(typeof row!.revocation_ciphertext === 'string' && !String(row!.revocation_ciphertext).includes('ghs_'));
  assert.equal(f.audits('git.push.credential_issued').length, 1);
  const replay = await f.post(credential, request);
  assert.equal(replay.status, 409);
  assert.equal(await code(replay), 'capability_consumed');
  assert.equal(f.calls.filter(call => call.url.endsWith('/access_tokens')).length, 1);
});

test('explicit pushes require an approving approver and a writing requester', async t => {
  const f = await fixture(t);
  const op = f.operation();
  const noApprove = await f.approve('approval-a', op, viewer, owner);
  assert.equal((await f.post(credential, { sessionId: 'session', approvalId: 'approval-a', actorId: viewer, operation: op, capability: noApprove })).status, 403);
  const noWrite = await f.approve('approval-b', op, approver, viewer);
  assert.equal((await f.post(credential, { sessionId: 'session', approvalId: 'approval-b', actorId: approver, operation: op, capability: noWrite })).status, 403);
  assert.equal(f.ledger().length, 0);
  assert.equal(f.calls.length, 0);
});

test('automatic pushes require an unexpired auto-approve admission from the owner', async t => {
  const f = await fixture(t);
  const op = f.operation();
  const approvalAccess = await f.post(credential, { sessionId: 'session', approvalId: 'tool-auto-1', actorId: owner, operation: op, admissionId: f.admit('approval') });
  assert.equal(approvalAccess.status, 403);
  assert.equal((await f.post(credential, { sessionId: 'session', approvalId: 'tool-auto-2', actorId: owner, operation: op, admissionId: f.admit(null) })).status, 403);
  assert.equal((await f.post(credential, { sessionId: 'session', approvalId: 'tool-auto-3', actorId: approver, operation: op, admissionId: f.admit('auto', approver) })).status, 403,
    'non-owners cannot push automatically');
  const admissionId = f.admit('auto');
  const issued = await f.post(credential, { sessionId: 'session', approvalId: 'tool-auto-4', actorId: owner, operation: op, admissionId });
  assert.equal(issued.status, 200);
  assert.equal(f.ledger()[0]!.automatic, 1);
  const duplicate = await f.post(credential, { sessionId: 'session', approvalId: 'tool-auto-4', actorId: owner, operation: op, admissionId });
  assert.equal(duplicate.status, 409);
  assert.equal(await code(duplicate), 'push_attempt_exists');
  assert.equal(f.ledger().length, 1);
});

test('repository path, owner permission and default-branch policy gate minting', async t => {
  const f = await fixture(t, { canPush: false });
  const unknown = await f.post(credential, { sessionId: 'session', approvalId: 'tool-p-1', actorId: owner, operation: f.operation({}, 'owner/other'), admissionId: f.admit('auto') });
  assert.ok([403, 404].includes(unknown.status));
  const denied = await f.post(credential, { sessionId: 'session', approvalId: 'tool-p-2', actorId: owner, operation: f.operation(), admissionId: f.admit('auto') });
  assert.equal(denied.status, 403);
  assert.equal(await code(denied), 'push_permission_required');
  assert.equal(f.ledger().length, 0);
  assert.ok(!f.calls.some(call => call.url.endsWith('/access_tokens')));
  f.state.canPush = true;
  f.sqlite.prepare('INSERT INTO repository_push_policies (binding_id,workspace_id,forbid_default_branch,updated_by,updated_at) VALUES (?,?,?,?,?)')
    .run('binding-gh', 'workspace', 1, owner, new Date().toISOString());
  const main = await f.post(credential, { sessionId: 'session', approvalId: 'tool-p-3', actorId: owner, operation: { ...f.operation(), branch: 'main' }, admissionId: f.admit('auto') });
  assert.equal(main.status, 403);
  assert.equal(await code(main), 'default_branch_push_forbidden');
  const feature = await f.post(credential, { sessionId: 'session', approvalId: 'tool-p-4', actorId: owner, operation: f.operation(), admissionId: f.admit('auto') });
  assert.equal(feature.status, 200);
  assert.equal(f.ledger().length, 1);
});

test('completion revokes the GitHub token, verifies the tip and opens the pull request as the owner', async t => {
  const f = await fixture(t);
  const op = f.operation({ pullRequest: { title: 'Add feature', body: 'Details' } });
  const issued = await (await f.post(credential, { sessionId: 'session', approvalId: 'tool-c-1', actorId: owner, operation: op, admissionId: f.admit('auto') })).json() as { credentialId: string };
  const base = { sessionId: 'session', approvalId: 'tool-c-1', credentialId: issued.credentialId };
  assert.equal((await f.post(complete, { ...base, approvalId: 'other', outcome: 'pushed', tip })).status, 403);
  f.state.githubTip = 'd'.repeat(40);
  const moved = await f.post(complete, { ...base, outcome: 'pushed', tip });
  assert.equal(moved.status, 409);
  assert.equal(await code(moved), 'push_tip_mismatch');
  const revoke = f.calls.filter(call => call.method === 'DELETE');
  assert.equal(revoke.length, 1);
  assert.equal(revoke[0]!.url, 'https://api.github.com/installation/token');
  assert.equal(revoke[0]!.authorization, 'Bearer ghs_installation_token');
  const [row] = f.ledger();
  assert.equal(row!.outcome, 'pushed');
  assert.equal(row!.tip, tip);
  assert.ok(row!.completed_at);
  assert.equal(row!.revocation_ciphertext, null);
  assert.equal((await f.post(complete, { ...base, outcome: 'pushed', tip })).status, 409, 'completion is single-use');

  f.state.githubTip = tip;
  const op2 = f.operation({ pullRequest: { title: 'Add feature', body: 'Details' } });
  const second = await (await f.post(credential, { sessionId: 'session', approvalId: 'tool-c-2', actorId: owner, operation: op2, admissionId: f.admit('auto') })).json() as { credentialId: string };
  const done = await f.post(complete, { sessionId: 'session', approvalId: 'tool-c-2', credentialId: second.credentialId, outcome: 'pushed', tip });
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { pullRequest: { url: 'https://github.com/owner/repo/pull/5', number: 5, created: true } });
  const pull = f.calls.find(call => call.method === 'POST' && call.url === 'https://api.github.com/repos/owner/repo/pulls')!;
  assert.equal(pull.authorization, 'Bearer owner-oauth-token');
  assert.deepEqual(pull.body, { title: 'Add feature', head: 'feature', base: 'main', body: 'Details' });
  assert.equal(f.ledger().find(item => item.id === second.credentialId)!.pull_request_url, 'https://github.com/owner/repo/pull/5');
  assert.equal(f.audits('git.push.pull_request').length, 1);
  assert.equal(f.audits('git.push.completed').length, 2);

  f.state.githubPullExists = true;
  const third = await (await f.post(credential, { sessionId: 'session', approvalId: 'tool-c-3', actorId: owner, operation: op2, admissionId: f.admit('auto') })).json() as { credentialId: string };
  const existing = await f.post(complete, { sessionId: 'session', approvalId: 'tool-c-3', credentialId: third.credentialId, outcome: 'up-to-date', tip });
  assert.deepEqual(await existing.json(), { pullRequest: { url: 'https://github.com/owner/repo/pull/4', number: 4, created: false } });
});

test('token providers mint from the workspace identity and open pull requests with the owner account', async t => {
  const f = await fixture(t);
  const op = f.operation({ pullRequest: { title: 'Bitbucket change', body: 'Body', base: 'develop' } }, bitbucketPin.path);
  const response = await f.post(credential, { sessionId: 'session', approvalId: 'tool-b-1', actorId: owner, operation: op, admissionId: f.admit('auto') });
  assert.equal(response.status, 200);
  const issued = await response.json() as { credentialId: string; remote: string; authorization: string };
  assert.equal(issued.remote, 'https://bitbucket.org/team/repo.git');
  assert.equal(issued.authorization, `Basic ${Buffer.from('x-token-auth:bitbucket-bot-token').toString('base64')}`);
  const token = f.calls.find(call => call.url === 'https://bitbucket.org/site/oauth2/access_token')!;
  assert.equal(token.authorization, `Basic ${Buffer.from('consumer-key:consumer-secret').toString('base64')}`);
  const permission = f.calls.find(call => call.url.startsWith('https://api.bitbucket.org/2.0/user/permissions/repositories'))!;
  assert.equal(permission.authorization, `Basic ${Buffer.from('owner@example.test:owner-bitbucket-token').toString('base64')}`);
  assert.equal(f.ledger()[0]!.kind, 'bitbucket-client-credentials');
  assert.equal(f.ledger()[0]!.identity_id, 'identity-bb');
  assert.equal(f.ledger()[0]!.revocation_ciphertext, null);
  const done = await f.post(complete, { sessionId: 'session', approvalId: 'tool-b-1', credentialId: issued.credentialId, outcome: 'pushed', tip });
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { pullRequest: { url: 'https://bitbucket.org/team/repo/pull-requests/7', number: 7, created: true } });
  const pull = f.calls.find(call => call.method === 'POST' && call.url.endsWith('/pullrequests'))!;
  assert.equal(pull.authorization, permission.authorization);
  assert.deepEqual(pull.body, { title: 'Bitbucket change', description: 'Body', source: { branch: { name: 'feature' } }, destination: { branch: { name: 'develop' } } });
  assert.ok(!f.calls.some(call => call.method === 'DELETE'));

  f.state.bitbucketPullExists = true;
  const again = await (await f.post(credential, { sessionId: 'session', approvalId: 'tool-b-2', actorId: owner, operation: op, admissionId: f.admit('auto') })).json() as { credentialId: string };
  const existing = await f.post(complete, { sessionId: 'session', approvalId: 'tool-b-2', credentialId: again.credentialId, outcome: 'pushed', tip });
  assert.deepEqual(await existing.json(), { pullRequest: { url: 'https://bitbucket.org/team/repo/pull-requests/6', number: 6, created: false } });

  f.state.bitbucketWrite = false;
  const denied = await f.post(credential, { sessionId: 'session', approvalId: 'tool-b-3', actorId: owner, operation: op, admissionId: f.admit('auto') });
  assert.equal(denied.status, 403);
  assert.equal(await code(denied), 'push_permission_required');
});

test('a removed workspace binding blocks minting and pull request opening', async t => {
  const f = await fixture(t);
  const op = f.operation({ pullRequest: { title: 'Add feature', body: 'Details' } });
  const issued = await (await f.post(credential, { sessionId: 'session', approvalId: 'tool-r-1', actorId: owner, operation: op, admissionId: f.admit('auto') })).json() as { credentialId: string };
  f.sqlite.prepare("DELETE FROM workspace_repositories WHERE id = 'binding-gh'").run();
  const removed = await f.post(credential, { sessionId: 'session', approvalId: 'tool-r-2', actorId: owner, operation: op, admissionId: f.admit('auto') });
  assert.equal(removed.status, 403);
  assert.equal(await code(removed), 'repository_binding_removed');
  assert.equal(f.ledger().length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/access_tokens')).length, 1);
  const done = await f.post(complete, { sessionId: 'session', approvalId: 'tool-r-1', credentialId: issued.credentialId, outcome: 'pushed', tip });
  assert.equal(done.status, 403);
  assert.equal(await code(done), 'repository_binding_removed');
  assert.ok(!f.calls.some(call => call.method === 'POST' && call.url.endsWith('/pulls')));
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1, 'the credential is still revoked');
  assert.equal(f.ledger()[0]!.outcome, 'pushed');
  const [failure] = f.audits('git.push.pull_request_failed') as { metadata_json?: string }[];
  assert.ok(failure);
  assert.ok(JSON.stringify(failure).includes('repository_binding_removed'));
  // A binding re-created for a different repository under the same id does not count either.
  f.sqlite.prepare('INSERT INTO workspace_repositories (id,workspace_id,provider,host,repository_id,full_name,ref,private,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('binding-gh', 'workspace', 'github', 'github.com', '999', 'owner/repo', 'main', 1, new Date().toISOString());
  const replaced = await f.post(credential, { sessionId: 'session', approvalId: 'tool-r-3', actorId: owner, operation: op, admissionId: f.admit('auto') });
  assert.equal(await code(replaced), 'repository_binding_removed');
});

test('branch-level owner checks block minting before any ledger row; new branches fall back to the repository check', async t => {
  const f = await fixture(t);
  let next = 0;
  const request = (pin: { path: string }) => f.post(credential, { sessionId: 'session', approvalId: `tool-branch-${++next}`, actorId: owner,
    operation: f.operation({ branch: 'feature/x' }, pin.path), admissionId: f.admit('auto') });
  const deniedBy = async (pin: { path: string }, expected: string) => {
    const response = await request(pin);
    assert.equal(response.status, 403);
    assert.equal(await code(response), expected);
    assert.equal(f.ledger().length, 0);
  };
  const passes = async (pin: { path: string }) => {
    const before = f.ledger().length;
    const response = await request(pin);
    assert.ok(!['push_permission_required', 'protected_branch'].includes((await response.clone().json() as { code?: string }).code ?? ''));
    assert.equal(f.ledger().length, before + 1, 'owner checks passed and the attempt reached the mint');
  };

  f.state.gitlabBranch = { name: 'feature/x', can_push: false };
  await deniedBy(gitlabPin, 'push_permission_required');
  assert.ok(f.calls.some(call => call.url === 'https://gitlab.com/api/v4/projects/301/repository/branches/feature%2Fx'));
  assert.ok(f.calls.filter(call => call.url.startsWith('https://gitlab.com/')).every(call => call.authorization === 'Bearer owner-gitlab-token'));

  f.state.giteaBranch = { name: 'feature/x', user_can_push: false };
  await deniedBy(giteaPin, 'push_permission_required');
  assert.ok(f.calls.some(call => call.url === 'https://git.acme.dev/api/v1/repos/acme/tools/branches/feature/x'));

  f.state.azureAllow = false;
  await deniedBy(azurePin, 'push_permission_required');
  const permission = new URL(f.calls.find(call => call.url.includes('/_apis/permissions/'))!.url);
  assert.equal(permission.searchParams.get('tokens'),
    `repoV2/${azureProjectId}/${azureRepositoryId}/refs/heads/6600650061007400750072006500/7800`);

  f.state.githubBranch = { name: 'feature/x', protected: true };
  await deniedBy(githubPin, 'protected_branch');
  assert.ok(f.calls.some(call => call.url === 'https://api.github.com/repos/owner/repo/branches/feature/x'));
  assert.ok(!f.calls.some(call => call.url.endsWith('/access_tokens')));

  f.state.gitlabBranch = null; f.state.giteaBranch = null; f.state.azureAllow = true; f.state.githubBranch = null;
  await passes(gitlabPin);
  await passes(giteaPin);
  await passes(azurePin);
  await passes(githubPin);
  f.state.githubBranch = { name: 'feature/x', protected: false };
  await passes(githubPin);
  // A new branch still needs repository-level write access.
  f.state.githubBranch = null; f.state.canPush = false;
  const before = f.ledger().length;
  const response = await request(githubPin);
  assert.equal(await code(response), 'push_permission_required');
  assert.equal(f.ledger().length, before);
});

test('automatic credentials need a tool-call approval id and stop at 20 per admission', async t => {
  const f = await fixture(t);
  const op = f.operation();
  const admissionId = f.admit('auto');
  const untagged = await f.post(credential, { sessionId: 'session', approvalId: 'approval-auto', actorId: owner, operation: op, admissionId });
  assert.equal(untagged.status, 400);
  assert.equal(f.ledger().length, 0);
  const createdAt = new Date().toISOString();
  for (let index = 0; index < 19; index++) {
    f.sqlite.prepare(`INSERT INTO push_credentials (id,session_id,approval_id,requested_by,kind,binding_id,operation_json,automatic,admission_id,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(`prior-${index}`, 'session', `tool-prior-${index}`, owner, 'github-app', 'binding-gh', JSON.stringify(op), 1, admissionId, 0, createdAt);
  }
  const twentieth = await f.post(credential, { sessionId: 'session', approvalId: 'tool-limit-20', actorId: owner, operation: op, admissionId });
  assert.equal(twentieth.status, 200);
  const stored = f.sqlite.prepare("SELECT admission_id FROM push_credentials WHERE approval_id = 'tool-limit-20'").get() as { admission_id: string };
  assert.equal(stored.admission_id, admissionId);
  const limited = await f.post(credential, { sessionId: 'session', approvalId: 'tool-limit-21', actorId: owner, operation: op, admissionId });
  assert.equal(limited.status, 429);
  assert.equal(await code(limited), 'automatic_push_limit');
  assert.equal(f.ledger().length, 20);
  assert.equal(f.calls.filter(call => call.url.endsWith('/access_tokens')).length, 1);
  // Another admission has its own allowance; explicit credentials carry none.
  assert.equal((await f.post(credential, { sessionId: 'session', approvalId: 'tool-limit-other', actorId: owner, operation: op, admissionId: f.admit('auto') })).status, 200);
  const capability = await f.approve('approval-explicit', op);
  assert.equal((await f.post(credential, { sessionId: 'session', approvalId: 'approval-explicit', actorId: owner, operation: op, capability })).status, 200);
  assert.equal((f.sqlite.prepare("SELECT admission_id FROM push_credentials WHERE approval_id = 'approval-explicit'").get() as { admission_id: null }).admission_id, null);
});

test('a failing step after minting revokes the GitHub token and closes the ledger row', async t => {
  const f = await fixture(t);
  f.sqlite.exec(`CREATE TRIGGER fail_issue_audit BEFORE INSERT ON audit WHEN NEW.action = 'git.push.credential_issued'
    BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
  const response = await f.post(credential, { sessionId: 'session', approvalId: 'tool-mint-1', actorId: owner, operation: f.operation(), admissionId: f.admit('auto') });
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes('ghs_'));
  const revoke = f.calls.filter(call => call.method === 'DELETE');
  assert.equal(revoke.length, 1);
  assert.equal(revoke[0]!.url, 'https://api.github.com/installation/token');
  assert.equal(revoke[0]!.authorization, 'Bearer ghs_installation_token');
  const [row] = f.ledger();
  assert.equal(row!.outcome, 'failed');
  assert.ok(row!.completed_at);
  assert.equal(row!.revocation_ciphertext, null);
});

test('a completion without connector scope still closes and revokes the credential', async t => {
  const f = await fixture(t);
  const op = f.operation({ pullRequest: { title: 'Add feature', body: 'Details' } });
  const issued = await (await f.post(credential, { sessionId: 'session', approvalId: 'tool-scope-1', actorId: owner, operation: op, admissionId: f.admit('auto') })).json() as { credentialId: string };
  // Simulate a session whose callbacks now require a connector scope this internal caller lacks.
  f.sqlite.exec('PRAGMA foreign_keys = OFF; DROP TRIGGER sessions_connector_immutable');
  f.sqlite.prepare("UPDATE sessions SET connector_id = 'connector-gone' WHERE id = 'session'").run();
  const response = await f.post(complete, { sessionId: 'session', approvalId: 'tool-scope-1', credentialId: issued.credentialId, outcome: 'pushed', tip });
  assert.equal(response.status, 403);
  assert.equal(await code(response), 'connector_scope_required');
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
  const [row] = f.ledger();
  assert.equal(row!.outcome, 'failed');
  assert.equal(row!.tip, null);
  assert.ok(row!.completed_at);
  assert.equal(row!.revocation_ciphertext, null);
  assert.ok(!f.calls.some(call => call.method === 'POST' && call.url.endsWith('/pulls')));
  assert.equal((await f.post(complete, { sessionId: 'session', approvalId: 'tool-scope-1', credentialId: issued.credentialId, outcome: 'pushed', tip })).status, 409);
});

test('an unknown outcome revokes the credential and opens no pull request', async t => {
  const f = await fixture(t);
  const op = f.operation({ pullRequest: { title: 'Add feature', body: 'Details' } });
  const issued = await (await f.post(credential, { sessionId: 'session', approvalId: 'tool-unknown-1', actorId: owner, operation: op, admissionId: f.admit('auto') })).json() as { credentialId: string };
  const response = await f.post(complete, { sessionId: 'session', approvalId: 'tool-unknown-1', credentialId: issued.credentialId, outcome: 'unknown' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
  assert.ok(!f.calls.some(call => call.method === 'POST' && call.url.endsWith('/pulls')));
  const [row] = f.ledger();
  assert.equal(row!.outcome, 'unknown');
  assert.equal(row!.revocation_ciphertext, null);
});
