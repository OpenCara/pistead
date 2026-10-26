import type { SessionPullRequest } from "../../../packages/shared/src/types";
import { pullRequestStateLabels, pullRequestStateTones } from "../../../packages/shared/src/pull-requests";
import { Icon } from "./icons";

/** "#12", or "PR" for a pull request URL with no number. */
export function pullRequestLabel(pull: SessionPullRequest): string {
  return pull.number === undefined ? "PR" : `#${pull.number}`;
}

/**
 * The repository a pull request URL names, as "owner/repo", or undefined when its path isn't one of the known shapes:
 * owner/repo/pull/12 (GitHub), owner/repo/pulls/12 (Gitea), group/sub/project/-/merge_requests/12 (GitLab),
 * team/repo/pull-requests/12 (Bitbucket Cloud), projects/KEY/repos/repo/pull-requests/12 or users/name/repos/repo/...
 * (Bitbucket Server and Data Center, possibly under a context path), org/project/_git/repo/pullrequest/12 (Azure DevOps).
 */
export function pullRequestRepository(url: string): string | undefined {
  let path: string[];
  try { path = new URL(url).pathname.split("/").filter(Boolean).map(decodeURIComponent); } catch { return undefined; }
  const marker = path.findIndex(part => ["pull", "pulls", "-", "pull-requests", "merge_requests", "pullrequest"].includes(part));
  if (marker < 2) return undefined;
  const before = path.slice(0, marker);
  const repos = before.lastIndexOf("repos");
  if (repos >= 2 && repos === before.length - 2 && ["projects", "users"].includes(before[repos - 2]!)) return `${before[repos - 1]}/${before[repos + 1]}`;
  return before.filter(part => part !== "_git").join("/");
}

/** The tooltip: "Pull request #12 in owner/repo: CI failed", or the URL when it names no repository this recognizes. */
function pullRequestTitle(pull: SessionPullRequest): string {
  const repository = pullRequestRepository(pull.url);
  const state = pull.state ? `: ${pullRequestStateLabels[pull.state]}` : "";
  return repository ? `Pull request ${pullRequestLabel(pull)} in ${repository}${state}` : `${pull.url}${state}`;
}

/** Its state as a word in the state's color: Draft, Open, CI failed, Changes requested, Merged, Closed. */
function PullRequestState({ pull }: { pull: SessionPullRequest }) {
  return pull.state ? <span className={`pull-state ${pullRequestStateTones[pull.state]}`}>{pullRequestStateLabels[pull.state]}</span> : null;
}

/** Beside a session's status in lists, which are links themselves, so this is a label rather than a link. */
export function PullRequestTag({ pull }: { pull: SessionPullRequest }) {
  return <span className={`session-pull${pull.state ? ` ${pullRequestStateTones[pull.state]}` : ""}`} title={pullRequestTitle(pull)}>
    <Icon name="git-pull-request" size={12} />{pullRequestLabel(pull)}{pull.state && <> <PullRequestState pull={pull} /></>}
  </span>;
}

/** The open session's header: a link to its pull request. */
export function PullRequestLink({ pull }: { pull: SessionPullRequest }) {
  return <a className={`badge session-pull-link${pull.state ? ` ${pullRequestStateTones[pull.state]}` : ""}`} href={pull.url} target="_blank" rel="noreferrer" title={pullRequestTitle(pull)}>
    <Icon name="git-pull-request" size={12} />{pull.number === undefined ? "Pull request" : `PR #${pull.number}`}{pull.state && <> · <PullRequestState pull={pull} /></>}<Icon name="external" size={12} />
  </a>;
}
