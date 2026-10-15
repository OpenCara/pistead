import type { Hono, MiddlewareHandler } from 'hono';
import type { AuthorizationResult, Permission } from '../../../packages/shared/src/types.js';
import { permissions } from '../../../packages/shared/src/types.js';
import { constantTimeEqual } from '../../../packages/shared/src/crypto.js';
import { hasPermission } from '../../../packages/shared/src/policy.js';
import type { AppContext, WorkerEnv } from './types.js';
import { sessionAccess } from './db.js';
import { fail, identifier, jsonObject, userIdentifier } from './http.js';
import { requireCallbackScope } from './connectors.js';
import { githubComment, githubMerge, githubRead } from './github-broker.js';
import { legacyRestoreDownload } from './restore-routes.js';
import { repositoryDownload } from './repositories.js';
import { pushComplete, pushCredential } from './push/broker.js';

const internalAuthentication: MiddlewareHandler<WorkerEnv> = async (c, next) => {
  const configured = c.env.RUNNER_SHARED_SECRET;
  const authorization = c.req.header('authorization');
  if (!configured || configured.length < 32) fail(503, 'internal_unavailable', 'Internal authorization is not configured.');
  if (!authorization?.startsWith('Bearer ') || authorization.length > 512 || !constantTimeEqual(authorization.slice(7), configured)) {
    fail(401, 'unauthorized', 'Internal authentication is required.');
  }
  await next();
};

export function registerInternal(app: Hono<WorkerEnv>): void {
  app.use('/api/internal/*', internalAuthentication);
  app.post('/api/internal/authorize', c => authorizeSession(c, null));
  app.post('/api/internal/github/comment', c => githubComment(c, null));
  app.post('/api/internal/github/read', c => githubRead(c, null));
  app.post('/api/internal/github/merge', c => githubMerge(c, null));
  app.post('/api/internal/git/push/credential', c => pushCredential(c, null));
  app.post('/api/internal/git/push/complete', c => pushComplete(c, null));
  app.post('/api/internal/restores/:restoreId/download', legacyRestoreDownload);
  app.post('/api/internal/repositories/:bindingId/download', c => repositoryDownload(c, null));
}

export async function authorizeSession(c: AppContext, connectorId: string | null): Promise<Response> {
    const input = await jsonObject(c, 4096);
    const sessionId = identifier(input.sessionId, 'sessionId');
    const actorId = userIdentifier(input.actorId, 'actorId');
    const ownerId = userIdentifier(input.ownerId, 'ownerId');
    if (!permissions.includes(input.permission as Permission)) fail(400, 'invalid_permission', 'Invalid permission.');
    const access = await sessionAccess(c.env, sessionId, actorId);
    if (access) await requireCallbackScope(c, access.row, connectorId);
    const allowed = !!access && access.row.owner_id === ownerId && access.row.status !== 'archived' && hasPermission(access.permissions, input.permission as Permission);
    const result: AuthorizationResult = { allowed, policyVersion: access?.row.policy_version ?? 0, ownerId: access?.row.owner_id ?? '' };
    return c.json(result);
}
