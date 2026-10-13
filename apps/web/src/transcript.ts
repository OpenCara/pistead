/** A tool call as the runner writes it into an assistant message's text. */
export interface ToolCallLine {
  name: string;
  line: string;
}

/**
 * The line the runner writes for each tool call in an assistant message (`entryView` in apps/runner/src/session.ts):
 * the tool name, then its JSON arguments. `s` because JSON leaves U+2028 and U+2029 unescaped.
 */
const toolCallLine = /^([a-z_]+)\(\{.*\}\)$/s;
/** A line that opens or closes a fenced code block: up to three spaces, then three or more backticks or tildes. */
const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/s;

/**
 * Separates the runner's tool call lines from an assistant message's prose wherever the model interleaved them,
 * so markdown never rewrites their JSON. Lines inside a fenced code block always stay prose.
 */
export function splitToolCalls(text: string): { prose: string; calls: ToolCallLine[] } {
  const prose: string[] = [];
  const calls: ToolCallLine[] = [];
  let fence = "";
  for (const line of text.split("\n")) {
    const marker = fenceLine.exec(line);
    if (fence) {
      // A closing fence repeats the opening character at least as many times, with nothing after it.
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = "";
      prose.push(line);
      continue;
    }
    // A backtick fence's info string cannot contain a backtick; such a line is inline code.
    if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
      fence = marker[1];
      prose.push(line);
      continue;
    }
    const call = toolCallLine.exec(line);
    if (call) calls.push({ name: call[1], line });
    else prose.push(line);
  }
  return { prose: prose.join("\n"), calls };
}
