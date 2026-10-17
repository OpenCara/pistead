import test from "node:test";
import assert from "node:assert/strict";
import { GitRemote } from "../apps/runner/src/git-remote.js";
import { repositoryPath, repositoryRemote, type GitProvider, type SessionRepository } from "../packages/shared/src/repositories.js";

const commit = "a".repeat(40);

function pin(provider: GitProvider, host: string, fullName: string): SessionRepository {
  if (provider === "github") return { bindingId: "binding", repositoryId: 7, fullName, ref: "main", commit, path: fullName };
  const value = { bindingId: "binding", provider, host, repositoryId: "7", fullName, ref: "main", commit };
  return { ...value, path: repositoryPath(value) };
}

test("repository remotes are credential-free https clone URLs for every provider", () => {
  const cases: [SessionRepository, string][] = [
    [pin("github", "github.com", "acme/app"), "https://github.com/acme/app.git"],
    [pin("github-enterprise", "ghe.acme.dev", "acme/app"), "https://ghe.acme.dev/acme/app.git"],
    [pin("gitlab", "gitlab.com", "group/sub/app"), "https://gitlab.com/group/sub/app.git"],
    [pin("bitbucket", "bitbucket.org", "team/app"), "https://bitbucket.org/team/app.git"],
    [pin("azure-devops", "dev.azure.com", "org/My Project/My Repo"), "https://dev.azure.com/org/My%20Project/_git/My%20Repo"],
    [pin("gitea", "git.acme.dev:3000", "acme/tools"), "https://git.acme.dev:3000/acme/tools.git"],
  ];
  for (const [repository, expected] of cases) {
    const remote = repositoryRemote(repository);
    assert.equal(remote, expected);
    const url = new URL(remote);
    assert.equal(url.protocol, "https:");
    assert.deepEqual([url.username, url.password, url.search, url.hash], ["", "", "", ""]);
    // The host's fetch client accepts exactly these URLs.
    assert.doesNotThrow(() => new GitRemote({ url: remote, authorization: "Basic eDp5" }));
  }
});
