import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { testDatabase } from './helpers/control-plane.js';
import type { WorkspaceInvite, WorkspaceInviteLink, WorkspaceJoinRequest } from '../packages/shared/src/invites.js';
import type { Workspace } from '../packages/shared/src/types.js';

// Invite links and pending members, end to end through the control plane.
const origin = 'http://localhost:8787';
const testSecret = 'workspace-invites-test-secret-not-for-deployment';

type ApiRequest = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Response | Promise<Response>;
interface Client { user: { id: string }; request: ApiRequest }

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body as T;
}

async function denied(response: Response, status: number, code: string) {
  const body = await json<{ code: string }>(response, status);
  assert.equal(body.code, code);
}

async function fixture(t: TestContext): Promise<{ sqlite: DatabaseSync; client(name: string): Promise<Client> }> {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true',
    TEST_AUTH_SECRET: testSecret, TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    VAULT_KEY: Buffer.alloc(32, 7).toString('base64url') };
  function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return app.request(path, { method, headers: { Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) }, env);
  }
  async function client(name: string): Promise<Client> {
    const response = await request('POST', '/api/auth/test', { id: name, displayName: name, gitName: name,
      gitEmail: `${name}@example.test` }, { Authorization: `Bearer ${testSecret}` });
    const { user } = await json<{ user: { id: string } }>(response);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const { csrfToken } = await json<{ csrfToken: string }>(await request('GET', '/api/auth/csrf', undefined, { Cookie: cookie }));
    return { user, request: (method, path, body, headers = {}) => request(method, path, body, { Cookie: cookie, 'X-CSRF-Token': csrfToken, ...headers }) };
  }
  return { sqlite, client };
}

async function workspace(owner: Client) {
  return (await json<{ workspace: { id: string } }>(await owner.request('POST', '/api/workspaces', { name: 'Team' }), 201)).workspace;
}

async function addMember(by: Client, workspaceId: string, member: Client, role: string) {
  await json(await by.request('POST', `/api/workspaces/${workspaceId}/members`, { userId: member.user.id, role }));
}

const tokenOf = (link: WorkspaceInviteLink) => {
  const match = /^http:\/\/localhost:8787\/#\/join\/([A-Za-z0-9_-]{43})$/.exec(link.url);
  assert.ok(match, link.url);
  return match[1];
};

const invite = async (client: Client, token: string, status = 200) =>
  (await json<{ invite: WorkspaceInvite }>(await client.request('GET', '/api/invite', undefined, { 'x-invite-token': token }), status)).invite;
const ask = (client: Client, token: string) => client.request('POST', '/api/invite', { token });
const requests = async (client: Client, workspaceId: string) =>
  (await json<{ requests: WorkspaceJoinRequest[] }>(await client.request('GET', `/api/workspaces/${workspaceId}/join-requests`))).requests;
const workspaces = async (client: Client) => (await json<{ workspaces: Workspace[] }>(await client.request('GET', '/api/workspaces'))).workspaces;

test('owners and admins share one invite link; other roles and outsiders cannot manage it', async t => {
  const f = await fixture(t);
  const [owner, admin, member, viewer, outsider] = await Promise.all(['owner', 'admin', 'member', 'viewer', 'outsider'].map(name => f.client(name)));
  const team = await workspace(owner);
  await addMember(owner, team.id, admin, 'admin');
  await addMember(owner, team.id, member, 'member');
  await addMember(owner, team.id, viewer, 'viewer');
  const path = `/api/workspaces/${team.id}/invite-link`;

  assert.equal((await json<{ link: null }>(await owner.request('GET', path))).link, null);
  const created = (await json<{ link: WorkspaceInviteLink }>(await owner.request('PUT', path), 201)).link;
  // Idempotent: the admin gets the same link, and so does a second request.
  assert.deepEqual((await json<{ link: WorkspaceInviteLink }>(await admin.request('PUT', path))).link, created);
  assert.deepEqual((await json<{ link: WorkspaceInviteLink }>(await admin.request('GET', path))).link, created);
  // The token is stored only hashed and encrypted.
  const row = f.sqlite.prepare('SELECT token_hash, token_ciphertext FROM workspace_invite_links').get() as { token_hash: string; token_ciphertext: string };
  assert.notEqual(row.token_hash, tokenOf(created));
  assert.ok(!row.token_ciphertext.includes(tokenOf(created)));

  for (const client of [member, viewer]) {
    await denied(await client.request('GET', path), 403, 'forbidden');
    await denied(await client.request('PUT', path), 403, 'forbidden');
    await denied(await client.request('DELETE', path), 403, 'forbidden');
    await denied(await client.request('GET', `/api/workspaces/${team.id}/join-requests`), 403, 'forbidden');
  }
  await denied(await outsider.request('GET', path), 404, 'not_found');
  await denied(await outsider.request('PUT', path), 404, 'not_found');
  await denied(await outsider.request('GET', `/api/workspaces/${team.id}/join-requests`), 404, 'not_found');
});

test('opening the link makes a registered user a pending member, with no access until accepted', async t => {
  const f = await fixture(t);
  const [owner, admin, alice, bob] = await Promise.all(['owner', 'admin', 'alice', 'bob'].map(name => f.client(name)));
  const team = await workspace(owner);
  await addMember(owner, team.id, admin, 'admin');
  const token = tokenOf((await json<{ link: WorkspaceInviteLink }>(await admin.request('PUT', `/api/workspaces/${team.id}/invite-link`), 201)).link);

  // The link shows the workspace's name, but not its id, to someone who isn't a member.
  assert.deepEqual(await invite(alice, token), { workspaceName: 'Team', status: 'none' });
  assert.deepEqual((await json<{ invite: WorkspaceInvite }>(await ask(alice, token), 201)).invite, { workspaceName: 'Team', status: 'pending' });
  // Asking again keeps the request.
  assert.deepEqual((await json<{ invite: WorkspaceInvite }>(await ask(alice, token))).invite, { workspaceName: 'Team', status: 'pending' });
  assert.deepEqual(await invite(alice, token), { workspaceName: 'Team', status: 'pending' });

  // Pending is not membership.
  assert.deepEqual(await workspaces(alice), []);
  await denied(await alice.request('GET', `/api/workspaces/${team.id}/members`), 404, 'not_found');
  const members = (await json<{ members: { userId: string }[] }>(await owner.request('GET', `/api/workspaces/${team.id}/members`))).members;
  assert.ok(!members.some(item => item.userId === alice.user.id));

  await json(await ask(bob, token), 201);
  const pending = await requests(admin, team.id);
  assert.deepEqual(pending.map(item => [item.userId, item.displayName]), [[alice.user.id, 'alice'], [bob.user.id, 'bob']]);

  // Admins accept with the roles below their own; only the owner makes someone an admin.
  const accept = (by: Client, who: Client, role: string) => by.request('POST', `/api/workspaces/${team.id}/join-requests/${encodeURIComponent(who.user.id)}/accept`, { role });
  await denied(await accept(admin, alice, 'admin'), 403, 'forbidden');
  await denied(await accept(admin, alice, 'owner'), 400, 'invalid_input');
  const left = (await json<{ requests: WorkspaceJoinRequest[] }>(await accept(admin, alice, 'collaborator'))).requests;
  assert.deepEqual(left.map(item => item.userId), [bob.user.id]);
  assert.deepEqual((await workspaces(alice)).map(item => [item.id, item.role]), [[team.id, 'collaborator']]);
  assert.deepEqual(await invite(alice, token), { workspaceName: 'Team', status: 'member', workspaceId: team.id });
  // A member asking again stays a member and adds no request.
  assert.deepEqual((await json<{ invite: WorkspaceInvite }>(await ask(alice, token))).invite.status, 'member');
  await denied(await accept(admin, alice, 'member'), 404, 'not_found');

  await json(await accept(owner, bob, 'admin'));
  assert.deepEqual((await workspaces(bob)).map(item => item.role), ['admin']);
  assert.deepEqual(await requests(owner, team.id), []);
  const audit = f.sqlite.prepare("SELECT action FROM audit WHERE action LIKE 'workspace.join.%' ORDER BY created_at").all() as { action: string }[];
  assert.deepEqual(audit.map(item => item.action).sort(), ['workspace.join.accept', 'workspace.join.accept', 'workspace.join.request', 'workspace.join.request']);
});

test('declining, withdrawing, adding directly and turning the link off', async t => {
  const f = await fixture(t);
  const [owner, member, alice, bob, carol] = await Promise.all(['owner', 'member', 'alice', 'bob', 'carol'].map(name => f.client(name)));
  const team = await workspace(owner);
  await addMember(owner, team.id, member, 'member');
  const path = `/api/workspaces/${team.id}/invite-link`;
  const token = tokenOf((await json<{ link: WorkspaceInviteLink }>(await owner.request('PUT', path), 201)).link);
  for (const client of [alice, bob, carol]) await json(await ask(client, token), 201);

  // Only owners and admins decide.
  await denied(await member.request('DELETE', `/api/workspaces/${team.id}/join-requests/${encodeURIComponent(alice.user.id)}`), 403, 'forbidden');
  await denied(await member.request('POST', `/api/workspaces/${team.id}/join-requests/${encodeURIComponent(alice.user.id)}/accept`, { role: 'viewer' }), 403, 'forbidden');

  const declined = (await json<{ requests: WorkspaceJoinRequest[] }>(await owner.request('DELETE', `/api/workspaces/${team.id}/join-requests/${encodeURIComponent(alice.user.id)}`))).requests;
  assert.ok(!declined.some(item => item.userId === alice.user.id));
  assert.equal((await invite(alice, token)).status, 'none');
  await denied(await owner.request('DELETE', `/api/workspaces/${team.id}/join-requests/${encodeURIComponent(alice.user.id)}`), 404, 'not_found');

  // Withdrawing one's own request.
  assert.equal((await json<{ invite: WorkspaceInvite }>(await bob.request('DELETE', '/api/invite', undefined, { 'x-invite-token': token }))).invite.status, 'none');

  // Adding someone directly settles their pending request.
  await addMember(owner, team.id, carol, 'viewer');
  assert.deepEqual(await requests(owner, team.id), []);

  // Turning the link off stops new requests, with one answer for every link that doesn't work, and keeps pending ones.
  await json(await ask(bob, token), 201);
  await json(await owner.request('DELETE', path));
  await denied(await alice.request('GET', '/api/invite', undefined, { 'x-invite-token': token }), 404, 'not_found');
  await denied(await ask(alice, token), 404, 'not_found');
  await denied(await alice.request('GET', '/api/invite', undefined, { 'x-invite-token': 'short' }), 404, 'not_found');
  await denied(await alice.request('GET', '/api/invite'), 404, 'not_found');
  assert.deepEqual((await requests(owner, team.id)).map(item => item.userId), [bob.user.id]);

  // A request outlives its link: its requester still sees and withdraws it, without the link.
  const own = async (client: Client) => (await json<{ requests: { workspaceId: string; workspaceName: string }[] }>(await client.request('GET', '/api/join-requests'))).requests;
  assert.deepEqual((await own(bob)).map(item => [item.workspaceId, item.workspaceName]), [[team.id, 'Team']]);
  assert.deepEqual(await own(alice), []);
  // Nobody withdraws someone else's request, and a workspace they aren't waiting on answers like a missing one.
  await denied(await alice.request('DELETE', `/api/join-requests/${team.id}`), 404, 'not_found');
  await denied(await alice.request('DELETE', '/api/join-requests/missing'), 404, 'not_found');
  assert.deepEqual((await requests(owner, team.id)).map(item => item.userId), [bob.user.id]);
  assert.equal((await bob.request('DELETE', `/api/join-requests/${team.id}`)).status, 204);
  assert.deepEqual(await own(bob), []);
  assert.deepEqual(await requests(owner, team.id), []);

  // Turning it on again issues a new link; the old one keeps failing.
  const fresh = tokenOf((await json<{ link: WorkspaceInviteLink }>(await owner.request('PUT', path), 201)).link);
  assert.notEqual(fresh, token);
  await denied(await ask(alice, token), 404, 'not_found');
  await json(await ask(alice, fresh), 201);
});

test('the pending queue is bounded', async t => {
  const f = await fixture(t);
  const [owner, late] = await Promise.all([f.client('owner'), f.client('late')]);
  const team = await workspace(owner);
  const token = tokenOf((await json<{ link: WorkspaceInviteLink }>(await owner.request('PUT', `/api/workspaces/${team.id}/invite-link`), 201)).link);
  const insertUser = f.sqlite.prepare(`INSERT INTO users (id, display_name, git_name, git_email, auth_kind, created_at)
    VALUES (?, ?, ?, ?, 'test', ?)`);
  const insertRequest = f.sqlite.prepare('INSERT INTO workspace_join_requests (workspace_id, user_id, created_at) VALUES (?, ?, ?)');
  const at = new Date().toISOString();
  for (let index = 0; index < 200; index++) {
    insertUser.run(`test:filler-${index}`, 'Filler', 'Filler', 'filler@example.test', at);
    insertRequest.run(team.id, `test:filler-${index}`, at);
  }
  await denied(await ask(late, token), 409, 'too_many_pending');
  // Waiting requests count until someone decides them; declining one makes room.
  await json(await owner.request('DELETE', `/api/workspaces/${team.id}/join-requests/${encodeURIComponent('test:filler-0')}`));
  await json(await ask(late, token), 201);
});
