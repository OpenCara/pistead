import test from "node:test";
import assert from "node:assert/strict";
import { pullRequestLabel, pullRequestRepository } from "../apps/web/src/pull-request.js";
import { githubPullRequest, pullRequestState } from "../apps/server/src/pull-request-states.js";
import { pullRequestStateLabels } from "../packages/shared/src/pull-requests.js";

test("a pull request URL names its repository on each provider, and nothing it doesn't recognize", () => {
  const cases: [string, string | undefined][] = [
    ["https://github.com/owner/repo/pull/12", "owner/repo"],
    ["https://git.acme.dev/acme/tools/pulls/3", "acme/tools"],
    ["https://gitlab.com/group/sub/project/-/merge_requests/7", "group/sub/project"],
    ["https://bitbucket.org/team/repo/pull-requests/6", "team/repo"],
    ["https://bitbucket.acme.dev/projects/PRJ/repos/service/pull-requests/9", "PRJ/service"],
    ["https://acme.dev/bitbucket/projects/PRJ/repos/service/pull-requests/9/overview", "PRJ/service"],
    ["https://bitbucket.acme.dev/users/jane/repos/dotfiles/pull-requests/2", "jane/dotfiles"],
    ["https://dev.azure.com/contoso/Project/_git/repo/pullrequest/3", "contoso/Project/repo"],
    ["https://dev.azure.com/contoso/My%20Project/_git/repo/pullrequest/3", "contoso/My Project/repo"],
    ["https://example.test/review", undefined],
    ["https://example.test/pull/12", undefined],
    ["https://example.test/%E0%A4%A/repo/pull/1", undefined],
    ["not a url", undefined],
  ];
  for (const [url, repository] of cases) assert.equal(pullRequestRepository(url), repository, url);
  assert.equal(pullRequestLabel({ url: "https://github.com/owner/repo/pull/12", number: 12 }), "#12");
  assert.equal(pullRequestLabel({ url: "https://example.test/review" }), "PR");
});

test("a pull request's state: merged and closed, then draft, then changes requested, then failed CI, otherwise open", () => {
  const open = { state: "open", merged: false, draft: false, reviews: [], checkRuns: [], statuses: [] };
  assert.equal(pullRequestState(open), "open");
  assert.equal(pullRequestState({ ...open, state: "closed", merged: true }), "merged");
  assert.equal(pullRequestState({ ...open, state: "closed" }), "closed");
  const failing = { ...open, checkRuns: [{ status: "completed", conclusion: "failure" }] };
  assert.equal(pullRequestState({ ...failing, draft: true }), "draft");
  assert.equal(pullRequestState(failing), "failing");
  for (const conclusion of ["timed_out", "cancelled", "action_required", "startup_failure"]) {
    assert.equal(pullRequestState({ ...open, checkRuns: [{ status: "completed", conclusion }] }), "failing", conclusion);
  }
  for (const conclusion of ["success", "neutral", "skipped"]) {
    assert.equal(pullRequestState({ ...open, checkRuns: [{ status: "completed", conclusion }] }), "open", conclusion);
  }
  assert.equal(pullRequestState({ ...open, checkRuns: [{ status: "in_progress", conclusion: null }] }), "open", "pending CI is still open");
  assert.equal(pullRequestState({ ...open, statuses: [{ state: "failure" }] }), "failing");
  assert.equal(pullRequestState({ ...open, statuses: [{ state: "pending" }, { state: "success" }] }), "open");

  const requested = { author: "ann", state: "CHANGES_REQUESTED" };
  assert.equal(pullRequestState({ ...failing, reviews: [requested] }), "changes_requested");
  assert.equal(pullRequestState({ ...open, reviews: [requested, { author: "ann", state: "COMMENTED" }] }), "changes_requested", "a comment keeps the decision");
  assert.equal(pullRequestState({ ...open, reviews: [requested, { author: "ann", state: "APPROVED" }] }), "open", "a later approval replaces it");
  assert.equal(pullRequestState({ ...open, reviews: [requested, { author: "ann", state: "DISMISSED" }] }), "open", "a dismissal withdraws it");
  assert.equal(pullRequestState({ ...open, reviews: [requested, { author: "bob", state: "APPROVED" }] }), "changes_requested", "per reviewer");
});

test("only github.com pull request URLs are read", () => {
  assert.deepEqual(githubPullRequest("https://github.com/owner/repo/pull/12"), { fullName: "owner/repo", number: 12 });
  assert.deepEqual(githubPullRequest("https://github.com/my.org/my-repo_1/pull/3/"), { fullName: "my.org/my-repo_1", number: 3 });
  for (const url of ["https://gitlab.com/group/project/-/merge_requests/7", "http://github.com/owner/repo/pull/12", "https://github.com/owner/repo/issues/12",
    "https://github.com/owner/repo/pull/12/files", "not a url"]) assert.equal(githubPullRequest(url), undefined, url);
  assert.equal(pullRequestStateLabels.failing, "CI failed");
  assert.equal(pullRequestStateLabels.changes_requested, "Changes requested");
});
