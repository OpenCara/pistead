import type { Context } from 'hono';
import type { Permission, UserProfile, WorkspaceRole } from '../../../packages/shared/src/types';

export interface Env {
  DB: D1Database;
  CONNECTOR_HUB?: DurableObjectNamespace;
  BUCKET?: R2Bucket;
  ASSETS?: Fetcher;
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
}
export interface AuthIdentity {
  userId: string;
  tokenHash: string;
  csrfToken: string;
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
  visibility?: 'private' | 'workspace';
}
export interface SessionAccess { row: SessionRow; permissions: Permission[] }
export type PublicProfile = UserProfile;
