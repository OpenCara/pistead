# Design: sessions that use plain Git through a host egress proxy

Status: implemented: phases 1 (the egress proxy and Git relay), 2 (clone sessions), 3 (the host cache for clones), 4
(session-branch pushes, and backups and moves of clone sessions) and 5 (every session clones; pinned sessions are
read-only, and the pin machinery is gone). This replaced the pinned snapshot model; the host cache it shares is in
[repository-cache.md](repository-cache.md).

## Goal

A session starts with an empty sandbox. The agent uses Git as usual (`git clone`, `checkout`, `fetch`) and other
HTTPS clients as usual. Credentials and policy stay outside the sandbox, in a proxy on the host and in the control
plane. Nothing is resolved, downloaded or pinned when a session is created.

The rules this keeps from today:

- **No credential enters the sandbox.** A sandboxed process can read and send anything it holds, so it holds none.
- **Session owners read with their own accounts.** On a shared host the host owner's credentials never serve other
  members' sessions, and owners' tokens never reach other people's hosts.
- **Policy is enforced where the agent can't change it:** in the runner, outside the sandbox, and in the control plane.

## Phases

1. **Egress proxy (this change).** The sandbox's only network is a per-session proxy on the host. Git reads of the
   workspace's repositories go to a control-plane relay that adds the session owner's credential; other HTTPS
   follows a per-workspace network policy (off, allowlist, open).
2. **Repositories on demand, no pins.** Sessions start empty; the agent clones what it needs with plain Git. The
   commits served and pushed are recorded for audit instead of pins. Branches are plain Git.
3. **Host cache.** A bare mirror per repository on the host, filled by the proxy and mounted read-only into sandboxes
   authorized for it; sessions borrow its objects through `objects/info/alternates` (a `git` shim adds
   `--reference-if-able` to clones of bound repositories). Keep refs per live session, prune with a grace period,
   `pistead cache add` / `pistead cache prune`. Sparse checkout and partial clone served from the mirror.
4. **Pushes and durability.** Pushes to the session branch `pistead/<session-id>` go through the proxy without
   approval; pushes elsewhere need approval. Pull requests, comments and merges keep the broker. Backups and moves
   keep each clone's local work (branches, unpushed commits, uncommitted changes) as a Git bundle and clone the rest
   again. (The first plan pushed a WIP commit to the session branch instead; see below for why it doesn't.)
5. **Removal.** Pin resolution at creation, archive downloads and their validation, `repositoryLimits`,
   `git_repin`, the push rewrite (`pushPrepare`) and snapshot restores go away. Sessions created before the change
   stay readable but frozen.

## Phase 1: the egress proxy

### In the sandbox

Every `bwrap` invocation already unshares the network namespace, leaving only loopback. For shell commands
(`bash` requests only), the runner bind-mounts the session's proxy socket read-only at `/run/pistead/egress.sock`,
and the sandbox helper relays the loopback port `127.0.0.1:41080` to it byte for byte. Commands get:

- `HTTPS_PROXY` / `HTTP_PROXY` (both cases) pointing at the loopback port, `NO_PROXY` for loopback, and
  `NODE_USE_ENV_PROXY=1`;
- `GIT_CONFIG_COUNT` entries rewriting `https://` remotes, and SSH remotes of github.com, gitlab.com and
  bitbucket.org, to `http://127.0.0.1:41080/git/<host>/<path>`;
- `PISTEAD_EGRESS_STATUS`, the proxy's status endpoint;
- the host's trusted certificates (`trust-store.ts`), bound read-only at `/etc/ssl/certs/ca-certificates.crt` and named
  by `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `REQUESTS_CA_BUNDLE` and `NODE_EXTRA_CA_CERTS`. The sandbox has
  no `/etc`, so without them only clients with a store of their own (Node) could verify a tunnel's host (#63). The
  runner writes them into the session's private root at each open, from the host's system store (Node's bundled store
  where it has none) plus its `NODE_EXTRA_CA_CERTS`; no other file of the host's `/etc` is mounted.

None of this is a boundary: a command that ignores it has no network at all. File tools, commits and the other helper
steps get neither the socket nor the variables.

### The proxy (`apps/runner/src/egress.ts`)

One `EgressProxy` per open session, listening on a Unix socket in a private per-process directory (socket paths are
limited to about 100 bytes). Only that session's sandbox can reach the socket, so every request it serves is that
session's. It asks the control plane for the session's **grant** (network policy and workspace repositories), caches
it for a minute, and keeps a stale one for up to five minutes if the control plane is briefly unreachable.

- **`/git/<host>/<path>/info/refs?service=git-upload-pack` and `…/git-upload-pack`** for a workspace repository
  (matched against `bindingRemote`, case-insensitively, with or without `.git`) are relayed to the control plane.
  Other repositories on a host the policy allows get a redirect to their real `https://` URL, which the client then
  fetches through the tunnel below, without credentials. Everything else, and every `git-receive-pack`, is refused
  with a `text/plain` reason that Git shows as `remote: …`.
- **`CONNECT host:443`** opens a tunnel if the policy allows the host and every address it resolves to is public
  (no loopback, private, CGNAT, link-local, multicast or documentation ranges, IPv4-mapped included); the
  connection goes to a checked address, so DNS can't be swapped in between. The proxy never looks inside tunnels.
  Other ports and plain-HTTP proxying are refused.
- **`/__pistead/status`** shows the policy, the relayed repositories and the last 50 decisions (the proxy keeps
  200 in memory).

### The control plane (`apps/server/src/network.ts`)

- `GET|PUT /api/workspaces/:id/network-policy`: members read, owners and admins write (audited as
  `workspace.network_policy.updated`). Stored in `workspace_network_policies`; no row means `off`. Included in
  workspace exports.
- `POST /api/connectors/self/network` (and `/api/internal/network`): the grant for one session, only for the
  connector serving it over its current connection. Archived sessions get none.
- `POST /api/connectors/self/git/relay/:bindingId/:service?sessionId=…` (and `/api/internal/git/relay/…`), `service`
  being `info-refs` or `upload-pack`. Each request re-checks the session's authority and the connector, requires the
  binding to belong to the session's workspace, loads the session owner's own account for it, verifies the
  repository's identity on every request, adds the owner's credential
  (`ownerGitAuthorization`) and streams the provider's answer back after checking its content type. Upload requests
  are bounded to 64 MiB. Refusals by the provider become fixed, credential-free reasons.

### Not in phase 1

- Pushes through the proxy (phase 4: only the session branch, in clone sessions); `git_push` keeps working as before.
- Hosts without the sandbox: their commands use the host's network directly, and the policy doesn't apply.
- Persisting the proxy's decisions: they live in memory for the open session.
- Shell commands still stop after 30 seconds, which limits large clones until the host cache (phase 3).

## Phase 2: clone sessions

### Which sessions clone

A session is created as a **clone session** (`sessions.repository_mode = 'clone'`, `SessionRecord.repositoryMode`) when
its host's connector advertises `plainGit` (sandboxed connectors of this version) and can run the session owner's shell
commands: the host has resource limits (`productionShell`), or the owner is the host's owner. The session's agent must
also have `bash` (a session started from a model always does). Shell access is what cloning needs, so elsewhere
sessions keep pinning as before, and an agent with only file and Git tools keeps its pinned snapshots; phase 5
revisits that. The mode is immutable like the pins
(a trigger refuses updates), carried by restores, and required of a host a clone session moves to.

A clone session pins nothing: creation checks the workspace has a repository and that its bindings don't change before
the insert, but resolves nothing with the owner's accounts. The relay checks the owner's own access on every read.

### In the session

- The worktree starts empty. The agent clones through the proxy, fetches and switches branches with Git, and commits
  with Git. The instructions say so and list the workspace's repositories from the grant.
- `git_status`, `git_commit` and `git_repin` are not offered, and their operations are refused; the control plane
  refuses repins of clone sessions too.
- `git_push {directory, branch, pull_request?}` pushes a clone. The runner reads the clone's checked-out commit and its
  `origin` (`clone-head`), maps the origin to a workspace repository (`repositoryForRemote`: `https://`, SSH and the
  proxy's own form) and asks for approval of `{kind, repository, directory, branch, commit}`, `repository` being that
  binding's path.
- The push broker and the GitHub broker resolve a clone session's repository from the workspace's bindings
  (`cloneSessionRepository`) instead of its pins; everything else about minting, policies and pull requests is
  unchanged.
- `performClonePush` sends the commit as it is: the remote's advertisement gives the branch's tip and the other tips;
  the sandbox (`clone-push-prepare`) reports which tips the clone has, whether the branch's tip is an ancestor of the
  commit, and the new commits; a branch that moved is refused (fetch and merge or rebase first); the pack
  (`clone-push-pack`) excludes what the present tips reach. Git runs in the clone read-only, with its own config but the
  hardened flags, inside the sandbox.

### Not in phase 2

- Clone sessions have backups as before; the snapshot includes the clones and their `.git`, so large clones hit the
  backup size limit until durability moves to the session branch (phase 4).
- Recording the commits served by the relay; pushes are recorded in the push ledger as before.

## Phase 3: the host cache for clone sessions

Hosts started with `--repo-cache` keep one bare mirror per repository ([repository-cache.md](repository-cache.md)),
which pinned sessions were checked out of until phase 5. Clone sessions borrow from the same mirrors.

- **Filled through the relay.** `RepositoryCache.refresh` fetches every branch and tag the remote advertises that the
  mirror lacks, with a `GitRemote` whose `fetch` is `relayFetch`: every read goes through the control plane's relay,
  with the session owner's own account and the relay's checks. Refreshes are serialized per repository with a lock,
  and report progress.
- **Asked for by the clone.** Clone sessions' shell commands get a `git` shim first on `PATH`. For `git clone` of a
  URL, it asks the proxy's `/__pistead/mirror?remote=…` (up to 20 seconds), which maps the URL to a workspace
  repository, refreshes its mirror and answers its path in the sandbox; the shim then adds `--reference-if-able`.
  Clones that already chose `--reference`, `--shared` or `--dissociate`, and everything else, run Git unchanged.
- **Mounted only while authorized.** A mirror is mounted read-only at `/repository-mirrors/<provider>/<host>/<id>.git`
  (`mirrorPath`) for shell commands and for the steps that run Git in a clone (`clone-head`, `clone-push-*`; a
  borrowing clone can't read its objects without it). It is mounted only while the repository is in the session's
  grant and the relay let the owner read it in the last 10 minutes: after this open's refresh of it, or, for a mirror
  that already existed when the session was reopened, after a ref listing through the relay confirms it (asked for
  again every 10 minutes, at the next step that needs it). A refusal from the relay (a 4xx other than a timeout or rate
  limit), or the grant dropping the repository, unmounts it for the rest of the open; a timeout, a rate limit or an
  outage only leaves it out of that step. Mounts are fixed when a step starts, so a mirror the session's
  first clone created is visible from its next command on.
- **Kept and pruned.** Each refresh moves the session's keep ref (`refs/pistead/sessions/<hash>`) to a new commit whose
  parents are its previous keep commit and the branch tips it saw (500 per commit, chained), so the objects its clones
  borrowed stay reachable; each confirmation moves it on too (`touch`), dating its last use. `pistead cache prune
  --older-than DAYS` drops keep refs older than that and runs `git gc` with the same cutoff; pins are never dropped.
  `pistead cache list` shows sizes and how many sessions and pins each mirror keeps.
- **Older control planes.** A grant without provider repository ids still works; its repositories just get no mirror.

### Not in phase 3

- Shell commands still stop after 30 seconds. A first clone of a big repository can outlast that; its mirror keeps
  filling in the runner, so a later clone borrows from it.
- Pre-filling a mirror without a session: every fill needs a session's owner and the relay.

## Phase 4: pushing the session branch

A clone session's own branch is `pistead/<session-id>` (`sessionBranch`), given to shell commands as
`PISTEAD_SESSION_BRANCH`. The agent pushes it with plain Git, without approval; every other branch still goes through
`git_push` and its approval, and so do pull requests (the agent calls `git_push` with the session branch once it has
pushed it). Pinned sessions push only with `git_push`.

- **In the proxy.** `info/refs?service=git-receive-pack` (`receive-refs`) and `git-receive-pack` (`receive-pack`) of a
  workspace repository are relayed only when the session has a branch. The proxy reads a push's command section
  (`readPushCommands`: pkt-lines up to the first flush, at most 64 KiB) and lets through exactly one command that creates
  or moves `refs/heads/pistead/<session-id>` (`sessionBranchRefusal`); anything else is answered as a forge answers it
  (`pushRejection`: `ng <ref> <reason>`, on side-band 1 when negotiated), so Git shows `! [remote rejected] … (reason)`.
  Git's probe before a chunked upload (a lone flush) is answered here. The pack then streams to the control plane as Git
  sends it, up to 2 GiB. Closing the proxy (a session closing, as on a connector reconnect) waits for pushes under way,
  within the relay's hour, so Git hears how one the forge took went.
- **In the control plane** (`push/session-branch.ts`, behind the same relay route). Only clone sessions, and only while the
  owner holds `write` on them, no restore or move is pending, and the binding is still configured. As for an approved
  push, the owner's own account must be able to push the repository (`pushTarget`), and the binding's default-branch
  policy applies. The command section is checked again, then the workspace's push
  identity is minted (`mintPushToken` with `relay`) and used by the control plane itself: the owner's token needs no
  reset, the host's own Git credentials can't serve (`host_git_credentials_relay`), and the owner's account still serves
  only sessions on their own hosts. The advertisement and the push each mint, and an installation token is revoked once
  its answer has streamed back. Each push is audited as `git.push.session_branch` with its old and new commit.
- **Errors.** The control plane's refusals of the advertisement reach Git as `remote: …` text, which covers a missing or
  unusable push identity and missing permission before any pack is sent. Answers the proxy gives itself (a probe, a
  rejection) come once the request is read, so the connection stays up for Git to read them.
- **Force pushes** of the session branch are allowed: it is the session's own, and receive-pack can't tell a fast-forward
  from a rewrite without the objects. Branch rules on the forge can forbid them; pull requests from it are opened with
  `git_push` and its approval.
- **The owner's account** as push identity still serves only sessions on the owner's own hosts, although its token stays
  on the control plane: on another person's host, that host's owner decides what the session pushes under the member's
  name.

### Not yet

- A push's upload must finish within the control plane's request timeout (Node's default is five minutes) and its
  outbound fetch's; the proxy itself allows an hour.

## Phase 4: backups and moves of clone sessions

A clone session's backup (and the snapshot a move carries) keeps its clones' local work, not the clones: what a clone's
`origin` already has is cloned again on restore. That keeps backups small whatever the repository's size, and works for
clones that borrow from the host's mirror.

- **Taking it** (`clone-backup`, before the snapshot). The helper finds the worktree's clones (directories up to four
  levels down holding a `.git` directory, clones inside clones included; `node_modules` is not searched) and, in each,
  without touching its HEAD or index: records `origin`, the checked-out branch, HEAD and every local branch (a name Git
  allows but `validPushBranch` doesn't fails the backup rather than being dropped); commits the working tree (untracked
  files included, ignored ones and clones inside it not) on top of HEAD from a copy of its index, so sparse checkouts
  stay as they are, or uses HEAD when nothing changed; and bundles that commit and the local branches, less what
  `refs/remotes/origin/*` reaches. Bundles share a 16 MiB budget. The snapshot (`files`) then leaves the clones out. The
  backup lists them as `clones` (`CloneBackup`); restorations still pending are carried as they were.
- **Restoring it** (`restore.ts`). Only into a clone session. Each clone is checked (path, branch names, commits, bundle
  header, no duplicate paths); clones may nest, and a pending clone may share its path with files. Its bundle and the
  list of pending clones are staged in the worktree's `.git/pistead-clones`, which shell commands see read-only.
- **Opening the restored session.** Pending clones are cloned again in the background, as a cache host prepares pinned
  repositories, and runs wait for it. For each (`clone-restore`, with the proxy socket and the mirrors): its origin must
  be one of the workspace's repositories; the mirror is refreshed through the relay where the host keeps a cache and
  borrowed from; `git clone --no-checkout` goes through the proxy into a staging directory; commits the bundle builds on
  that the origin no longer lists (a branch merged and deleted) are fetched by commit; the bundle is fetched; branches
  and HEAD are set; the working tree is checked out from the backup commit and the index reset to HEAD, so the changes
  show as uncommitted again; and the clone is moved into place. A path already taken is never overwritten, unless it is
  this restoration's own result (a marker in its `.git`), left by a runner that stopped before updating the list. A
  clone that fails stays pending, carried by later backups, and is retried at the next open; the agent's instructions say
  which and where their bundles are. The runner looks for the list on the host before asking the sandbox.
- **Moves.** The successor's host must advertise `cloneBackups`: an older connector would restore the other files and
  drop the clones.

### Why not a WIP commit on the session branch

The plan was to push a WIP commit to the session branch and clone it on restore. It would put uncommitted work, including
untracked files the agent never meant to publish, on the forge, publicly for a public repository; it would need a push
identity for every backup; it would race the agent's own pushes to that branch; and it would leave a branch per session
on the forge. Bundles in the backup keep all of that where backups already go.

### Not in phase 4

- A clone whose origin no longer serves commits its bundle builds on, not even by commit, fails to restore; its bundle
  is kept for the agent to recover from.
- Clones of repositories outside the workspace, worktrees and submodules (`.git` files) are not restored automatically.

## Phase 5: every session clones, pinned sessions are read-only

- **New sessions** are all clone sessions (`repository_mode = 'clone'`), and pin nothing. The host must advertise
  `plainGit`; a connector from before can't start one (`connector_update_required`). Every connector of this version
  advertises `plainGit` (and, unless unsandboxed, `cloneBackups`) whatever its `sandbox` claim says: real connectors
  advertise `sandbox: false` because isolation is verified per session, and their sessions always run in the sandbox.
- **Unsandboxed hosts** advertise `plainGit` too. Their clone sessions have no proxy: the agent clones, commits and pushes
  with the host's own Git, network and credentials, each command with the owner's approval as before. Their Git config
  gets a credential helper that asks the host user's own helpers with their real HOME (`hostCredentialConfig`), which
  sessions from before don't (their owner config is immutable). `git_push` is not offered there. Backups keep the
  worktree as files, so a session with a clone in its worktree can't be backed up: a clone's history has no bound.
- **Sessions that can't clone.** An agent without `bash`, or another member's session on a host without resource limits
  (whose shell commands are refused), works in an empty worktree. The session is created anyway, and its record says why
  (`cloneUnavailable`, on creation and on single-session reads).
- **Pinned sessions are read-only** (`frozenSession`: not a clone session, with pins). Every runner request but `view`,
  `events`, `create`, `restart` and `stop` (which open it to show its history, and end work) is refused
  (`session_frozen`), and so are push credentials, GitHub comments and merges, restores of their backups and moves.
  Opening one ends whatever it had queued or at work, and the cards waiting on decisions, as `interrupted`. Their transcript, approvals, backups (to download) and exports stay available; the session
  record says `frozen`, and the web and mobile apps offer nothing that would be refused.
