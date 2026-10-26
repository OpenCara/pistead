# Design: a native Windows 11 sandbox for the connector

Status: investigation. Nothing here is implemented. Native Windows is refused today
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

1. **Back the Windows sandbox with PSEC through MXC, and refuse every weaker tier.** At start-up, call
   `getAvailableBackends()` / `probe()` and require `tier === "base-container"`. Set
   `fallback.allowDaclMutation: false` and never use the AppContainer tiers. This follows the existing rule
   "refusing unsandboxed execution" and is the same choice Codex made. One container per session (`containerName`)
   gives each session its own container SID, so sessions are separated from each other and from the host user by the
   OS. Grants: worktree and home read-write; `C:\Windows`, `Program Files`, Git for Windows, the CA bundle and
   mirrors read-only; `.git` read-only except for Git steps. Network: Model 2 with the session's own loopback proxy
   port.
2. **Ship a small native launcher, `pistead-sandbox.exe` (Rust, using the `mxc-sdk` crate and `windows-sys`).**
   It takes the same one-line JSON request on stdin as `HELPER`. It creates a job with the host's limits, starts the
   MXC container inside it, runs the file operations or the command, and streams output. That mirrors today's
   bwrap+Python pair. It keeps Node's `child_process` (which can't create suspended processes or job objects) out of
   the trust boundary, and it means one signed binary per architecture (x64 and arm64) instead of a Python dependency.
   The Node SDK would work for a prototype, but it ships about 108 MB of native assets and adds no job limits.
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

### Phases

1. Run the unsandboxed host on win32: lease, path rules, `HostWorkspace`, `connect-setup` checks.
2. Prototype `pistead-sandbox.exe`: PSEC container, job limits, bash from Git for Windows, file operations. Use it
   behind a hidden `--experimental-windows-sandbox` flag.
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
