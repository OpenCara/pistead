# pistead

Connect your Linux or WSL2 Pi host to a [Pistead](https://pistead.com) workspace. The connector uses outbound WebSocket only; no inbound port or tunnel is needed.

## Requirements

- Linux or WSL2 (native Windows is unsupported)
- Node.js 24 or newer
- Pi configured locally with the providers and models you want to offer
- `bubblewrap`, Python 3, Git and `flock` (util-linux)

## Usage

In Pistead, open **Settings → Hosts → Pair a host**, choose a workspace and create a pairing code. Then run, on the Pi host:

```sh
npx pistead@latest connect --server https://pistead.com --pairing-id PAIRING_ID
```

Enter the single-use code when prompted; it is never accepted as an argument and expires after 10 minutes. Later runs reuse the private saved connector token, kept in `~/.local/share/pistead/connector` (`--state-dir` chooses another directory):

```sh
npx pistead@latest connect
```

To pair the machine again, for example after revoking its host in Pistead or to move it to another workspace or server, create a new pairing code and add `--force` to its command:

```sh
npx pistead@latest connect --server https://pistead.com --pairing-id PAIRING_ID --force
```

The saved token is replaced only once the new code is accepted. The old host stays in **Settings → Hosts**, offline, until you revoke it there; its sessions are not moved to the new host.

Connector 0.8.0 moved the default state directory from `~/.local/share/opencara/connector` to `~/.local/share/pistead/connector` without moving anything: to keep a pairing made by an older connector, run `npx pistead@latest connect --state-dir ~/.local/share/opencara/connector`, or pair the machine again.

Run `npx pistead connect --help` for all options. The connector takes only what pairing and this machine's own setup need (`--state-dir`, `--pi-agent-dir`, `--model`, `--resources`, `--unsafe-no-sandbox`).

## Host configuration

Everything else about how the host runs sessions is set in the web app, on the host's page under **Settings → Hosts → the host → Configuration**, and reaches running sessions within a minute:

- **Command time limit**: how long a shell command may run, from 30 seconds (the default) to an hour. A longer limit also lifts the per-process limits of short commands (25 seconds of CPU, 64 MiB per file, 256 open files) so builds fit. Set by the host's owner or its admins.
- **GPU**: sandboxed commands get the host's GPU render device for offscreen rendering and compute: `/dev/dxg` on WSL2 (install Mesa's `vulkan-dzn` there for Vulkan), or Linux DRM render nodes. Never the screen, windows or input. Offered only where the connector found such a device. Set by the host's owner or its admins.
- **Git credentials** and **Repository cache**: see below. Only the host's owner changes them.

`--git-credentials`, `--repo-cache` and `--repo-cache-scope` are still accepted, so existing service units keep starting, but ignored: a host that used them keeps those settings in its configuration.

Workspace repositories can come from GitHub, GitHub Enterprise Server, GitLab (gitlab.com or self-managed), Bitbucket Cloud, Azure DevOps and Gitea/Forgejo. Connect the non-GitHub accounts in the web app under **Settings → Profile → Git accounts** with personal access tokens. Sessions read the repositories through the Pistead server, which uses those tokens; the connector never receives them.

Model credentials stay in Pi on your host. Pairing keeps the host private to you; sharing it with a workspace is a separate, explicit action in the web app.

The connector offers the models matched by `enabledModels` in Pi's `settings.json` (the same patterns Pi uses for model cycling, e.g. `"anthropic/*"`, `"*/claude-opus-5-5*"`), or every authenticated Pi model when that list is unset. `--model PROVIDER/MODEL` (repeatable) overrides both. In the web app, you and the host's admins can also disable any of these models, for everyone who uses the host, without restarting the connector (**Settings → Hosts →** the host **→ Models**).

## Host commands from chat

Ask the agent to use `host_bash` when you need a host-installed SDK or network access, for example `dotnet --info`. Ordinary `bash` remains in the offline sandbox; a missing SDK does not silently turn a sandbox command into a host command. Update the connector to a version advertising `hostCommands` to expose this tool.

**Host commands run outside the sandbox as the connector's OS user.** They can read or change host files and credentials, access the network, and launch other processes. They have no CPU, memory, process-count or disk quotas. Pistead passes the host's `PATH` and `HOME`, not the connector's entire environment, and starts Bash without shell profiles, in the session worktree. Use an absolute SDK path or configure the connector's `PATH` if a tool is only available in your interactive shell.

Commands run in the session's worktree, whose files and Git configuration the agent can change: builds, package scripts, Git hooks and settings such as `core.fsmonitor` there can run the agent's code on the host, even for a command that looks harmless like `git status`. Approve a host command only if you would run it yourself in that directory.

Each exact command and timeout needs the approval of the **host owner**, or of a member they (or one of the host's admins) granted host commands, in the session. On a shared host, the approver must also have approve access to the session. The session owner's **Auto-approve** skips this decision only when they own the host too, or hold an automatic host command grant on it; without one it never authorizes commands on someone else's host. Commands default to a five-minute timeout (`timeout_seconds`, 1-3600); timeout, cancellation and output limits terminate the process group, but cannot contain an unrestricted command that deliberately detaches processes.

## macOS and hosts without bubblewrap

The isolated sandbox needs Linux. On macOS, or Linux without bubblewrap, you can opt out of isolation:

```sh
npx pistead@latest connect --unsafe-no-sandbox
```

This needs only Git on your `PATH` (on macOS: `xcode-select --install` or `brew install git`). The connector prints the risks and asks you to type `unsandboxed` before starting:

- Approved shell commands run directly as your user, with access to your files, credentials (`~/.ssh`, cloud and Git config, Pi's auth) and network, and no CPU, memory or disk limits.
- File tools are confined to each session folder by path checks only.
- Anyone you share the Pi with, and anyone granted approve permission on a session that runs on it, can cause approved commands to run on your machine.

Every command needs an exact human approval unless the session's owner turns on **Auto-approve** in the chat box; then that owner's commands, pushes, GitHub comments, merges and issues run immediately. Pistead labels the host **Unsandboxed** to everyone who can see it.

## Repository cache (preview)

Every session starts with an empty worktree, and its agent clones the workspace repositories it needs. With **Repository cache** set to **Shared** (one cache for every session on this host) or **Per owner** (a separate cache for each session owner) in the host's configuration, the connector keeps a full mirror of each repository on the host, so clones borrow its objects instead of downloading everything again. A change applies when the connector next connects.

- `git clone` of a workspace repository in a sandboxed session borrows the cached objects (`--reference-if-able`) after bringing the mirror up to date through Pistead, with the session owner's own account. The host uses no Git credential of its own for this. A session sees a mirror, read-only, only while Pistead lets its owner read the repository.
- `npx pistead@latest cache list` shows the cached repositories and their sizes; `npx pistead@latest cache prune --older-than 30` forgets clone sessions idle for longer and collects what nothing reaches any more (their clones lose the objects they borrowed). Pins of sessions from before every session cloned are kept.
- It needs a Pistead server that supports the repository cache; older servers refuse the connector's manifest.

## Pushing commits

In a session that clones on demand, agents push their work to the session's own branch, named for its work (`pistead/<title-slug>-<short id>`, for example `pistead/add-dark-mode-1a2b3c4d5e6f`), with plain `git push` and no approval; Pistead pushes it with the workspace's push identity below. Agents with the `git_push` tool push a clone's checked-out commit, as it is, to any other branch of the workspace repository it was cloned from. A push needs an approval that shows the repository, the branch and the exact commit, unless the session owner chose **Auto-approve** for that message. Pushes are fast-forward only and never forced, and send only the objects the branch doesn't have. On a host without the sandbox, the agent pushes with the host's own Git instead, each command with approval. The agent can also ask for a pull request; Pistead opens it as the session owner with the owner's connected account (non-GitHub tokens then need write scopes: GitHub Enterprise pull requests write, GitLab `api`, Bitbucket `write:pullrequest:bitbucket`, Azure DevOps Code (Read & write), Gitea `write:repository`).

For each push, Pistead checks with the session owner's own account that the owner may push to the repository and, where the Git host reports it, to that branch (GitLab, Gitea/Forgejo and Azure DevOps branch permissions; GitHub protected branches are refused). Bitbucket owners need an Atlassian API token connected with their account email for this check. Pistead then issues a credential for that push from the push identity that a workspace owner or admin sets up for the provider under **Settings → Workspaces → Push access**: usually a short-lived token minted from an app or bot, as below. The connector keeps the credential in memory only and talks to the Git host directly, so large files never pass through the Pistead server, and the agent's shell and sandbox never see the credential.

| Provider | Push identity | Token |
|---|---|---|
| GitHub | The Pistead GitHub App installed on the repository, or your own GitHub App | 1 hour, this repository only, revoked after the push |
| GitHub Enterprise Server | A GitHub App registered on your server | 1 hour, this repository only, revoked after the push |
| GitLab | An OAuth application authorized once by a bot account (`write_repository read_user`) | Up to 2 hours, the bot's projects |
| Bitbucket Cloud | An OAuth consumer of the Bitbucket workspace with Repositories: Write | 1–2 hours as Bitbucket issues it, the workspace's repositories |
| Azure DevOps | A Microsoft Entra app with a federated credential that trusts Pistead, its service principal added to the organization | About 1 hour, what you grant the service principal |
| Forgejo v16 or newer | A Generic JWT Authorized Integration that trusts Pistead | 10 minutes, what the integration allows |
| Gitea 1.23 or newer | An OAuth2 application authorized once by a bot account (`write:repository read:user`) | Up to 1 hour, the bot's repositories |

Except for GitHub, a push token carries everything its identity can reach until it expires, and the host that runs the session receives it. Give each bot, consumer, service principal or integration access to the workspace's repositories only; a Forgejo integration can also require the `repository` and `ref` claims Pistead adds to each token. Workspace owners and admins can forbid agent pushes to a repository's default branch, and removing a repository from the workspace stops pushes from sessions pinned to it.

Instead of an app or bot, a provider's push identity can be one of these. Both push only from sessions running on the session owner's own hosts, so no one's credentials reach anyone else's machine; elsewhere the push is refused and needs an app or bot identity:

- **Session owner's account**: the push uses the account the session owner connected to Pistead, the GitHub sign-in or the token under **Settings → Profile → Git accounts**, which then needs write scopes (GitHub Enterprise Contents write, GitLab `write_repository`, Bitbucket `write:repository:bitbucket`, Azure DevOps Code (Read & write), Gitea `write:repository`). Your account tokens otherwise never reach the connector: with this identity your own host receives yours for each push in your sessions. Pistead resets a GitHub token through its OAuth app when the push ends, so the host's copy stops working while you stay connected; if the host never reports the push, the reset follows about an hour later. Tokens for the other providers can't be reset and stay valid after the push.
- **Host's Git credentials** (connector 0.6.0 or newer): the connector reads the HTTPS credentials Git on the host would use for the repository, through its credential helpers (for example after `gh auth setup-git`, or from the macOS keychain or Git Credential Manager), without ever prompting. Pistead sends no credential. The host's owner turns on **Git credentials** in its configuration; then only their own sessions on that host push this way.

Pull requests are still opened as the session owner, with the owner's connected account.

## GitHub issues and pull requests

The sandbox has no network, so `gh` and `curl` inside it can't reach GitHub. Agents read and act on GitHub through Pistead instead, as the session owner and with the owner's GitHub sign-in, which stays on the Pistead server: the host and the sandbox never see it. These tools need connector 0.7.0 or newer; an agent whose tools predate them asks the session owner the first time, with the permission card described below. GitHub Enterprise and other providers are not covered.

- `github_read` reads an issue or pull request of one of the workspace's github.com repositories: its description and comments, and for a pull request its merge state, head commit, reviews, review comments with file, line and diff hunk, and checks. Long threads keep their newest items. Like any repository content, what it returns is untrusted input. A read needs no approval, but only runs during a write message (until an hour after it was sent), and each read is recorded in the session's audit log.
- `github_merge` merges a pull request of one of those repositories at the exact head commit the agent read, with a merge commit, squash or rebase. It waits for a human approval unless the session owner's message chose **Auto-approve** (in older Pistead apps, with their **Auto-merge** option on too). If the head moved or GitHub refuses (failing checks, missing reviews, conflicts, a method the repository doesn't allow), nothing is merged and the agent gets GitHub's reason.
- `github_comment` posts a comment. It waits for a human approval unless the session owner's message chose **Auto-approve**.
- `github_issue` opens an issue with exactly the approved title and body in one of those repositories, and gives the agent its number and URL (connector newer than 0.9.0). It waits for a human approval unless the session owner's message chose **Auto-approve**. If GitHub refuses (issues turned off, no access), no issue is opened and the agent gets GitHub's reason.

## Chat options

In a session's chat box you can pick any model this host's Pi offers that isn't disabled in the web app, its reasoning level, and the access mode for each message: **Read only**, **Ask before acting** (the default) or **Auto-approve** (session owner only). Hosts running a connector older than 0.3.0 keep each session's pinned model; restart the connector with `npx pistead@latest connect` to enable the options.

A model starts at the reasoning level Pi on the host gives it: the level in its `enabledModels` pattern (such as `"anthropic/*:high"`), else its entry in `modelThinkingLevels`, else `defaultThinkingLevel`, else Pi's default (medium), moved to the nearest level the model supports. The chat box shows that level when you pick the model (connector 0.5.1 or newer). The levels on offer are the ones Pi reports for the model. If the host's `models.json` redefines a model without its `thinkingLevelMap`, Pi offers only Off to High for it.

Agents change files with `edit_file`, which replaces exact text in place, or with `write_file`, which writes a whole file. `edit_file` needs connector 0.5.1 or newer.

A new session starts from a host and one of its models, and gets every tool that host supports with no extra instructions. The access mode still decides what runs without asking.

When a call needs more than the session allows, the agent asks instead of failing (connector 0.6.0 or newer): a tool its agent doesn't include, a change in a **Read only** message, or a shell command on a sandboxed host without resource limits. The session owner gets a card with **Allow once**, **Allow for this session** and **Deny**. The call can wait for the answer until an hour after the message was sent, and the session's queue waits with it. Allowing a tool doesn't approve what it does: commands, commits, pushes, GitHub comments, merges and issues still need their own approval unless the message auto-approves. A message the session owner sends with **Auto-approve** asks none of this (connector 0.7.1 or newer): its calls go ahead at once, for that message only. Only the host's owner can let commands run without resource limits, and only in their own sessions: they still run in the sandbox, offline and for at most the host's command time limit, but with no cap on CPU, memory, processes or disk. A session restored from a backup asks again.

## Session status

The session list shows what each session's agent is doing, as its host reports it: **In progress** while a message is queued or running, **Needs approval** while a permission card holds the work or, once the work stops, an operation awaits its approval, then **Done** or **Failed** for how the latest shared message ended. Side asks don't change done or failed. Hosts report this with connectors newer than 0.7.1; restart an older one with `npx pistead@latest connect` to show it.

## License

MIT
