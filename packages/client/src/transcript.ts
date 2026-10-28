// The server reads tool call lines too (to shorten them when a session shows brief tool output), so they live in shared.
export { splitToolCalls, transcriptLines, type ToolCallLine } from "../../shared/src/transcript";
