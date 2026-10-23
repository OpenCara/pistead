import {
  gitProviderNames, repositoryLimits, validGitHost, validRepositoryId, validRepositoryName,
  type ProviderRepository, type ProviderRepositoryList, type TokenGitProvider,
} from '../../../../packages/shared/src/repositories.js';
import { fail } from '../http.js';
import { boundedRepositoryBody, repositoryRef } from '../repositories.js';
import type { GitCredential, GitProviderAdapter, RepositoryRef } from './types.js';

// GitHub, GitHub Enterprise Server, GitLab and Bitbucket serve at most 100 repositories per list page.
export const listPageSize = 100;
// One list page of full repository objects; GitHub's run about 6 KiB each.
export const listBytes = 2 * 1024 * 1024;
// Gitea clamps `limit` to its MAX_RESPONSE_ITEMS setting and a short page ends the listing, so keep its default.
const giteaPageSize = 30;
const jsonBytes = 512 * 1024;
// Azure DevOps lists every repository of an organization in one response (no server paging).
const azureListBytes = 4 * 1024 * 1024;
const remoteTimeout = 20_000;
const userAgent = 'OpenCara-Agent-Workspace';
const deniedStatuses: readonly number[] = [401, 403, 404];
// Azure DevOps answers unauthenticated requests with 203 (sign-in HTML) or a 302 to its sign-in service.
const azureDeniedStatuses: readonly number[] = [203, 302, 401, 403, 404];
const sha1 = /^[0-9a-f]{40}$/;
const sha256 = /^[0-9a-f]{64}$/;
const azureOrganization = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;

type Headers = Record<string, string>;
type JsonObject = Record<string, unknown>;
interface ReadOptions { verify?: boolean; denied?: readonly number[]; limit?: number }

const label = (provider: TokenGitProvider): string => gitProviderNames[provider];

function accessFailure(provider: TokenGitProvider, verify: boolean): never {
  if (verify) fail(400, 'git_account_rejected', 'The provider rejected this token. Check the token, its scopes and the host.');
  return fail(403, 'git_repository_unavailable',
    `${label(provider)} repository access could not be verified. Check the connected account's access and try again.`);
}
function providerUnavailable(provider: TokenGitProvider): never {
  return fail(502, 'git_provider_unavailable', `${label(provider)} could not complete the repository request.`);
}
function invalidResponse(provider: TokenGitProvider): never {
  return fail(502, 'invalid_git_response', `${label(provider)} returned invalid repository metadata.`);
}
function emptyRepository(provider: TokenGitProvider): never {
  return fail(409, 'git_repository_empty', `This ${label(provider)} repository has no default branch yet. Push a commit first.`);
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

/** Every upstream request: no automatic redirects, bounded time, no cookies, fixed User-Agent. */
async function request(provider: TokenGitProvider, url: string, headers: Headers): Promise<Response> {
  try {
    return await fetch(url, { headers: { ...headers, 'User-Agent': userAgent }, redirect: 'manual', signal: AbortSignal.timeout(remoteTimeout) });
  } catch {
    return providerUnavailable(provider);
  }
}

async function expectOk(provider: TokenGitProvider, response: Response, options: ReadOptions): Promise<void> {
  if (response.status === 200) return;
  await discard(response);
  if ((options.denied ?? deniedStatuses).includes(response.status)) accessFailure(provider, options.verify ?? false);
  providerUnavailable(provider);
}

async function readText(provider: TokenGitProvider, response: Response, limit: number): Promise<string> {
  const bytes = await boundedRepositoryBody(response, limit);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return invalidResponse(provider); }
}

async function getJson(provider: TokenGitProvider, url: string, headers: Headers, options: ReadOptions = {}): Promise<{ body: unknown; response: Response }> {
  const response = await request(provider, url, { Accept: 'application/json', ...headers });
  await expectOk(provider, response, options);
  const text = await readText(provider, response, options.limit ?? jsonBytes);
  try { return { body: JSON.parse(text), response }; }
  catch { return invalidResponse(provider); }
}

function record(provider: TokenGitProvider, value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidResponse(provider);
  return value as JsonObject;
}
function list(provider: TokenGitProvider, value: unknown): unknown[] {
  if (!Array.isArray(value)) invalidResponse(provider);
  return value;
}
/** One list page: an array of at most the `size` entries requested. */
function pageItems(provider: TokenGitProvider, value: unknown, size: number): unknown[] {
  const items = list(provider, value);
  if (items.length > size) invalidResponse(provider);
  return items;
}
function login(provider: TokenGitProvider, value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255 || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) invalidResponse(provider);
  return value;
}
function identity(provider: TokenGitProvider, value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (!validRepositoryId(value)) invalidResponse(provider);
  return value;
}
function canonicalName(provider: TokenGitProvider, value: unknown): string {
  if (!validRepositoryName(provider, value)) invalidResponse(provider);
  return value;
}
function branch(provider: TokenGitProvider, value: unknown): string {
  try { return repositoryRef(value); }
  catch { return invalidResponse(provider); }
}
function flag(provider: TokenGitProvider, value: unknown): boolean {
  if (typeof value !== 'boolean') invalidResponse(provider);
  return value;
}
function commitSha(provider: TokenGitProvider, value: unknown): string {
  if (typeof value === 'string' && sha256.test(value)) {
    fail(422, 'unsupported_repository_format', `This ${label(provider)} repository uses SHA-256 object names, which are not supported.`);
  }
  if (typeof value !== 'string' || !sha1.test(value)) invalidResponse(provider);
  return value;
}

function target(provider: TokenGitProvider, repository: RepositoryRef): RepositoryRef {
  if (!validRepositoryId(repository.id) || !validRepositoryName(provider, repository.fullName)) {
    fail(400, 'invalid_repository', `Use a valid ${label(provider)} repository.`);
  }
  return repository;
}
/**
 * Requests pages 1, 2, ... of `size` entries until the provider reports no more, keeping at most
 * repositoryLimits.pickerRepositories. The page count is bounded too, so skipped entries cannot extend a listing.
 */
export async function collectRepositories(size: number,
  page: (number: number) => Promise<{ repositories: ProviderRepository[]; hasMore: boolean }>): Promise<ProviderRepositoryList> {
  const limit = repositoryLimits.pickerRepositories;
  const repositories: ProviderRepository[] = [];
  for (let number = 1; number <= Math.ceil(limit / size); number++) {
    const result = await page(number);
    repositories.push(...result.repositories);
    if (repositories.length >= limit) return { repositories: repositories.slice(0, limit), truncated: repositories.length > limit || result.hasMore };
    if (!result.hasMore) return { repositories, truncated: false };
  }
  return { repositories, truncated: true };
}
/** Origin of a self-hosted provider; only validated public DNS names over HTTPS. */
function selfHostedOrigin(credential: GitCredential): URL {
  if (!validGitHost(credential.host)) fail(400, 'invalid_git_host', 'The connected account has an invalid host.');
  return new URL(`https://${credential.host}`);
}
export function basic(user: string, password: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(`${user}:${password}`)) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

// GitHub Enterprise Server: REST v3 under /api/v3.
function githubEnterpriseApi(credential: GitCredential): { origin: URL; base: string; headers: Headers } {
  const origin = selfHostedOrigin(credential);
  return { origin, base: `${origin.origin}/api/v3`, headers: { Authorization: `Bearer ${credential.token}`, Accept: 'application/vnd.github+json' } };
}
function githubEnterpriseRepository(value: unknown): ProviderRepository {
  const provider = 'github-enterprise';
  const item = record(provider, value);
  return { id: identity(provider, item.id), fullName: canonicalName(provider, item.full_name),
    defaultBranch: branch(provider, item.default_branch), private: flag(provider, item.private) };
}
const githubEnterprise: GitProviderAdapter = {
  async verify(credential) {
    const api = githubEnterpriseApi(credential);
    const { body } = await getJson('github-enterprise', `${api.base}/user`, api.headers, { verify: true });
    return { login: login('github-enterprise', record('github-enterprise', body).login) };
  },
  async list(credential) {
    const api = githubEnterpriseApi(credential);
    return collectRepositories(listPageSize, async page => {
      const { body, response } = await getJson('github-enterprise',
        `${api.base}/user/repos?per_page=${listPageSize}&page=${page}&sort=full_name&direction=asc`, api.headers, { limit: listBytes });
      return { repositories: pageItems('github-enterprise', body, listPageSize).map(githubEnterpriseRepository),
        hasMore: /<[^>]*>\s*;\s*rel="next"/.test(response.headers.get('link') ?? '') };
    });
  },
  async repository(credential, repository) {
    const api = githubEnterpriseApi(credential);
    const { id } = target('github-enterprise', repository);
    const { body } = await getJson('github-enterprise', `${api.base}/repositories/${encodeURIComponent(id)}`, api.headers);
    return githubEnterpriseRepository(body);
  },
  async commit(credential, repository, ref) {
    const api = githubEnterpriseApi(credential);
    const { fullName } = target('github-enterprise', repository);
    // The sha media type answers with the bare commit id instead of the full commit (and its file list).
    const response = await request('github-enterprise', `${api.base}/repos/${fullName}/commits/${encodeURIComponent(repositoryRef(ref))}`,
      { ...api.headers, Accept: 'application/vnd.github.sha' });
    await expectOk('github-enterprise', response, { denied: [...deniedStatuses, 422] });
    return commitSha('github-enterprise', (await readText('github-enterprise', response, 1024)).trim());
  },
};

// GitLab (gitlab.com and self-managed): REST v4.
function gitlabApi(credential: GitCredential): { base: string; headers: Headers } {
  return { base: `${selfHostedOrigin(credential).origin}/api/v4`, headers: { Authorization: `Bearer ${credential.token}` } };
}
function gitlabRepository(value: unknown): ProviderRepository | null {
  const item = record('gitlab', value);
  if (item.default_branch === null || item.default_branch === undefined) return null;
  if (item.visibility !== 'public' && item.visibility !== 'internal' && item.visibility !== 'private') invalidResponse('gitlab');
  return { id: identity('gitlab', item.id), fullName: canonicalName('gitlab', item.path_with_namespace),
    defaultBranch: branch('gitlab', item.default_branch), private: item.visibility !== 'public' };
}
const gitlab: GitProviderAdapter = {
  async verify(credential) {
    const api = gitlabApi(credential);
    const { body } = await getJson('gitlab', `${api.base}/user`, api.headers, { verify: true });
    return { login: login('gitlab', record('gitlab', body).username) };
  },
  async list(credential) {
    const api = gitlabApi(credential);
    return collectRepositories(listPageSize, async page => {
      // simple=true omits `visibility`, so the full representation is requested.
      const { body, response } = await getJson('gitlab',
        `${api.base}/projects?membership=true&per_page=${listPageSize}&page=${page}&order_by=path&sort=asc`, api.headers, { limit: listBytes });
      const items = pageItems('gitlab', body, listPageSize);
      const next = response.headers.get('x-next-page');
      return {
        repositories: items.map(gitlabRepository).filter((item): item is ProviderRepository => item !== null),
        hasMore: next === null ? items.length === listPageSize : next.trim() !== '',
      };
    });
  },
  async repository(credential, repository) {
    const api = gitlabApi(credential);
    const { id } = target('gitlab', repository);
    const { body } = await getJson('gitlab', `${api.base}/projects/${encodeURIComponent(id)}`, api.headers);
    return gitlabRepository(body) ?? emptyRepository('gitlab');
  },
  async commit(credential, repository, ref) {
    const api = gitlabApi(credential);
    const { id } = target('gitlab', repository);
    const { body } = await getJson('gitlab',
      `${api.base}/projects/${encodeURIComponent(id)}/repository/commits/${encodeURIComponent(repositoryRef(ref))}`, api.headers);
    return commitSha('gitlab', record('gitlab', body).id);
  },
};

// Gitea and Forgejo: REST v1.
function giteaApi(credential: GitCredential): { base: string; headers: Headers } {
  return { base: `${selfHostedOrigin(credential).origin}/api/v1`, headers: { Authorization: `token ${credential.token}` } };
}
function giteaRepository(value: unknown): ProviderRepository | null {
  const item = record('gitea', value);
  if (item.empty === true) return null;
  return { id: identity('gitea', item.id), fullName: canonicalName('gitea', item.full_name),
    defaultBranch: branch('gitea', item.default_branch), private: flag('gitea', item.private) };
}
const gitea: GitProviderAdapter = {
  async verify(credential) {
    const api = giteaApi(credential);
    const { body } = await getJson('gitea', `${api.base}/user`, api.headers, { verify: true });
    return { login: login('gitea', record('gitea', body).login) };
  },
  async list(credential) {
    const api = giteaApi(credential);
    return collectRepositories(giteaPageSize, async page => {
      const { body } = await getJson('gitea', `${api.base}/user/repos?page=${page}&limit=${giteaPageSize}`, api.headers);
      const items = pageItems('gitea', body, giteaPageSize);
      return { repositories: items.map(giteaRepository).filter((item): item is ProviderRepository => item !== null), hasMore: items.length === giteaPageSize };
    });
  },
  async repository(credential, repository) {
    const api = giteaApi(credential);
    const { id } = target('gitea', repository);
    const { body } = await getJson('gitea', `${api.base}/repositories/${encodeURIComponent(id)}`, api.headers);
    return giteaRepository(body) ?? emptyRepository('gitea');
  },
  async commit(credential, repository, ref) {
    const api = giteaApi(credential);
    const { fullName } = target('gitea', repository);
    const { body } = await getJson('gitea',
      `${api.base}/repos/${fullName}/commits?sha=${encodeURIComponent(repositoryRef(ref))}&limit=1&stat=false&verification=false&files=false`, api.headers);
    const items = list('gitea', body);
    if (items.length === 0) accessFailure('gitea', false);
    return commitSha('gitea', record('gitea', items[0]).sha);
  },
};

// Bitbucket Cloud: REST 2.0. Cross-workspace listing (GET /2.0/repositories) was removed by CHANGE-2770, so
// repositories are listed per workspace from GET /2.0/user/workspaces.
const bitbucketApi = 'https://api.bitbucket.org/2.0';
const bitbucketWeb = 'https://bitbucket.org';
const bitbucketWorkspacePages = 10;
function bitbucketHeaders(credential: GitCredential): Headers {
  return { Authorization: credential.username ? basic(credential.username, credential.token) : `Bearer ${credential.token}` };
}
function bitbucketRepository(value: unknown): ProviderRepository | null {
  const item = record('bitbucket', value);
  if (item.mainbranch === null || item.mainbranch === undefined) return null;
  return { id: identity('bitbucket', item.uuid), fullName: canonicalName('bitbucket', item.full_name),
    defaultBranch: branch('bitbucket', record('bitbucket', item.mainbranch).name), private: flag('bitbucket', item.is_private) };
}
function bitbucketPage(body: unknown): { values: unknown[]; next: boolean } {
  const item = record('bitbucket', body);
  return { values: pageItems('bitbucket', item.values, listPageSize), next: typeof item.next === 'string' };
}
async function bitbucketWorkspaces(headers: Headers): Promise<string[]> {
  const slugs: string[] = [];
  for (let page = 1; page <= bitbucketWorkspacePages; page++) {
    const { body } = await getJson('bitbucket', `${bitbucketApi}/user/workspaces?pagelen=100&page=${page}&sort=slug`, headers);
    const result = bitbucketPage(body);
    for (const value of result.values) {
      const slug = record('bitbucket', record('bitbucket', value).workspace).slug;
      if (typeof slug !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(slug)) invalidResponse('bitbucket');
      slugs.push(slug);
    }
    if (!result.next) break;
  }
  return slugs;
}
const bitbucket: GitProviderAdapter = {
  async verify(credential) {
    const headers = bitbucketHeaders(credential);
    const response = await request('bitbucket', `${bitbucketApi}/user`, { Accept: 'application/json', ...headers });
    if ((response.status === 401 || response.status === 403) && !credential.username) {
      // Workspace/project/repository access tokens have no user; they authenticate but cannot read /user.
      await discard(response);
      await getJson('bitbucket', `${bitbucketApi}/user/workspaces?pagelen=1`, headers, { verify: true });
      return { login: 'access token' };
    }
    await expectOk('bitbucket', response, { verify: true });
    const text = await readText('bitbucket', response, jsonBytes);
    let body: unknown;
    try { body = JSON.parse(text); } catch { invalidResponse('bitbucket'); }
    return { login: login('bitbucket', record('bitbucket', body).username) };
  },
  async list(credential) {
    const headers = bitbucketHeaders(credential);
    const limit = repositoryLimits.pickerRepositories;
    const repositories: ProviderRepository[] = [];
    // Workspaces sorted by slug, each listed by full_name.
    const workspaces = await bitbucketWorkspaces(headers);
    for (const [index, workspace] of workspaces.entries()) {
      for (let page = 1; ; page++) {
        const { body } = await getJson('bitbucket',
          `${bitbucketApi}/repositories/${workspace}?role=member&pagelen=${listPageSize}&page=${page}&sort=full_name`, headers, { limit: listBytes });
        const result = bitbucketPage(body);
        for (const value of result.values) {
          const repository = bitbucketRepository(value);
          if (repository) repositories.push(repository);
        }
        // An empty page ends the workspace even when it links another.
        const more = result.next && result.values.length > 0;
        if (repositories.length >= limit) {
          return { repositories: repositories.slice(0, limit), truncated: repositories.length > limit || more || index < workspaces.length - 1 };
        }
        if (!more) break;
      }
    }
    return { repositories, truncated: false };
  },
  async repository(credential, repository) {
    const { fullName } = target('bitbucket', repository);
    const { body } = await getJson('bitbucket', `${bitbucketApi}/repositories/${fullName}`, bitbucketHeaders(credential));
    return bitbucketRepository(body) ?? emptyRepository('bitbucket');
  },
  async commit(credential, repository, ref) {
    const { fullName } = target('bitbucket', repository);
    const { body } = await getJson('bitbucket',
      `${bitbucketApi}/repositories/${fullName}/commit/${encodeURIComponent(repositoryRef(ref))}`, bitbucketHeaders(credential));
    return commitSha('bitbucket', record('bitbucket', body).hash);
  },
};

// Azure DevOps Services: REST 7.1 under https://dev.azure.com/{organization}.
function azureApi(credential: GitCredential): { organization: string; base: string; headers: Headers } {
  const organization = credential.organization;
  if (!azureOrganization.test(organization)) fail(400, 'invalid_git_account', 'The connected Azure DevOps account has an invalid organization.');
  return { organization, base: `https://dev.azure.com/${organization}`, headers: { Authorization: basic('', credential.token) } };
}
function azureTarget(credential: GitCredential, repository: RepositoryRef): { organization: string; base: string; headers: Headers; id: string } {
  const api = azureApi(credential);
  const { id, fullName } = target('azure-devops', repository);
  if (fullName.split('/')[0] !== api.organization) accessFailure('azure-devops', false);
  return { ...api, id: encodeURIComponent(id) };
}
function azureRepository(organization: string, value: unknown): ProviderRepository | null {
  const item = record('azure-devops', value);
  const project = record('azure-devops', item.project);
  if (item.isDisabled === true || typeof item.defaultBranch !== 'string' || !item.defaultBranch.startsWith('refs/heads/')) return null;
  if (typeof project.name !== 'string' || typeof item.name !== 'string') invalidResponse('azure-devops');
  return {
    id: identity('azure-devops', item.id),
    fullName: canonicalName('azure-devops', `${organization}/${project.name}/${item.name}`),
    defaultBranch: branch('azure-devops', item.defaultBranch.slice('refs/heads/'.length)),
    private: project.visibility !== 'public',
  };
}
async function azureRefs(api: { base: string; headers: Headers; id: string }, filter: string, peel: boolean): Promise<JsonObject[]> {
  const { body } = await getJson('azure-devops',
    `${api.base}/_apis/git/repositories/${api.id}/refs?filter=${encodeURIComponent(filter)}${peel ? '&peelTags=true' : ''}&api-version=7.1`,
    api.headers, { denied: azureDeniedStatuses });
  return list('azure-devops', record('azure-devops', body).value).map(item => record('azure-devops', item));
}
const azureDevOps: GitProviderAdapter = {
  async verify(credential) {
    const api = azureApi(credential);
    // connectionData only exists as a preview API; any failure other than an auth rejection falls back to projects.
    const response = await request('azure-devops', `${api.base}/_apis/connectionData?api-version=7.1-preview`, { Accept: 'application/json', ...api.headers });
    if (azureDeniedStatuses.includes(response.status)) { await discard(response); accessFailure('azure-devops', true); }
    if (response.status === 200) {
      let body: unknown;
      try { body = JSON.parse(await readText('azure-devops', response, jsonBytes)); } catch { body = undefined; }
      const user = body && typeof body === 'object' && 'authenticatedUser' in body ? body.authenticatedUser : undefined;
      const name = user && typeof user === 'object' && 'providerDisplayName' in user ? user.providerDisplayName : undefined;
      if (typeof name === 'string' && name.trim() && name.length <= 255 && !/[\x00-\x1f\x7f]/.test(name)) return { login: name.trim() };
    } else await discard(response);
    await getJson('azure-devops', `${api.base}/_apis/projects?$top=1&api-version=7.1`, api.headers, { verify: true, denied: azureDeniedStatuses });
    return { login: api.organization };
  },
  async list(credential) {
    const api = azureApi(credential);
    const { body } = await getJson('azure-devops', `${api.base}/_apis/git/repositories?api-version=7.1`, api.headers,
      { denied: azureDeniedStatuses, limit: azureListBytes });
    const repositories = list('azure-devops', record('azure-devops', body).value)
      .map(item => azureRepository(api.organization, item))
      .filter((item): item is ProviderRepository => item !== null)
      .sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0));
    const limit = repositoryLimits.pickerRepositories;
    return { repositories: repositories.slice(0, limit), truncated: repositories.length > limit };
  },
  async repository(credential, repository) {
    const api = azureTarget(credential, repository);
    const { body } = await getJson('azure-devops', `${api.base}/_apis/git/repositories/${api.id}?api-version=7.1`, api.headers, { denied: azureDeniedStatuses });
    const item = record('azure-devops', body);
    if (item.isDisabled === true) accessFailure('azure-devops', false);
    return azureRepository(api.organization, item) ?? emptyRepository('azure-devops');
  },
  async commit(credential, repository, ref) {
    const api = azureTarget(credential, repository);
    const name = repositoryRef(ref);
    if (sha1.test(name)) {
      const { body } = await getJson('azure-devops', `${api.base}/_apis/git/repositories/${api.id}/commits/${name}?api-version=7.1`,
        api.headers, { denied: azureDeniedStatuses });
      if (commitSha('azure-devops', record('azure-devops', body).commitId) !== name) invalidResponse('azure-devops');
      return name;
    }
    // refs filters are prefix matches; only an exact branch, then tag, name is accepted.
    const head = (await azureRefs(api, `heads/${name}`, false)).find(item => item.name === `refs/heads/${name}`);
    if (head) return commitSha('azure-devops', head.objectId);
    const tag = (await azureRefs(api, `tags/${name}`, true)).find(item => item.name === `refs/tags/${name}`);
    if (tag) return commitSha('azure-devops', tag.peeledObjectId ?? tag.objectId);
    return accessFailure('azure-devops', false);
  },
};

export const gitProviderAdapters: Record<TokenGitProvider, GitProviderAdapter> = {
  'github-enterprise': githubEnterprise,
  gitlab,
  bitbucket,
  'azure-devops': azureDevOps,
  gitea,
};
