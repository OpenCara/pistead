import type { PullRequestState } from "./types.js";

export const pullRequestStates: readonly PullRequestState[] = ["draft", "open", "failing", "changes_requested", "merged", "closed"];

/** How lists and headers name a pull request's state. */
export const pullRequestStateLabels: Record<PullRequestState, string> = {
  draft: "Draft",
  open: "Open",
  failing: "CI failed",
  changes_requested: "Changes requested",
  merged: "Merged",
  closed: "Closed",
};

/** The tone a state shows in: needing work is danger, merged is its own (purple, as on GitHub). */
export const pullRequestStateTones: Record<PullRequestState, "neutral" | "success" | "danger" | "merged"> = {
  draft: "neutral",
  open: "success",
  failing: "danger",
  changes_requested: "danger",
  merged: "merged",
  closed: "neutral",
};

export function isPullRequestState(value: unknown): value is PullRequestState {
  return typeof value === "string" && (pullRequestStates as readonly string[]).includes(value);
}
