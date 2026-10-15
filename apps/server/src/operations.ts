import type { GitHubMergeMethod, Operation, PermissionNeed, PullRequestRequest, ToolName } from '../../../packages/shared/src/types.js';
import { githubMergeMethods, permissionNeeds, toolNames } from '../../../packages/shared/src/types.js';
import { validPushBranch } from '../../../packages/shared/src/repositories.js';
import { fail, text } from './http.js';

/** A pinned repository's worktree path, as produced by repositoryPath(): 2-64 safe segments. */
export function validRepositoryPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){1,63}$/.test(value)
    && !value.split('/').some(part => ['.', '..', '.git'].includes(part.toLowerCase()));
}

function pullRequest(value: unknown): PullRequestRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_operation', 'Invalid pull request.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['title', 'body', 'base'].includes(key))) fail(400, 'invalid_operation', 'Invalid pull request.');
  const title = text(input.title, 'pull request title', 256);
  if (!title.trim() || /[\r\n]/.test(title)) fail(400, 'invalid_operation', 'Invalid pull request title.');
  const body = text(input.body, 'pull request body', 60000, 0);
  if (input.base !== undefined && !validPushBranch(input.base)) fail(400, 'invalid_operation', 'Invalid pull request base branch.');
  return { title, body, ...(input.base === undefined ? {} : { base: input.base as string }) };
}

/** A github.com repository as owner/name, never a URL or a path. */
export function githubRepositoryName(value: unknown): string {
  const repository = text(value, 'repository', 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || repository.endsWith('/.') || repository.endsWith('/..')) {
    fail(400, 'invalid_operation', 'Expected a GitHub owner/repository, not a URL.');
  }
  return repository;
}
export function issueNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail(400, 'invalid_operation', 'Invalid issue number.');
  return Number(value);
}

export function parseOperation(input: unknown): Operation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'invalid_operation', 'Expected an operation.');
  const value = input as Record<string, unknown>;
  switch (value.kind) {
    case 'git.commit': return { kind: value.kind, message: text(value.message, 'commit message', 4000) };
    case 'bash': return { kind: value.kind, command: text(value.command, 'command', 8192) };
    case 'github.comment':
      return { kind: value.kind, repository: githubRepositoryName(value.repository), issue: issueNumber(value.issue), body: text(value.body, 'comment body', 60000) };
    case 'github.merge': {
      const repository = githubRepositoryName(value.repository);
      if (!Number.isSafeInteger(value.pull) || Number(value.pull) < 1) fail(400, 'invalid_operation', 'Invalid pull request number.');
      if (typeof value.sha !== 'string' || !/^[0-9a-f]{40}$/.test(value.sha)) fail(400, 'invalid_operation', 'Expected the 40-character head commit to merge.');
      if (!githubMergeMethods.includes(value.method as GitHubMergeMethod)) fail(400, 'invalid_operation', 'Expected the merge, squash or rebase method.');
      // Canonical key order: approval review and broker hashes are computed over JSON.stringify of this value.
      return { kind: value.kind, repository, pull: Number(value.pull), sha: value.sha, method: value.method as GitHubMergeMethod };
    }
    case 'git.push': {
      if (!validRepositoryPath(value.repository)) fail(400, 'invalid_operation', 'Expected a pinned repository path.');
      if (!validPushBranch(value.branch)) fail(400, 'invalid_operation', 'Invalid branch name.');
      if (typeof value.commit !== 'string' || !/^[0-9a-f]{40}$/.test(value.commit)) fail(400, 'invalid_operation', 'Expected a 40-character session commit.');
      // Canonical key order: approval review and broker hashes are computed over JSON.stringify of this value.
      return { kind: value.kind, repository: value.repository, branch: value.branch, commit: value.commit,
        ...(value.pullRequest === undefined ? {} : { pullRequest: pullRequest(value.pullRequest) }) };
    }
    case 'permission': {
      const needs = value.needs;
      if (!toolNames.includes(value.tool as ToolName)) fail(400, 'invalid_operation', 'Unknown tool.');
      // Unique and in permissionNeeds order, so equal requests hash equally.
      if (!Array.isArray(needs) || !needs.length || needs.join() !== permissionNeeds.filter(need => needs.includes(need)).join()) {
        fail(400, 'invalid_operation', 'Invalid permission needs.');
      }
      return { kind: value.kind, tool: value.tool as ToolName, target: text(value.target, 'target', 8192, 0), needs: [...needs] as PermissionNeed[] };
    }
    default: fail(400, 'invalid_operation', 'Unsupported operation.');
  }
}
