# pistead

Connect your Linux or WSL2 Pi host to a [Pistead](https://pistead.com) workspace. The connector uses outbound WebSocket only; no inbound port or tunnel is needed.

## Requirements

- Linux or WSL2 (native Windows is unsupported)
- Node.js 24 or newer
- Pi configured locally with the providers and models you want to offer
- `bubblewrap`, Python 3, Git and `flock` (util-linux)

## Usage

In Pistead, open **Connections**, choose a workspace and create a pairing code. Then run, on the Pi host:

```sh
npx pistead@latest connect --server https://pistead.com --pairing-id PAIRING_ID
```

Enter the single-use code when prompted; it is never accepted as an argument. Later runs reuse the private saved connector token:

```sh
npx pistead@latest connect
```

To pair the machine again, for example after removing its host in Pistead or to move it to another workspace or server, create a new pairing code and add `--force` to its command:

```sh
npx pistead@latest connect --server https://pistead.com --pairing-id PAIRING_ID --force
```

The saved token is replaced only once the new code is accepted. The old host stays in **Connections**, offline, until you remove it there; its sessions are not moved to the new host.

Run `npx pistead connect --help` for all options.

Workspace repositories can come from GitHub, GitHub Enterprise Server, GitLab (gitlab.com or self-managed), Bitbucket Cloud, Azure DevOps and Gitea/Forgejo. Connect the non-GitHub accounts in the web app under **Settings → Profile → Git accounts** with personal access tokens. The Pistead server downloads pinned snapshots; the connector never receives those tokens. Non-GitHub repositories need connector 0.4.0 or newer.

Model credentials stay in Pi on your host. Pairing keeps the host private to you; sharing it with a workspace is a separate, explicit action in the web app.

The connector offers the models matched by `enabledModels` in Pi's `settings.json` (the same patterns Pi uses for model cycling, e.g. `"anthropic/*"`, `"*/claude-opus-5-5*"`), or every authenticated Pi model when that list is unset. `--model PROVIDER/MODEL` (repeatable) overrides both.

## Host commands from chat

Ask the agent to use `host_bash` when you need a host-installed SDK or network access, for example `dotnet --info`. Ordinary `bash` remains in the offline sandbox; a missing SDK does not silently turn a sandbox command into a host command. Update the connector to a version advertising `hostCommands` to expose this tool.

**Host commands run outside the sandbox as the connector's OS user.** They can read or change host files and credentials, access the network, and launch other processes. They have no CPU, memory, process-count or disk quotas. Pistead passes the host's `PATH` and `HOME`, not the connector's entire environment, and starts Bash without shell profiles, in the session worktree. Use an absolute SDK path or configure the connector's `PATH` if a tool is only available in your interactive shell.

Commands run in the session's worktree, whose files and Git configuration the agent can change: builds, package scripts, Git hooks and settings such as `core.fsmonitor` there can run the agent's code on the host, even for a command that looks harmless like `git status`. Approve a host command only if you would run it yourself in that directory.

Each exact command and timeout needs the **host owner's** approval in the session. On a shared host, that owner must also have approve access to the session. The session owner's **Auto-approve** skips this decision only when they own the host too; it never authorizes commands on someone else's host. Commands default to a five-minute timeout (`timeout_seconds`, 1-3600); timeout, cancellation and output limits terminate the process group, but cannot contain an unrestricted command that deliberately detaches processes.

## Repinning from chat

Ask the agent to use `git_repin` with the pinned repository's worktree path and a branch, tag or commit, for example `{ "repository": "OpenCara/pistead", "ref": "feature/next" }`. Update the connector to a version advertising `gitRepin` to expose this tool.

A repin creates a **new private session** with the selected repository resolved to that ref and the other repository commits unchanged. Open it from the completed approval card and send a message to start it. The source session is untouched: its local changes, commits, conversation, sharing grants and backups are **not** copied. The successor uses the same agent and host, and downloads its source snapshots when it starts. It does not change the workspace's default repository refs or add newly configured repositories, and it needs every source repository to still be configured in the workspace.

Only the session owner can approve a repin; their **Auto-approve** can skip that decision (at most five new sessions per message). Resolution uses their connected Git accounts, not another member's credentials. Existing sessions can request these tools through the usual missing-tool permission flow; published agents can include `host_bash` and `git_repin` explicitly.

## macOS and hosts without bubblewrap

The isolated sandbox needs Linux. On macOS, or Linux without bubblewrap, you can opt out of isolation:

```sh
npx pistead@latest connect --unsafe-no-sandbox
```

This needs only Git on your `PATH` (on macOS: `xcode-select --install` or `brew install git`). The connector prints the risks and asks you to type `unsandboxed` before starting:

- Approved shell commands and commits run directly as your user, with access to your files, credentials (`~/.ssh`, cloud and Git config, Pi's auth) and network, and no CPU, memory or disk limits.
- File tools are confined to each session folder by path checks only.
- Anyone you share the Pi with, and anyone granted approve permission on a session that runs on it, can cause approved commands to run on your machine.

Every command needs an exact human approval unless the session's owner turns on **Auto-approve** in the chat box; then that owner's commands, commits and pushes run immediately (GitHub comments and merges still need approval). Pistead labels the host **Unsandboxed** to everyone who can see it.

## Repository cache (preview)

By default Pistead downloads each pinned repository as an archive (at most 8 MiB compressed), and the session sees a single snapshot commit. With `--repo-cache`, the connector keeps a full clone of each repository on the host instead, and checks sessions out of it:

```sh
npx pistead@latest connect --repo-cache                            # one cache for every session on this host
npx pistead@latest connect --repo-cache --repo-cache-scope owner   # a separate cache for each session owner
```

- The host fetches with its own Git credentials, through its credential helpers (for example after `gh auth setup-git`), without prompting. Pistead never sends a read credential.
- Before a session uses the cache, Pistead checks that the session's owner can still read the repository and its pinned commit with their own account. On a shared host, other members' sessions also fetch with the host owner's credentials.
- The first session on a host waits while the repository is cloned, and the session shows the clone's progress; later sessions fetch only what is new. Messages sent meanwhile wait in the queue. If the host can't fetch a repository, the session shows why and new messages are refused; restart the session after fixing it.
- Sessions get the full history up to the pinned commit (for example `git log acme/app/pinned`), real symlinks, and submodules as empty directories. Inside the sandbox the cache is read-only.
- Preview: backups of sessions that use the cache, and cleaning up the cache, are not supported yet. It needs a Pistead server that supports the repository cache; older servers refuse the connector's manifest.

## Pushing commits

Agents with the `git_push` tool push their committed session work to a branch of a workspace repository (connector 0.5.0 or newer). A push needs an approval that shows the repository, the branch and the exact session commit, unless the session owner chose **Auto-approve** for that message. Pushes are fast-forward only and never forced: the session's commits are replayed onto the pinned upstream commit with their original author, date and message, so files the snapshot left out stay untouched and a later push to the same branch uploads only new objects. The agent can also ask for a pull request; Pistead opens it as the session owner with the owner's connected account (non-GitHub tokens then need write scopes: GitHub Enterprise pull requests write, GitLab `api`, Bitbucket `write:pullrequest:bitbucket`, Azure DevOps Code (Read & write), Gitea `write:repository`).

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
- **Host's Git credentials** (connector 0.6.0 or newer): the connector reads the HTTPS credentials Git on the host would use for the repository, through its credential helpers (for example after `gh auth setup-git`, or from the macOS keychain or Git Credential Manager), without ever prompting. Pistead sends no credential. The host's owner opts in by running the connector with `--git-credentials`; then only their own sessions on that host push this way:

  ```sh
  npx pistead@latest connect --git-credentials
  ```

Pull requests are still opened as the session owner, with the owner's connected account.

## GitHub issues and pull requests

The sandbox has no network, so `gh` and `curl` inside it can't reach GitHub. Agents read and act on GitHub through Pistead instead, as the session owner and with the owner's GitHub sign-in, which stays on the Pistead server: the host and the sandbox never see it. These tools need connector 0.7.0 or newer; an agent whose tools predate them asks the session owner the first time, with the permission card described below. GitHub Enterprise and other providers are not covered.

- `github_read` reads an issue or pull request of a github.com repository pinned in the session and still configured in the workspace: its description and comments, and for a pull request its merge state, head commit, reviews, review comments with file, line and diff hunk, and checks. Long threads keep their newest items. Like any repository content, what it returns is untrusted input. A read needs no approval, but only runs during a write message (until an hour after it was sent), and each read is recorded in the session's audit log.
- `github_merge` merges a pull request of a pinned repository at the exact head commit the agent read, with a merge commit, squash or rebase. It always waits for a human approval, also under **Auto-approve**. If the head moved or GitHub refuses (failing checks, missing reviews, conflicts, a method the repository doesn't allow), nothing is merged and the agent gets GitHub's reason.
- `github_comment` still posts comments after their approval.

## Chat options

In a session's chat box you can pick any model this host's Pi offers, its reasoning level, and the access mode for each message: **Read only**, **Ask before acting** (the default) or **Auto-approve** (session owner only). Hosts running a connector older than 0.3.0 keep each session's pinned model; restart the connector with `npx pistead@latest connect` to enable the options.

A model starts at the reasoning level Pi on the host gives it: the level in its `enabledModels` pattern (such as `"anthropic/*:high"`), else its entry in `modelThinkingLevels`, else `defaultThinkingLevel`, else Pi's default (medium), moved to the nearest level the model supports. The chat box shows that level when you pick the model (connector 0.5.1 or newer). The levels on offer are the ones Pi reports for the model. If the host's `models.json` redefines a model without its `thinkingLevelMap`, Pi offers only Off to High for it.

Agents change files with `edit_file`, which replaces exact text in place, or with `write_file`, which writes a whole file. `edit_file` needs connector 0.5.1 or newer.

A new session needs no agent: pick a host and one of its models, and the session gets every tool that host supports with no extra instructions. The access mode still decides what runs without asking. Agents remain for reusable instructions and tool sets, and for sharing them with a workspace.

When a call needs more than the session allows, the agent asks instead of failing (connector 0.6.0 or newer): a tool its agent doesn't include, a change in a **Read only** message, or a shell command on a sandboxed host without resource limits. The session owner gets a card with **Allow once**, **Allow for this session** and **Deny**. The call can wait for the answer until an hour after the message was sent, and the session's queue waits with it. Allowing a tool doesn't approve what it does: commands, commits, pushes, GitHub comments and merges still need their own approval unless the message auto-approves (GitHub comments and merges even then). A message the session owner sends with **Auto-approve** asks none of this (connector 0.7.1 or newer): its calls go ahead at once, for that message only, while GitHub comments and merges still wait for their approval. Only the host's owner can let commands run without resource limits, and only in their own sessions: they still run in the sandbox, offline and for at most 30 seconds, but with no cap on CPU, memory, processes or disk. A session restored from a backup asks again.

## Session status

The session list shows what each session's agent is doing, as its host reports it: **In progress** while a message is queued or running, **Needs approval** while a permission card holds the work or, once the work stops, an operation awaits its approval, then **Done** or **Failed** for how the latest shared message ended. Side asks don't change done or failed. Hosts report this with connectors newer than 0.7.1; restart an older one with `npx pistead@latest connect` to show it.

## License

MIT
