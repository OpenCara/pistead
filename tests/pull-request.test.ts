import test from "node:test";
import assert from "node:assert/strict";
import { pullRequestLabel, pullRequestRepository } from "../apps/web/src/pull-request.js";

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
