import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headBranch, originUrl, readCloneBranches, reportedBranches } from "../apps/runner/src/clone-branches.js";
import type { EgressRepository } from "../packages/shared/src/network.js";

/** A clone's Git metadata as git clone leaves it, on `branch`, with origin `url` whose default branch is `remoteHead`. */
async function clone(root: string, path: string, options: { branch?: string; detached?: boolean; url?: string; remoteHead?: string | null }): Promise<void> {
  const git = join(root, path, ".git");
  await mkdir(join(git, "refs", "remotes", "origin"), { recursive: true });
  await writeFile(join(git, "HEAD"), options.detached ? `${"a".repeat(40)}\n` : `ref: refs/heads/${options.branch ?? "main"}\n`);
  await writeFile(join(git, "config"), options.url === undefined ? "[core]\n\tbare = false\n"
    : `[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/elsewhere/repo.git\n[remote "origin"]\n\turl = ${options.url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n`);
  if (options.remoteHead !== null) await writeFile(join(git, "refs", "remotes", "origin", "HEAD"), `ref: refs/remotes/origin/${options.remoteHead ?? "main"}\n`);
}

test("a clone's branch, origin and default branch are read from its Git files", () => {
  assert.equal(headBranch("ref: refs/heads/feature/x\n"), "feature/x");
  assert.equal(headBranch(`${"a".repeat(40)}\n`), undefined, "detached");
  assert.equal(headBranch("ref: refs/heads/-option\n"), undefined);
  assert.equal(headBranch("ref: refs/remotes/origin/main\n", "refs/remotes/origin/"), "main");
  assert.equal(originUrl('[remote "origin"]\n\turl = git@github.com:owner/repo.git\n\turl = https://second.example/repo\n'), "git@github.com:owner/repo.git");
  assert.equal(originUrl('[remote "upstream"]\n\turl = https://github.com/a/b\n'), undefined);
  assert.equal(originUrl('[Remote "origin"] \n  URL = "https://github.com/owner/repo"\n'), "https://github.com/owner/repo");
  // Values as Git writes and reads them: Git for Windows writes a local path's backslashes escaped; comments end a value.
  assert.equal(originUrl('[remote "origin"]\n\turl = C:\\\\Users\\\\me\\\\upstream\n'), "C:\\Users\\me\\upstream");
  assert.equal(originUrl('[remote "origin"]\n\turl = "https://x.example/a b" ; a comment\n'), "https://x.example/a b");
  assert.equal(originUrl('[remote "origin"]\n\turl = git@github.com:owner/repo.git # a comment\n'), "git@github.com:owner/repo.git");
});

test("the worktree's clones report their checked-out branches of the workspace's github.com repositories", async t => {
  const root = await mkdtemp(join(tmpdir(), "clone-branches-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // The worktree's own repository is Pistead's, not a clone.
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/session\n");
  await clone(root, "app", { branch: "fix/login", url: "https://github.com/Owner/Repo.git" });
  await clone(root, "src/tools", { branch: "feature", url: "git@github.com:owner/tools.git" });
  await clone(root, "work/a/b/c/deep", { branch: "too-deep", url: "https://github.com/owner/repo" });
  await clone(root, "on-main", { branch: "main", url: "https://github.com/owner/repo" });
  await clone(root, "develop-default", { branch: "main", url: "https://github.com/owner/repo", remoteHead: "develop" });
  await clone(root, "no-remote-head", { branch: "master", url: "https://github.com/owner/repo", remoteHead: null });
  await clone(root, "detached", { detached: true, url: "https://github.com/owner/repo" });
  await clone(root, "no-origin", { branch: "feature" });
  await clone(root, "node_modules/dependency", { branch: "feature", url: "https://github.com/owner/repo" });
  await clone(root, "elsewhere", { branch: "x", url: "https://gitlab.com/owner/repo.git" });
  // A clone's own directories are its work, and symlinks are not followed.
  await clone(root, "app/nested", { branch: "inner", url: "https://github.com/owner/repo" });
  // A linked worktree or submodule has a .git file: neither it nor what's under it is reported.
  await mkdir(join(root, "linked-worktree"), { recursive: true });
  await writeFile(join(root, "linked-worktree", ".git"), "gitdir: /elsewhere/.git/worktrees/linked\n");
  await clone(root, "linked-worktree/inner", { branch: "inner", url: "https://github.com/owner/repo" });
  await clone(join(root, ".."), `${root.split("/").at(-1)}-outside`, { branch: "outside", url: "https://github.com/owner/repo" });
  t.after(() => rm(`${root}-outside`, { recursive: true, force: true }));
  await symlink(`${root}-outside`, join(root, "linked"));

  const clones = await readCloneBranches(root);
  assert.deepEqual(clones, [
    { directory: "app", origin: "https://github.com/Owner/Repo.git", branch: "fix/login" },
    { directory: "develop-default", origin: "https://github.com/owner/repo", branch: "main" },
    { directory: "elsewhere", origin: "https://gitlab.com/owner/repo.git", branch: "x" },
    { directory: "src/tools", origin: "git@github.com:owner/tools.git", branch: "feature" },
  ]);
  const repositories: EgressRepository[] = [
    { bindingId: "binding-1", provider: "github", host: "github.com", fullName: "owner/repo" },
    { bindingId: "binding-2", provider: "github", host: "github.com", fullName: "owner/tools" },
    { bindingId: "binding-3", provider: "gitlab", host: "gitlab.com", fullName: "owner/repo" },
  ];
  assert.deepEqual(reportedBranches(clones, repositories), [
    { repository: "owner/repo", branch: "fix/login" },
    { repository: "owner/repo", branch: "main" },
    { repository: "owner/tools", branch: "feature" },
  ], "only github.com repositories of the workspace, by the workspace's name, sorted");
  assert.deepEqual(reportedBranches(clones, []), []);
});
