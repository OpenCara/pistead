import test from "node:test";
import assert from "node:assert/strict";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HIGHLIGHT_LIMIT, highlightText, languageFor, loadHighlighter } from "../apps/web/src/code-highlight.js";

const highlighter = await loadHighlighter();
const html = (path: string, text: string) => renderToStaticMarkup(createElement(Fragment, null, highlightText(highlighter, text, path).content));
const unescape = (markup: string) => markup.replace(/<[^>]+>/g, "")
  .replaceAll("&quot;", "\"").replaceAll("&#x27;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

test("the Files tab picks a grammar by file name, never by guessing", () => {
  const known = (name: string) => highlighter.registered(name);
  const cases: Record<string, string | null> = {
    "src/app.ts": "ts", "a/b.tsx": "tsx", "x.py": "py", "main.go": "go", "lib.rs": "rs", "README.md": "md", "data.json": "json",
    "c.yml": "yml", "x.h": "c", "index.html": "html", "icon.svg": "svg", "a.mjs": "javascript", "pyproject.toml": "toml", "patch.diff": "diff",
    "Makefile": "makefile", "Gemfile": "ruby", ".env": "bash", ".env.local": "bash", "Dockerfile": "bash",
    "notes.txt": "plaintext", "LICENSE": null, "go.mod": null, "x.unknownext": null,
  };
  for (const [path, language] of Object.entries(cases)) assert.equal(languageFor(path, known), language, path);
});

test("highlighted code is spans around the file's text, which is never markup", () => {
  const ts = html("a.ts", "const x: number = 1; // hi\nfunction f() { return \"s\"; }\n");
  assert.match(ts, /<span class="hljs-keyword">const<\/span>/);
  assert.match(ts, /<span class="hljs-comment">\/\/ hi<\/span>/);
  assert.match(ts, /<span class="hljs-string">&quot;s&quot;<\/span>/);
  const hostile = "<script>alert(1)</script><img src=x onerror=alert(2)>";
  const markup = html("x.html", hostile);
  assert.ok(!markup.includes("<script") && !markup.includes("<img"), markup);
  assert.equal(unescape(markup), hostile);
  // No grammar: the text as it is.
  assert.equal(html("LICENSE", "<b>plain</b>"), "&lt;b&gt;plain&lt;/b&gt;");
  const code = "def f(x):\n    return x * 2  # 'double'\n".repeat(1000);
  assert.equal(unescape(html("big.py", code)), code);
});

test("text too large to highlight quickly stays plain", () => {
  const text = "x = 1\n".repeat(Math.ceil(HIGHLIGHT_LIMIT / 6) + 1);
  const result = highlightText(highlighter, text, "big.py");
  assert.equal(result.content, text);
  assert.equal(result.tooLarge, true);
  assert.equal(highlightText(highlighter, "x = 1\n", "small.py").tooLarge, undefined);
});
