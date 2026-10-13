/** One `edit_file` replacement: `oldText` must occur exactly once in the file as it is before the call. */
export interface TextEdit {
  oldText: string;
  newText: string;
}

/**
 * Applies `edits` together, each matched against the original content, so their order does not matter. Errors name the
 * edit and the path for the model to fix its next call. A file that uses CRLF throughout is matched and written with
 * LF/CRLF translated, since models write LF; a file that mixes endings must be matched exactly.
 */
export function applyEdits(content: string, edits: readonly TextEdit[], path: string): string {
  const crlf = content.includes("\r\n") && !/(?<!\r)\n/.test(content);
  const lf = (value: string) => crlf ? value.replaceAll("\r\n", "\n") : value;
  const base = lf(content);
  const matches = edits.map((edit, index) => {
    const oldText = lf(edit.oldText);
    if (!oldText) throw new Error(`edits[${index}].oldText is empty`);
    const at = base.indexOf(oldText);
    if (at === -1) throw new Error(`edits[${index}].oldText was not found in ${path}; it must match the file exactly, including whitespace and line breaks`);
    let count = 0;
    for (let next = at; next !== -1; next = base.indexOf(oldText, next + 1)) count++;
    if (count > 1) throw new Error(`edits[${index}].oldText occurs ${count} times in ${path}; include more surrounding text so it matches once`);
    return { index, at, end: at + oldText.length, newText: lf(edit.newText) };
  }).sort((a, b) => a.at - b.at);
  for (let i = 1; i < matches.length; i++) {
    if (matches[i]!.at < matches[i - 1]!.end) throw new Error(`edits[${matches[i - 1]!.index}] and edits[${matches[i]!.index}] overlap in ${path}; merge them into one edit`);
  }
  let result = "";
  let from = 0;
  for (const match of matches) {
    result += base.slice(from, match.at) + match.newText;
    from = match.end;
  }
  result += base.slice(from);
  return crlf ? result.replaceAll("\n", "\r\n") : result;
}
