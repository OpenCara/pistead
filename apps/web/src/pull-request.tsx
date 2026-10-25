import type { SessionPullRequest } from "../../../packages/shared/src/types";
import { Icon } from "./icons";

/** "#12", or "PR" for a pull request URL with no number. */
export function pullRequestLabel(pull: SessionPullRequest): string {
  return pull.number === undefined ? "PR" : `#${pull.number}`;
}

/** Where the pull request lives, for tooltips: "owner/repo" on its host, else the URL. */
function pullRequestTitle(pull: SessionPullRequest): string {
  try {
    const url = new URL(pull.url);
    const path = url.pathname.split("/").filter(Boolean);
    // owner/repo/pull/12, group/project/-/merge_requests/12, team/repo/pull-requests/12, org/project/_git/repo/pullrequest/12
    const marker = path.findIndex(part => ["pull", "pulls", "-", "pull-requests", "merge_requests", "pullrequest"].includes(part));
    const repository = (marker > 0 ? path.slice(0, marker) : path.slice(0, 2)).filter(part => part !== "_git").join("/");
    return `Pull request ${pullRequestLabel(pull)}${repository ? ` in ${repository}` : ""}`;
  } catch { return pull.url; }
}

/** Beside a session's status in lists, which are links themselves, so this is a label rather than a link. */
export function PullRequestTag({ pull }: { pull: SessionPullRequest }) {
  return <span className="session-pull" title={pullRequestTitle(pull)}><Icon name="git-pull-request" size={12} />{pullRequestLabel(pull)}</span>;
}

/** The open session's header: a link to its pull request. */
export function PullRequestLink({ pull }: { pull: SessionPullRequest }) {
  return <a className="badge session-pull-link" href={pull.url} target="_blank" rel="noreferrer" title={pullRequestTitle(pull)}>
    <Icon name="git-pull-request" size={12} />{pull.number === undefined ? "Pull request" : `PR #${pull.number}`}<Icon name="external" size={12} />
  </a>;
}
