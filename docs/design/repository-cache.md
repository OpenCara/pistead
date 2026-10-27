# Design: host repository cache

Status: implemented, behind the host's **Repository cache** setting (HostConfig.repositoryCache, set by its owner in
Pistead; connectors 0.9.0 and older use `--repo-cache`). The cache holds one Git mirror per repository, which
clone sessions borrow objects from. How clone sessions use it is in [egress.md](egress.md), phase 3; this document
covers the cache itself (`apps/runner/src/repo-cache.ts`).

Until phase 5 of [egress.md](egress.md), sessions pinned their repositories to commits and the cache also served those
pins: the host fetched each pinned commit with its own Git credentials, the server re-checked the owner's access to it
(`repositoryAuthorize`), and the session's worktree was checked out of the cache. That path, the archive downloads it
replaced (`repositoryDownload`, with their tar and zip parsers) and the snapshot rewrite for pushes are gone: every
session now clones, and sessions that pinned their repositories are read-only.

## Layout

```
repo-cache/<provider>/<host>/<repositoryId>.git              # bare mirror: full history, every blob, no partial-clone filter
repo-cache/<…>.git/refs/upstream/{heads,tags}/…              # the remote's branches and tags, as last fetched
repo-cache/<…>.git/refs/pistead/sessions/<hash of session>   # a clone session's keep ref (below)
repo-cache/<…>.git/refs/pistead/pins/<hash of session>       # pins of sessions from before every session cloned
repo-cache/<provider>/<host>/<repositoryId>.git.pistead.lock # holder's pid: one writer (fetch, gc) at a time
```

- **Key.** A mirror is named by the provider's stable repository id (`mirrorPath`), not the repository's name, so a
  rename keeps its mirror and a different repository under an old name never reuses it. Every component is validated
  before it names a directory.
- **Scope.** **Shared** (`host`) serves every session on the host from one cache. **Per owner** (`owner`) keeps one
  per session owner, under `repo-cache/owners/<hash of owner>/`, for owners who don't want to share objects. The
  connector reads the setting when it connects and keeps it for that connection; a switch leaves the other scope's
  mirrors on disk until `pistead cache prune` collects them.
- **Privacy.** The cache root must be a private directory owned by the runner user, or nothing is written.

## Filling a mirror

`RepositoryCache.refresh` brings a mirror up to date with every branch and tag the remote advertises: it lists the
remote's refs (or takes the listing it is given), fetches the tips the mirror lacks with their full history
(`GitRemote.fetchHistory`, offering the tips it already has), checks the result is complete as `git fetch` does (`rev-list --objects`), and updates
`refs/upstream/*`. A remote that refuses a ref (a hidden one) just leaves it out.

Every fetch goes through a `GitRemote` the caller supplies. For clone sessions (`RunnerSession.cacheRemote`) it reads
the repository straight from its provider with the credential Git on the host would use (`hostGitAuthorization`: its
credential helpers), or anonymously where the host has none for the provider. Mirrors were once filled through the
control plane's relay, which carried every pack from the provider to the host: an order of magnitude slower than the
host's own network, cut off with every reconnect of the connector, and never resumed.

The cache decides no access. Before a session asks for a mirror, the relay lists the repository's branches and tags with
the session owner's own account (checking a rename or transfer, as every relayed read does), which confirms that they
may read it; a session borrows a mirror only while that confirmation is recent (see [egress.md](egress.md), phase 3).
The fill comes after it, so a session can't have the host download a repository its owner can't read, and it mirrors
that listing (`MirrorTarget.refs`): the host's credential only downloads the history of the tips the owner's listing
named, so a mirror never holds what that listing didn't reach, even if the repository's name changed hands in between.

- **Retries.** A ref listing or fetch that fails in a way another attempt may get past (the connection failed or broke
  off, the remote answered 5xx, 408 or 429; `GitRemoteError.retryable`) is tried twice more, after 2 and 10 seconds;
  anything else, an unforeseen error included, is final. A fetch starts again from what the mirror had: a pack that
  broke off is not kept.
- **Temporary packs.** index-pack leaves `objects/pack/tmp_*` behind when its pack breaks off. Each fetch removes them
  before it starts and after it fails, and so does a prune, all with the mirror's lock held, so no fetch is writing them.
- **Ready to borrow** (`RepositoryCache.ready`). A mirror no fill has completed yet (`filled`: it mirrors no branch or
  tag) is filled first, however long that takes. A filled one is refreshed too, but answered as it is after a bounded
  wait or a failed refresh, while the refresh goes on: a clone borrows what it has and fetches only the rest.
- **Created up front** (`RepositoryCache.prepare`). A session creates the empty mirror of each workspace repository when
  it opens, so the command that first clones one already mounts the mirror its clone waits to fill.

Only the runner writes to the cache, outside any sandbox. Sandboxes mount a mirror read-only.

## Serialization and progress

Operations on one mirror are serialized: in process with a promise chain, and across runner processes with an
exclusive lock file holding the holder's pid. A lock whose process is gone is taken over; an empty lock gets one poll
interval to receive its pid. An aborted operation fails before Git starts and never takes the lock. A caller that waits
behind another's fetch sees that fetch's progress, which carries Git's numbers only, never remote text.

Git runs against a mirror with no global or system config, no hooks, no credential helpers and no protocols: all
network traffic goes through `GitRemote`.

## Lifetime

- **Keep refs.** Each refresh moves the session's keep ref to a new commit whose parents are its previous keep commit
  and the branch tips it saw (500 parents per commit, chained), so the objects its clones borrowed stay reachable
  while the ref does. `touch` moves it on without fetching, dating the session's last use.
- **Prune.** `pistead cache prune --older-than DAYS` drops keep refs older than that and runs `git gc` with the same
  cutoff, so a clone in a session idle for longer loses the objects it borrowed. Each mirror is locked while it is
  pruned, so it is safe while the connector runs.
- **Pin refs** of sessions from before every session cloned are listed and kept, never written or pruned: a read-only
  pinned session that was checked out of the cache still borrows their objects.
- `pistead cache list` shows each mirror's size and how many sessions and pins keep objects in it.

## Open questions

- A size budget per host, evicting whole mirrors no session has used for longest.
- Pre-filling a mirror without a session. Fills need no relay any more, but which repositories to fill, and when, needs
  a session (or a setting) to say.
- Resuming a fill that broke off from where it was, rather than from what the mirror had: with the host's own network
  a fill rarely takes long enough for it to matter.
