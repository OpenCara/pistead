import type { CompactionFailure } from "../../shared/src/types";

/** The card title for a turn that failed because Pi could not compact the conversation's context first. */
export const COMPACTION_FAILED_TITLE = "Context compaction failed";

const causes: Record<CompactionFailure, string> = {
  token_limit: "Pi's summary of the conversation hit its token limit, so the context could not be compacted.",
  tool_call: "Pi's summarizer tried to call a tool instead of writing a summary, so the context could not be compacted.",
  no_text: "Pi's summarizer wrote no summary, so the context could not be compacted.",
  aborted: "Compacting the conversation's context was aborted.",
};

/**
 * Why a turn failed when Pi could not compact the context first, and what to do about it. The conversation is past its
 * model's compaction threshold, so every message needs that compaction first: retrying as before fails the same way.
 */
export function compactionFailureText(failure: CompactionFailure, options: { advice?: boolean } = {}): string {
  const cause = causes[failure] ?? "The conversation's context could not be compacted.";
  if (options.advice === false) return cause;
  if (failure === "aborted") return `${cause} Send the message again to retry.`;
  return `${cause} Retrying at the same reasoning level will fail the same way: send the next message with a lower reasoning level, `
    + "or continue in a new session. The host owner can also raise Pi's compaction.reserveTokens for this model.";
}
