/**
 * How a host runs its sessions. Its owner sets this in Pistead (Settings → Hosts → the host → Configuration), and so do
 * its admins, except for the settings that decide whose Git credentials the host uses (`ownerOnlyHostConfig`). The
 * connector reads it from the control plane instead of taking connect options; a connector that predates this (no
 * `hostConfig` capability) keeps its options.
 */

/** A Git mirror of each repository on the host: none, one for every session on it, or one per session owner. */
export const repositoryCacheModes = ["off", "host", "owner"] as const;
export type RepositoryCacheMode = (typeof repositoryCacheModes)[number];

/** The GPU device a host can lend its sandboxed commands: WSL's /dev/dxg, or Linux DRM render nodes. */
export const gpuKinds = ["dxg", "render"] as const;
export type GpuKind = (typeof gpuKinds)[number];

export interface HostConfig {
  /**
   * The longest a shell command in this host's sessions runs, in seconds. Commands longer than the default also get
   * room for builds: their CPU-time, file-size and open-file limits grow with it (see the runner's `commandLimits`).
   */
  commandTimeoutSeconds: number;
  /**
   * Sandboxed commands get the host's GPU render device (WSL's /dev/dxg or Linux DRM render nodes) for rendering and
   * compute. Never a display, window system or input device.
   */
  gpu: boolean;
  /** Pushes in the host owner's own sessions may use the credentials of the host's Git credential helpers. */
  gitCredentials: boolean;
  /**
   * A full-history Git mirror of each repository on the host, which sessions' clones borrow objects from. A change takes
   * effect when the connector next connects.
   */
  repositoryCache: RepositoryCacheMode;
}

export const hostConfigLimits = Object.freeze({ commandTimeoutSeconds: Object.freeze({ min: 30, max: 3600 }) });

export const defaultHostConfig: Readonly<HostConfig> = Object.freeze({
  commandTimeoutSeconds: 30, gpu: false, gitCredentials: false, repositoryCache: "off",
});

/** Only the host's owner changes these: they decide whose Git credentials the host uses. Its admins change the rest. */
export const ownerOnlyHostConfig: readonly (keyof HostConfig)[] = Object.freeze(["gitCredentials", "repositoryCache"]);

/** A whole configuration, as the web app sends it and the control plane reports it; anything else is refused. */
export function parseHostConfig(value: unknown): HostConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid host configuration");
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== Object.keys(defaultHostConfig).length || keys.some(key => !Object.hasOwn(defaultHostConfig, key))) {
    throw new Error("Invalid host configuration");
  }
  const { min, max } = hostConfigLimits.commandTimeoutSeconds;
  const timeout = input.commandTimeoutSeconds;
  if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < min || timeout > max) {
    throw new Error(`The command time limit is between ${min} and ${max} seconds`);
  }
  if (typeof input.gpu !== "boolean") throw new Error("Invalid GPU setting");
  if (typeof input.gitCredentials !== "boolean") throw new Error("Invalid Git credentials setting");
  if (!repositoryCacheModes.includes(input.repositoryCache as RepositoryCacheMode)) throw new Error("Invalid repository cache setting");
  return { commandTimeoutSeconds: timeout, gpu: input.gpu, gitCredentials: input.gitCredentials, repositoryCache: input.repositoryCache as RepositoryCacheMode };
}
