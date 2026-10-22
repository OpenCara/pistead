import type { EgressGitService } from '../../../../packages/shared/src/network.js';
import { gitProviderNames } from '../../../../packages/shared/src/repositories.js';
import { boundedStream, PushRequestError, readPushCommands, sessionBranch, sessionBranchRefusal, type PushCommand } from '../../../../packages/shared/src/git-push.js';
import type { AppContext, RepositoryRow, SessionRow } from '../types.js';
import { auditStatement } from '../db.js';
import { fail } from '../http.js';
import { cloneSessionRepository, recheckAccess, type RepositoryAccess } from '../repositories.js';
import { requireBinding, requireNoRestore } from './broker.js';
import { mintPushToken, revokePushToken } from './mint.js';
import { pushTarget } from './targets.js';

/** Forges refuse pushes far below this; it bounds what one request can make the control plane stream. */
const pushRequestBytes = 2 * 1024 * 1024 * 1024;
/** The upstream answer starts within this; a large pack may stream for as long as the session's command runs. */
const relayTimeout = 60 * 60 * 1000;
const pushTypes = {
  'receive-refs': 'application/x-git-receive-pack-advertisement',
  'receive-pack': 'application/x-git-receive-pack-result',
} as const;

/** `body`, calling `done` once when it ends, fails, or its reader goes away. */
function settled(body: ReadableStream<Uint8Array>, done: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) { done(); controller.close(); }
        else controller.enqueue(part.value);
      } catch (error) {
        done();
        controller.error(error);
      }
    },
    async cancel(reason) {
      done();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * A clone session's push of its own branch (`pistead/<session-id>`) through its host's egress proxy, without approval:
 * the ref advertisement (`receive-refs`) and the push itself (`receive-pack`), whose commands may only create or move
 * that branch. The workspace's push identity is minted here and used here; it never reaches the host. The caller has
 * checked the session's authority, its connector and the repository binding, and loaded the owner's account.
 */
export async function sessionBranchPush(c: AppContext, input: {
  session: SessionRow; binding: RepositoryRow; access: RepositoryAccess; service: Exclude<EgressGitService, 'info-refs' | 'upload-pack'>;
  authorize: () => Promise<unknown>;
}): Promise<Response> {
  const { session, binding, access, service, authorize } = input;
  const branch = sessionBranch(session.id);
  const provider = gitProviderNames[binding.provider];
  await requireNoRestore(c, session.id);
  const pin = await cloneSessionRepository(c.env, session, row => row.id === binding.id);
  if (!pin) fail(404, 'repository_not_bound', 'This repository is not bound to the session\'s workspace.');
  const policy = await requireBinding(c, session.workspace_id, pin);
  // The owner must be able to push the repository themselves, whichever identity pushes for them.
  const target = await pushTarget(access, pin, branch);
  if (!target.canPush) fail(403, 'push_permission_required', 'The session owner cannot push to this repository.');
  if (policy.forbid_default_branch === 1 && branch === target.defaultBranch) {
    fail(403, 'default_branch_push_forbidden', 'This workspace forbids pushes to the repository default branch.');
  }
  let body: ReadableStream<Uint8Array> | undefined;
  let command: PushCommand | undefined;
  if (service === 'receive-pack') {
    if (c.req.header('content-type')?.toLowerCase() !== 'application/x-git-receive-pack-request') fail(415, 'unsupported_media_type', 'Expected a Git receive-pack request.');
    if (c.req.header('content-encoding')) fail(415, 'unsupported_media_type', 'Unsupported Git request encoding.');
    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > pushRequestBytes) fail(413, 'body_too_large', 'The push is too large.');
    if (!c.req.raw.body) fail(400, 'invalid_push_request', 'The Git push request is empty.');
    let parsed: Awaited<ReturnType<typeof readPushCommands>>;
    try { parsed = await readPushCommands(c.req.raw.body); }
    catch (error) {
      if (error instanceof PushRequestError) fail(400, 'invalid_push_request', error.message);
      throw error;
    }
    // Git's probe before a chunked upload changes nothing: it is answered without a credential.
    if (!parsed.commands.length) {
      await parsed.body.cancel().catch(() => {});
      return new Response(null, { headers: { 'Content-Type': pushTypes[service], 'Cache-Control': 'private, no-store' } });
    }
    const refusal = sessionBranchRefusal(parsed.commands, branch);
    if (refusal) {
      await parsed.body.cancel().catch(() => {});
      fail(403, 'session_branch_only', refusal);
    }
    command = parsed.commands[0]!;
    body = boundedStream(parsed.body, pushRequestBytes, 'The push is too large.');
  }
  await recheckAccess(c.env, access);
  await authorize();
  await requireBinding(c, session.workspace_id, pin);
  const minted = await mintPushToken(c.env, { workspaceId: session.workspace_id, sessionId: session.id, provider: binding.provider, host: binding.host,
    fullName: binding.full_name, repositoryId: binding.repository_id, branch, ownerId: session.owner_id, connectorId: session.connector_id ?? null,
    hostOwnerId: session.connector_owner_id ?? null, owner: access, relay: true });
  let revoked = false;
  const revoke = () => {
    if (revoked || !minted.revocation) return;
    revoked = true;
    void revokePushToken(c.env, minted.revocation);
  };
  let upstream: Response;
  try {
    if (minted.authorization === null) fail(409, 'host_git_credentials_relay', 'The host\'s Git credentials can\'t push through the egress proxy.');
    if (command) {
      await auditStatement(c.env, session.owner_id, 'git.push.session_branch', session.workspace_id, session.id, {
        bindingId: binding.id, branch, old: command.old, new: command.new, kind: minted.kind, ...(minted.identityId ? { identityId: minted.identityId } : {}),
      }).run();
    }
    const agent = c.req.header('user-agent');
    const headers: Record<string, string> = {
      Authorization: minted.authorization,
      'User-Agent': agent && /^git\/[\x21-\x7e]{1,120}$/.test(agent) ? agent : 'git/2 (pistead)',
      ...(body ? { 'Content-Type': 'application/x-git-receive-pack-request', Accept: pushTypes['receive-pack'] } : {}),
    };
    try {
      upstream = await fetch(service === 'receive-refs' ? `${target.remote}/info/refs?service=git-receive-pack` : `${target.remote}/git-receive-pack`, {
        method: body ? 'POST' : 'GET', headers, body, duplex: 'half', redirect: 'manual', signal: AbortSignal.timeout(relayTimeout),
      } as RequestInit);
    } catch {
      return fail(502, 'git_unavailable', `${provider} could not be reached.`);
    }
  } catch (error) {
    revoke();
    throw error;
  }
  const type = upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (upstream.status !== 200 || type !== pushTypes[service] || !upstream.body) {
    await upstream.body?.cancel().catch(() => {});
    revoke();
    const denied = [401, 403, 404].includes(upstream.status);
    return fail(denied ? 403 : 502, denied ? 'push_identity_denied' : 'git_unavailable', denied
      ? `${provider} did not let the workspace's push identity push to ${binding.full_name}.`
      : `${provider} could not complete the push.`);
  }
  return new Response(settled(upstream.body, revoke), { headers: { 'Content-Type': pushTypes[service], 'Cache-Control': 'private, no-store' } });
}
