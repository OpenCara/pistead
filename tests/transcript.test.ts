import test from "node:test";
import assert from "node:assert/strict";
import { splitToolCalls } from "../apps/web/src/transcript.js";

test("tool call lines leave the assistant's prose wherever the model put them", () => {
  const read = 'read_file({"path":"src/__init__.py","note":"*not* emphasis"})';
  const write = 'write_file({"path":"a.txt","content":"line\u2028separator"})';
  assert.deepEqual(splitToolCalls(`Let me look.\n${read}\nNow write it.\n${write}`), {
    prose: "Let me look.\nNow write it.",
    calls: [{ name: "read_file", line: read }, { name: "write_file", line: write }],
  });
  assert.deepEqual(splitToolCalls(read), { prose: "", calls: [{ name: "read_file", line: read }] });
});

test("call-like lines inside fenced code stay prose; calls after the fence closes do not", () => {
  const prose = ["Example:", "```js", 'setup({"debug":true})', "~~~", 'still({"inside":true})', "````", "Done (see the docs)."];
  const call = 'bash({"command":"ls"})';
  assert.deepEqual(splitToolCalls([...prose, call].join("\n")), { prose: prose.join("\n"), calls: [{ name: "bash", line: call }] });
});
