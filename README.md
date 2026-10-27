# Pistead

Run [Pi](https://github.com/earendil-works/pi) coding agents on your own machines and work on them together with your team. Pistead is a self-hosted control plane: a web app (with iPhone, iPad and Mac apps), a Node.js server, and the `pistead` connector that each host runs to offer its local Pi to a workspace.

Two things set it apart:

- **One subscription, the whole team.** Pair a machine where Pi is signed in to your model provider, share it with a workspace, and every teammate can start their own sessions on its models. They never see its API keys or subscription login: those stay on the host. Each session still runs as the member who started it, with their own Git accounts, so the team shares the models and not each other's identities. See [Sharing a host](#sharing-a-host).
- **Share a chat session, with exactly the permissions you choose.** Every session is a live conversation teammates can follow. Make it visible to the workspace or keep it private, then give people exactly what they need: `read` to watch, `ask` for side questions that don't touch the work, `write` to drive it, `approve` to decide its commands and pushes, `manage` to share it further. A read-only link can show the conversation to anyone, even without signing in. See [Collaborating on a session](#collaborating-on-a-session).

<p align="center">
  <img src="docs/images/team-collaboration.svg" alt="Alice shares her host, where Pi is signed in to a model provider, with the workspace. Bob starts a session on it that runs as Bob. Carol can write and approve, Dan sends side asks, Erin reads, and anyone with the share link follows the conversation read-only." width="900">
</p>

And around them:

- **Your machines, your models.** Sessions run on members' own hosts with the models and credentials configured in Pi there. A host connects over an outbound WebSocket: no inbound port or tunnel.
- **Isolated work.** Each session clones the workspace's repositories into its own sandbox, whose only way out is a proxy that reads them with the session owner's account and follows the workspace's network policy.
- **People decide.** Shell commands, commits, pushes, GitHub comments, merges and new issues wait for an approval unless the session owner auto-approves a message.
- **Built for teams.** Workspace roles (viewer, member, collaborator, admin) set what each person can do by default, and session grants add more for one session at a time.

## Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Using Pistead](#using-pistead)
  - [Signing in and your profile](#signing-in-and-your-profile)
  - [Workspaces and members](#workspaces-and-members)
  - [Repositories and Git accounts](#repositories-and-git-accounts)
  - [Hosts](#hosts)
  - [Models and tools](#models-and-tools)
  - [Sessions](#sessions)
  - [Approvals and permission requests](#approvals-and-permission-requests)
  - [Collaborating on a session](#collaborating-on-a-session)
  - [Commits, pushes and pull requests](#commits-pushes-and-pull-requests)
  - [GitHub issues and pull requests](#github-issues-and-pull-requests)
  - [Host commands](#host-commands)
  - [Backups, restores and exports](#backups-restores-and-exports)
  - [Moving a session to another host](#moving-a-session-to-another-host)
  - [iPhone, iPad and Mac apps](#iphone-ipad-and-mac-apps)
- [Running the server](#running-the-server)
- [Development](#development)
- [Layout](#layout)

## How it works

```text
 web app, iPhone/iPad and Mac apps ──HTTPS──▶ Pistead server ◀──outbound WebSocket── pistead connector + Pi
                                              (control plane)                        (a member's host)
```

- The **server** keeps workspaces, members, session records, permissions and approvals. It relays sessions' Git reads with the session owner's Git account and their session-branch pushes with the workspace's push identity, issues short-lived push credentials, and acts on GitHub for session owners. It never runs an agent itself.
- A **host** runs the agents. Pi's configuration and model credentials, each session's files and its conversation stay there; the server relays every request to it. While a host is offline, its sessions' conversations can't load and no work runs on them.
- Everyone watching a session shares the server's reads of it, about one a second, and after the first read the host, the server and the apps send each other only what changed in the conversation.
- The web app is the complete client; the Mac app shows it in its own window, and the iPhone and iPad app covers sessions (see [iPhone, iPad and Mac apps](#iphone-ipad-and-mac-apps)). They all call the same API.

| Concept | What it is |
|---|---|
| Workspace | A team's shared home: members, repositories, push access and sessions. Each member is its owner, an admin, a collaborator, a member or a viewer. |
| Host | A machine running the `pistead` connector (or the Mac app) next to Pi. It belongs to the member who paired it, not to a workspace: they can use it in every workspace they belong to, and it stays private to them until they share it with one. |
| Model | A Pi model a host offers. Its credentials never leave the host. |
| Agent | The Pi agent that works in a session, on the model it started from, with every tool its host supports. Each session has its own. |
| Session | One agent conversation on one host, in its own worktree where the agent clones the workspace's repositories. It always runs as its owner. |
| Shared message, side ask | Shared messages drive the session's work; side asks are read-only questions in separate threads. |
| Approval | A card for one exact operation (command, push, merge, comment or host command), which runs only once someone allowed to decide it approves it. |
| Permission request | A card asking the session owner to let a tool call do more than the session allows. |

## Quick start

1. **Run the server** with Docker and a GitHub OAuth app: see [Running the server](#running-the-server).
2. **Sign in** with **Continue with GitHub**, then choose **New workspace** and name it.
3. **Bind a repository**: **Settings → Workspaces →** your workspace **→ Repositories → Add repository**. Pick the account, the repository and optionally a branch, tag or commit, then **Bind repository**.
4. **Pair a host**: on a Linux or WSL2 machine with Node.js 24, Pi configured with at least one model, and `bubblewrap`, Python 3, Git and `flock` installed, open **Settings → Hosts → Pair a host**, name the host and **Create pairing code** (a host isn't paired into a workspace: it is yours, in each of your workspaces). Run the command it shows on the host and type the code at the hidden prompt:

   ```sh
   npx pistead@latest connect --server https://pistead.example.com --pairing-id PAIRING_ID
   ```

5. **Start a session**: select the workspace in the sidebar, choose your host in **Host**, describe the task and press Enter.
6. **Approve** commands and commits as their cards appear above the transcript.

To bring in teammates, they sign in once and send you their **User ID** from **Settings → Profile**; add them under **Settings → Workspaces → Members → Add member**. To let them run sessions on your machine, share your host with the workspace under **Settings → Hosts →** your host **→ Sharing**. Each workspace page shows a **Setup** checklist (**Bind a repository**, **Pair a host**, **Start a session**) until all three are done.

## Using Pistead

### Signing in and your profile

Pistead signs people in with GitHub only, and asks GitHub for the `read:user user:email repo workflow` scopes. That token is kept encrypted on the server and used to read your repositories, open your pull requests and act on GitHub for your sessions; it reaches a host only when a push uses your own account. A browser sign-in lasts 7 days, an app sign-in 30 days.

**Settings → Profile** holds:

- **Identity**: **Display name**, **Git author name** and **Git author email**. Commits in sessions you own use this identity; new sessions pick up saved changes.
- **Environment**: up to 32 non-secret `APP_` variables (for example `APP_PROJECT=web`) sent to the host of every session you own. Values are at most 2,048 characters, and names containing `TOKEN`, `SECRET`, `PASSWORD`, `PRIVATE_KEY` or `API_KEY` are refused: credentials belong in Git accounts or in Pi on the host.
- **Git accounts**: your GitHub sign-in plus personal access tokens for other Git providers (see [Repositories and Git accounts](#repositories-and-git-accounts)).
- **Signed-in apps**: the iPhone, iPad and Mac apps signed in as you, each of which you can sign out.
- **Account**: your **User ID** (owners add you to workspaces with it) and **Sign out**.

**Settings → Appearance** switches between the Light, Dark and System themes.

### Workspaces and members

Create a workspace with **New workspace** in the sidebar or on the home screen; you become its owner. Its page under **Settings → Workspaces** has these sections: **General**, **Setup**, **Repositories**, **Push access**, **Network access**, **Transcripts**, **Session database**, **Members** and, for owners and admins, **Data export**.

Owners and admins add people with **Members → Add member**, entering the person's **User ID** and a role; saving an existing member changes their role, which takes effect at once. Or they share an invite link instead (see [Invite links and pending members](#invite-links-and-pending-members)). Below the owner there are four tiers:

- **Viewer**: follows workspace-visible sessions read-only and can't start sessions, restore a backup into a new one, or move one to another host. A session role can't give a viewer more than session viewer (read).
- **Member**: starts sessions, and follows other people's workspace-visible sessions read-only unless their owner grants more.
- **Collaborator**: starts sessions, and can send messages and side asks to any workspace-visible session.
- **Admin**: everything a collaborator can do, plus managing the workspace.

| | Owner | Admin | Collaborator | Member | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| View workspace-visible sessions | ✓ | ✓ | ✓ | ✓ | ✓ |
| Start sessions | ✓ | ✓ | ✓ | ✓ | |
| Send messages to any workspace-visible session | ✓ | ✓ | ✓ | | |
| Bind and remove repositories, set their push policy and Git LFS | ✓ | ✓ | | | |
| Manage push identities | ✓ | ✓ | | | |
| Set network access | ✓ | ✓ | | | |
| Add, change or remove collaborators, members and viewers | ✓ | ✓ | | | |
| Share the invite link, accept or decline pending members | ✓ | ✓ | | | |
| Add, change or remove admins | ✓ | | | | |
| Connect the session database, import dumps | ✓ | | | | |
| Export the workspace | ✓ | ✓ | | | |

Approving tool calls, and managing or opening someone else's private session, still take an explicit grant from the session's owner, whatever the role.

#### Invite links and pending members

Owners and admins can share one link to the workspace with anyone: **Members → Invite link → Create link**, then copy it. Whoever opens it signs in (if they haven't yet) and chooses **Ask to join**, which makes them a **pending member**. A pending member is not a member: they can't see or do anything in the workspace, and it doesn't appear in their sidebar. They show under **Members → Pending members**, where an owner or admin picks a role and chooses **Accept**, or **Decline**. Admins accept people with the roles below their own; only the owner can accept someone as an admin.

- The link opens only for people signed in to this Pistead server, and shows them the workspace's name and nothing else. It never admits anyone by itself, so accept only people you recognize.
- The link's token is in the URL's fragment, so opening it sends the token to neither the server's access logs nor a proxy's; the server keeps it only hashed and encrypted.
- **Replace link** issues a new link and stops the old one at once; **Turn off link** stops it. People already waiting stay pending until someone decides.
- A pending member can withdraw their request from the link's page, or under **Settings → Profile → Your requests to join**, which keeps working after the link is turned off or replaced. Adding someone with **Add member** also settles their pending request.
- At most 200 people wait to join one workspace at a time. Requests count until someone accepts, declines or withdraws them, also after the link changes, so decline the ones you won't accept to make room.

Workspace admins manage only their workspace; the server's administrators are configured separately (see [Administration](#administration)). A workspace has one owner, who can't be removed. Membership alone grants no GitHub access, no tool use and no access to anyone's host, and it shows private sessions to no one. Removing a member also removes their grants on the workspace's sessions; sessions they own are not reassigned, and nobody can open them while their owner isn't a member.

### Repositories and Git accounts

Sessions work on the repositories bound to their workspace. Until a workspace has one, nobody can share a host with it or start a session in it.

Connect the accounts that can read your repositories under **Settings → Profile → Git accounts** (**Add account**). Pistead verifies each token with its provider and keeps it encrypted on the server; tokens never go to other people's hosts.

| Provider | How to connect | Token scopes |
|---|---|---|
| GitHub (github.com) | Your GitHub sign-in | Granted at sign-in |
| GitHub Enterprise Server | Personal access token and host | Fine-grained Contents and Metadata read (or classic `repo`); opening pull requests needs Pull requests write, pushing with your account Contents write |
| GitLab (gitlab.com or self-managed) | Personal access token (and host if self-managed) | `read_api` and `read_repository`; opening merge requests needs `api`, pushing with your account `write_repository` (or `api`) |
| Bitbucket Cloud | API token with your Atlassian account email | `read:repository:bitbucket` and `read:user:bitbucket`; opening pull requests needs `write:pullrequest:bitbucket`, pushing with your account `write:repository:bitbucket`. Workspace or repository access tokens (no email) can browse but not push. |
| Azure DevOps | Personal access token and organization | Code (Read); opening pull requests or pushing with your account needs Code (Read & write) |
| Gitea / Forgejo | Personal access token and host | `read:repository` and `read:user`; opening pull requests or pushing with your account needs `write:repository` |

Owners and admins bind a repository under **Settings → Workspaces →** the workspace **→ Repositories → Add repository**: choose an **Account**, a repository the account can access (the first 3,000 are listed) and, optionally, a **Branch, tag or commit** (the default branch otherwise), then **Bind repository**. To change a ref, remove the repository and bind it again. Each repository row also has **Allow agent pushes to the default branch** (see [Commits, pushes and pull requests](#commits-pushes-and-pull-requests)). and **Git LFS**, off by default: sessions then check out the repository's LFS files as pointer files, as plain Git does. Turned on, sandboxed sessions download LFS files' content when they clone the repository, through the host's egress proxy and with the session owner's own account, on hosts that have `git-lfs` installed (Pistead uses the host's own). The provider's download links and the tokens that come with them stay on the control plane. Sessions never upload LFS objects, so commits that add or change LFS-tracked files shouldn't be pushed from a session. Unsandboxed hosts use their own Git and `git-lfs` configuration, whatever the setting.

Sessions **clone on demand**: every new session starts with an empty worktree and pins nothing.

- On a sandboxed host, the agent clones the repositories it needs with plain Git (`git clone https://github.com/acme/app`), and fetches, switches and creates branches as usual. Git reaches the workspace's repositories through the session's [egress proxy](#network-access), which reads them with the **session owner's own** account; the account never reaches the host.
- The agent commits with Git and pushes its work to the session's own branch, named for its work (`pistead/<title-slug>-<short id>`, for example `pistead/add-dark-mode-1a2b3c4d5e6f`), with plain `git push`, without approval. Other branches, and pull requests, go through `git_push` (see [Commits, pushes and pull requests](#commits-pushes-and-pull-requests)).
- On a host its owner runs [without the sandbox](#running-without-the-sandbox), the agent clones, commits and pushes with the host's own Git, network and credentials (its Git credential helpers, such as `gh auth setup-git`), each command with approval. Such a session can't be backed up once it has a clone in its worktree.
- Cloning needs shell commands: an agent without `bash` (a session started from a model has it), or another member's session on a host without [resource limits](#the-sandbox), works in an empty worktree, and the session says so.
- Removing a repository from the workspace stops new reads and pushes of it at once, in running sessions too.
- The host needs connector 0.9.0 or newer: one from before sessions cloned their repositories can't start new sessions.

Sessions started before this change pinned their repositories to exact commits. They stay **read-only**: their conversation, approvals, backups (to download) and exports remain, but they no longer run messages, approvals, backups, restores or moves. Start a new session to continue their work.

### Hosts

A host is a machine where you run the `pistead` connector next to [Pi](https://github.com/earendil-works/pi). Sessions on it use the models and credentials configured in Pi there (by default in `~/.pi/agent`); provider credentials, Pi history and personal extensions are never uploaded.

**Requirements:** Linux or WSL2 with Node.js 24 or newer, Pi configured with the providers and models to offer, and `bubblewrap`, Python 3, Git and `flock` (util-linux) for the sandbox. macOS, or Linux without bubblewrap, can run [without the sandbox](#running-without-the-sandbox). Native Windows is unsupported: run the connector inside WSL2.

#### Pairing

1. In **Settings → Hosts**, choose **Pair a host**, enter a **Host name**, then **Create pairing code**. A pairing names no workspace: the host is yours, and you can use it in every workspace you belong to, including ones you create or join later.
2. On the host, run the command shown under **Run this on your host**:

   ```sh
   npx pistead@latest connect --server https://pistead.example.com --pairing-id PAIRING_ID
   ```

3. Paste the code at the hidden prompt. It is never accepted as an argument, works once and expires after 10 minutes.

Each person can hold at most five unexpired pairing codes and 20 active hosts. The connector saves its token in `~/.local/share/pistead/connector` (`--state-dir` chooses another directory), so later runs need no arguments:

```sh
npx pistead@latest connect
```

Keep it running, for example in `tmux` or under your service manager: it reconnects by itself after network failures, and sessions on the host work only while it runs. Restart it after changing Pi's configuration, and run it with `@latest` to update it; newer features need a newer connector, and the web app says when a host's is too old.

To pair a machine again (after revoking its host, or to move it to another server), create a new code and add `--force` to its command. The saved token is replaced only once the new code is accepted; the old host stays in **Settings → Hosts**, offline, until you revoke it, and its sessions don't move. Use a separate `--state-dir` to run a second connection on the same machine.

An offline host's page in **Settings → Hosts** has **Reconnect**, which shows the command to restart its saved connection on that machine (Pistead can't start it remotely), or **Pair again** once it's revoked. **Remove permanently** (owner only) takes a host off the list for good: it revokes its credentials, stops sharing it, and marks its models unavailable. Its sessions and their history stay, but can't run again, and nothing on the machine is deleted; pair it as a new host to use it again.

> **Upgrading to connector 0.8.0:** it keeps its state in `~/.local/share/pistead/connector` instead of `~/.local/share/opencara/connector`, without moving anything. To keep a pairing made by an older connector, run `npx pistead@latest connect --state-dir ~/.local/share/opencara/connector`, or pair the machine again.

#### Models

A host offers the models matched by `enabledModels` in Pi's `settings.json` (the same patterns Pi uses for model cycling, such as `"anthropic/*"`), or every authenticated Pi model when that list is unset; `--model PROVIDER/MODEL` (repeatable) overrides both. A host offers at most 200 models. Each model starts at the reasoning level Pi gives it; see [Chat options](#chat-options).

The host's owner and its [admins](#host-admins-and-host-command-grants) can also turn models off without touching the machine: under **Settings → Hosts →** the host **→ Models**, clear a model's **Enabled** box. Disabling a model applies to everyone who uses the host, the owner included, in every workspace, and takes effect at once:

- It leaves every model picker, and no session starts from it or moves onto it. Only the host's **Models** section still lists it, to its owner and admins.
- No message switches to it. Sessions already on it keep their history and continue on another model; while the host has a disabled model, each message names the model it runs on, as the apps always do, so a conversation still on a disabled model asks you to choose another.
- A message already running on it when it is disabled runs to its end.

The setting stays with the host until someone enables the model again, even if Pi on the host stops offering the model for a while. Disabling a model doesn't change Pi's own configuration on the host.

Sessions on a host also follow two more of its Pi settings:

- **Compaction**: `compaction` (`enabled`, `reserveTokens`, `keepRecentTokens`) decides when a long conversation is summarized, and `compaction.modelOverrides` sets the token values per exact `provider/modelId`, so a session that switches between a small-window and a large-window model compacts in time for each. Pi's defaults apply where these are unset, with one exception: a reasoning model keeps a tenth of its context window, between 16K and 64K tokens, as `reserveTokens` instead of Pi's 16K. Pi summarizes at the conversation's reasoning level within 80% of `reserveTokens`, so at 16K a model thinking at a high level can spend the whole budget thinking, and once the context is past the threshold every message fails the same compaction. Set `reserveTokens` (overall or for the model) to use another value.

  The host's owner and its admins can also set these token counts in Pistead, without touching the machine: under **Settings → Hosts →** the host **→ Compaction**, enter **Reserve** and **Keep recent** tokens for all models, or for single models under **Per model**. Each count set there replaces the one in the host's `settings.json`; an empty one keeps it. Sessions use a change from their next message, without restarting the connector. This needs a connector from this release or later.
- **Provider attribution**: with Pi's `enableInstallTelemetry` set to `false` (or `PI_TELEMETRY=0`), sessions' model requests carry no attribution headers to pi, as Pi's own don't.

The connector reads these when it starts; restart it after changing them.

#### Sharing a host

A paired host is private: only you can start sessions on it, in any of your workspaces. Under **Settings → Hosts →** the host **→ Sharing**, **Share** it with a workspace you belong to (one with a bound repository) to let its members run their own sessions on it; **Unshare** stops that at once.

This is how a team shares one model subscription or set of API keys. Sign Pi in once on one machine and share that machine, and everyone in the workspace can pick its models when they start a session. The provider's credentials stay on that machine, and teammates never see or copy them. Revoking the host or unsharing it cuts everyone off at once. Check that your provider's terms allow sharing your plan this way.

- Sessions on a shared host still belong to the members who start them: they run as those members, with their Git accounts, not yours. Agents, session permissions and Git credentials are not shared, and your Pi history is never imported.
- As the host's operator, you can see the prompts and repository files of every session that runs on it. Members starting a session on someone else's host confirm they trust it (**I trust …'s host**).
- **Settings → Hosts → Shared with you** lists the hosts others shared into your workspaces.

The host's page shows its **Status** (online or offline, owner, capabilities), **Models** (where its owner and admins [enable or disable](#models) each one), **Sharing**, **[Configuration](#host-configuration)**, **Host command access**, **Admins**, **Details** (the connection ID) and **Danger zone**. **Revoke host** disconnects it and blocks work in every workspace, your own sessions included; session records are kept, and the machine needs a new pairing to come back.

#### Host admins and host command grants

By default only a host's owner manages its sharing and models and decides its `host_bash` commands, which run outside the sandbox on their machine. The owner can hand some of that out on the host's page:

- **Admins**: **Add admin** makes another member of a workspace the host is connected to an admin. Admins share and unshare the host, in workspaces they and the owner both belong to, give or remove host command grants, and [enable or disable its models](#models) for everyone who uses it, but hold no host command access themselves unless a grant gives it to them. Only the owner adds or removes admins, reconnects, revokes or removes the host; an admin can **Step down**.
- **Host command access**: in a workspace the host is shared with, grant one member or **All members** either **Approve host commands** (they decide each host command in sessions they can approve) or **Auto-approve host commands** (their own **Auto-approve** messages also run host commands without asking). A grant can expire after a day, a week or a month, or never. It ends when it expires, when an owner or admin removes it, or when the host stops being shared there. Viewers can't hold one.

The host asks the control plane who holds which grant each time a host command is created, decided or run, so a grant that ends stops working at the next command. Grants need a connector advertising `hostGrants`; until it is updated, only the owner decides host commands. Every admin, grant and model change is recorded in the audit log.

#### Host configuration

How a host runs its sessions is set on its page, under **Configuration**, rather than with connector options (connector newer than 0.9.0):

| Setting | Effect | Changed by |
|---|---|---|
| **Command time limit** | How long a shell command may run before it is stopped, from 30 seconds (the default) to an hour. A longer limit also lifts the per-process limits of short commands (25 seconds of CPU, 64 MiB per file, 256 open files) so builds fit: each process may use every CPU for the whole limit, write files of up to 16 GiB and open 8192 files | Owner and admins |
| **GPU** | Sandboxed commands get the host's GPU render device for rendering and compute: `/dev/dxg` on WSL2, or Linux DRM render nodes with their sysfs entries. Never the screen, windows, input or display (`card`) nodes, so the agent renders offscreen, for example to image files it reads back. Offered only where the connector found such a device. On WSL2, Mesa's `vulkan-dzn` on the host gives Vulkan over the Windows driver | Owner and admins |
| **Git credentials** | Pushes in the owner's own sessions may use the credentials Git on the host would use (see [push access](#push-access)) | Owner |
| **Repository cache** | Off, or a full mirror of each repository on the host for every session (**Shared**) or one per session owner (**Per owner**); see [Repository cache](#repository-cache-preview) | Owner |
| **Sessions on the host** | The owner may start sessions that run directly on the host, without the sandbox; see [Sessions on the host](#sessions-on-the-host) | Owner |

Running sessions pick up a change within a minute, and the agent finds the time limit and GPU in `identity` (`commands`); a repository cache change applies when the connector next connects. Saving changes only the settings you changed, so it never undoes one someone else saved meanwhile. Turning on Git credentials, the cache or the GPU asks first, and every change is recorded in the audit log (`host.config.updated`).

- A command approved by hand no longer holds the approval until it ends: its card shows it running and settles with its outcome, as host commands do. Stopping the message, or the session closing, stops a running command.
- Without provisioned resource limits (`--resources`), a command can use the whole machine for its time limit.
- A host started with `--git-credentials` or `--repo-cache` keeps those settings here; current connectors ignore the options. A connector that predates host configuration keeps its options until it is updated, and the page says so.

#### Sessions on the host

A sandboxed host can also run some of its owner's sessions directly on the machine, for work the sandbox doesn't allow: an app or game that opens windows or uses the GPU and the machine's drivers as installed, or tools and SDKs the sandbox can't see. Turn on **Sessions on the host** in the host's [configuration](#host-configuration) (owner only; it asks first), then choose **Where it runs → On this host** when you start a session on it. Each session keeps the choice it started with; restored and moved copies start in the sandbox.

Such a session runs like one on an [unsandboxed host](#running-without-the-sandbox): commands run as the connector's OS user, in the session's own folder, with your files, credentials and network and no resource limits, and the workspace's network access doesn't apply. They start with the connector's `PATH`, the session's own `HOME` and no display: set `DISPLAY` to open windows (for example `DISPLAY=:0` under WSLg). The host's command time limit still applies. Clones use the host's own Git and credentials, so push with `git` itself rather than `git_push`. In addition:

- Only the host's owner starts one, and only on their own host; members it is shared with always get the sandbox.
- Its commands are decided like [host commands](#host-commands): only by the host's owner, or a member they granted host commands. Approve permission on the session isn't enough.
- Turning **Sessions on the host** off stops the next command of every such session (within half a minute) before it runs; nothing else of theirs changes.
- Everyone who can see the session is warned that it runs without a sandbox (**Runs on the host**).

#### The sandbox

With bubblewrap, every session runs in its own sandbox: no direct network (see [Network access](#network-access)), read-only system directories, and only the session's own worktree writable. Commands in it stop after the host's [command time limit](#host-configuration), 30 seconds unless its owner or an admin sets a longer one. Git there runs without hooks, stored credentials or SSH: an approved push gets a credential for that push alone (see [Commits, pushes and pull requests](#commits-pushes-and-pull-requests)), and GitHub actions go through Pistead.

Shell commands (`bash`) also need resource limits. A connector started with `--resources PATH` (an operator-provisioned cgroup v2 configuration: CPU, memory, process and disk limits, described in [`apps/runner/src/resources.ts`](apps/runner/src/resources.ts)) runs them in every session. Without it, only the host's owner can let commands run without limits, and only in their own sessions, through a [permission request](#permission-requests); in other members' sessions on that host, `bash` is refused.

#### Network access

A sandbox's only way out is its session's **egress proxy**, which the connector runs on the host. Shell commands find it through `HTTPS_PROXY` (`http://127.0.0.1:41080`); file tools, commits and every other sandboxed step have no network at all.

- **Git reads of the workspace's repositories always work.** Git in the sandbox sends `https://` remotes, and SSH remotes of github.com, gitlab.com and bitbucket.org, to the proxy, so `git clone https://github.com/acme/app` or `git fetch` work as usual. The proxy relays them to Pistead, which reads the repository with the **session owner's own account**; the credential never reaches the host. Pistead re-checks the session and the owner's access on every request.
- **In a session that clones on demand, pushes of the session's own branch work too:** `git push origin HEAD:$PISTEAD_SESSION_BRANCH` (the branch, such as `pistead/add-dark-mode-1a2b3c4d5e6f`, is in `$PISTEAD_SESSION_BRANCH`). The proxy relays them to Pistead, which pushes with the workspace's [push identity](#push-access); its credential never leaves Pistead. A push of any other branch is rejected, as a Git host rejects one, and goes through `git_push` instead (see [Commits, pushes and pull requests](#commits-pushes-and-pull-requests)). Pinned sessions push only with `git_push`.
- **Everything else follows the workspace's network access**, under **Settings → Workspaces →** the workspace **→ Network access** (owners and admins):

  | Access | HTTPS reaches |
  |---|---|
  | **Off** (default) | Nothing besides the workspace's repositories |
  | **Allowlist** | The listed domains (`*.example.com` for subdomains), and, with **Allow package registries**, npm, PyPI, crates.io, Go modules, RubyGems, Maven, NuGet and Packagist |
  | **Open** | Any public host |

  Other repositories on an allowed host are fetched without credentials. Only HTTPS on port 443 is tunnelled, the proxy never looks inside it, and addresses in the host's own networks (loopback, private, link-local, such as cloud metadata services) are never reachable. Running sessions pick up a change within a minute.

  Shell commands verify these hosts against the certificates the **host** trusts (its system store, or Node.js's bundled one where it has none, plus the connector's `NODE_EXTRA_CA_CERTS`): the connector copies them into the session when it opens, and the sandbox sees them read-only at `/etc/ssl/certs/ca-certificates.crt`, which `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `REQUESTS_CA_BUNDLE` and `NODE_EXTRA_CA_CERTS` name. Nothing else of the host's `/etc` is visible. A certificate added on the host reaches a session the next time it opens.

`curl -s "$PISTEAD_EGRESS_STATUS"` in a session shows its current access, the repositories the proxy relays and its recent decisions. A session on a connector that predates the proxy keeps having no network; update the connector to use it.

#### Running without the sandbox

On macOS, or Linux without bubblewrap, you can opt out of isolation. This needs only Git (on macOS, `xcode-select --install` or `brew install git`):

```sh
npx pistead@latest connect --unsafe-no-sandbox
```

The connector prints the risks and asks you to type `unsandboxed` before it starts:

- Approved commands and commits run directly as your user, with access to your files, credentials (`~/.ssh`, cloud and Git configuration, Pi's auth) and network, and no CPU, memory or disk limits.
- File tools are confined to each session's folder by path checks only.
- Commands use this machine's network directly: the workspace's [network access](#network-access) doesn't apply.
- Anyone you share the host with, and anyone with approve permission on a session that runs on it, can cause approved commands to run on your machine.

Pistead labels such a host **Unsandboxed** to everyone who can see it.

#### Repository cache (preview)

By default each session downloads its clones itself. With **Repository cache** set to **Shared** (one cache for every session on the host) or **Per owner** (a separate cache for each session owner) in the host's [configuration](#host-configuration), the connector keeps a full clone of each repository on the host and lets sessions' clones borrow from it. Only the host's owner changes it, and it applies when the connector next connects. (Connectors 0.9.0 and older take `--repo-cache` and `--repo-cache-scope owner` instead.)

- `git clone` of a workspace repository first brings the host's copy up to date through Pistead, with the session owner's own account like every other read, then borrows its objects (`--reference-if-able`) instead of downloading and storing them again. A clone that doesn't come within 20 seconds goes ahead on its own; clones with `--reference`, `--shared` or `--dissociate` are left alone. A session sees a copy, read-only, only once Pistead has let its owner read the repository, again each time the session is reopened. A copy the session's first command created is visible from its next command on.
- Inside the sandbox the cache is read-only.
- `npx pistead@latest cache list` shows each cached repository, its size and how many sessions keep objects in it. `npx pistead@latest cache prune --older-than 30` forgets sessions idle for longer than that many days and collects what nothing reaches any more; a clone in such a session loses the objects it borrowed. Both take `--state-dir`.

#### Connector options

| Option | Effect |
|---|---|
| `--server ORIGIN` | The Pistead server's origin; needed for the first pairing |
| `--pairing-id ID` | The pairing ID from **Pair a host**; the code is asked for at a hidden prompt |
| `--force` | With `--pairing-id`, replace this machine's saved pairing |
| `--state-dir PATH` | Connector state (default `~/.local/share/pistead/connector`) |
| `--pi-agent-dir PATH` | Pi's configuration and auth directory (default: Pi's own) |
| `--model PROVIDER/MODEL` | Offer this model (repeatable) instead of `enabledModels` |
| `--resources PATH` | Operator-provisioned resource limits that let `bash` run in every session |
| `--unsafe-no-sandbox` | Run agent work directly on this machine, without isolation; asks for confirmation |
| `--allow-insecure-loopback` | Allow an `http://` server on localhost (development) |
| `--help` | Show all options |

Everything else is the host's [configuration](#host-configuration), set in Pistead: its command time limit, GPU, Git credentials and repository cache. `--git-credentials`, `--repo-cache` and `--repo-cache-scope` are still accepted, so existing service units keep starting, but ignored.

The Mac app's **This Mac** runs the same connector; see [iPhone, iPad and Mac apps](#iphone-ipad-and-mac-apps). [`packages/cli/README.md`](packages/cli/README.md) is the connector's own guide.

### Models and tools

You can use the models of your own hosts and of hosts shared with the workspace, except those the host's owner or an admin [disabled](#models). A session starts from a host and one of its models, and its agent gets every tool that host supports, with no extra instructions. The access you choose for each message (see [Chat options](#chat-options)) decides what runs without asking.

The tools an agent can use:

| Tool | What it does | Needs |
|---|---|---|
| `identity` | Tells the agent the session owner's identity and `APP_` environment | Nothing |
| `list_files`, `read_file` | List and read session files; images (PNG, JPEG, GIF, WebP) go to the model as images | Nothing |
| `write_file`, `edit_file` | Write a whole file, or replace exact text in place | Permission in **Read only** messages |
| `bash` | Run a shell command in the sandbox | Approval |
| `git_push` | Push a clone's checked-out commit to a branch, optionally opening a pull request, or tag a commit already on a branch | Approval |
| `github_read` | Read a GitHub issue or pull request | Nothing, during a shared message |
| `github_comment` | Comment on a GitHub issue or pull request | Approval |
| `github_merge` | Merge a GitHub pull request | Approval |
| `github_issue` | Open a GitHub issue | Approval |
| `host_bash` | Run a command on the host, outside the sandbox | The approval of the host owner, or of a member they [granted host commands](#host-admins-and-host-command-grants) |

"Approval" is skipped for messages the session owner sends with **Auto-approve**: always for commands, pushes, GitHub comments, merges and issues, and for `host_bash` only on the owner's own host or one whose owner granted them automatic host commands. Side asks offer only the read-only tools.

Sessions started from a saved agent, before agents were removed, keep that agent's instructions and tools; any other tool they call first asks the session owner with a [permission request](#permission-requests).

### Sessions

#### Starting a session

Select a workspace in the sidebar (or open **New session** in it):

- **Describe the task**: the first message. Its first line becomes the session's title.
- **Host**: one of your hosts, or a host shared with the workspace.
- **Visibility**: **Workspace** (members can view; the default) or **Private** (explicit grants only). See [Collaborating on a session](#collaborating-on-a-session).
- **Where it runs** (on your own host, once its [configuration](#host-configuration) allows **Sessions on the host**): **Sandbox** (the default) or **On this host**, without the sandbox. See [Sessions on the host](#sessions-on-the-host).
- The model, reasoning level and access for the first message (see [Chat options](#chat-options)). The info tips show the host, the model and the repositories the session will pin.

Press Enter to start (Shift+Enter adds a line). On someone else's host, first confirm that you trust it: its operator can read the session's prompts and repository files. The session shows **Starting** while the host prepares it, then runs your message. If it fails to start (**Not started**), its owner sends a message to start it again on the same host (**Restart and send**).

#### Shared messages and side asks

The composer switches between **Shared** and **Side ask**:

- A **shared** message (**Submit to session**, needs write permission) goes into the session's conversation and drives its work. Every message runs as the session owner, with their Git identity, accounts and environment, whoever sends it.
- A **side ask** (**Send side ask**, needs ask permission) asks about the work without changing it: the agent gets only the read-only tools, in a separate thread that starts from the shared conversation (**Side ask 1**, **Side ask 2**, …). Anyone who can view the session can see side asks, but share links don't show them.

Shared messages and side asks share one queue: up to 64 waiting or running, with up to 1 MiB of queued text. Accepted work goes on after you leave the page, as long as the host is online.

#### Images

Paste images, such as screenshots, into the composer: into a new session's first message, a shared message or a side ask. They show as thumbnails above the text; **×** removes one. A message carries up to 4 images, and can be images alone. The browser scales each image to at most 1568 pixels on its longest edge and compresses it until the message fits what the host takes in one request; the host decodes and prepares each image again, and the model gets them after the message's text. The images stay on the host: the transcript notes each one as `[image image/png]`.

Images need a connector that supports them on the session's host (update it with `npx pistead@latest connect`) and a model that accepts images; otherwise the composer or the send says why.

#### Stopping the agent

While the agent works, anyone with write permission can press **Stop** (the square beside send) to stop the message running now and every message queued behind it, side asks included (connector 0.9.0 or newer). They show as stopped in the queue at once, and the transcript marks where the work stopped and who stopped it. A tool call waiting on a card ends and its card is marked interrupted; a command or push already running finishes, and its card shows the outcome. The queue line reads **Stopping...** until the host has ended the work; messages sent meanwhile wait and then run as usual. A queued message that was stopped never reaches the agent: send it again to run it. A session whose last shared message was stopped shows as **Idle**.

The host can stop a message too. When the host crashes (rather than stopping its connector) five times in a row while the same message is being worked on, Pi stops resuming that work so the host doesn't keep crashing. The transcript then says the message stopped because the host crashed, the session shows as **Failed**, and the queue moves on. Send the message again to retry it.

#### Chat options

Beside the composer you can pick, for each message:

- **Model**: any model the session's host offers and hasn't [disabled](#models).
- **Reasoning**: Off, Minimal, Low, Medium, High, Extra high or Max, as the model supports. A model starts at the level Pi on the host gives it: the level in its `enabledModels` pattern (such as `"anthropic/*:high"`), else its entry in `modelThinkingLevels`, else `defaultThinkingLevel`, else medium.
- **Access** (shared messages only):

| Access | Effect |
|---|---|
| **Read only** | Inspect files; edits, commands and commits ask the session owner first |
| **Ask before acting** (default for everyone but the session owner) | Edits are automatic; commands, commits, pushes, GitHub comments, merges and issues need approval |
| **Auto-approve** (session owner only; their default) | Commands, commits, pushes, GitHub comments, merges and new issues run at once as the owner, as do tools outside the agent and commands without resource limits. `host_bash` runs without asking only on the owner's own host, or one whose owner granted them automatic host commands. |

Before a session's first shared message, the owner's chat box starts on **Auto-approve** and everyone else's on **Ask before acting**; after it, each starts on the last shared message's access (Auto-approve only for the owner). Switching to **Auto-approve** asks for confirmation each time, and warns more strongly on an unsandboxed host. Under it the agent can merge any pull request of the workspace's github.com repositories that GitHub lets the owner merge, without asking; GitHub's branch protection and required checks still apply. The owner's chat box starts on **Auto-approve** without that confirmation, so their first message that would merge without asking asks for it instead, once in each browser or app (confirming it when switching counts too). Apps from before Auto-approve covered merges keep their **Auto-merge** option, and merge without asking only with it on. Automatic comments, issues and merges need a connector advertising `automaticGitHub`; older ones still ask for each. Hosts running a connector older than 0.3.0 keep each session's model and offer none of these options.

The **Approvals** list keeps to what people decide. Shell and host commands that ran under **Auto-approve** get no card there: the conversation marks their tool calls **Auto-approved** (with their outcome when it isn't the usual "executed"), and each call's result holds the command's output. Automatic commits, pushes, repins and GitHub comments, issues and merges keep their cards. The list shows every approval still in play and the newest 50 settled ones, each with the start and end of its result; the host keeps them all. Hosts running an older connector list every approval.

#### Status, menu and panel

Session lists show what each session's agent is doing: **Starting**, **Not started**, **In progress**, **Needs approval**, **Done**, **Failed**, **Idle** or **Archived**. A session at rest with a [scheduled prompt](#scheduled-prompts) shows **Scheduled**, with a clock in place of its status dot. The **Sessions** page groups sessions by workspace, with a search box, **Show archived** and **Open by ID** (for a session ID someone gave you).

The session's menu offers **Copy session ID** and **Open in workspace settings**, and to its owner **Rename**, **Make private** or **Make workspace-visible**, **Create backup** and **Archive** (or **Unarchive**). Archiving makes a session read-only for everyone and hides it from lists; unarchiving brings it back as it was.

The session panel has five tabs:

- **Details**: **Host**, **Repositories** (cloned on demand; a pinned session's ref, commit and folder), **People**, **Transcript** (see [Transcript size](#transcript-size)), **Backups**, **Operation request**, **Export** and **Access**.
- **Approvals**: every approval and permission request, pending ones first.
- **Files**: the session's worktree on its host, read-only. Open directories and preview files: text up to 256 KB, with line numbers and syntax highlighting chosen by file name (up to 128 KB), and PNG, JPEG, GIF and WebP images up to 2 MB, over a checkerboard that shows transparency; click an image to switch between fitting the panel and its actual size. SVG files show as an image, drawn without running scripts or loading anything, with their source a click away. Each path is read from the host as you open it (**Refresh** reads it again), inside the session's sandbox and confined to its worktree like the agent's file tools; symlinks that lead out of it don't open, and values that look like secrets are hidden as in the transcript. It takes the session collaborator role (`write`), since collaborators can already have the agent read any file; viewers and share links don't get it. It isn't offered on archived sessions, and needs a host whose connector is new enough to advertise it.
- **Schedules**: the session's [scheduled prompts](#scheduled-prompts).
- **Activity**: the session's audit log, newest 200 entries.

#### Scheduled prompts

A scheduled prompt wakes the session's agent on a schedule: the server sends it a message, as the session's owner, as if they typed it in the chat box. Use it for recurring work such as a nightly test run or a weekly dependency report. The session owner manages them in the panel's **Schedules** tab (**New**, **Pause**/**Resume**, **Run now**, **Edit**, **Delete**), and everyone who can view the session sees them.

- **When**: a five-field cron expression (minute, hour, day of month, month, day of week, as in crontab, with ranges, steps, lists and names such as `*/30 8-18 * * mon-fri`, or `@hourly`, `@daily`, `@weekly`, `@monthly`), read in an IANA time zone (the browser's by default). Runs are at least 5 minutes apart. The form shows the next three runs as you type.
- **Access**: **Ask for approval** (the default, as in the chat box), **Read-only** or the owner's **Auto-approve**, which runs commands without anyone watching. Read-only and auto-approve need a host whose connector takes chat options.
- **Busy sessions**: a run that comes while the agent is working or waiting for an approval is skipped, not queued, and the schedule shows why. Runs missed while the server or host was offline, or the session archived, aren't caught up: the next check sends one and moves on. The session's host must be online for its message to run.
- Each run is audited as the owner's `session.submit` with the schedule's ID; creating, changing and deleting schedules are audited too. A session keeps at most 20 schedules, and the server checks for due ones every 30 seconds.

### Approvals and permission requests

#### Approvals

Commands, pushes, GitHub comments, merges and issues, and host commands each need an approval: a card above the transcript (and under **Approvals**) that shows the exact operation, such as the command, or the repository, branch and commit of a push. **Approve** runs exactly that operation, as the session owner (a host command as the host's OS user); **Deny** drops it.

| Operation | Who can decide |
|---|---|
| Commands, commits, pushes, GitHub comments, merges | Anyone with approve permission on the session (the owner always has it) |
| Host commands | Only the host's owner, who also needs approve permission on the session |

The agent's tool call waits for the decision, and its message waits with it (connector 0.9.0 or newer). **Approve** runs the operation at once: its output appears on the card and goes back to the agent, which carries on. Commands, pushes and host commands run in the background (connector newer than 0.9.0 for commands), so the card shows them running until they end. After **Deny**, the agent learns the operation was denied. The card can be decided until an hour after its message was sent; a card whose call stops first (the message is stopped, the session restarts, or the hour passes) is marked interrupted and can no longer run. An operation you request yourself, outside a message, can be approved once the session's queue is idle. Approving also checks that whoever requested it still has write permission. You can request an operation yourself under **Details → Operation request** (**Bash command** or **GitHub comment**), with write permission; it needs approval like the agent's.

#### Permission requests

When a tool call needs more than the session allows (a tool its agent doesn't include, a change in a **Read only** message, or a shell command on a host without resource limits), the agent asks instead of failing, and the session owner gets a card with **Allow once**, **Allow for this session** and **Deny**. Only the session owner decides these, and only a host's owner can let commands run without resource limits, in their own sessions.

The call can wait for the answer until an hour after its message was sent, and the session's queue waits with it. **Allow once** lets that call use the tool, but what it does still needs its own approval; the permission then shows on that operation's card instead of a card of its own. **Allow for this session** also approves what the tool does in the session owner's later messages, as **Auto-approve** would: its commands and pushes run without asking, while GitHub comments, merges and issues still wait for a decision (they run automatically only under **Auto-approve** itself), and other people's messages still ask for approval. Host commands (`host_bash`) can only be allowed once, so each one asks again. Messages the session owner sends with **Auto-approve** raise no permission requests. A session restored from a backup asks again.

### Collaborating on a session

A session is a chat that can be shared. Teammates watch it live, ask side questions, send messages that drive the work, and approve its commands and pushes. Each person gets only what their session role, given by the session's owner, and their workspace role allow. Everything still runs as the session owner, whoever sends the message.

A typical day, with Alice's shared host from [Sharing a host](#sharing-a-host):

```mermaid
sequenceDiagram
    autonumber
    actor Alice as Alice (host owner)
    actor Bob as Bob (session owner)
    actor Carol as Carol (session admin)
    actor Dan as Dan (session member)
    participant P as Pistead
    participant H as Alice's host (Pi + subscription)

    Alice->>P: Share host with workspace
    Bob->>P: Start session on Alice's host: "Fix the login redirect" (Ask before acting)
    P->>H: Run the message as Bob, with Bob's Git account
    H-->>P: Agent edits code, asks to push fix/login
    P-->>Carol: Approval card: git push to fix/login
    Carol->>P: Approve
    P->>H: Push exactly that commit
    Dan->>P: Side ask: "Why does it redirect after refresh?"
    P->>H: Answer in a separate read-only thread
    H-->>Dan: Answer (the shared work is unchanged)
    Bob->>P: Create share link
    P-->>Bob: Read-only link for anyone, no sign-in needed
```

#### Visibility and session roles

- **Workspace-visible** sessions can be viewed by every workspace member: prompts, output, tool output, repository content shown in the transcript, and side asks. Collaborators and admins can also send them messages. **Private** sessions only by the owner and people with a grant. Only the owner changes visibility; making a session private keeps explicit grants but can't recall what was already seen.
- Session roles (**Details → People → Session roles**) give a workspace member one of four tiers of access to one session, named after the workspace roles. Each tier includes everything in the tiers below it. You can only give a tier whose permissions you hold, and the owner's own access can't be changed. A workspace viewer can only be a session viewer. Removing someone's session role doesn't take away what their workspace role gives them on a workspace-visible session (viewing, and for collaborators and admins messaging); making the session private does.

| Session role | Permissions | Allows |
|---|---|---|
| **Viewer** | `read` | Viewing the session, its side asks, approvals and activity |
| **Member** | `read`, `ask` | Also sending side asks |
| **Collaborator** | `read`, `ask`, `write` | Also sending shared messages, stopping work and requesting operations |
| **Admin** | `read`, `ask`, `write`, `approve`, `manage` | Also deciding approvals (host commands need the host's owner; permission requests, the session owner) and managing who has a session role |

The API takes a tier (`POST /api/sessions/:id/grants` with `{ userId, role }`) or, as before, an explicit permission list (`{ userId, permissions }`). A grant that matches no tier, such as one made before tiers existed, shows as **Custom** until someone chooses a tier for it.

Only the session's owner can rename, archive or restart it, change its visibility or share link, back it up, restore or export it, use **Auto-approve**, and decide permission requests.

#### Share links

The owner can share a session by link (**Details → People → Create link**). Anyone who has the link can follow the shared conversation read-only, without signing in, with the session's title and the owner's display name. They see nothing else: no side asks, approvals, senders, host, workspace or repositories. **Turn off** stops the link at once, and turning sharing on again issues a new one; archived sessions can't get a new link. The token is carried only in the URL fragment (`#/shared/…`) and an `X-Share-Token` header, never in a request path, and the link pages read only `GET /api/shared` and `GET /api/shared/view`.

#### Transcript size

A session's transcript comes from its host, which always sends Pistead the whole conversation, compressed. Two settings make what reaches each viewer smaller. Both change only what Pistead shows, so they work with every connector version:

- **Full tool output** (**Details → Transcript**, the session's owner only; `PATCH /api/sessions/:id` with `{"toolOutput": "brief"}` or `"full"`) is on by default. Turned off, each tool result shows only its first line (up to 200 characters), on its row in the transcript. Long tool calls, such as a file the agent writes, are cut to their first 200 characters. Tool output is most of a typical transcript, so long sessions then load roughly half as much. It applies to everyone viewing the session, its share link included. A shortened row says how many lines and characters the full output has; the host keeps all of it, and the agent still sees all of it. Secrets are hidden before anything is shortened.
- **Latest messages first** (**Settings → Workspaces →** the workspace **→ Transcripts**, owners and admins; `PUT /api/workspaces/:id/transcripts` with `{"paging": true}`) is off by default. Turned on, a session opens with only the newest 50 entries of each conversation. Earlier ones load 50 at a time as you scroll up, or with **Show earlier messages** at the top (`GET /api/sessions/:id/entries?conversation=…&before=…&limit=…`, up to 200). Entries you've already seen stay in place while new ones arrive. Your browser's find on the page only searches what has loaded. Share links aren't paged: they show the whole shared conversation.

Open sessions pick up either change within a few seconds.

#### Hidden secrets

Everything Pistead shows people (transcripts, approvals and their output, in every session view and share link) has values that look like secrets replaced by `[redacted]`, for everyone including the session's owner. That covers well-known token formats, private keys, the values of password-, secret-, token- and key-named settings, and credentials in URLs, Authorization headers, `curl -u` and `.netrc`. The agent and the host still see the real values, and an approved operation runs with them. In shell commands only single words are ever hidden, so an approver always sees what a command does, and an approval that holds a hidden value says so. Detection is pattern-based, so other sensitive text can still show; backups keep the real transcript.

### Commits, pushes and pull requests

Agents commit with Git itself, as the session owner's Git identity, and push committed work to a branch:

- The agent pushes the session's own branch (`pistead/<title-slug>-<short id>`) with plain `git push`, without approval: Pistead checks, as for `git_push`, that the session owner may push to the repository, and pushes with the workspace's push identity (its own Git credentials on the host can't serve here). For any other branch, `git_push {directory, branch}` pushes a clone's checked-out commit as it is to the workspace repository the clone's `origin` names; if the branch moved, the agent fetches and merges or rebases first. To open a pull request from the session branch, the agent calls `git_push` with that branch and a pull request.
- To tag a release, the agent checks out a commit that is already on a branch (main, say) and calls `git_push {directory, branch, tag}`. That creates the lightweight tag `refs/tags/<tag>` at the commit and moves no branch. Before pushing, Pistead confirms against the remote that the branch reaches the commit, and that the tag doesn't exist yet. Tags are never moved or replaced, a tag push opens no pull request, and the default-branch setting below doesn't apply because no branch moves. Plain `git push` of a tag is refused, like any ref other than the session branch.
- The approval shows the repository, the clone's directory if any, the branch, the tag if any and the exact commit.
- Pushes are fast-forward only and never forced; a branch that moved elsewhere is refused.
- The agent can also ask for a pull request, which Pistead opens as the session owner with their connected account. Session lists and the session header then show the session's newest pull request with its state: **Draft**, **Open**, **CI failed** (a check run or commit status of its head failed), **Changes requested** (a reviewer's latest review asks for changes), **Merged** or **Closed**. Pistead reads the state in the background with the session owner's GitHub account, about every two minutes (every 30 minutes for archived sessions), and stops once the pull request is merged or closed. Only github.com pull requests show a state so far.
- Before each push, Pistead checks with the session owner's own account that they may push to the repository and, where the Git host reports it, to that branch; GitHub protected branches are refused. For a tag, it checks that they may push to the repository (on Azure DevOps, that they may create that tag); tag rules on the Git host (GitHub rulesets, GitLab and Gitea protected tags) apply to the push identity's push, and its bypass list too. Owners and admins can forbid pushes to a repository's default branch by clearing **Allow agent pushes to the default branch**.
- The connector holds the push credential in memory only and talks to the Git host directly; the sandbox never sees it.

#### Push access

Owners and admins set up how agents push, per provider, under **Settings → Workspaces → Push access** (**Add identity**). Usually that's an app or bot that Pistead mints a short-lived token from:

| Provider | Push identity | Token |
|---|---|---|
| GitHub | **GitHub App**: the operator's (`GITHUB_APP_*`, listed as **Operator GitHub App** with an **Install** link) or the workspace's own | 1 hour, this repository only, revoked after the push |
| GitHub Enterprise Server | **GitHub App** registered on your server | 1 hour, this repository only, revoked after the push |
| GitLab | **OAuth app authorized by a bot account** (`write_repository read_user`) | Up to 2 hours, the bot's projects |
| Bitbucket Cloud | **Bitbucket OAuth consumer** with Repositories: Write | 1–2 hours, the Bitbucket workspace's repositories |
| Azure DevOps | **Entra workload identity federation**: an app whose federated credential trusts Pistead, its service principal added to the organization | About 1 hour, what the service principal is granted |
| Forgejo v16 or newer | **Forgejo authorized integration**: a Generic JWT integration that trusts Pistead | 10 minutes, what the integration allows |
| Gitea 1.23 or newer | **OAuth app authorized by a bot account** (`write:repository read:user`) | Up to 1 hour, the bot's repositories |

OAuth app identities show a **Redirect URI** to register and need **Authorize** (signed in as the bot) before they're **Ready**; Entra and Forgejo identities need the operator's `OIDC_SIGNING_KEY`. Secrets are write-only. Except for GitHub, a minted token reaches everything its identity can until it expires, and the host running the session receives it: give each bot, consumer, service principal or integration access to the workspace's repositories only (a Forgejo integration can also require the `repository` and `ref` claims Pistead adds).

Instead of an app or bot, an identity can be one of these. Both push only from sessions on the session owner's own hosts, so nobody's credentials reach anyone else's machine; elsewhere the push is refused:

- **Session owner's account**: the account the owner connected (their GitHub sign-in, or a token under **Git accounts** with write scopes). Their own host receives that token for each push; Pistead resets a GitHub token when the push ends, but tokens of other providers stay valid.
- **Host's Git credentials** (connector 0.6.0 or newer): the connector reads the HTTPS credentials Git on the host would use, through its credential helpers (for example after `gh auth setup-git`, or from the macOS keychain or Git Credential Manager), without prompting. The host's owner turns on **Git credentials** in its [configuration](#host-configuration) (connectors 0.9.0 and older: `npx pistead@latest connect --git-credentials`).

Pull requests are opened as the session owner with their connected account either way. [`packages/cli/README.md`](packages/cli/README.md#pushing-commits) has the full details of each identity.

### GitHub issues and pull requests

The sandbox has no network, so agents read and act on GitHub through Pistead instead, as the session owner and with their GitHub sign-in, which stays on the server (connector 0.7.0 or newer; github.com only):

- `github_read` reads an issue or pull request of one of the workspace's github.com repositories: its description and comments and, for a pull request, its merge state, head commit, reviews, review comments with file, line and diff hunk, and checks. It needs no approval, runs only during a shared message (until an hour after it was sent), and each read is recorded in the session's activity. Treat what it returns as untrusted input.
- `github_comment` posts a comment once it's approved.
- `github_issue` opens an issue with exactly the approved title and body in one of the workspace's github.com repositories, once it's approved, and gives the agent its number and URL (connector newer than 0.9.0). Use it rather than `gh issue create`: the sandbox holds no GitHub credentials. If GitHub refuses (issues turned off, no access), no issue is opened and the agent gets GitHub's reason.
- `github_merge` merges a pull request at the exact head commit the agent read, with a merge commit, squash or rebase, once it's approved. If the head moved or GitHub refuses, nothing is merged and the agent gets GitHub's reason.

Comments, issues and merges wait for a human decision, unless the session owner sent the message with **Auto-approve**: then they run at once. Each automatic one is attempted once (never retried), keeps its card with its outcome and is recorded in the session's activity; a message runs at most 20 of them.

### Host commands

Host commands need connector 0.8.0 or newer. When a task needs an SDK installed on the host or network access, ask the agent to use `host_bash`, for example for `dotnet --info`; ordinary `bash` stays in the sandbox, with only the workspace's [network access](#network-access). Each exact command and timeout (five minutes by default, `timeout_seconds` up to 3600) needs the approval of the **host owner**, or of a member they [granted host commands](#host-admins-and-host-command-grants); on a shared host, the approver also needs approve permission on the session. The session owner's **Auto-approve** skips this only on their own host, or where they hold an automatic host command grant.

Host commands run **outside the sandbox, as the connector's OS user**, in the session's worktree: they can read and change host files and credentials, use the network, and run without CPU, memory, process or disk limits. The agent can change the worktree's files and Git configuration, so builds, package scripts and Git hooks there can run its code on the host, even for a command as harmless-looking as `git status`. Approve a host command only if you would run it yourself in that directory. Commands get the host's `PATH` and `HOME`, not the connector's whole environment, and Bash starts without shell profiles.

### Backups, restores and exports

A session's conversation and files live on its host. A backup copies them to the server's backup storage (`STORAGE_URL`) or, when the workspace owner has connected one, to the workspace's [session database](#workspace-session-databases). A server with neither keeps no backups.

- Only the session owner can create, download or restore backups, from **Details → Backups** or the session menu (**Create backup**), and only while the session is idle. Listing and downloading work while the host is offline.
- A backup holds the session's conversation, its files and the owner's personal environment values, so whoever can read the backup store can read them. When backups go to a database another member connected, you confirm that database before each backup.
- In a session that clones on demand, a backup keeps each clone's **local work** rather than the clone itself: its branches, which branch is checked out, commits its `origin` doesn't have, and its uncommitted changes and untracked files (ignored files aren't kept). The restored session clones each repository again through its egress proxy, with the session owner's access, before its work resumes, and puts that work back: the same branch checked out, the changes uncommitted again. A clone that can't be cloned again (for example, its repository was removed from the workspace) is retried when the session next opens, and the agent is told where its work is kept meanwhile. Clones of repositories outside the workspace keep only their local work too, and can't be restored automatically.
- **Conversation only** (next to **Create backup**, or **Back up conversation only** in the session menu; `POST /api/sessions/:id/backup` with `conversationOnly: true`) keeps just the session's conversation and its state: Pi's database, its runs and its approval history. The session's files and its clones' local work aren't kept, so the backup is much smaller, and a session restored from it starts with an empty worktree. Its agent is told that the files and clones its earlier messages mention weren't restored, so it clones what it needs again (a later restore from a full backup drops that note). Work that isn't pushed is lost in such a restore. These backups are marked **Conversation only** in the backup list, and as `conversationOnly: true` in the `backup.created` activity and the session export. They need a current connector on the session's host (`conversationBackups` capability). Automatic backups are always full backups.
- **Restore into new private session** creates a new private session from a backup, optionally with a **New session title**, and never overwrites the source. It doesn't replay approvals or run operations, and it needs the original host to be available. Retrying reuses the same request, so it opens the same restored session instead of creating another.

Exports are JSON records without secrets; a session's conversation is in its backups:

- Session owners export a session (details, people, approvals, pushes, backup list and activity) under **Details → Export**.
- Workspace owners and admins export a workspace (settings, members, models, published agents, repositories, push access, its session database connection and activity, with their own sessions in full and the records of the other sessions they can view) under **Settings → Workspaces → Data export**. Other members' private sessions are left out; their owners can export them.

### Moving a session to another host

While both hosts are connected, a session's owner can move it to a model on another host in its workspace (session panel → **Move to another host**, or `POST /api/sessions/:id/migrate` with `requestId` and `modelId`). The source host's live snapshot, the same one a backup takes, goes straight to the new host, so no `STORAGE_URL` is needed:

- The new host restores it into a new session with the same conversation, files, repository pins, visibility and title (or a new title), running that host's model. Its agent keeps the original's tools that the new host can carry. Session grants, and approvals given for the rest of the session, aren't copied.
- Once the new host confirms, the original session is archived: its history stays readable and its owner can unarchive it.
- A session that clones on demand moves as its backups restore: each clone is cloned again on the new host and its local work put back. It needs a sandboxed new host with a current connector (`cloneBackups` capability).
- The session must be idle. Until the move finishes, both sessions only accept reads, so nothing sent after the snapshot is lost. The control plane holds the snapshot until then; retrying with the same `requestId` needs only the new host, and `POST /api/sessions/:id/migrations/:migrationId/cancel` gives up on the move, archiving the unfinished copy.
- Moving to a host someone else owns needs `trustedConnectorId`, as starting a session there does. The new host must run a current connector on Linux (`hostMigration` capability).

### iPhone, iPad and Mac apps

- **iPhone and iPad** ([`apps/mobile`](apps/mobile/README.md), Expo): your sessions grouped by workspace with their status; a session opens live with its transcript, queue, pending approvals to decide, and the chat box for shared messages and side asks; new sessions start from the app. It isn't on the App Store or TestFlight yet: build it from source as a development build.
- **macOS** ([`apps/desktop`](apps/desktop/README.md), Electron): Pistead in its own window, plus **This Mac**, which runs the `pistead` connector on the Mac without a terminal. Pair it with a pairing ID and code from **Settings → Hosts**. It shares the command-line connector's state, so a Mac paired with `pistead connect` is adopted as is, and only one of the two can run at a time. macOS has no sandbox, so starting the host asks for the same consent as `--unsafe-no-sandbox`.

The apps sign in with GitHub through the server's GitHub OAuth app; nothing else needs configuring. Each app sign-in lasts 30 days and appears under **Settings → Profile → Signed-in apps**, where you can sign it out.

## Running the server

### Docker

```sh
cp apps/server/.env.example .env
# In .env set APP_ORIGIN (the public https:// origin), SESSION_SECRET (openssl rand -base64 48)
# and VAULT_KEY (head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '='), then:
docker compose up -d
```

The image builds the web app and the bundled server and runs them as a non-root user. The server listens on port 8787 and keeps its SQLite database in the `pistead-data` volume; it stores no session backups unless you set `STORAGE_URL` (see [Database and backup storage](#database-and-backup-storage)). The image sets `WORKSPACE_DATABASES=true`, so workspace owners can keep their sessions' backups in a Postgres database of their own (see [Workspace session databases](#workspace-session-databases)); set `WORKSPACE_DATABASES=false` in `.env` to turn that off. `GET /api/health` reports which providers are configured, and the image's health check uses it. Migrations run automatically at start-up: to upgrade, update the source and run `docker compose up -d --build`.

Each server release (`server-v*` tag) is published as `ghcr.io/opencara/pistead` (`latest`, `X.Y` and `X.Y.Z`, for linux/amd64 and linux/arm64); to use it instead of building, set `image: ghcr.io/opencara/pistead:latest` and drop `build: .` in `docker-compose.yml`.

Put a reverse proxy with TLS in front of it (Caddy, nginx, Traefik, a cloud load balancer); the app serves plain HTTP. If the proxy sets `X-Forwarded-Proto`/`X-Forwarded-Host`, set `TRUST_PROXY=true`. The proxy must pass WebSocket upgrades on `/api/connectors/socket`, accept request bodies of 32 MiB for dump imports, and route `/.well-known/` to Pistead if you use `OIDC_SIGNING_KEY`. The server gzips its responses and session event streams itself, and compresses the connector WebSocket for connectors that offer it, so the proxy needs no compression of its own.

### GitHub sign-in and apps

- **Sign-in** needs a GitHub OAuth app whose callback URL is `<APP_ORIGIN>/api/auth/github/callback`; put its id and secret in `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Without it, the sign-in page says GitHub sign-in isn't configured. The same app resets session owners' GitHub tokens after pushes that used them.
- **github.com pushes** can use an operator GitHub App with Repository contents read & write: set `GITHUB_APP_ID`, `GITHUB_APP_SLUG` and `GITHUB_APP_PRIVATE_KEY`. Without it, each workspace adds its own GitHub App under **Push access**.
- **Azure DevOps and Forgejo push identities** trust Pistead as an OIDC issuer at `APP_ORIGIN` (`/.well-known/openid-configuration`, `/.well-known/jwks.json`): set `OIDC_SIGNING_KEY` to an RSA key (`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072`).

### Configuration

Settings are environment variables, read once at start-up; secrets are never logged. [`apps/server/.env.example`](apps/server/.env.example) documents each one.

| Variable | Default | Purpose |
|---|---|---|
| `APP_ORIGIN` | required | Public origin of the server (scheme and host, no path); HTTPS outside local test mode |
| `SESSION_SECRET` | required | Random string of at least 32 characters |
| `VAULT_KEY` | required | Base64url 32-byte key that encrypts stored tokens and secrets; keep it stable, since secrets stored with one key can't be read with another |
| `HOST`, `PORT` | `0.0.0.0`, `8787` | Listening address |
| `TRUST_PROXY` | `false` | Honor `X-Forwarded-Proto`/`X-Forwarded-Host` from a trusted proxy |
| `STATIC_DIR` | `dist/web` | Built web app |
| `DATABASE_URL` | `sqlite:///data/pistead.sqlite` | Control-plane database |
| `DATABASE_WAIT_SECONDS` | `60` | How long start-up retries an unreachable database |
| `STORAGE_URL` | none | Session backup storage; none means no backups |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | AWS SDK chain | S3 credentials; the `AWS_*` names also work |
| `WORKSPACE_DATABASES` | `false` (`true` in the Docker image) | Let workspace owners connect a Postgres database |
| `WORKSPACE_DATABASE_PRIVATE_HOSTS` | `false` | Also allow workspace databases on private networks |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | none | GitHub OAuth app for sign-in |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` | none | Operator GitHub App for github.com pushes (PEM as one line with `\n` escapes) |
| `OIDC_SIGNING_KEY` | none | RSA private key (PKCS#8 PEM) for Pistead's OIDC issuer |
| `ADMIN_USER_IDS` | none | Comma-separated user IDs of the server's administrators (see [Administration](#administration)) |
| `RUNNER_URL`, `RUNNER_EVENT_TRANSPORT`, `RUNNER_SHARED_SECRET` | none | Legacy operator-managed runner, for development only; leave empty |
| `TEST_AUTH_ENABLED`, `TEST_AUTH_SECRET`, `TEST_AUTH_EXPIRES_AT` | off | Local test mode, for development only |

### Administration

The server's administrators see every account, workspace and host under **Settings → Administration** and can suspend accounts. List their user IDs in `ADMIN_USER_IDS`, separated by commas (`ADMIN_USER_IDS=github:12345,github:67890`); each person finds theirs under **Settings → Profile**. The role comes only from this setting: nobody can grant it in the app, and it gives no access inside workspaces or sessions.

- **Overview** counts accounts, workspaces, hosts (and how many are online) and sessions.
- **Accounts**, **Workspaces** and **Hosts** list each one with its owner and how many members, repositories, hosts and sessions it has. They never show session titles, prompts, repository names, models, environment values or credentials.
- **Suspend**, in an account's menu, signs the account out of every browser and app and refuses its sign-ins, disconnects its hosts and keeps them from reconnecting, and closes the sessions it owns to everyone, as when someone leaves a workspace. Sessions other members run on its hosts stop too. Nothing is deleted: **Unsuspend** restores the account, its hosts can reconnect and its sessions open again. Administrators can't be suspended; remove them from `ADMIN_USER_IDS` and restart the server first.

Each suspension and unsuspension is recorded in the server's audit table with the administrator who made it.

### Database and backup storage

Every provider is chosen by a URL:

| Setting | Default | Alternatives |
|---|---|---|
| `DATABASE_URL` | `sqlite:///data/pistead.sqlite` | `postgres://user:password@host:5432/db` (TLS via `?sslmode=require`; `docker compose --profile postgres up -d` starts one) |
| `STORAGE_URL` (session backups) | none: backups are off | `file:///data/backups` (a directory on the server; under Docker, the `pistead-data` volume), or `s3://bucket/prefix?endpoint=https://minio.example.com&region=us-east-1` with `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (or the `AWS_*` names); omit `endpoint` for AWS |

Migrations run automatically at start-up on whichever database is configured; `pnpm db:migrate` (or `node dist/server/main.js --migrate-only`) applies them without starting the server. Switching providers later means starting with an empty database: there is no data migration between SQLite and Postgres.

Without `STORAGE_URL` the server keeps no session backups, and session owners can't create any, except in workspaces whose owner connected a database of their own. A backup holds a session's conversation, its files and its owner's personal environment values, so whoever can read the backup store can read those sessions. A server that saved backups before `STORAGE_URL` became optional kept them in `/data/backups`: set `STORAGE_URL=file:///data/backups` to download and restore them again.

### Workspace session databases

With `WORKSPACE_DATABASES=true`, a workspace owner can connect a Postgres database of their own under **Settings → Workspaces → Session database → Connect database**. Session backups of that workspace are then saved there instead of in `STORAGE_URL`, and downloads and restores read them back from it:

- Pistead creates `pistead_workspaces`, `pistead_sessions` (each session's record in a `record` JSONB column), `pistead_session_backups` (the exact backup bytes; `convert_from(snapshot, 'UTF8')::jsonb` reads one) and `pistead_audit` (activity) when they are missing, in the first schema of the user's `search_path`. Tables created beforehand are used as they are, so the connecting user needs only `SELECT`, `INSERT` and `UPDATE` on them; they need the columns defined in [`apps/server/src/workspace-databases/postgres.ts`](apps/server/src/workspace-databases/postgres.ts).
- The control plane keeps each backup's SHA-256 and size, so a snapshot changed in that database is refused on download and restore.
- Only the owner connects, replaces or disconnects it; the password is vault-encrypted and write-only. Whoever can read that database can read the sessions saved there, including their owners' personal environment values, so other members confirm the database before each of their backups is saved there. Pointing the connection at another database asks them again; new credentials for the same one don't. A database is named by its host, port and database name: where that host name resolves is up to whoever controls it, normally the owner.
- Connections use TLS that verifies the server certificate (against the public roots, or a CA certificate the owner pastes), or TLS without verification if the owner chooses it. Hosts must resolve to public addresses; `WORKSPACE_DATABASE_PRIVATE_HOSTS=true` also allows private networks, and unencrypted connections to them.
- If the operator turns the feature off, that workspace's backups stop (they never fall back to `STORAGE_URL`) until its owner disconnects the database.

#### Automatic backups

The owner can also have sessions backed up into the database on their own, under **Session database → Automatic backups**: every 15 minutes, hour, 6 hours or day at most (`PUT /api/workspaces/:id/database/automatic-backups` with `minutes` of `15`, `60`, `360`, `1440` or `null`). Replacing the connection keeps the schedule; disconnecting the database ends it.

- A session is backed up when it changed since its last automatic backup (its host reported its agent working), it is idle, and the interval since the last attempt has passed. The server checks every minute and takes at most 10 backups each time, oldest change first. A failed attempt is retried 15 minutes later, and the session's **Details → Backups** shows why it failed.
- Automatic backups go only into the workspace database, never into `STORAGE_URL` instead, and are marked **Automatic** in the backup list and as `automatic: true` in the `backup.created` activity.
- The workspace owner's own sessions take part as soon as the schedule is on. Another member's sessions take part only once that member confirms the database under **Session database → Your sessions** (`PUT /api/workspaces/:id/database/consent` with the `databaseId` they were shown; `DELETE` withdraws it). That confirmation also stops manual backups asking each time. It names the database, so it lapses when the owner points the connection at another one or disconnects it, and when the member leaves the workspace.
- Nothing deletes old automatic backups yet: the database keeps every one, so choose an interval the database has room for.

### Dumps and imports

Operators can dump straight from the database, with every session of a workspace in full:

```sh
node dist/server/main.js --dump-workspace WORKSPACE_ID > workspace.json
node dist/server/main.js --dump-session SESSION_ID > session.json
docker compose exec -T pistead node dist/server/main.js --dump-workspace WORKSPACE_ID > workspace.json
pnpm -s db:dump --dump-workspace WORKSPACE_ID > workspace.json   # from source
```

Like start-up, a dump applies pending migrations first.

A workspace's owner can import a session or workspace export of that workspace into its session database under **Settings → Workspaces → Session database → Import dump** (up to 32 MiB), or with `POST /api/workspaces/:id/database/import`. This keeps the history of sessions saved before the database was connected, and adds what backups don't carry:

- `pistead_sessions.data`: each fully exported session's grants, approvals, pushes, backup list and restores; `pistead_workspaces.data`: the workspace's members, models, agents, repositories, push access and database connection; `pistead_audit`: every activity entry.
- A session's record and details replace older ones only (by export or save time), and activity entries are added once, so importing a dump again, or an older one, changes nothing. Each import is one transaction.
- The dump must be of that workspace; it is checked before anything is written. Only the workspace database changes; the workspace's activity records the import.

Operators import dumps of up to 256 MiB from the command line, with the server's settings (`WORKSPACE_DATABASES`, `WORKSPACE_DATABASE_PRIVATE_HOSTS` and the `VAULT_KEY` that reads the database password). The dump names its workspace, which needs a connected database:

```sh
node dist/server/main.js --import-dump workspace.json
docker compose exec -T pistead node dist/server/main.js --import-dump - < workspace.json
pnpm -s db:import workspace.json   # from source
```

An operator's dump holds every session of the workspace, other members' private ones included: importing it gives whoever can read the workspace database their records and activity.

## Development

Requires Node 24 and pnpm.

```sh
pnpm install
cp apps/server/.env.example apps/server/.env   # see below
pnpm dev:server                                 # API on :8787
pnpm dev                                        # web UI on :5173, proxying /api to :8787
```

For local development, set in `apps/server/.env`: `APP_ORIGIN=http://localhost:5173`, `DATABASE_URL=sqlite:./data/dev.sqlite` (the default `/data` path is the container's), `SESSION_SECRET`, `VAULT_KEY`, and the test mode that allows plain HTTP on localhost: `TEST_AUTH_ENABLED=true`, a `TEST_AUTH_SECRET` of at least 32 characters and a future `TEST_AUTH_EXPIRES_AT` (such as `2030-01-01T00:00:00Z`). Sign in with a GitHub OAuth app whose callback is `http://localhost:5173/api/auth/github/callback`, or as a test user by running this in the browser console on `http://localhost:5173`, then reloading:

```js
await fetch("/api/auth/test", { method: "POST", headers: { Authorization: "Bearer YOUR_TEST_AUTH_SECRET", "Content-Type": "application/json" }, body: JSON.stringify({ displayName: "Dev" }) });
```

- `pnpm typecheck` (also typechecks the apps), `pnpm test` (set `TEST_DATABASE_URL=postgres://…` to also run the provider suite against Postgres), `pnpm build` (web), `pnpm build:server` (bundled server in `dist/server`), `pnpm build:cli` (the connector package).
- `pnpm connect …` runs the connector from source, with the same options as `pistead connect`; add `--allow-insecure-loopback` to pair with a local `http://` server.
- `pnpm test:connected` runs the end-to-end suite against a real server and connector (Linux with bubblewrap).
- `pnpm dev:native [--port 8787] [--no-host] [--pairing]` runs a local test-mode server for developing the apps: a test user with an app token, a workspace and, unless `--no-host`, this machine as a host offering the deterministic fixture model (not an LLM) with one session. `--pairing` adds a pairing code for the desktop app. It writes what the apps need to `.local/dev-native.json`; Ctrl-C stops it and deletes its data.
- Releasing: each part has its own release line and version, started by pushing its tag on a commit in `main` (e.g. `git tag server-v1.4.0 && git push origin server-v1.4.0`). A suffix such as `-beta.1` makes a prerelease. Nothing needs committing first: each workflow checks the tag is on `main`, runs CI and sets the tag's version in the package it builds (`scripts/set-release-version.mjs`), so the committed versions need not match.

  | Tag | Workflow | Publishes |
  | --- | --- | --- |
  | `cli-v1.2.3` | `release.yml` | `pistead` on npm, with provenance; a prerelease goes to the `next` dist-tag |
  | `server-v1.2.3` | `release-server.yml` | The server image (web app and backend) to `ghcr.io/opencara/pistead`; no GitHub release |
  | `desktop-v1.2.3` | `release-desktop.yml` | The desktop app on a GitHub release: macOS (arm64 DMG and zip) today, Windows and Linux from the same tag later |
  | `ios-v1.2.3` | `release-ios.yml` | The iOS app to TestFlight |

  Only the desktop line creates a GitHub release, the one GitHub marks latest, with notes since the line's previous tag. The desktop app bundles the connector from `packages/cli` at its tagged commit, so when a connector change matters to it, release `cli-v` and then `desktop-v`. npm needs either a trusted publisher on npmjs.com for `OpenCara/pistead`, workflow `release.yml` (keep that file name), environment `release`, or an `NPM_TOKEN` repository secret.
- Apple signing for the `desktop-v` and `ios-v` releases: the secrets and variables below live in the `release` environment. Without them, the macOS app is released ad-hoc signed (Gatekeeper blocks it on other Macs until it's opened with right-click › Open), and the iOS job only checks that the app archives.
  - An App Store Connect API key (Users and Access › Integrations; the App Manager role is enough), shared by both apps: `APP_STORE_CONNECT_API_KEY` (the `.p8` file's contents), `APP_STORE_CONNECT_API_KEY_ID` and `APP_STORE_CONNECT_API_ISSUER_ID`.
  - macOS, signed with Developer ID and notarized: `MAC_CERTIFICATE_P12` (a **Developer ID Application** certificate and its key, exported as `.p12`, base64: `base64 -i cert.p12`), `MAC_CERTIFICATE_PASSWORD`, and the variable `MAC_SIGNING_IDENTITY`, the certificate's name without its `Developer ID Application:` prefix (e.g. `OpenCara (TEAMID)`).
  - iOS, uploaded to TestFlight: an app record for the bundle ID `com.pistead.app` in App Store Connect, `IOS_CERTIFICATE_P12` (an **Apple Distribution** certificate as base64 `.p12`), `IOS_CERTIFICATE_PASSWORD`, `IOS_PROVISIONING_PROFILE` (an App Store provisioning profile for `com.pistead.app`, base64) and the variable `APPLE_TEAM_ID`. Its version is the tag's without a prerelease suffix, and its build number is the run's (`run number.attempt`). Every `ios-v` tag goes to TestFlight; submitting a build for App Store review stays manual.

## Layout

- `apps/server`: the control plane (Hono on Node). `src/db` holds the database providers and the SQLite→Postgres dialect translation; `src/storage` the backup storage providers; `src/workspace-databases` the owner-connected session databases; `src/git` the Git providers and accounts; `src/push` push identities and credentials; `src/data-export.ts` the session and workspace exports; `src/admin.ts` the server administration API; `src/connector-hub.ts` the WebSocket relay to connected hosts.
- `apps/web`: the React UI.
- `apps/mobile`: the iPhone and iPad app (Expo; Android later). `apps/desktop`: the macOS app (Electron; Linux and Windows later).
- `apps/runner`: the connector runtime that runs on each host, published as the `pistead` CLI from `packages/cli` and bundled into the desktop app.
- `packages/shared`: types and policy shared by all of the above. `packages/client`: the API client, live session updates and chat-option rules shared by the web and the apps.
- `docs/design`: design notes, such as the [repository cache](docs/design/repository-cache.md).
