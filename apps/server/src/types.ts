import type { Context } from 'hono';
import type { Permission, PushIdentityKind, SessionActivity, UserProfile, WorkspaceRole } from '../../../packages/shared/src/types';
import type { GitProvider, TokenGitProvider } from '../../../packages/shared/src/repositories';
import type { ConnectorHub } from './connector-hub-types.js';
import type { Database } from './db/types.js';
import type { ObjectStorage } from './storage/types.js';
import type { WorkspaceDatabaseProvider } from './workspace-databases/types.js';

/** Everything a request handler can reach: providers plus configuration. Built once in `apps/server/src/config.ts`. */
export interface Env {
  DB: Database;
  CONNECTOR_HUB?: ConnectorHub;
  BUCKET?: ObjectStorage;
  /** Reaches the databases workspace owners connect for their session backups; absent unless the operator enabled them. */
  WORKSPACE_DATABASES?: WorkspaceDatabaseProvider;
  APP_ORIGIN: string;
  RUNNER_URL?: string;
  RUNNER_EVENT_TRANSPORT?: string;
  RUNNER_SHARED_SECRET?: string;
  SESSION_SECRET?: string;
  VAULT_KEY?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  TEST_AUTH_ENABLED?: string;
  TEST_AUTH_SECRET?: string;
  TEST_AUTH_EXPIRES_AT?: string;
  /** Operator GitHub App for github.com pushes: numeric app id, URL slug, and RSA private key (PEM, PKCS#1 or PKCS#8; secret). */
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** RSA private key (PEM, PKCS#8; secret) signing Pistead OIDC assertions for Entra federation and Forgejo integrations. */
  OIDC_SIGNING_KEY?: string;
  /** Comma-separated user IDs of the instance administrators, who manage every account (see `apps/server/src/admin.ts`). */
  ADMIN_USER_IDS?: string;
}
export interface AuthIdentity {
  userId: string;
  tokenHash: string;
  csrfToken: string;
  /** "browser": the session cookie, so changes need the CSRF token. "native": an app's bearer token, never ambient. */
  client: 'browser' | 'native';
}
export type WorkerEnv = { Bindings: Env; Variables: { auth: AuthIdentity } };
export type AppContext = Context<WorkerEnv>;
export interface UserRow {
  id: string;
  github_id: string | null;
  github_login: string | null;
  display_name: string;
  git_name: string;
  git_email: string;
  env_json: string;
  auth_kind: 'github' | 'test';
  created_at: string;
  /** Set while an instance administrator has the account suspended. */
  suspended_at?: string | null;
  github_connected?: number;
}
export interface WorkspaceRow { id: string; name: string; owner_id: string; created_at: string }
export interface MemberRow { workspace_id: string; user_id: string; role: WorkspaceRole; created_at: string }
export interface ModelRow {
  id: string; workspace_id: string; name: string; provider: string; model_id: string; created_at: string;
  connector_id?: string | null; connector_owner_id?: string | null; available?: number;
}
export interface AgentRow {
  id: string; agent_id: string; author_id: string; workspace_id: string | null; version: number;
  name: string; description: string; instructions: string; tools_json: string; model_id: string; created_at: string;
}
export interface SessionRow {
  id: string; workspace_id: string; owner_id: string; agent_version_id: string; title: string;
  policy_version: number; status: 'provisioning' | 'ready' | 'error' | 'archived'; created_at: string;
  connector_id?: string | null; connector_owner_id?: string | null;
  repositories_json?: string;
  /** 'clone': no pins; the agent clones the workspace's repositories through the host's egress proxy. */
  repository_mode?: 'clone' | null;
  /** A clone session's own branch, named when it was created; NULL: pistead/<id>. Immutable. */
  branch?: string | null;
  /** 1: the session runs directly on its host's own environment, without the sandbox (SessionRecord.hostEnvironment). Immutable. */
  host_environment?: number | null;
  visibility?: 'private' | 'workspace';
  /** The status before archiving, restored on unarchive. */
  archived_status?: 'provisioning' | 'ready' | 'error' | null;
  /** What its agent is doing, as its host last reported it; display state only, never part of the runner binding. */
  activity?: SessionActivity | null;
  /** When its next scheduled prompt runs (scheduled-prompts.ts); display state only, never part of the runner binding. */
  next_scheduled_at?: string | null;
  /** How its transcript shows tool output to viewers (transcript-display.ts); display only. Absent on older rows: full. */
  tool_output?: 'full' | 'brief';
  /** Only on rows read through session access: the newest pull request a push from this session opened or found. */
  pull_request_url?: string | null;
  /** Only on rows read through session access: that pull request's state as last read (pull-request-states.ts). */
  pull_request_state?: string | null;
}
export interface RepositoryRow {
  id: string; workspace_id: string; provider: GitProvider; host: string; repository_id: string; full_name: string;
  ref: string; private: number; created_at: string;
}
export interface GitCredentialRow {
  id: string; user_id: string; provider: TokenGitProvider; host: string; organization: string; username: string | null;
  login: string; ciphertext: string; created_at: string; updated_at: string;
}
export interface PushIdentityRow {
  id: string; workspace_id: string; provider: GitProvider; host: string; scope: string; kind: PushIdentityKind;
  config_json: string; secret_ciphertext: string | null; status: 'ready' | 'authorization_required'; lease_until: number | null;
  created_by: string; created_at: string; updated_at: string;
}
export interface PushCredentialRow {
  id: string; session_id: string; approval_id: string; requested_by: string; identity_id: string | null; kind: string;
  binding_id: string; operation_json: string; automatic: number; admission_id: string | null; revocation_ciphertext: string | null; expires_at: number;
  created_at: string; completed_at: string | null; outcome: 'pushed' | 'up-to-date' | 'failed' | 'unknown' | null; tip: string | null;
  pull_request_url: string | null;
  pull_request_state?: string | null; pull_request_checked_at?: string | null;
}
export interface SessionAccess { row: SessionRow; permissions: Permission[] }
export type PublicProfile = UserProfile;
