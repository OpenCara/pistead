import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, relative, sep } from "node:path";
import { defaultHostConfig, hostConfigLimits, readHostConfig, type GpuKind, type HostConfig } from "../../../packages/shared/src/host-config.js";

/** How long the host's configuration is used before the control plane is asked again: changes reach commands within it. */
const CONFIG_TTL_MS = 30_000;
/** A configuration the control plane can't refresh stays in use this long, so a brief outage changes no running work. */
const CONFIG_STALE_MS = 5 * 60_000;

/**
 * The host's configuration as its owner and admins set it in Pistead, asked for again at most every 30 seconds. Without
 * an answer it keeps the last one for a while, then falls back to the defaults, which are the most restrictive.
 */
export class HostConfigSource {
  #cached?: { value: HostConfig; at: number };
  #refresh?: Promise<HostConfig>;
  /** Set by `refresh`: the next answer is asked for, though the cached one may still be served if asking fails. */
  #expired = false;

  constructor(private readonly load: () => Promise<unknown>, private readonly options: { ttlMs?: number; staleMs?: number; now?: () => number } = {}) {}

  async current(): Promise<HostConfig> {
    const now = this.options.now ?? Date.now;
    const cached = this.#cached;
    if (cached && !this.#expired && now() - cached.at < (this.options.ttlMs ?? CONFIG_TTL_MS)) return cached.value;
    this.#refresh ??= this.load().then(value => {
      const config = readHostConfig(value);
      this.#cached = { value: config, at: now() };
      this.#expired = false;
      return config;
    }).finally(() => { this.#refresh = undefined; });
    try { return await this.#refresh; }
    catch {
      if (cached && now() - cached.at < (this.options.staleMs ?? CONFIG_STALE_MS)) return cached.value;
      return { ...defaultHostConfig };
    }
  }

  /** Asks again now, whatever the cache holds: a new connection may bring a configuration changed while it was away. */
  refresh(): Promise<HostConfig> {
    this.#expired = true;
    return this.current();
  }
}

/** What bounds one shell command: its wall-clock time and the per-process limits the sandbox's helper sets before it starts. */
export interface CommandLimits {
  seconds: number;
  /** RLIMIT_CPU: the CPU time of each of the command's processes, counting all of its threads. */
  cpuSeconds: number;
  /** RLIMIT_FSIZE: the largest file a process may write. */
  fileBytes: number;
  /** RLIMIT_NOFILE, capped at the runner's own hard limit. */
  openFiles: number;
}

const MiB = 1024 * 1024;

/**
 * The limits of a command that may run `seconds`. At the 30-second default they stay those of every short command (25 s
 * of CPU per process, 64 MiB per file, 256 open files). A longer time limit is room for builds: each process may use
 * every CPU for the whole time, write files of up to 16 GiB and open 8192 files. These per-process limits are defence in
 * depth, not session quotas: a host's provisioned resources (`--resources`) bound the session as a whole.
 */
export function commandLimits(seconds: number, cpus = availableParallelism()): CommandLimits {
  const { min, max } = hostConfigLimits.commandTimeoutSeconds;
  const bounded = Math.min(Math.max(Math.trunc(Number.isFinite(seconds) ? seconds : min), min), max);
  if (bounded <= min) return { seconds: min, cpuSeconds: 25, fileBytes: 64 * MiB, openFiles: 256 };
  return { seconds: bounded, cpuSeconds: bounded * Math.max(1, Math.trunc(cpus)), fileBytes: 16 * 1024 * MiB, openFiles: 8192 };
}

/** What lends sandboxed commands the host's GPU: bubblewrap arguments, and environment for the user-space driver. */
export interface GpuMounts { kind: GpuKind; args: string[]; env: Record<string, string> }

/** WSL's paravirtualized GPU and the libraries of its Windows driver, which the sandbox's empty /etc leaves off the library path. */
const DXG = "dev/dxg";
const WSL_LIBRARIES = "usr/lib/wsl/lib";
const RENDER_NODE = /^renderD\d{1,4}$/;
const DEVICE_NUMBER = /^\d{1,6}:\d{1,6}$/;

/**
 * How to lend sandboxed commands this host's GPU, or undefined when it has none. Only render devices: never a display,
 * window system socket, KMS (card) node or input device, so a command can render and compute offscreen but neither see
 * nor drive the screen.
 * - WSL: /dev/dxg. Its user-space driver (Mesa's dzn or d3d12 over the Windows driver's libraries) is already visible
 *   under the read-only /usr, but needs /usr/lib/wsl/lib on the library path.
 * - Linux: each DRM render node, and read-only the sysfs directory of its device with the /sys/dev/char link that names
 *   it, where libdrm and Mesa find out what it is.
 * `root` is where the host's / is; tests use a stand-in.
 */
export function gpuMounts(root = "/"): GpuMounts | undefined {
  let base: string;
  try { base = realpathSync(root); }
  catch { return undefined; }
  const at = (path: string) => join(base, path);
  // The path a host directory has in the sandbox: the same as on the host.
  const inside = (path: string) => `/${relative(base, path).split(sep).join("/")}`;
  if (existsSync(at(DXG))) {
    return { kind: "dxg", args: ["--dev-bind", at(DXG), "/dev/dxg"], env: existsSync(at(WSL_LIBRARIES)) ? { LD_LIBRARY_PATH: `/${WSL_LIBRARIES}` } : {} };
  }
  let names: string[];
  try { names = readdirSync(at("dev/dri")).filter(name => RENDER_NODE.test(name)).sort(); }
  catch { return undefined; }
  const devices = at("sys/devices");
  const args: string[] = [];
  const bound = new Set<string>();
  for (const name of names) {
    try {
      const number = readFileSync(at(`sys/class/drm/${name}/dev`), "utf8").trim();
      const node = realpathSync(at(`sys/class/drm/${name}`));
      const device = realpathSync(at(`sys/class/drm/${name}/device`));
      if (!DEVICE_NUMBER.test(number) || ![node, device].every(path => path.startsWith(`${devices}${sep}`))) continue;
      args.push("--dev-bind", at(`dev/dri/${name}`), `/dev/dri/${name}`);
      if (!bound.has(device)) { args.push("--ro-bind", device, inside(device)); bound.add(device); }
      args.push("--symlink", inside(node), `/sys/dev/char/${number}`);
    } catch { /* A node without its sysfs entry is left out. */ }
  }
  return args.length ? { kind: "render", args, env: {} } : undefined;
}

/** The GPU device this host can lend its sandboxed commands, as the connector advertises it. */
export function detectGpu(root = "/"): GpuKind | undefined {
  return gpuMounts(root)?.kind;
}
