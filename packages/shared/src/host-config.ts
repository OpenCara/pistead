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

/** A model's compaction token counts, or the whole host's; each one left out keeps the host's Pi setting. */
export interface CompactionTokens {
  /**
   * The context left free for compaction: a conversation is summarized once it is within this many tokens of the model's
   * context window, and Pi gives the summary up to 80% of it.
   */
  reserveTokens?: number;
  /** The most recent context kept word for word, unsummarized, in tokens. */
  keepRecentTokens?: number;
}

/**
 * When a long conversation is summarized, as the host's owner and admins set it in Pistead: for every model, and for
 * models by exact `provider/modelId`. Each count it sets replaces the one in Pi's settings.json on the host; the counts
 * it leaves out keep that file's, or the defaults (see the runner's hostCompaction).
 */
export interface HostCompaction extends CompactionTokens {
  modelOverrides?: Record<string, CompactionTokens>;
}

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
  /**
   * The host's owner may start sessions that run directly on the host's own environment, without the sandbox
   * (SessionRecord.hostEnvironment): their commands run as the connector's OS user, with its files, credentials,
   * network and GPU. Turning it off stops those sessions' commands at once.
   */
  hostSessions: boolean;
  /** Compaction token counts over the host's Pi settings; empty keeps those. Sessions pick a change up within a minute (the connector's refresh), with their next message. */
  compaction: HostCompaction;
}

export const hostConfigLimits = Object.freeze({
  commandTimeoutSeconds: Object.freeze({ min: 30, max: 3600 }),
  /** Each compaction token count, and the number of models with their own (a host offers at most 200). */
  compactionTokens: Object.freeze({ min: 0, max: 10_000_000 }),
  compactionModels: 200,
});

export const defaultHostConfig: Readonly<HostConfig> = Object.freeze({
  commandTimeoutSeconds: 30, gpu: false, gitCredentials: false, repositoryCache: "off", hostSessions: false, compaction: Object.freeze({}),
});

const compactionTokenKeys = ["reserveTokens", "keepRecentTokens"] as const;
/** A model as Pi's compaction overrides name it: `provider/modelId`, as the host advertises them (80 and 200 characters at most). */
const COMPACTION_MODEL = /^[^/\s]{1,80}\/\S{1,200}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

function compactionTokens(value: unknown): CompactionTokens {
  if (!isPlainObject(value) || Object.keys(value).some(key => !(compactionTokenKeys as readonly string[]).includes(key))) {
    throw new Error("Invalid compaction setting");
  }
  const { min, max } = hostConfigLimits.compactionTokens;
  const tokens: CompactionTokens = {};
  // In a fixed order, so equal settings are equal JSON.
  for (const key of compactionTokenKeys) {
    const count = value[key];
    if (count === undefined) continue;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < min || count > max) {
      throw new Error(`Compaction token counts are whole numbers from ${min} to ${max.toLocaleString("en-US")}`);
    }
    tokens[key] = count;
  }
  return tokens;
}

/** A compaction setting: token counts for every model and per model, each a whole number in bounds; a model with none is left out. */
export function parseHostCompaction(value: unknown): HostCompaction {
  if (!isPlainObject(value)) throw new Error("Invalid compaction setting");
  const { modelOverrides, ...overall } = value;
  const compaction: HostCompaction = compactionTokens(overall);
  if (modelOverrides === undefined) return compaction;
  if (!isPlainObject(modelOverrides)) throw new Error("Invalid compaction setting");
  const models = Object.keys(modelOverrides);
  if (models.length > hostConfigLimits.compactionModels) throw new Error(`Compaction is set for at most ${hostConfigLimits.compactionModels} models`);
  if (models.some(model => !COMPACTION_MODEL.test(model))) throw new Error("Compaction names each model as provider/modelId");
  const overrides = Object.fromEntries(models.sort().map(model => [model, compactionTokens(modelOverrides[model])])
    .filter(([, tokens]) => Object.keys(tokens as CompactionTokens).length));
  return Object.keys(overrides).length ? { ...compaction, modelOverrides: overrides } : compaction;
}

/**
 * Only the host's owner changes these: they decide whose Git credentials the host uses, and whether anything runs on it
 * without the sandbox. Its admins change the rest.
 */
export const ownerOnlyHostConfig: readonly (keyof HostConfig)[] = Object.freeze(["gitCredentials", "repositoryCache", "hostSessions"]);

/** A whole configuration, as the control plane reports it; anything else is refused. */
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
  if (typeof input.hostSessions !== "boolean") throw new Error("Invalid host sessions setting");
  return { commandTimeoutSeconds: timeout, gpu: input.gpu, gitCredentials: input.gitCredentials, repositoryCache: input.repositoryCache as RepositoryCacheMode,
    hostSessions: input.hostSessions, compaction: parseHostCompaction(input.compaction) };
}

/**
 * A change of configuration, as the host's page sends it (`PATCH /api/connectors/:id/config`): one or more settings, each
 * valid, and nothing else. The settings it leaves out keep their values, so a form sends only what its user changed and
 * never undoes someone else's change of another setting.
 */
export function parseHostConfigChange(value: unknown): Partial<HostConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid host configuration");
  const keys = Object.keys(value);
  if (!keys.length || keys.some(key => !Object.hasOwn(defaultHostConfig, key))) throw new Error("Invalid host configuration");
  // Each named setting is checked as in a whole configuration; the defaults fill in the rest, and are valid.
  const whole = parseHostConfig({ ...defaultHostConfig, ...value });
  return Object.fromEntries(keys.map(key => [key, whole[key as keyof HostConfig]])) as Partial<HostConfig>;
}

/**
 * A configuration as a connector reads it from the control plane: settings it doesn't know (from a newer control plane)
 * are left out, and ones the control plane doesn't send (an older one) keep their defaults. What it does read must be
 * valid, or none of it is used.
 */
export function readHostConfig(value: unknown): HostConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid host configuration");
  const input = value as Record<string, unknown>;
  const known = Object.fromEntries(Object.keys(defaultHostConfig).filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
  return parseHostConfig({ ...defaultHostConfig, ...known });
}
