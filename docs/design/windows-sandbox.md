# Design: a native Windows 11 sandbox for the connector

Status: experimental implementation behind `pistead connect --experimental-sandbox` (macOS and native Windows), and
native Windows without a sandbox (`--unsafe-no-sandbox`); not yet run on either platform. See
[Implementation](#implementation-experimental) for what exists and what the first runs must check. The cross-platform
decision is in [Choosing](#choosing-across-windows-linux-and-macos-from-the-requirements-alone). Native Windows is refused today
(`apps/runner/src/connect-setup.ts`), and Windows hosts run the connector inside WSL2.

This note sets out what a native backend has to guarantee, the Windows primitives that can provide it, how three
open-source sandboxes build on those primitives, and a recommended path. Sources read for it:

- **OpenAI Codex** (`codex-rs/windows-sandbox-rs`, `windows-sandbox-service`, `mxc-sandbox`; Apache-2.0), at commit
  `d292f72` (2026-10-14).
- **Anthropic sandbox-runtime** (`src/sandbox/windows-sandbox-utils.ts` and its README; Apache-2.0), at v0.0.79. Its
  Rust helper `srt-win` isn't in the published source, so its design is taken from the README.
- **Microsoft MXC** (`microsoft/mxc`; MIT), at v1.0.1 (docs and the source layout), and the `@microsoft/mxc-sdk` npm
  package at 1.0.1.

Points marked *(unverified)* come from general Windows knowledge, not from those sources. Nothing here has been
run on Windows yet; see [Spikes](#spikes-before-committing).

## Implementation (experimental)

What exists, in `apps/runner/src`:

| Piece | Where | Notes |
|---|---|---|
| One interface for every backend | `workspace.ts` | `SessionWorkspace` (every backend), `IsolatedWorkspace` (clone, backup and push steps that run inside the boundary) |
| A workspace for helper-per-step backends | `helper-workspace.ts` | Same checks, queueing, limits and output caps as `Sandbox`. The session's Git directory is `root/git`, with a runner-written `gitdir:` file at `worktree/.git` that steps can't change |
| Loopback egress with a token | `egress.ts` (`tcp`, `endpoint`, `egressEnvironment(branch, endpoint, caBundle)`) | An ephemeral `127.0.0.1` port. Requests need `pistead:<token>` as Basic credentials (401 for the proxy's own endpoints, 407 for proxying); `HTTPS_PROXY` and the Git rewrites carry them |
| macOS | `seatbelt.ts` | `sandbox-exec` with a generated, deny-by-default profile, with paths passed as `-D` parameters; the Linux Python helper, told where things are (`SANDBOX_GITDIR`, `SANDBOX_GIT`, `SANDBOX_BASH`, `SANDBOX_OWNER_CONFIG`) |
| Windows | `windows-sandbox.ts`, `windows-job.ts`, `node-helper.ts` | A per-step Node runner in a job object (koffi) loads MXC, refuses any tier but `base-container`, and runs the Node helper in the container |
| Native Windows without a sandbox | `platform.ts`, `lease.ts`, `host-workspace.ts`, `host-shell.ts`, `file-browser.ts`, `connector.ts` | A named-pipe lease, Git for Windows' bash, `taskkill /T`, no POSIX mode checks |
| CLI | `connect-cli.ts`, `connect-setup.ts` | `--experimental-sandbox`, `--memory-limit`, `--process-limit`, `--cpu-limit`; per-platform prerequisites |

Tested on Linux (`tests/native-sandboxes.test.ts`): both helpers run unconfined through `HelperWorkspace` (files,
`.git` protection, shell, clone head, push preparation and pack, snapshot, backup), the token-guarded proxy, the
Seatbelt profile's rules, and the Windows scripts' syntax. Nothing here has run under Seatbelt or PSEC.

Where the implementation departs from the decision above:

- **The proxy is authenticated by a per-session token on both platforms**, not by looking up the peer process
  (`GetExtendedTcpTable` + `IsProcessInJob`). The kernel fences (Seatbelt's port rule, PSEC's per-container filter)
  keep sessions off each other's ports; the token keeps other programs on the host off them. A peer check can be
  added on Windows later.
- **macOS uses our own Seatbelt profile**, not MXC's. That avoids a 108 MB dependency and native code loaded
  through FFI, and the profile is in the repository to review. Its rules follow MXC's and Codex's documented ones.
- **Not yet:** the repository cache and GPU on both, and clone-session backups and moves on Windows (the Node helper
  has no `clone-backup`/`clone-restore`; the workspace refuses them by name).

What the first runs must check, beyond [Spikes](#spikes-before-committing):

- macOS:
  - the profile lets Python (from the developer tools), Git over the proxy, bash, node and Homebrew tools start;
  - nothing outside the session is readable;
  - `curl`/`git` send the proxy credentials from the URL (the 407 path), and Go tools' TLS (no `trustd` lookups are
    allowed);
  - xcrun caches and `/private/var/folders` writes are denied without breaking tools.
- Windows:
  - whether MXC replaces our `HTTPS_PROXY` (which carries the token) with its own `networkProxy` value; if so, tunnels
    get 407s, and the token has to go another way or be replaced by the peer check;
  - whether a read-only grant inside a read-write one (`worktree\.git`) and grants of single files (owner config,
    CA bundle) work under PSEC;
  - that MXC's container stays inside the runner's job (no breakaway) and the job's limits hold;
  - Git for Windows' bash and coreutils inside the container;
  - the named-pipe lease;
  - unsandboxed sessions end to end.

First run on Windows 11 25H2 build 26200.9445 (MXC 1.0.1 reports `base-container` there):

- Fixed: the container's environment needs `LOCALAPPDATA` (MXC refuses to start without it); `ui.disable: true` turns
  Win32k off, so `node.exe` and `git.exe` die in DLL initialization (`0xC0000142`); Node needs
  `--preserve-symlinks-main` because the container can't `lstat` the drive root.
- Holds: other sessions' folders, the host user's profile, `C:\ProgramData`, `C:\Users\Public` and `C:\Windows\Temp`
  are denied; direct egress and other loopback ports are blocked while the session's proxy port is reachable; the job's
  memory and process limits reach into the container, and closing the job ends it.
- Open:
  - MSYS2 programs (Git for Windows' `bash.exe`, `sh.exe`, coreutils) die in DLL initialization inside the container,
    so shell commands can't run;
  - Git for Windows can't get its working directory unless every ancestor folder is readable (it needs traversal
    without read, `enumeratePaths`, which this build lacks);
  - MXC replaces `HTTPS_PROXY` with `http://127.0.0.1:<port>`, dropping the session token, so proxied requests get 407;
  - a loopback server inside the container can't be connected to (expected before .9550);
  - unsandboxed: stopping a command leaves the background processes MSYS2 bash started (`taskkill /T` can't follow
    them), so a time limit or cancel waits for them to finish.

## What the Linux sandbox guarantees today

These come from `apps/runner/src/sandbox.ts` (bubblewrap), `resources.ts` (cgroup v2) and `egress.ts`. A Windows
backend has to keep every one of them, or say clearly which it drops.

| Property | Linux mechanism |
|---|---|
| Nothing of the host is visible except an allowlist | `--unshare-all`, read-only `/usr` `/lib` `/lib64`, empty `/etc` apart from the CA bundle |
| Only the session's worktree and home are writable; `.git` is writable only for Git steps | fd-pinned `--bind-fd` / `--ro-bind-fd`, `--remount-ro /` |
| No direct network; the only way out is the session's egress proxy | network namespace; the proxy's Unix socket bind-mounted at `/run/pistead/egress.sock`, relayed to `127.0.0.1:41080` inside |
| **Sessions are isolated from each other and from the host user** (members share hosts) | one namespace set per command, with mounts limited to that session |
| No privileges; the process tree dies with the runner; commands are killable | `--cap-drop ALL`, `--disable-userns`, `--die-with-parent`, `--new-session`, process-group kill |
| CPU, memory, process and disk limits | operator-provisioned cgroup v2 subtree, plus an ext4 or tmpfs volume per sandbox root |
| Race-free file tools | the Python `HELPER` runs *inside* the namespace and walks pinned directory fds with `O_NOFOLLOW` |
| Git without hooks, stored credentials or SSH; host CA bundle | `.gitconfig` pinned read-only; `SSL_CERT_FILE` and similar variables |
| Optional GPU render node | `gpuMounts` (`/dev/dxg` or DRM render nodes) |

The fourth row matters most here. Pistead hosts are shared between workspace members, so one container per host
isn't enough: it has to be one boundary **per session**.

## Windows primitives

| Primitive | What it gives | Gaps for Pistead |
|---|---|---|
| **Restricted token** (`CreateRestrictedToken`, `WRITE_RESTRICTED`, `DISABLE_MAX_PRIVILEGE`) | Writes allowed only where a restricting SID has an ACE. Chromium and Codex's "legacy" backend use it | `WRITE_RESTRICTED` limits writes only, so reads still run as the real user (`~/.ssh`, browser profiles). No network control |
| **Low integrity level** | No write-up | Read-up is still allowed. Not a confinement boundary on its own |
| **AppContainer / LPAC** | Deny by default on files, registry and named objects. Network by capability (`internetClient`, `privateNetworkClientServer`). Has its own SID | Every path must be granted with ACEs on the host (MXC's "Tier 3 DACL" mutates host security descriptors). Many tools fail at start-up (`C:\` attributes, `\Device\Null`, whose SD resets at every boot; see MXC `host-prep.md`). Loopback to the host is blocked unless exempted, which needs admin *(unverified)* |
| **Dedicated local user account** | A different user SID: no rights on the real user's files, its own profile and `HKCU`, and processes it spawns out of band (Task Scheduler, COM, BITS) still carry it. Used by Codex "elevated" and srt-win | One-time admin install. Still reads anything readable by `Users`, `Authenticated Users` or `Everyone` (non-system drive roots, `C:\ProgramData`, `C:\Users\Public`), so it's allow-by-default for world-readable data. A single account doesn't separate sessions from each other |
| **WFP filters / firewall rules keyed on a SID** (`FWPM_LAYER_ALE_AUTH_CONNECT_V4/V6`, `ALE_USER_ID`) | Kernel egress fence: block everything except loopback to the proxy port. srt-win and Codex both rely on it | Installing filters needs admin; they're persistent and machine-wide |
| **Job objects** | Kill-on-close tree termination, `JOB_OBJECT_LIMIT_JOB_MEMORY`, `JOB_OBJECT_LIMIT_ACTIVE_PROCESS`, CPU hard cap (`JobObjectCpuRateControlInformation`), UI limits. Jobs nest (Windows 8+) | No disk quota |
| **Private desktop** (`CreateDesktop`) / `JOB_OBJECT_UILIMIT_*` | Blocks shatter attacks, `SendInput` and clipboard access to the user's session. Codex `desktop.rs` | Some tools want a visible desktop |
| **PSEC / BaseContainer** ("ProcessContainer", reached through MXC) | An OS-native process container with its own container SID. Path grants and deny paths are enforced by the OS without mutating host ACLs. Per-container WFP egress and a per-container WinHTTP proxy. No UAC prompt per launch | New: Windows 11 24H2/25H2 builds **26100/26200.9278** (August 2026 update) and later, and **.9550** (September 2026) for loopback servers inside the container (MXC `os-version-support.md`, `networking.md`) |
| **Windows Sandbox** (Hyper-V VM) | VM-level isolation | One VM per host (MXC acquires "the host's single Windows Sandbox VM"), seconds to boot, experimental in MXC. Not on Home editions *(unverified)*. Doesn't fit many concurrent sessions |
| **Windows containers** (Docker/containerd) | Namespaced Windows userland | Gigabyte Server Core images; Hyper-V isolation on client SKUs. Too heavy |
| **Sandboxie-Plus** | Mature, driver-based | Kernel driver install and GPLv3. Not something to embed |
| **WSL2** | Today's supported path: the bubblewrap sandbox unchanged | Needs WSL2, and Windows-native tools aren't available |

## How the reference implementations do it

### OpenAI Codex: three backends

- **Legacy (unelevated):** a restricted token with `DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED`. The
  restricting SIDs are random synthetic capability SIDs (`S-1-5-21-…`), one per workspace and one per extra writable
  root (`cap.rs`), plus the logon SID and Everyone (`token.rs`). Allow ACEs for those SIDs are written on the
  writable roots, and the default DACL is limited to the logon SID so launches can't open each other's processes.
  This gives write confinement only: no read confinement and no network fence.
- **Elevated:** a one-time admin setup (`setup_provisioning/`) creates local sandbox users (offline and online)
  with DPAPI-protected random passwords. It installs Windows Firewall rules (`firewall.rs`: block non-loopback in
  and out for the offline user, block loopback except the proxy ports) and WFP filters keyed on the account
  (`wfp.rs`). Commands run under a restricted token of that user (`create_…_with_caps_and_user_from`) on a private
  desktop (`desktop.rs`), and deny-read ACLs are applied to protected paths (`deny_read_acl.rs`). A newer
  `windows-sandbox-service` moves provisioning into a service with package identity.
- **MXC (newest, opt-in through `features.prefer_mxc`):** the command is wrapped through MXC's `BaseContainerRunner`.
  It **refuses MXC's AppContainer and ACL fallbacks** ("never enters MXC's ACL fallbacks"), so it runs only where
  PSEC is usable. Managed networking allows loopback to the proxy listeners and denies direct egress. Their README
  notes that native host-loopback access is bidirectional, so they require `allow_local_binding = true`.

The direction is telling: Codex built two generations of DIY token, user, firewall and ACL machinery (about 38k
lines of Rust across its Windows crates, tests included), and is now moving to the OS container.

### Anthropic sandbox-runtime: `srt-win` (alpha)

- A one-time `windows-install` (one UAC prompt) provisions a single `srt-sandbox` local user, with its password
  DPAPI-encrypted in HKLM, a `sandbox-runtime-users` group and a machine-wide WFP filter pair. The pair permits
  loopback connects into a proxy port range (default `60080–60089`) and blocks every other connect from that SID.
- Each command goes through a two-hop launch: broker → `CreateProcessWithLogonW` runner as `srt-sandbox` → target
  under a restricted token inside a job object.
- Filesystem access uses additive, inheriting explicit ACEs for the sandbox SID (`allowWrite` = MODIFY without
  `FILE_DELETE_CHILD`, plus deny ACEs), written at `initialize()` and refcounted for removal.
- Known limitations it documents: per-user tool installs are unreachable; schannel revocation checks fail behind the
  fence; the proxy token is visible on the runner's command line; DNS through `Dnscache` isn't fenced.
- One account serves every session, so it doesn't separate concurrent sessions. That's fine for a single-user CLI,
  but not for Pistead's shared hosts.

### Microsoft MXC

- An SDK with Rust, .NET and **Node (`@microsoft/mxc-sdk`, Node ≥ 24, MIT)** bindings, plus a `wxc-exec.exe` JSON
  executor. Its `ContainerRequest` takes `command`, `filesystem {readwritePaths, readonlyPaths, deniedPaths}`,
  `network {egress, ingress}`, `ui`, `timeoutMs`, `workingDirectory` and `environment`.
- **The Windows ProcessContainer has tiers.** `base-container` is PSEC (OS-enforced). `appcontainer-bfs` and
  `appcontainer-dacl` are fallbacks that mutate host ACLs and need `wxc-host-prep` admin steps.
  `probe()` / `getAvailableBackends()` report the tier, and `fallback.allowDaclMutation: false` refuses Tier 3.
- **Its networking "Model 2: proxy-only egress (recommended)" is Pistead's egress design:** egress deny by default,
  per-container WFP that permits only the configured loopback proxy endpoint, with `HTTP(S)_PROXY` set to it. An
  identity-less loopback proxy (an unpackaged Node process, like our connector) needs `hostLoopback: "allow"`
  together with the proxy endpoint. Builds .9550+ report `identitylessLoopbackProxy`.
- It applies no CPU, memory or process limits to ProcessContainer. It only assigns a kill-on-close job, so Pistead
  would have to add its own limits.

## What changes for Pistead on Windows

1. **Egress transport.** Bind-mounting a Unix socket doesn't exist on Windows, and with no network namespace the
   sandbox shares the host's loopback. A fixed `127.0.0.1:41080` therefore can't serve several sessions. Each session
   needs **its own proxy port**: `egressEnvironment`, the `GIT_SHIM` template and `identity` would take the port
   instead of the `EGRESS_PORT` constant. The fence (PSEC's per-container WFP) must allow each container *only its
   own* port. srt-win's shared port range would let session A reach session B's proxy, and through it B's owner's
   Git read access.
2. **Proxy peer authentication.** Any process on the host, including other users', can connect to a loopback port,
   and the proxy reads repositories with the session owner's account. Before relaying, the proxy should verify that
   the peer belongs to the session: look up the peer's PID with `GetExtendedTcpTable`, then check it is in the
   session's job object (`IsProcessInJob`). A per-session credential in the proxy URL can be added as a second check.
   On Linux this was implicit, because only the sandbox could reach its socket.
3. **Resource limits get easier.** Job objects replace the cgroup v2 supervisor (`resources.ts`) and need no
   operator provisioning: memory, active processes and CPU hard cap are applied to a job that encloses MXC's own (jobs
   nest). Disk has no job limit. The options are NTFS per-user quotas (these need a distinct SID per session and
   admin to enable), a VHDX per session (admin to attach), or a soft limit where the runner measures the worktree and
   stops the session.
4. **The in-sandbox helper.** The Python `HELPER` assumes Linux (`/proc/self/fd`, `O_NOFOLLOW`, `os.open(dir_fd=)`).
   On Windows the OS container enforces confinement, so the helper's checks become defense in depth. Reparse points
   (junctions, symlinks) still need `FILE_FLAG_OPEN_REPARSE_POINT` or handle-relative opens (see Codex
   `no_reparse_dir.rs`). Python isn't a safe assumption on Windows, so the helper would be a small compiled launcher
   (see below) or a script run by the host's `node.exe` mounted read-only.
5. **Shell and tools.** The agent writes bash. Git for Windows ships bash and coreutils (MSYS2) under
   `C:\Program Files\Git`, which can be granted read-only along with `C:\Windows` and `Program Files`. This replaces
   the read-only `/usr`. Tools installed under the user's profile (nvm, Scoop, `%LOCALAPPDATA%\Programs`) stay
   invisible, as in srt-win, and the setup check should say so. Git also needs `http.sslBackend=openssl` so our CA
   bundle variables apply, plus an empty `credential.helper` (no Git Credential Manager), no hooks and no SSH.
6. **Platform-specific helpers elsewhere in the runner.** `lease.ts` (flock → `LockFileEx`), `file-browser.ts`
   (`/proc/self/fd` → `GetFinalPathNameByHandleW`), `restore.ts` (no-replace rename → `MoveFileEx` without
   `REPLACE_EXISTING`), repository-cache mirrors (read-only grants instead of bind mounts; `alternates` paths become
   Windows paths), the GPU (to be tested under PSEC), and path rules in `packages/shared` (drive letters,
   case-insensitivity, reserved names such as `CON`, alternate data streams `file:stream`).
7. **Seam.** `session.ts` holds `Sandbox | HostWorkspace`. A `WindowsSandbox` with the same method set (initialize,
   read/write/list/browse, execute, snapshot, clone-*, close) slots in beside them. Extracting an interface first
   keeps the Linux code untouched.

## Recommendation

WSL2 with the Linux sandbox stays the **default** on Windows: it is the only option that meets every requirement
today (see [Choosing](#choosing-across-windows-linux-and-macos-from-the-requirements-alone)). The native backend
below is an add-on for hosts that need Windows-native tools.

1. **Back the native Windows sandbox with PSEC through MXC, and refuse every weaker tier.** At start-up, call
   `getAvailableBackends()` / `probe()` and require `tier === "base-container"`. Set
   `fallback.allowDaclMutation: false` and never use the AppContainer tiers. This follows the existing rule
   "refusing unsandboxed execution" and is the same choice Codex made. One container per session (`containerName`)
   gives each session its own container SID, so sessions are separated from each other and from the host user by the
   OS. Grants: worktree and home read-write; `C:\Windows`, `Program Files`, Git for Windows, the CA bundle and
   mirrors read-only; `.git` read-only except for Git steps. Network: Model 2 with the session's own loopback proxy
   port.
2. **Use `@microsoft/mxc-sdk` directly, inside a small per-command Node runner process** (see
   [Using the Node SDK directly](#using-microsoftmxc-sdk-directly)). The connector starts the runner, puts it in a
   fresh job with the host's limits (through `koffi`, which the SDK already depends on), and only then lets it call
   the SDK. That mirrors today's bwrap+Python pair and the cgroup supervisor's gated start, with no Rust and no
   Python. A Rust launcher on the `mxc-sdk` crate is the fallback if the in-process FFI proves fragile.
3. **Minimum OS: Windows 11 24H2/25H2 at .9550 or later, or 26H2/26H1 per MXC's table.** Before .9550 a session
   can't host a loopback server inside its container, and agents routinely start dev servers and test servers. The
   identity-less loopback proxy probe also needs that build. Older Windows keeps today's answer, WSL2, and
   `connect-setup.ts` says which one applies.
4. **Don't build a dedicated-account backend (Codex elevated / srt-win style) now.** It needs admin install, a pool
   of per-session accounts to separate members, deny-read ACL stamping for world-readable data, and firewall/WFP
   upkeep. That's a large surface which the OS container makes unnecessary, and Codex is moving away from it.
   Revisit only if PSEC adoption stays too low.
5. **Cheap first step: native Windows without the sandbox.** Let `--unsafe-no-sandbox` and "Sessions on the host"
   run on win32 (`HostWorkspace`, the lease, path handling). It's useful on its own for Windows-native app work
   (games, GPU, SDKs), and it ports the platform-specific helpers the sandbox also needs.

## Using `@microsoft/mxc-sdk` directly

Checked against the published package, 1.0.1 (MIT; `engines.node >= 24`; dependencies `koffi`, `semver` and
`node-pty`). The tarball is about 38 MB, about 108 MB unpacked, with Microsoft-signed binaries for x64 and arm64.

**How it runs.** `spawn()` / `run()` don't start a helper process. They call `mxc_spawn_json` in the bundled
`mxc_ffi.dll` **inside the calling Node process** through koffi (`dist/bindings/streaming.js`), and get back native
stdio pipes and `wait`, `kill` and `killForTimeout` on a sandbox handle. The package also ships the standalone JSON
executor `wxc-exec.exe`, the admin-only `wxc-host-prep.exe`, and Linux and macOS binaries.

**What fits.**

- `ContainerRequest` covers the session sandbox: read-write and read-only paths, denied paths, `workingDirectory`,
  an explicit `environment` (`inheritDefaultEnvironment: false`), `timeoutMs`, and `network.egress` / `ingress` /
  `hostLoopback` with `runtimeConfig.networkProxy` (MXC's Model 2).
- Stdin, stdout and stderr are Node streams, so the one-line JSON request and the push-pack streaming work the same
  way.
- `probe(request)` reports the `isolationTier` the request would get, along with tier-degradation warnings.
- Telemetry is off unless a request opts in.

**Gaps, and how to cover them.**

| Gap | Consequence | Cover |
|---|---|---|
| The typed API drops `fallback`: `prepareOneShotRequest` builds the native request without it, so `allowDaclMutation` stays at its default `true` | On a host without usable PSEC, MXC may fall back to AppContainer and **rewrite host folder ACLs** instead of failing | Call `probe(request)` before each spawn and refuse unless `isolationTier === "base-container"` with no warnings. This leaves a small window if the host changes between probe and spawn. To close it, use `wxc-exec.exe` with a JSON file that sets `fallback.allowDaclMutation: false`, or ask upstream to expose `fallback` in V1 |
| `MxcProcess` has no PID and no job handle | Pistead can't set per-session memory, CPU or process limits on the container, and its egress proxy can't recognize the session's processes | Run each sandbox step in a **per-command Node runner** (`node runner.js`, mxc-sdk loaded there, not in the connector). The connector creates a job with `JOB_MEMORY`, `ACTIVE_PROCESS`, a CPU hard cap and kill-on-close, assigns the runner to it through koffi (`CreateJobObjectW`, `SetInformationJobObject`, `AssignProcessToJobObject`), and only then sends the request on stdin, as the cgroup supervisor gates its child today. MXC's own kill-on-close job nests inside ours. The proxy checks a connecting peer with `GetExtendedTcpTable` and `IsProcessInJob(peer, sessionJob)` |
| FFI runs in the calling process | A native crash or hang would take the whole connector down with it | The per-command runner above isolates that too |
| The package carries Linux, macOS, WSLC, Windows Sandbox and test binaries | A 108 MB install on every platform | Install it only on win32: as an optional dependency fetched on first native-Windows connect, or bundled into a Windows-only connector build |
| No disk quota | Same as before | Same as before |

**Verdict:** yes. The SDK can be the Windows backend directly, as long as it's wrapped in a per-command runner
process that the connector puts in a job first and that refuses any tier other than `base-container` (by probing,
or by `wxc-exec` with `allowDaclMutation: false`). No Rust is needed for the first version.

Also worth a spike: the `isolation_session` backend ("a freshly provisioned isolated user account in its own
OS-managed session", available from build .9550) gives each session its own user SID. That would make NTFS per-user
disk quotas possible, but it's heavier than a ProcessContainer.

## MXC on Linux and macOS

The same SDK and request shape also drive `bubblewrap` (the Linux default; `lxc`, `microvm` and `hyperlight` are
options) and `seatbelt` on macOS 15 and later. The `process` intent resolves to `processcontainer`, `bubblewrap` or
`seatbelt` by platform. The npm package ships `libmxc_ffi.so` / `.dylib` for them.

**Linux: keep Pistead's own bubblewrap sandbox.** MXC's backend is looser than ours in the places that matter, and it
needs more on the host:

| | Pistead `sandbox.ts` | MXC bubblewrap |
|---|---|---|
| `/etc` | empty except the CA bundle | all of `/etc` read-only |
| Mounts | fd-pinned `--bind-fd`, so a swapped symlink can't redirect them | path-based binds |
| Proxy-only egress | the session's Unix socket bind-mounted into an empty network namespace; nothing else to install | `slirp4netns`, `nsenter`, `ip`, `iptables`/`ip6tables(-restore)` with per-namespace DROP chains |
| Resource limits | cgroup v2 CPU, memory and pids, plus a disk volume | none |
| Also | `--disable-userns`, `--die-with-parent`, `.git` read-only except for Git steps, mirrors, GPU | |

Adopting it would mean giving up isolation and adding host dependencies, for no gain. The one thing it could offer is
a shared request format across platforms, and the runner's own `Request` protocol already serves that purpose.

**macOS: a real option where Pistead has no sandbox today.** macOS hosts now run only `--unsafe-no-sandbox`.
Seatbelt (`sandbox_init` with a generated profile, the framework under the App Sandbox; no root, no install, macOS
15+) gives:

- read-only, read-write and denied paths, kernel-enforced and subtree-scoped;
- outbound network limited to one localhost port (`(allow network-outbound (remote ip "localhost:<port>"))`), so a
  client that ignores `HTTPS_PROXY` can't get out;
- UI, clipboard and input-injection lockdown.

The caveats for Pistead:

- `localhost:<port>` also matches the host's non-loopback addresses on that port, and every session shares the host's
  network stack. So it needs the same per-session proxy port as Windows, and the same peer check. macOS has no job
  objects, so the check would be by the peer's process ancestry or a per-session proxy credential.
- The baseline exposes `/private/etc`, `/Library` and `/System` read-only. That's broader than our empty `/etc`, but
  holds no user data.
- AF_UNIX `connect()` is allowed throughout `readwritePaths`. Keep the read-write roots to the session's own worktree
  and home so no host agent sockets fall under them.
- No resource limits: rlimits only, and macOS doesn't enforce `RLIMIT_AS`.
- `sandbox_init` is deprecated in the headers, but Chromium, Codex and Claude Code all rely on it.

That makes MXC Seatbelt a candidate for a "sandboxed macOS host" mode that is clearly weaker than Linux but far
better than none. It's a separate decision from the Windows backend, but the same runner-process design would serve
both.

## Choosing across Windows, Linux and macOS, from the requirements alone

This evaluation deliberately ignores what Pistead already has (`sandbox.ts`, the docs). It scores every option only
against what a session sandbox has to do.

### Requirements

| # | Requirement | Weight |
|---|---|---|
| R1 | Reads denied by default: a session sees nothing of the host unless granted | Must, since hosts are shared |
| R2 | A separate boundary per session, from other sessions and from the host user | Must |
| R3 | The only way out is our proxy, enforced by the kernel, and the proxy can tell which session is connecting | Must |
| R4 | CPU, memory, process and disk limits per session | Must on shared hosts |
| R5 | No admin or root at run time, and little or no install | Should |
| R6 | Process trees can be killed, with timeouts | Must |
| R7 | File operations inside the boundary, without symlink races | Must |
| R8 | Works from a Node connector shipped with npx | Should |
| R9 | Real tools work (git, bash, node, compilers); GPU optional | Should |
| R10 | Mature, maintained, permissive license | Should |
| R11 | Same behaviour on every platform | Nice |

### Linux

| Option | R1 | R2 | R3 | R4 | R5 | Notes |
|---|---|---|---|---|---|---|
| Thin wrapper over bubblewrap (our own) | ✓ | ✓ | ✓ | ◐ with cgroups | ✓ | A per-session Unix socket in an empty network namespace gives proxy peer identity for free |
| MXC bubblewrap | ◐ (all of `/etc` visible) | ✓ | ◐ | ✗ | ◐ | Proxy over slirp4netns to host loopback: needs `slirp4netns`/`iptables`, and other local processes can reach the proxy too |
| sandbox-runtime | ✗ by default (reads allowed everywhere) | ✓ | ◐ (its own filtering proxy in front of ours) | ✗ | ✓ | Built for one developer's machine |

The real package on Linux is bubblewrap itself. The wrappers around it add dependencies or looser defaults, and none
adds limits. **Our own thin wrapper wins even starting from scratch.**

### macOS

| Option | R1 | R2 | R3 | R4 | R5 | Notes |
|---|---|---|---|---|---|---|
| MXC Seatbelt | ✓ | ✓ per process tree | ◐ (one localhost port, needs a peer check) | ✗ | ✓ | Maintained by Microsoft, same API as on Windows |
| Our own Seatbelt profile | ✓ | ✓ | ◐ (same) | ✗ | ✓ | A few hundred lines, fully under our control |
| sandbox-runtime | ✗ by default | ✓ | ◐ | ✗ | ✓ | |

MXC and our own profile come out nearly even. We lean to **MXC**: one API for macOS and Windows, maintained by
Microsoft, as long as a 108 MB package and native code loaded through FFI are acceptable. Otherwise, our own
profile. Neither can give hard memory limits, because macOS has no cgroup equivalent (rlimits only, and
`RLIMIT_AS` isn't enforced).

### Windows

| Option | R1 | R2 | R3 | R4 | R5 | R9 | Notes |
|---|---|---|---|---|---|---|---|
| MXC on PSEC | ✓ | ✓ (container SID per session) | ✓ (per-container network filter to the proxy) | ✗, add job objects | ✓ | ✓ | Only Windows 11 24H2/25H2 builds from August–September 2026 |
| sandbox-runtime (`srt-win`) | ✗ | ✗ (one shared user) | ◐ | ◐ | ✗ (admin install) | ◐ | Alpha |
| Dedicated user accounts (Codex style, built ourselves) | ◐ | ◐ (needs an account pool) | ✓ | ◐ | ✗ (admin) | ◐ | About 38k lines in Codex, which is moving away from it |
| Windows Sandbox VM | ✓ | ✗ (one VM per host) | ✓ | ✓ | ◐ | ✓ | |
| **WSL2 + the Linux sandbox** | ✓ | ✓ | ✓ | ✓ | ◐ (one-time WSL install) | ✗ for Windows-native tools | Meets every Must today |

**WSL2 is the only option that meets every Must on Windows today.** Native Windows is worth adding only for
Windows-native tooling, and then MXC on PSEC is the only viable route.

### Gaps no package fills

Whatever we choose, we build these ourselves:

- resource limits on every platform (cgroups, job objects, rlimits on macOS);
- per-session proxy ports plus a check that a connection comes from that session, on Windows and macOS;
- disk quotas;
- one shared request protocol that hides the platform differences.

### Alternative: one VM per session

Starting from scratch, this is a serious alternative to process sandboxes, for example Firecracker on Linux, Apple's
Virtualization or Containerization framework on macOS, and Hyper-V or WSL on Windows *(unverified; not read in
this investigation)*.

- **For:** the strongest boundary, because sessions don't share a kernel. That matters on shared hosts, where a
  kernel exploit breaks every process sandbox. It also gives the same Linux environment everywhere and natural
  resource limits, and the proxy can be reached over vsock so the connecting session is known.
- **Against:** boot time and memory per session, images to build and update, nested virtualization limits, and no
  host-native tools (Xcode, Windows SDKs).

### Decision

| Platform | Choice |
|---|---|
| Linux | Our own thin bubblewrap wrapper plus cgroups |
| macOS | MXC Seatbelt, or our own profile if we'd rather avoid the native dependency; labelled as having no hard memory limit |
| Windows | WSL2 by default; MXC on PSEC with our job limits for native Windows tools |
| Everywhere | Our own request protocol, limits, proxy peer checks and capability report |
| Revisit | VM per session, if shared-host security outweighs start-up cost and native tools |

## Phases (native Windows backend)

1. Run the unsandboxed host on win32: lease, path rules, `HostWorkspace`, `connect-setup` checks.
2. Prototype the per-command runner on `@microsoft/mxc-sdk`: the koffi job gate, the base-container tier check, bash
   from Git for Windows, and file operations. Use it behind a hidden `--experimental-windows-sandbox` flag.
3. Egress on Windows: a per-session port, peer verification against the session job, Model 2 policy, and
   `identity`/env/`GIT_SHIM` taking the port.
4. Cache mirrors, Git LFS, backups and restores, the file browser, and the GPU (if PSEC allows it).
5. Disk limits, the host capability report (`sandbox: true` on win32) and docs. Then drop "Native Windows is
   unsupported" for qualifying builds.

## Spikes before committing

These have to be run on a real Windows 11 machine at .9550 or later. This investigation couldn't run Windows.

- MXC `run`/`spawn` with `containment: processcontainer` reports `base-container`. Git for Windows' `bash.exe`,
  `git clone` through the proxy, `node` and `python` start with read-only `Program Files` grants only.
- Two containers can't read or write each other's worktrees. A container can't read `C:\Users\<host user>`, a
  non-system drive root, `C:\ProgramData` or `C:\Users\Public`.
- With egress deny and the session proxy port allowed, direct connects, DNS over UDP 53, other loopback ports and
  *another session's* proxy port are all blocked. A loopback server inside the container works.
- An outer job with `JOB_MEMORY`, `ACTIVE_PROCESS` and a CPU hard cap encloses MXC's kill-on-close job and is
  enforced. Killing the launcher kills the whole tree.
- `GetExtendedTcpTable` + `IsProcessInJob` reliably identifies a connecting process as the session's.
- Per-operation start-up cost (container create, run, close) for file tools, compared with bwrap's few milliseconds.
  If it's high, keep one container per session alive with `provisionContainer` / `runInContainer`.
- Whether D3D12/Vulkan is reachable from a PSEC container, for the GPU option.
- Edition coverage: whether PSEC is on Home as well as Pro/Enterprise.
