import type { SessionRepository } from '../../../../packages/shared/src/repositories.js';
import { gitProviderNames } from '../../../../packages/shared/src/repositories.js';
import { boundedStream, drainStream, PUSH_REQUEST_BYTES, PushRequestError, readPushCommands, sessionBranch, sessionBranchRefusal, type PushCommand } from '../../../../packages/shared/src/git-push.js';
import { fetchGit, gitServiceTypes, gitUpstreamHeaders } from '../../../../packages/shared/src/git-transfer.js';
import type { AppContext, RepositoryRow, SessionRow } from '../types.js';
import { auditStatement } from '../db.js';
import { fail, failTransfer } from '../http.js';
import { cloneSessionRepository, recheckAccess, type RepositoryAccess } from '../repositories.js';
import { requireBinding, requireNoRestore } from './broker.js';
import { mintPushToken, revokePushToken } from './mint.js';
import { pushTarget, type PushTarget } from './targets.js';

const pushTypes = { 'receive-refs': gitServiceTypes['receive-refs'], 'receive-pack': gitServiceTypes['receive-pack'] } as const;

/**
 * What a push of a clone session's own branch needs before any credential: no restore or move pending, the binding
 * still configured, the owner able to push the repository themselves (whichever identity pushes for them), and the
 * binding's default-branch policy. Shared by the relay and the direct grant.
 */
export async function sessionBranchTarget(c: AppContext, session: SessionRow, binding: RepositoryRow, access: RepositoryAccess)
  : Promise<{ branch: string; pin: SessionRepository; target: PushTarget }> {
  const branch = sessionBranch(session);
  await requireNoRestore(c, session.id);
  const pin = await cloneSessionRepository(c.env, session, row => row.id === binding.id);
  if (!pin) fail(404, 'repository_not_bound', 'This repository is not bound to the session\'s workspace.');
  const policy = await requireBinding(c, session.workspace_id, pin);
  const target = await pushTarget(access, pin, branch);
  if (!target.canPush) fail(403, 'push_permission_required', 'The session owner cannot push to this repository.');
  if (policy.forbid_default_branch === 1 && branch === target.defaultBranch) {
    fail(403, 'default_branch_push_forbidden', 'This workspace forbids pushes to the repository default branch.');
  }
  return { branch, pin, target };
}

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
 * A clone session's push of its own branch (its `branch`, or `pistead/<session-id>`) through its host's egress proxy, without approval:
 * the ref advertisement (`receive-refs`) and the push itself (`receive-pack`), whose commands may only create or move
 * that branch. The workspace's push identity is minted here and used here; it never reaches the host. The caller has
 * checked the session's authority, its connector and the repository binding, and loaded the owner's account.
 */
export async function sessionBranchPush(c: AppContext, input: {
  session: SessionRow; binding: RepositoryRow; access: RepositoryAccess; service: 'receive-refs' | 'receive-pack';
  authorize: () => Promise<unknown>;
}): Promise<Response> {
  const { session, binding, access, service, authorize } = input;
  const provider = gitProviderNames[binding.provider];
  const { branch, pin, target } = await sessionBranchTarget(c, session, binding, access);
  let body: ReadableStream<Uint8Array> | undefined;
  let command: PushCommand | undefined;
  if (service === 'receive-pack') {
    if (c.req.header('content-type')?.toLowerCase() !== 'application/x-git-receive-pack-request') fail(415, 'unsupported_media_type', 'Expected a Git receive-pack request.');
    if (c.req.header('content-encoding')) fail(415, 'unsupported_media_type', 'Unsupported Git request encoding.');
    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > PUSH_REQUEST_BYTES) fail(413, 'body_too_large', 'The push is too large.');
    if (!c.req.raw.body) fail(400, 'invalid_push_request', 'The Git push request is empty.');
    let parsed: Awaited<ReturnType<typeof readPushCommands>>;
    try { parsed = await readPushCommands(c.req.raw.body); }
    catch (error) {
      if (error instanceof PushRequestError) fail(400, 'invalid_push_request', error.message);
      throw error;
    }
    // Git's probe before a chunked upload changes nothing: it is answered without a credential, once read.
    if (!parsed.commands.length) {
      if (!await drainStream(parsed.body, PUSH_REQUEST_BYTES)) fail(413, 'body_too_large', 'The push is too large.');
      return new Response(null, { headers: { 'Content-Type': pushTypes[service], 'Cache-Control': 'private, no-store' } });
    }
    const refusal = sessionBranchRefusal(parsed.commands, branch);
    if (refusal) {
      // Read to its end first, as for the probe: the connection must stay up for the answer.
      if (!await drainStream(parsed.body, PUSH_REQUEST_BYTES)) fail(413, 'body_too_large', 'The push is too large.');
      fail(403, 'session_branch_only', refusal);
    }
    command = parsed.commands[0]!;
    body = boundedStream(parsed.body, PUSH_REQUEST_BYTES, 'The push is too large.');
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
  let upstream: { body: ReadableStream<Uint8Array> };
  try {
    if (minted.authorization === null) fail(409, 'host_git_credentials_relay', 'The host\'s Git credentials can\'t push through the egress proxy.');
    if (command) {
      await auditStatement(c.env, session.owner_id, 'git.push.session_branch', session.workspace_id, session.id, {
        bindingId: binding.id, branch, old: command.old, new: command.new, kind: minted.kind, ...(minted.identityId ? { identityId: minted.identityId } : {}),
      }).run();
    }
    const headers = gitUpstreamHeaders(service, { userAgent: c.req.header('user-agent'), contentType: body ? 'application/x-git-receive-pack-request' : undefined });
    upstream = await fetchGit({ remote: target.remote, service, authorization: minted.authorization, headers, body, provider, fullName: binding.full_name, identity: 'push' });
  } catch (error) {
    revoke();
    failTransfer(error);
  }
  return new Response(settled(upstream.body, revoke), { headers: { 'Content-Type': pushTypes[service], 'Cache-Control': 'private, no-store' } });
}
