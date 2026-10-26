import type { CompactionSettings } from "@earendil-works/pi-durable";
import type { CompactionFailure } from "../../../packages/shared/src/types.js";

/**
 * Pi's own fixed text for a blocking compaction that failed (pi-durable harness/generation and harness/compaction),
 * settled under the same `model_error` reason as a provider's failure. Only these exact texts are recognized: "Compaction
 * failed: Summarization failed: …" and faulted or orphaned compactions embed provider or runtime text, so they stay
 * plain model errors and their text never leaves the host.
 */
const compactionFailures: ReadonlyMap<string, CompactionFailure> = new Map([
  ["Compaction failed: Summarization hit the token limit; the summary is incomplete", "token_limit"],
  ["Compaction failed: Summarization attempted to call a tool", "tool_call"],
  ["Compaction failed: Summarization produced no text", "no_text"],
  ["Compaction was aborted", "aborted"],
]);

/** Which fixed compaction failure a settled submission's detail reports, if it is exactly one of Pi's own. */
export function compactionFailure(detail: unknown): CompactionFailure | undefined {
  return typeof detail === "string" ? compactionFailures.get(detail) : undefined;
}

/** Pi's own `reserveTokens` default (pi-durable `DEFAULT_COMPACTION_POLICY`): a 13,107-token summary cap. */
export const PI_RESERVE_TOKENS = 16_384;
/** The most room this host keeps by default: a 52,428-token summary cap, enough to think at `max` and still summarize. */
export const REASONING_RESERVE_TOKENS = 65_536;

/**
 * The room a reasoning model keeps by default. Pi summarizes at the conversation's reasoning level within 80% of
 * `reserveTokens`, so at Pi's default a model that thinks at a high level can spend the whole cap thinking and cut its
 * summary off, and then every later message fails the same compaction (#94). A tenth of the context window, between
 * Pi's default and 64K: a 1M-token model keeps 64K, a 200K one 20K, and a small window gives up little of itself.
 */
export function reasoningReserveTokens(model: { reasoning?: boolean; contextWindow?: number }): number | undefined {
  if (!model.reasoning || !Number.isSafeInteger(model.contextWindow) || model.contextWindow! <= 0) return undefined;
  const reserve = Math.min(REASONING_RESERVE_TOKENS, Math.floor(model.contextWindow! / 10));
  return reserve > PI_RESERVE_TOKENS ? reserve : undefined;
}

/**
 * The compaction settings a session's harness runs by: the host's Pi `compaction` setting, plus this host's default
 * room for each reasoning model in its catalog. Whatever the host's settings say wins: a harness-wide `reserveTokens`
 * turns the defaults off, and a model's own override keeps its `reserveTokens`, so an owner can always go back to Pi's.
 */
export function hostCompaction(host: CompactionSettings | undefined, models: Iterable<{ provider: string; id: string; reasoning?: boolean; contextWindow?: number }>): CompactionSettings | undefined {
  if (host?.reserveTokens !== undefined) return host;
  const overrides: Record<string, Partial<Omit<CompactionSettings, "modelOverrides">>> = {};
  for (const model of models) {
    const key = `${model.provider}/${model.id}`;
    const reserveTokens = reasoningReserveTokens(model);
    if (reserveTokens !== undefined && host?.modelOverrides?.[key]?.reserveTokens === undefined) overrides[key] = { reserveTokens };
  }
  if (!Object.keys(overrides).length) return host;
  const modelOverrides: Record<string, Partial<Omit<CompactionSettings, "modelOverrides">>> = { ...overrides };
  for (const [key, override] of Object.entries(host?.modelOverrides ?? {})) modelOverrides[key] = { ...overrides[key], ...override };
  return { ...host, modelOverrides };
}
