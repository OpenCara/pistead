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
