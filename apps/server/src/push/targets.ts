import { HTTPException } from 'hono/http-exception';
import type { GitProvider, SessionRepository } from '../../../../packages/shared/src/repositories.js';
import { gitProviderNames } from '../../../../packages/shared/src/repositories.js';
import { fail } from '../http.js';
import { boundedRepositoryBody, verifyRepository, type RepositoryAccess } from '../repositories.js';
import { basic, gitProviderAdapters } from '../git/providers.js';

/** Where and whether the session owner may push one pinned repository. */
export interface PushTarget { canPush: boolean; defaultBranch: string; remote: string; azureProjectId?: string }
export interface PullRequestInput { head: string; base: string; title: string; body: string }
export interface OpenedPullRequest { url: string; number: number; created: boolean }

const jsonBytes = 512 * 1024;
const remoteTimeout = 20_000;
const userAgent = 'OpenCara-Agent-Workspace';
const sha1 = /^[0-9a-f]{40}$/;
type Headers = Record<string, string>;
interface Api { provider: GitProvider; base: string; web: string; headers: Headers }

const label = (provider: GitProvider): string => gitProviderNames[provider];
function unavailable(provider: GitProvider): never {
  return fail(502, 'git_provider_unavailable', `${label(provider)} could not complete the push request.`);
}
function permissionRequired(provider: GitProvider): never {
  return fail(403, 'push_permission_required', `The session owner cannot push to this ${label(provider)} repository.`);
}
function unverifiable(provider: GitProvider, detail: string): never {
  return fail(409, 'push_permission_unverifiable', `${label(provider)} push permission could not be verified: ${detail}`);
}

function provider(pin: SessionRepository): GitProvider { return 'provider' in pin ? pin.provider : 'github'; }
function host(pin: SessionRepository): string { return 'provider' in pin ? pin.host : 'github.com'; }

/** The owner's own credential against the provider REST API (never the push identity). */
function api(access: RepositoryAccess, pin: SessionRepository): Api {
  if (access.provider !== provider(pin)) fail(409, 'repository_identity_changed', 'The repository provider changed.');
  if (access.provider === 'github') {
    return { provider: 'github', base: 'https://api.github.com', web: 'github.com', headers: {
      Authorization: `Bearer ${access.github.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } };
  }
  const credential = access.account.credential;
  if (credential.host !== host(pin)) fail(409, 'repository_identity_changed', 'The repository host changed.');
  const origin = `https://${credential.host}`;
  switch (access.provider) {
    case 'github-enterprise': return { provider: access.provider, base: `${origin}/api/v3`, web: credential.host,
      headers: { Authorization: `Bearer ${credential.token}`, Accept: 'application/vnd.github+json' } };
    case 'gitlab': return { provider: access.provider, base: `${origin}/api/v4`, web: credential.host, headers: { Authorization: `Bearer ${credential.token}` } };
    case 'gitea': return { provider: access.provider, base: `${origin}/api/v1`, web: credential.host, headers: { Authorization: `token ${credential.token}` } };
    case 'bitbucket': return { provider: access.provider, base: 'https://api.bitbucket.org/2.0', web: 'bitbucket.org',
      headers: { Authorization: credential.username ? basic(credential.username, credential.token) : `Bearer ${credential.token}` } };
    case 'azure-devops': {
      const organization = pin.fullName.split('/')[0]!;
      if (organization.toLowerCase() !== credential.organization.toLowerCase()) permissionRequired(access.provider);
      return { provider: access.provider, base: `https://dev.azure.com/${organization}`, web: 'dev.azure.com', headers: { Authorization: basic('', credential.token) } };
    }
  }
}

/**
 * The owner's own credential as a git smart-HTTP Authorization header, for push access that uses the owner's account.
 * Forges ignore the user name for tokens except Bitbucket, whose API tokens (connected with the account email) and
 * access tokens each have a fixed Git user name.
 */
export function ownerPushAuthorization(access: RepositoryAccess): string {
  if (access.provider === 'github') return basic('x-access-token', access.github.token);
  const { token, username } = access.account.credential;
  switch (access.provider) {
    case 'github-enterprise': return basic('x-access-token', token);
    case 'gitlab': case 'gitea': return basic('oauth2', token);
    case 'bitbucket': return basic(username ? 'x-bitbucket-api-token-auth' : 'x-token-auth', token);
    case 'azure-devops': return basic('', token);
  }
}

/** One bounded JSON exchange: manual redirects, fixed timeout, no upstream text in errors. */
async function call(target: Api, url: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, { method: init.method ?? 'GET', redirect: 'manual', signal: AbortSignal.timeout(remoteTimeout),
      headers: { Accept: 'application/json', ...target.headers, 'User-Agent': userAgent, ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  } catch { return unavailable(target.provider); }
  if (response.status < 200 || response.status >= 300 || response.status === 204) {
    await response.body?.cancel().catch(() => {});
    return { status: response.status, body: undefined };
  }
  let bytes: Uint8Array;
  try { bytes = await boundedRepositoryBody(response, jsonBytes); } catch { return unavailable(target.provider); }
  try { return { status: response.status, body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }; }
  catch { return unavailable(target.provider); }
}
function object(target: Api, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable(target.provider);
  return value as Record<string, unknown>;
}
function array(target: Api, value: unknown): unknown[] {
  if (!Array.isArray(value)) unavailable(target.provider);
  return value;
}
/** Successful reads only; 401/403/404 mean the owner lacks access. */
async function read(target: Api, url: string): Promise<Record<string, unknown>> {
  const result = await call(target, url);
  if (result.status === 200) return object(target, result.body);
  if ([401, 403, 404].includes(result.status)) permissionRequired(target.provider);
  return unavailable(target.provider);
}

function remote(pin: SessionRepository): string {
  const name = pin.fullName;
  switch (provider(pin)) {
    case 'github': return `https://github.com/${name}.git`;
    case 'bitbucket': return `https://bitbucket.org/${name}.git`;
    case 'azure-devops': {
      const [organization, project, repository] = name.split('/') as [string, string, string];
      return `https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}`;
    }
    default: return `https://${host(pin)}/${name}.git`;
  }
}

/** Azure DevOps Git security token segment: the UTF-16LE bytes of one branch segment as lowercase hex. */
function azureSegment(segment: string): string {
  let hex = '';
  for (let index = 0; index < segment.length; index++) {
    const unit = segment.charCodeAt(index);
    hex += (unit & 0xff).toString(16).padStart(2, '0') + (unit >> 8).toString(16).padStart(2, '0');
  }
  return hex;
}
/** The branch security token; permissions set on the repository or project reach new branches through inheritance. */
function azureBranchToken(projectId: string, repositoryId: string, branch: string): string {
  return `repoV2/${projectId}/${repositoryId}/refs/heads/${branch.split('/').map(azureSegment).join('/')}`;
}

/** A branch read as the owner: its JSON when it exists, null when it does not (a new branch). */
async function existingBranch(target: Api, url: string): Promise<Record<string, unknown> | null> {
  const result = await call(target, url);
  if (result.status === 200) return object(target, result.body);
  if (result.status === 404) return null;
  if (result.status === 401 || result.status === 403) permissionRequired(target.provider);
  return unavailable(target.provider);
}

async function ownerCanPush(target: Api, pin: SessionRepository, branch: string): Promise<{ canPush: boolean; azureProjectId?: string }> {
  const id = encodeURIComponent(String(pin.repositoryId));
  // Branch names in URL paths: each `/`-separated segment encoded on its own.
  const branchPath = branch.split('/').map(encodeURIComponent).join('/');
  switch (target.provider) {
    case 'github':
    case 'github-enterprise': {
      const repository = target.provider === 'github'
        ? await read(target, `${target.base}/repos/${pin.fullName}`)
        : await read(target, `${target.base}/repositories/${id}`);
      if (object(target, repository.permissions).push !== true) return { canPush: false };
      // Protected branches carry rules a push identity could bypass; they go through pull requests instead.
      const existing = await existingBranch(target, `${target.base}/repos/${pin.fullName}/branches/${branchPath}`);
      if (existing?.protected === true) fail(403, 'protected_branch', 'Protected branches are not pushed through push identities; open a pull request instead.');
      return { canPush: true };
    }
    case 'gitea': {
      if (object(target, (await read(target, `${target.base}/repositories/${id}`)).permissions).push !== true) return { canPush: false };
      const existing = await existingBranch(target, `${target.base}/repos/${pin.fullName}/branches/${branchPath}`);
      return { canPush: existing === null || existing.user_can_push === true };
    }
    case 'gitlab': {
      const permissions = object(target, (await read(target, `${target.base}/projects/${id}`)).permissions);
      const level = (value: unknown): number => {
        const item = value && typeof value === 'object' ? (value as Record<string, unknown>).access_level : undefined;
        return typeof item === 'number' ? item : 0;
      };
      if (Math.max(level(permissions.project_access), level(permissions.group_access)) < 30) return { canPush: false };
      // GitLab takes the branch as one path parameter, so its slashes are encoded too.
      const existing = await existingBranch(target, `${target.base}/projects/${id}/repository/branches/${encodeURIComponent(branch)}`);
      return { canPush: existing === null || existing.can_push === true };
    }
    case 'bitbucket': {
      if (!target.headers.Authorization!.startsWith('Basic ')) unverifiable(target.provider, 'connect an Atlassian API token with your account email in Settings → Profile.');
      const query = encodeURIComponent(`repository.full_name="${pin.fullName}"`);
      const values = array(target, (await read(target, `${target.base}/user/permissions/repositories?q=${query}`)).values);
      const permission = values.length === 1 ? object(target, values[0]).permission : undefined;
      return { canPush: permission === 'write' || permission === 'admin' };
    }
    case 'azure-devops': {
      const repository = await read(target, `${target.base}/_apis/git/repositories/${id}?api-version=7.1`);
      const projectId = object(target, repository.project).id;
      if (typeof projectId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(projectId)) unavailable(target.provider);
      // GenericContribute (4) on the branch token: branch policies and inherited repository permissions both apply.
      const tokens = encodeURIComponent(azureBranchToken(projectId, String(pin.repositoryId), branch));
      const result = await call(target, `${target.base}/_apis/permissions/2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87/4?tokens=${tokens}&api-version=7.1`);
      if (result.status !== 200) unverifiable(target.provider, 'the connected token cannot read repository permissions.');
      const value = array(target, object(target, result.body).value);
      return { canPush: value[0] === true, azureProjectId: projectId };
    }
  }
}

/** Confirms the binding identity, the owner's write access to the branch, the default branch and the credential-free remote. */
export async function pushTarget(access: RepositoryAccess, pin: SessionRepository, branch: string): Promise<PushTarget> {
  const target = api(access, pin);
  const metadata = await verifyRepository(access, { repositoryId: String(pin.repositoryId), fullName: pin.fullName });
  const permission = await ownerCanPush(target, pin, branch);
  return { canPush: permission.canPush, defaultBranch: metadata.defaultBranch, remote: remote(pin),
    ...(permission.azureProjectId ? { azureProjectId: permission.azureProjectId } : {}) };
}

/** Current commit of refs/heads/<branch> as the owner sees it; null when the branch does not exist. */
export async function branchTip(access: RepositoryAccess, pin: SessionRepository, branch: string): Promise<string | null> {
  const target = api(access, pin);
  if (access.provider === 'github') {
    const result = await call(target, `${target.base}/repos/${pin.fullName}/commits/${encodeURIComponent(branch)}`);
    if (result.status === 404 || result.status === 422) return null;
    if (result.status !== 200) return unavailable(target.provider);
    const sha = object(target, result.body).sha;
    if (typeof sha !== 'string' || !sha1.test(sha)) unavailable(target.provider);
    return sha;
  }
  try {
    return await gitProviderAdapters[access.provider].commit(access.account.credential, { id: String(pin.repositoryId), fullName: pin.fullName }, branch);
  } catch (error) {
    if (error instanceof HTTPException && error.status === 403) return null;
    throw error;
  }
}

function webURL(target: Api, value: unknown): string {
  let url: URL;
  try { url = new URL(typeof value === 'string' ? value : ''); } catch { return unavailable(target.provider); }
  if (url.protocol !== 'https:' || url.host !== target.web || url.username || url.password) unavailable(target.provider);
  return url.href;
}
function positive(target: Api, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) unavailable(target.provider);
  return value;
}

/** Opens (or finds the open) pull request head → base as the session owner. */
export async function openPullRequest(access: RepositoryAccess, pin: SessionRepository, input: PullRequestInput, azureProjectId?: string): Promise<OpenedPullRequest> {
  const target = api(access, pin);
  const id = encodeURIComponent(String(pin.repositoryId));
  const created = async (url: string, body: unknown, conflict: readonly number[]): Promise<unknown | null> => {
    const result = await call(target, url, { method: 'POST', body });
    if (result.status === 200 || result.status === 201) return result.body;
    if (conflict.includes(result.status)) return null;
    if ([401, 403, 404].includes(result.status)) permissionRequired(target.provider);
    return unavailable(target.provider);
  };
  const existing = async (url: string, pick: (body: unknown) => unknown): Promise<unknown> => {
    const result = await call(target, url);
    if (result.status !== 200) unavailable(target.provider);
    const item = pick(result.body);
    if (item === undefined) unavailable(target.provider);
    return item;
  };
  switch (target.provider) {
    case 'github':
    case 'github-enterprise': {
      const parse = (value: unknown) => { const item = object(target, value); return { url: webURL(target, item.html_url), number: positive(target, item.number) }; };
      const made = await created(`${target.base}/repos/${pin.fullName}/pulls`, { title: input.title, head: input.head, base: input.base, body: input.body }, [422]);
      if (made !== null) return { ...parse(made), created: true };
      const owner = pin.fullName.split('/')[0]!;
      return { ...parse(await existing(`${target.base}/repos/${pin.fullName}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.head}`)}&base=${encodeURIComponent(input.base)}`,
        body => array(target, body)[0])), created: false };
    }
    case 'gitlab': {
      const parse = (value: unknown) => { const item = object(target, value); return { url: webURL(target, item.web_url), number: positive(target, item.iid) }; };
      const made = await created(`${target.base}/projects/${id}/merge_requests`,
        { source_branch: input.head, target_branch: input.base, title: input.title, description: input.body }, [409]);
      if (made !== null) return { ...parse(made), created: true };
      return { ...parse(await existing(`${target.base}/projects/${id}/merge_requests?state=opened&source_branch=${encodeURIComponent(input.head)}&target_branch=${encodeURIComponent(input.base)}`,
        body => array(target, body)[0])), created: false };
    }
    case 'gitea': {
      const parse = (value: unknown) => { const item = object(target, value); return { url: webURL(target, item.html_url), number: positive(target, item.number) }; };
      const made = await created(`${target.base}/repos/${pin.fullName}/pulls`, { head: input.head, base: input.base, title: input.title, body: input.body }, [409, 422]);
      if (made !== null) return { ...parse(made), created: true };
      return { ...parse(await existing(`${target.base}/repos/${pin.fullName}/pulls/${encodeURIComponent(input.base)}/${encodeURIComponent(input.head)}`, body => body)), created: false };
    }
    case 'bitbucket': {
      const parse = (value: unknown) => {
        const item = object(target, value);
        return { url: webURL(target, object(target, object(target, item.links).html).href), number: positive(target, item.id) };
      };
      const made = await created(`${target.base}/repositories/${pin.fullName}/pullrequests`, { title: input.title, description: input.body,
        source: { branch: { name: input.head } }, destination: { branch: { name: input.base } } }, [400, 409]);
      if (made !== null) return { ...parse(made), created: true };
      const query = encodeURIComponent(`source.branch.name="${input.head}" AND destination.branch.name="${input.base}" AND state="OPEN"`);
      return { ...parse(await existing(`${target.base}/repositories/${pin.fullName}/pullrequests?q=${query}`, body => array(target, object(target, body).values)[0])), created: false };
    }
    case 'azure-devops': {
      const [organization, project, repository] = pin.fullName.split('/') as [string, string, string];
      const projectPath = encodeURIComponent(azureProjectId ?? project);
      const parse = (value: unknown) => {
        const number = positive(target, object(target, value).pullRequestId);
        return { url: `https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/pullrequest/${number}`, number };
      };
      const base = `${target.base}/${projectPath}/_apis/git/repositories/${id}/pullrequests`;
      const made = await created(`${base}?api-version=7.1`, { sourceRefName: `refs/heads/${input.head}`, targetRefName: `refs/heads/${input.base}`,
        title: input.title, description: input.body }, [409]);
      if (made !== null) return { ...parse(made), created: true };
      return { ...parse(await existing(`${base}?searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${input.head}`)}` +
        `&searchCriteria.targetRefName=${encodeURIComponent(`refs/heads/${input.base}`)}&searchCriteria.status=active&api-version=7.1`,
        body => array(target, object(target, body).value)[0])), created: false };
    }
  }
}
