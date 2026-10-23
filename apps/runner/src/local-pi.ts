import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ClientIdentity } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import type { CompactionSettings } from "@earendil-works/pi-durable";
import { getAgentDir, ModelRuntime, resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import type { LocalModelSummary } from "../../../packages/shared/src/connector.js";
import { connectorLimits } from "../../../packages/shared/src/connector.js";
import { thinkingLevels, type ModelDefinition, type ThinkingLevel } from "../../../packages/shared/src/types.js";
import { runnerModels } from "./provider.js";

export interface ResolvedLocalModel {
  models: Models;
  provider: string;
  modelId: string;
  /** The reasoning level Pi on this host starts the model at. */
  thinkingLevel?: ThinkingLevel;
}

export interface LocalModels {
  manifest(): Promise<LocalModelSummary[]>;
  resolve(model: ModelDefinition): Promise<ResolvedLocalModel>;
  /** Pi's compaction settings on this host, which its sessions compact by. */
  readonly compaction?: CompactionSettings;
  /** How this host's Pi identifies its requests to providers, which its sessions' requests follow. */
  readonly identity?: ClientIdentity;
}

/** Only these non-secret fields can cross the connector boundary. */
export function modelSummary(value: LocalModelSummary): LocalModelSummary {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.provider)
    || typeof value.modelId !== "string" || !value.modelId || value.modelId.length > 256 || /[\s\x00-\x1f\x7f]/.test(value.modelId)
    || typeof value.name !== "string" || !value.name.trim() || value.name.length > 200 || /[\x00-\x1f\x7f]/.test(value.name)
    || (value.thinkingLevels !== undefined && (!Array.isArray(value.thinkingLevels) || !value.thinkingLevels.length
      || value.thinkingLevels.some(level => !thinkingLevels.includes(level)) || new Set(value.thinkingLevels).size !== value.thinkingLevels.length))
    || (value.thinkingLevel !== undefined && (!thinkingLevels.includes(value.thinkingLevel) || (value.thinkingLevels && !value.thinkingLevels.includes(value.thinkingLevel))))) {
    throw new Error("Invalid local model metadata");
  }
  return { provider: value.provider, modelId: value.modelId, name: value.name, ...(value.thinkingLevels ? { thinkingLevels: [...value.thinkingLevels] } : {}),
    ...(value.thinkingLevel ? { thinkingLevel: value.thinkingLevel } : {}) };
}

export type LocalPiRuntime = Models;

export interface LocalPiOptions {
  /** Explicit Pi agent directory, not a session/history directory. */
  agentDir?: string;
  /** Optional explicit subset when a local catalog exceeds the wire limit. */
  models?: readonly { provider: string; modelId: string }[];
  /** Pi's `enabledModels` patterns (same globs as Pi's model cycling); explicit `models` take precedence. */
  enabledModels?: readonly string[];
  /** Pi's `defaultThinkingLevel` setting. */
  defaultThinkingLevel?: ThinkingLevel;
  /** Pi's `modelThinkingLevels` setting, keyed `provider/modelId`. */
  modelThinkingLevels?: ReadonlyMap<string, ThinkingLevel>;
  /** Pi's `compaction` setting. */
  compaction?: CompactionSettings;
  /** `false` when Pi sends no provider attribution here (see PiSettings). */
  attribution?: false;
  runtimeFactory?: (options: { authPath?: string; modelsPath?: string; refreshOnCreate: false; allowModelNetwork: false }) => Promise<LocalPiRuntime>;
}

/** The parts of Pi's global settings.json a connector follows; project settings never apply to a connector. */
export interface PiSettings {
  enabledModels?: string[];
  defaultThinkingLevel?: ThinkingLevel;
  modelThinkingLevels?: Map<string, ThinkingLevel>;
  /** Pi's `compaction` setting: whether and when conversations compact, overall and per `provider/modelId`. */
  compaction?: CompactionSettings;
  /**
   * `false` when Pi attributes no requests to itself with providers: its `enableInstallTelemetry` setting is off, or
   * `PI_TELEMETRY` turns it off (Pi's `isInstallTelemetryEnabled`).
   */
  attribution?: false;
}

/** Pi's own starting level when its settings name none (`DEFAULT_THINKING_LEVEL`, which pi-coding-agent does not export). */
const PI_DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

const isThinkingLevel = (value: unknown): value is ThinkingLevel => typeof value === "string" && thinkingLevels.includes(value as ThinkingLevel);

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Pi's compaction token counts, as Pi validates them: non-negative safe integers. */
function compactionTokens(value: Record<string, unknown>, path: string): { reserveTokens?: number; keepRecentTokens?: number } {
  const tokens: { reserveTokens?: number; keepRecentTokens?: number } = {};
  for (const key of ["reserveTokens", "keepRecentTokens"] as const) {
    const count = value[key];
    if (count === undefined) continue;
    if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error(`Pi settings.json ${path}.${key} must be a non-negative integer`);
    tokens[key] = count as number;
  }
  return tokens;
}

/** Pi's `compaction` setting; fields Pi doesn't know are ignored, as Pi ignores them. */
function compactionSettings(value: unknown): CompactionSettings {
  if (!isRecord(value)) throw new Error("Pi settings.json compaction must be an object");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("Pi settings.json compaction.enabled must be true or false");
  const overrides = value.modelOverrides;
  if (overrides !== undefined && (!isRecord(overrides) || !Object.values(overrides).every(isRecord))) {
    throw new Error("Pi settings.json compaction.modelOverrides must map provider/model to token settings");
  }
  return {
    ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
    ...compactionTokens(value, "compaction"),
    ...(overrides ? { modelOverrides: Object.fromEntries(Object.entries(overrides as Record<string, Record<string, unknown>>)
      .map(([model, tokens]) => [model, compactionTokens(tokens, `compaction.modelOverrides["${model}"]`)])) } : {}),
  };
}

/** Pi's reading of `PI_TELEMETRY`, which overrides its `enableInstallTelemetry` setting. */
const telemetryFlag = (value: string) => value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";

export async function readPiSettings(agentDir?: string, env: NodeJS.ProcessEnv = process.env): Promise<PiSettings> {
  const path = join(agentDir === undefined ? getAgentDir() : resolve(agentDir), "settings.json");
  let text: string | undefined;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const value = (text === undefined ? {} : JSON.parse(text)) as { enabledModels?: unknown; defaultThinkingLevel?: unknown; modelThinkingLevels?: unknown; compaction?: unknown; enableInstallTelemetry?: unknown };
  const settings: PiSettings = {};
  const enabled = value.enabledModels;
  if (enabled !== undefined) {
    if (!Array.isArray(enabled) || enabled.some(pattern => typeof pattern !== "string" || !pattern.trim()) || enabled.length > 200) {
      throw new Error("Pi settings.json enabledModels must be a list of model patterns");
    }
    if (enabled.length) settings.enabledModels = enabled;
  }
  if (value.defaultThinkingLevel !== undefined) {
    if (!isThinkingLevel(value.defaultThinkingLevel)) throw new Error(`Pi settings.json defaultThinkingLevel must be one of ${thinkingLevels.join(", ")}`);
    settings.defaultThinkingLevel = value.defaultThinkingLevel;
  }
  const perModel = value.modelThinkingLevels;
  if (perModel !== undefined) {
    if (!perModel || typeof perModel !== "object" || Array.isArray(perModel) || !Object.values(perModel).every(isThinkingLevel)) {
      throw new Error("Pi settings.json modelThinkingLevels must map provider/model to a reasoning level");
    }
    settings.modelThinkingLevels = new Map(Object.entries(perModel as Record<string, ThinkingLevel>));
  }
  if (value.compaction !== undefined) settings.compaction = compactionSettings(value.compaction);
  if (value.enableInstallTelemetry !== undefined && typeof value.enableInstallTelemetry !== "boolean") {
    throw new Error("Pi settings.json enableInstallTelemetry must be true or false");
  }
  const telemetry = env.PI_TELEMETRY;
  if (!(telemetry !== undefined ? telemetryFlag(telemetry) : value.enableInstallTelemetry !== false)) settings.attribution = false;
  return settings;
}

export async function loadLocalPiModels(options: LocalPiOptions = {}): Promise<LocalModels> {
  // ModelRuntime loads only Pi's model/auth configuration. No sessions, packages,
  // personal history, tools, or interactive extensions are installed here.
  const runtimeFactory: NonNullable<LocalPiOptions["runtimeFactory"]> = options.runtimeFactory ?? (config => ModelRuntime.create(config));
  const agentDir = options.agentDir === undefined ? undefined : resolve(options.agentDir);
  const runtime = await runtimeFactory({
    ...(agentDir === undefined ? {} : { authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") }),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const selected = options.models && new Set(options.models.map(model => JSON.stringify([model.provider, model.modelId])));
  const selectedProviders = options.models && [...new Set(options.models.map(model => model.provider))];
  const manifest = async (): Promise<LocalModelSummary[]> => {
    const signal = AbortSignal.timeout(15_000);
    // ModelRuntime's synchronous configured-auth snapshot starts empty when it is
    // created without a catalog refresh. getAvailable performs local auth/availability
    // checks, without refreshing the model catalog or extracting request credentials.
    const enabled = !selected && options.enabledModels?.length ? [...options.enabledModels] : undefined;
    // Same resolution as Pi's own model cycling: globs over "provider/id" or bare ids, best alias for exact names. A
    // pattern can also name the model's reasoning level, e.g. "anthropic/*:high".
    const scoped = !selectedProviders && enabled ? (await resolveModelScopeWithDiagnostics(enabled, runtime as never, { signal })).scopedModels : undefined;
    const available = selectedProviders
      ? (await Promise.all(selectedProviders.map(provider => runtime.getAvailable(provider, { signal })))).flat()
      : scoped ? scoped.map(item => item.model)
      : await runtime.getAvailable(undefined, { signal });
    const patternLevels = new Map(scoped?.flatMap(item => item.thinkingLevel ? [[JSON.stringify([item.model.provider, item.model.id]), item.thinkingLevel] as const] : []));
    const seen = new Set<string>();
    const result: LocalModelSummary[] = [];
    for (const model of available) {
      const key = JSON.stringify([model.provider, model.id]);
      if (seen.has(key) || (selected && !selected.has(key))) continue;
      seen.add(key);
      // The level Pi itself starts this model at: the pattern's, then the model's own setting, then the default one.
      const level = patternLevels.get(key) ?? options.modelThinkingLevels?.get(`${model.provider}/${model.id}`) ?? options.defaultThinkingLevel ?? PI_DEFAULT_THINKING_LEVEL;
      result.push(modelSummary({ provider: model.provider, modelId: model.id, name: model.name,
        thinkingLevels: getSupportedThinkingLevels(model), thinkingLevel: clampThinkingLevel(model, level) }));
    }
    if (selected && [...selected].some(key => !seen.has(key))) throw new Error("A selected local Pi model is unavailable or lacks configured authentication");
    if (result.length > connectorLimits.models) throw new Error("Local Pi catalog exceeds 200 models; narrow enabledModels in Pi's settings or pass --model");
    return result.sort((a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId));
  };
  await manifest();
  return {
    manifest,
    ...(options.compaction ? { compaction: options.compaction } : {}),
    // Pi's own identity without attribution; otherwise pi-durable's default, which attributes requests to pi as Pi does.
    ...(options.attribution === false ? { identity: { attribution: null } } : {}),
    async resolve(model) {
      const available = await manifest();
      const summary = available.find(item => item.provider === model.provider && item.modelId === model.modelId);
      if (!summary || !runtime.getModel(model.provider, model.modelId)) throw new Error("Requested local Pi model is unavailable");
      // ModelRuntime implements Models. Its request path resolves/refreshes OAuth
      // and custom-provider authentication locally; never extract an API key.
      return { models: runtime, provider: model.provider, modelId: model.modelId, ...(summary.thinkingLevel ? { thinkingLevel: summary.thinkingLevel } : {}) };
    },
  };
}

/** Deliberate fixture opt-in, never a fallback for an unsupported provider. */
export function createFauxLocalModels(modelId = "fixture"): LocalModels {
  const summary = modelSummary({ provider: "faux", modelId, name: "Deterministic test provider (not an LLM)", thinkingLevels: ["off"] });
  return {
    async manifest() { return [{ ...summary }]; },
    async resolve(model) {
      if (model.provider !== "faux" || model.modelId !== modelId) throw new Error("Requested fixture model is unavailable");
      return { models: runnerModels(model, true), provider: "faux", modelId };
    },
  };
}
