# Design: host repository cache with per-session Git object stores

Status: phase 1 in progress, behind the connector flag `--repo-cache` (preview). Done: the host cache and
full-history fetch (`repo-cache.ts`, `git-remote.ts`), the server's per-session authorization (`repositoryAuthorize`),
checking pinned trees out of the cache in the sandbox and in host mode, and session start. Not yet done: push without
re-fetching, progress in the UI, backups and restores of cache-backed sessions, and cache cleanup.

### Session start (implemented)

The control plane waits 30 seconds for a session's `create` and disconnects the connector when it times out, so a
first clone cannot run inside `create`. On a cache host, `RunnerSession.open()` returns at once and prepares the
repositories in the background: for each pin, `authorizeRepository` (the server re-checks the owner's access; the
answer must name exactly the pin and `repositoryRemote(pin)`), `RepositoryCache.ensure` and `inspect`; then one
`materializeFromCache`. `drainQueue` holds runs until it is done, so messages sent meanwhile queue. If it fails, new
messages are refused with the reason (for example "No Git credentials for github.com are set up on this host"), queued
ones stay queued, and restarting the session tries again. `close()` aborts a fetch in progress. Already checked-out
sessions re-run the authorization and `ensure` on every open (cheap when cached), so a host that lost the pin fetches
it again. Sessions checked out from archives keep working on a cache host and never use the mounts.

## How sessions get their code today

1. The server pins each workspace repository to a commit (`resolveWorkspaceRepositories`).
2. For each pin, the runner asks the server for an archive (`repositoryDownload`). The server downloads the
   provider's tarball or zip with the owner's credential, checks it, and sends it on.
3. The runner (the Python helper in `sandbox.ts`, or `HostWorkspace#materialize` without bubblewrap) extracts
   every archive into one worktree, runs `git init`, and makes one root commit,
   "Initialize pinned repository snapshots", whose tree holds every repository under its `path`. The commit is
   recorded as `baseline` in `.git/repository-cache.json`.
4. To push, the runner fetches the pinned commit again (`GitRemote.fetchCommit`, depth 1, `blob:none`), takes
   the session commits that touch `path/`, rewrites them onto the pinned commit in a scratch repository
   (`pushPrepare`), and pushes the result fast-forward.
5. A backup (`snapshot`) holds the whole worktree and the whole `.git`, with a 32 MiB limit.

Problems with this approach:

- **Hard size limits:** an archive can be at most 8 MiB compressed, 32 MiB expanded and 10,000 entries in total
  (`repositoryLimits`). Most real monorepos are bigger than that.
- **Repeated downloads:** every session, restore and push downloads the repository again.
- **No history:** the agent sees one synthetic commit, so log, blame and bisect have nothing to work with.
- **Size limits on backups and restores:** backups hold full copies of the files, so they also run into the
  32 MiB and 24 MiB limits.
- **Two code paths to keep in sync:** the tar/zip validation code (`parseArchive`, `zipToTarGz`) is large,
  security-critical, and written twice, once in Python and once in TypeScript.

## Proposal

### Host cache

On each connector host, add a cache directory owned by the runner, for example `<dataDir>/repo-cache/`. By
default there is one cache per host. A connector option (`--repo-cache-scope=owner`) switches to one cache per
session owner, at `repo-cache/owners/<ownerId>/…`. It holds one bare repository per repository identity:

```
repo-cache/<provider>/<host>/<repositoryId>.git              # bare repository; full history, no partial-clone filter
repo-cache/<…>.git/refs/pistead/pins/<hash of session id>    # keeps each live session's pinned commit reachable
repo-cache/<…>.git/refs/upstream/{heads,tags}/…              # the remote's branches and tags, as last fetched
repo-cache/<provider>/<host>/<repositoryId>.git.pistead.lock # holder's pid: one writer (fetch, gc) at a time
```

- **Cache key:** the cache is keyed by the provider's stable repository id, not its name, because renames
  already fail closed in `verifyRepository`.
- **Writers:** only the runner process writes to the cache, outside any sandbox. Fetching takes a lock for that
  repository. Sessions never write to it.
- **Fetching:** the runner fetches on the host, never through the server. It fetches the pinned commit plus
  the remote's branches and tags, with full history and no `filter`. Later fetches download only new objects.
- **Why no partial clone:** with `blob:none`, Git downloads missing file contents on demand when a command
  needs them (log -p, blame, old revisions). Those downloads would happen inside the sandbox, which has no
  network and no credentials, so the commands would fail. A complete clone means the session never needs the
  remote, so credentials are only used by the runner while it fetches.

### Credentials and authorization

Today the runner holds a credential only while it pushes (`PushCredential`). The server performs every read.
The cache changes this, and access must still fail closed:

1. **Fetch credential: host only.** The runner fetches with the host's own Git credentials and nothing else.
   It reuses `hostGitAuthorization()` (`git-credentials.ts`), which asks the host user's credential helpers
   (gh, keychain, Git Credential Manager, a store file) through `git credential fill`, never prompts, and is
   already used by the `host-credentials` push identity. The server never sends a read credential to a host,
   so no repository token leaves the control plane for reads. The runner keeps the resulting header in memory
   for one `GitRemote` fetch, and never writes it to disk, to the cache's Git config, or into a sandbox.
   - The remote URL is not secret. Both sides derive it from the pin with the shared `repositoryRemote(pin)`
     (the same function pushes use), the server returns it from the authorization call, and the runner refuses
     to fetch if the two differ.
   - If the host has no credential for that remote, or it cannot read the repository, session start fails with
     the existing message ("No Git credentials for <host> are set up on this host (for example with gh auth
     setup-git or a credential helper)") or a "this host cannot read <repo>" error. There is no fallback to a
     server credential.
   - The fetched pin is checked: the cache must contain exactly the pinned commit the server resolved with the
     owner's account, so a host credential that sees a different repository under the same URL fails closed.
2. **The owner's access is still checked by the server, for every session:** the host's credential decides what
   the host can fetch, not what the session owner may read. The server already verifies the owner's own access
   when it pins a commit (`resolveWorkspaceRepositories`), and it re-checks it with
   `POST /api/connectors/self/repositories/:bindingId/authorize` (or `/api/internal/…` for runners without a
   connector) before the runner uses the cache, whether the commit was just fetched or already cached.
   - **Checks:** the same session and connector authority as the archive download (current connection, session
     not archived, unchanged policy version, pins and owner); the owner's own account still reads the repository
     under the same identity (`verifyRepository`, before and after); the owner's account still reads the exact
     pinned commit (GitHub `commits/<sha>` with the sha media type, or the provider adapter's `commit()`); and
     the owner's provider connection did not change during the call (`recheckAccess`).
   - **Answer:** `{ repository: { bindingId, commit, remote } }`, `Cache-Control: private, no-store`. No
     credential and no repository content. The request accepts only `sessionId` and `commit`, so a host cannot
     name its own remote, owner or ref.
   - Without this check a second user on a shared host could read a private repository that only the host
     account (or another owner) can see.
3. **Shared cache across owners:** one cache per host is safe under bubblewrap, because authorization happens
   for each session and not per cache. Owners who don't want to share a store, or hosts that run without
   bubblewrap, can use the per-owner scope.
4. **Fallback to archives:** the server-side archive path (`repositoryDownload`) goes away for connectors that
   support the cache. Keep it only for older connectors during the transition.

### Session layout: phase 1 (keep one session repository)

Keep today's model of one Git repository for the session, with repositories under their paths. This means
`git_status`, `git_commit`, the cache marker, restore and push validation keep working as they are.

- **Create the session repository:** `git init`, as today. Then write
  `.git/objects/info/alternates` with one line per pinned repository's cache `objects` directory: the read-only
  mount `/repository-cache/<n>` (pin order) in the sandbox, or the cache's host path in host mode.
- **Build the baseline commit without archives:** only the directories above the pinned paths are new, so they
  are written with `git mktree`, each referencing its pinned tree by id. Then one `read-tree <root>` (which also
  fills Git's cached tree index), `checkout-index --all --index` into the empty worktree, and `commit-tree`.
  No archive is parsed and no cached object is copied: Git duplicates any object it "writes" that exists only in a
  read-only alternate, so a `write-tree` over the prefixed trees would have copied every tree of every repository.
  A session holds three new objects after checkout (two directory trees and the baseline commit), and owner
  commits add only the blobs and trees they change. These counts are tested.
- **Marker:** version 2 (`source: "cache"`), so older runners refuse cache-backed sessions instead of using them
  without their mounts. Readiness also requires the alternates file to match the configured mounts exactly.
- **Hardening:** the existing `GIT_HARDENED` flags already disable hooks, fsmonitor, protocols and similar risks.
  With archives, the checks happened in `parse_archive`. Now the runner checks each pinned tree in the cache
  before checkout (`RepositoryCache.inspect`, which streams `ls-tree -r -z -l`), with the same path rules: no
  traversal, control characters, backslashes or `:`, no `.git` component in any spelling Git treats as one
  (`.GIT`, `.git.`, `git~1`), bounded depth, length and size (`repositoryLimits.checkout*`), UTF-8 names. A
  commit's tree never changes, so checking it once, outside the sandbox, is enough.
- **Submodules:** kept in the index and checked out as empty directories, as archives left them, so pushes never
  delete them.
- **Symlinks:** they are checked out as real symlinks (mode `120000`). Each target must be relative, must
  resolve lexically inside its own repository's `path/`, and must not point into Git metadata. File tools already
  resolve paths and refuse anything that leaves the worktree, and `snapshot()` must learn to store symlinks as
  links instead of refusing them (backups of sessions with symlinks fail until then).
- **Push gets simpler:** `pushPrepare` no longer needs to fetch the pinned commit from the remote, because
  `base` is already in the alternate object store. The rewrite loop stays as it is. The remote is still contacted
  for the receive-pack advertisement, which is the fast-forward check.
- **What the agent sees:** the session repository still has one synthetic baseline commit. But the full history
  of each repository is in the alternate object store, and `refs/remotes/<path>/pinned` names each pinned commit
  (when `<path>` is a valid ref name), so `git log acme/alpha/pinned`, `git blame <pinned commit> -- file` and
  `git diff <pinned commit> …` work. Branches and tags are not mirrored into sessions yet: a session ref to an
  upstream tip the cache later prunes would break, so that waits for cache garbage collection. Phase 2 is still
  the better experience.

### Session layout: phase 2 (a real repository for each pin, optional)

To make `git log` and `git blame` work inside the session, each `path` becomes its own repository, with
`objects/info/alternates` pointing at that repository's cache, `HEAD` at a session branch, and the base at the
pinned commit:

- **Simpler push:** push becomes `pack-objects <tip> ^<remote branch head>`, with no rewrite step.
- **Tool and marker changes:** `git_status` and `git_commit` must work across several repositories, and the
  cache marker and baseline checks become per repository.
- **Breaking change:** this changes the agent-visible layout, so it should be opt-in for each workspace.

I'd ship phase 1 first. It delivers the speed and size gains with a small, contained change.

### Isolation

- **bubblewrap:** mount each pinned repository's cache `objects` directory read-only into the sandbox, at a fixed
  path such as `/cache/<n>/objects`. The alternates file uses those paths. The session `.git` stays the only
  writable Git directory, so new objects always land there.
- **Host mode (`HostWorkspace`):** without bubblewrap, nothing can be mounted read-only. An approved command
  already has the full rights of the runner user, so it could also damage the cache. Two ways to limit the
  damage:
  - run `git fsck --connectivity-only` on a pinned commit before reusing it;
  - give each owner a separate cache directory in host mode.
- **Corruption:** objects are verified by their hash, so a corrupted object shows up as missing or broken. It
  cannot silently become different content. On a failed check, re-fetch.

### Backups and restore

`snapshot()` currently copies the whole worktree and `.git`. With alternates:

- **Backup contents:** keep `.git` without `objects/info/alternates`, which is rewritten on restore. Keep only
  the worktree files that differ from `HEAD`, which you can get from `git status` / `git diff --name-only HEAD`
  plus untracked files. Committed files can be rebuilt with `checkout-index`. Backups then stay small even for
  large repositories.
- **Restore:** the pins are already checked as identical (`Backup immutable repository pins mismatch`). Restore
  makes sure the cache has each pin (authorize, then fetch if missing), writes alternates, rebuilds the
  committed files, then applies the changed files from the backup.
- **Compatibility:** this requires a new backup format version (`pi-runner-backup-v2`). v1 restores keep working.

### Lifetime and garbage collection

- **Pin refs:** pins are added when a session starts and removed when it is archived or deleted. They are also
  rebuilt at runner start from the sessions present on disk.
- **gc schedule:** run `git gc --prune=<grace>` only under the cache lock, with a grace period longer than the
  longest session start, for example 1 day.
- **Object safety:** sessions never write into the cache, and their own objects live in their own `.git`, so
  cache gc can only drop objects that no session pin reaches.
- **Disk budget:** set a size limit per host. Evict whole repositories with no live pins, least recently used
  first.

### Limits

- **Cache size:** a new connector option, for example `--repo-cache-max-bytes`, separate from per-session
  limits.
- **Checkout size:** `repositoryLimits.archiveBytes` and `expandedBytes` would no longer apply to checkout.
  Replace them with per-session checkout limits on files and bytes that are much higher, configurable, and
  still enforced before `checkout-index`.
- **File tools:** `MAX_FILE_BYTES` and the file-tool limits stay the same.

## Code that changes (phase 1)

| Area | Change |
|---|---|
| `packages/shared/src/repositories.ts` | Done: `repositoryRemote(pin)`, moved from `push/targets.ts`. To do: limits for checkout, separate from archive limits. |
| `packages/shared/src/connector.ts`, `apps/server/src/connectors.ts` | Done: the `repositoryCache` connector capability. |
| `apps/server/src/repositories.ts`, `internal.ts` | Done: `repositoryAuthorize` (connector and internal routes), sharing its session and connector checks with `repositoryDownload`, which stays only for older connectors. |
| `apps/runner/src/git-remote.ts` | A full-history fetch into the bare cache repository (want the pin plus branches and tags, `have` what the cache already holds, no depth or filter), with structured progress. |
| `apps/runner/src/git-credentials.ts` | Reused as-is for fetches (`hostGitAuthorization`). |
| `packages/shared` protocol, `apps/server/src/connector-hub.ts`, `apps/web` | `repository-progress` message, relay, and progress rows in the session view. |
| `apps/runner/src/` (new `repo-cache.ts`) | Cache layout (per host or per owner), locks, pin refs, gc, eviction. Runs outside the sandbox. |
| `apps/runner/src/connect-cli.ts`, `connector.ts` | Done: `--repo-cache` (opt-in while in preview) and `--repo-cache-scope host\|owner`; the connector creates the cache in its private state directory, advertises `repositoryCache`, and calls the scoped authorize route. To do: `--repo-cache-max-bytes`. |
| `apps/runner/src/session.ts` | Done: background preparation, held runs, refusal with the reason, agent instructions that mention the history. |
| `apps/runner/src/sandbox.ts` | Done: read-only `--ro-bind-try` mounts of the cache object directories (by path: the resource supervisor passes only fds 3-6 to bwrap), `materializeFromCache` (`repository-checkout` in the helper), `repositoryCacheState`, version 2 markers. To do: in `push_prepare`, skip the upstream pack; in `snapshot`, the diff-only format and symlinks. |
| `apps/runner/src/host-workspace.ts` | Done: the same checkout for host mode. To do: a fsck check of cached pins. |
| `apps/runner/src/repo-cache.ts` | Done: `inspect`, the tree check before checkout. |
| `apps/runner/src/push.ts` | Skip `fetchCommit` when the base is in the cache. |
| `apps/runner/src/restore.ts` | v2 backups: rebuild from the cache, then apply the changed files. |
| `tests/` | Connected suite: cache hit and miss, revoked access on a cache hit, two owners on one host, gc while a session is live, restore from v2. |

## Decisions

1. **History:** full history with all file contents, no partial clone.
2. **Symlinks:** real symlinks, restricted to targets inside their repository.
3. **Cache scope:** one cache per host by default; one per owner as an option.
4. **Fetching:** always done by the runner on the host, never by the server, and always with the host's own
   Git credentials. The server never sends a read credential to a host; it only authorizes the owner's access.
5. **First session on a host:** it waits for the clone, and the UI shows the clone's progress.
6. **Push identity:** unchanged. Reads always use the host's credentials, but pushes keep using the identity
   configured for the repository (GitHub App, the owner's account, or host credentials when chosen), as today.

## Clone progress

The first session on a host waits while the runner clones; later sessions only wait for the incremental fetch.

- **Source:** `GitRemote` currently sends `no-progress` and drops side-band 2. For cache fetches it stops
  sending `no-progress` and parses band 2 lines ("Counting objects", "Compressing objects", "Receiving objects:
  N% (a/b)", "Resolving deltas"). It also counts the pack bytes it receives, so it can show bytes and rate
  even when the remote sends no progress. `index-pack -v` reports the local receiving and delta phases.
- **Sanitizing:** progress lines come from the remote, so the runner reduces them to structured fields (phase,
  percent, done, total, bytes) and never forwards raw text.
- **Transport:** a new connector message, e.g. `repository-progress { sessionId, path, phase, percent, done,
  total, bytes }`, throttled to a few updates per second, relayed by `connector-hub.ts` to the session's
  watchers.
- **UI:** the session view shows one progress row per repository while the session is "preparing", and a
  clear error if the fetch fails (no host credential, no access, network).
- **Concurrency:** if two sessions need the same repository, the second waits on the cache lock and shows the
  first fetch's progress instead of starting another.
- **Timeouts:** cache fetches get a long deadline like pushes (`PUSH_TIMEOUT_MS`, one hour) instead of
  `TIMEOUT_MS`, and can be cancelled when the session is closed.

## Open questions

1. **Shared hosts.** When a host is shared with a workspace, other members' sessions on it fetch with the host
   owner's Git credentials. The server checks each member's own access first, and the URL comes from the pin,
   so a member only ever gets repositories they can read themselves. But the host owner's account is what the
   forge sees for those reads (audit logs, rate limits). Pushes with host credentials are stricter today: the
   owner must opt in with `--git-credentials`, and they only run in the host owner's own sessions
   (`requireOwnHost`). Options: (a) allow cache reads for every session on the host, which is how it works now;
   (b) require an opt-in flag for reads in other members' sessions, and fail those sessions with a clear error
   without it; (c) restrict cache reads to the host owner's own sessions.
