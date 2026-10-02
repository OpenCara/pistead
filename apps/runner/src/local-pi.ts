import { join, resolve } from "node:path";
import type { Models } from "@earendil-works/pi-ai/models";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { LocalModelSummary } from "../../../packages/shared/src/connector.js";
import { connectorLimits } from "../../../packages/shared/src/connector.js";
import type { ModelDefinition } from "../../../packages/shared/src/types.js";
import { runnerModels } from "./provider.js";

export interface ResolvedLocalModel {
  models: Models;
  provider: string;
  modelId: string;
}

export interface LocalModels {
  manifest(): Promise<LocalModelSummary[]>;
  resolve(model: ModelDefinition): Promise<ResolvedLocalModel>;
}

/** Only these non-secret fields can cross the connector boundary. */
export function modelSummary(value: LocalModelSummary): LocalModelSummary {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.provider)
    || typeof value.modelId !== "string" || !value.modelId || value.modelId.length > 256 || /[\s\x00-\x1f\x7f]/.test(value.modelId)
    || typeof value.name !== "string" || !value.name.trim() || value.name.length > 200 || /[\x00-\x1f\x7f]/.test(value.name)) {
    throw new Error("Invalid local model metadata");
  }
  return { provider: value.provider, modelId: value.modelId, name: value.name };
}

export type LocalPiRuntime = Models;

export interface LocalPiOptions {
  /** Explicit Pi agent directory, not a session/history directory. */
  agentDir?: string;
  /** Optional explicit subset when a local catalog exceeds the wire limit. */
  models?: readonly { provider: string; modelId: string }[];
  runtimeFactory?: (options: { authPath?: string; modelsPath?: string; refreshOnCreate: false; allowModelNetwork: false }) => Promise<LocalPiRuntime>;
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
    // Pi 1.0.0's synchronous configured-auth snapshot starts empty when catalog
    // refresh is disabled. getAvailable performs local auth/availability checks,
    // without refreshing the model catalog or extracting request credentials.
    const available = selectedProviders
      ? (await Promise.all(selectedProviders.map(provider => runtime.getAvailable(provider, { signal })))).flat()
      : await runtime.getAvailable(undefined, { signal });
    const seen = new Set<string>();
    const result: LocalModelSummary[] = [];
    for (const model of available) {
      const key = JSON.stringify([model.provider, model.id]);
      if (seen.has(key) || (selected && !selected.has(key))) continue;
      seen.add(key);
      result.push(modelSummary({ provider: model.provider, modelId: model.id, name: model.name }));
    }
    if (selected && [...selected].some(key => !seen.has(key))) throw new Error("A selected local Pi model is unavailable or lacks configured authentication");
    if (result.length > connectorLimits.models) throw new Error("Local Pi catalog exceeds 200 models; select a subset with --model");
    return result.sort((a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId));
  };
  await manifest();
  return {
    manifest,
    async resolve(model) {
      const available = await manifest();
      if (!available.some(item => item.provider === model.provider && item.modelId === model.modelId)
        || !runtime.getModel(model.provider, model.modelId)) throw new Error("Requested local Pi model is unavailable");
      // ModelRuntime implements Models. Its request path resolves/refreshes OAuth
      // and custom-provider authentication locally; never extract an API key.
      return { models: runtime, provider: model.provider, modelId: model.modelId };
    },
  };
}

/** Deliberate fixture opt-in, never a fallback for an unsupported provider. */
export function createFauxLocalModels(modelId = "fixture"): LocalModels {
  const summary = modelSummary({ provider: "faux", modelId, name: "Deterministic test provider (not an LLM)" });
  return {
    async manifest() { return [{ ...summary }]; },
    async resolve(model) {
      if (model.provider !== "faux" || model.modelId !== modelId) throw new Error("Requested fixture model is unavailable");
      return { models: runnerModels(model, true), provider: "faux", modelId };
    },
  };
}
