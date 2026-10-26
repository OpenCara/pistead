import { useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * Syntax highlighting for the Files tab. lowlight runs highlight.js's grammars and returns a tree of spans, which is
 * rendered here as React elements: no HTML string from the file ever reaches the DOM. It loads on first use, in its
 * own chunk, so the app's main bundle doesn't carry the grammars.
 */
type Highlighter = Awaited<ReturnType<typeof load>>;
type Tree = ReturnType<Highlighter["highlight"]>;
type Node = Tree["children"][number];

let loading: ReturnType<typeof load> | undefined;
async function load() {
  const { createLowlight, common } = await import("lowlight");
  return createLowlight(common);
}

/** Files named for what they are, without an extension the grammars know. */
const namedFiles: Record<string, string> = {
  makefile: "makefile", gnumakefile: "makefile", gemfile: "ruby", rakefile: "ruby", podfile: "ruby", vagrantfile: "ruby",
  "cmakelists.txt": "plaintext", ".bashrc": "bash", ".zshrc": "bash", ".profile": "bash", ".env": "bash",
  ".gitconfig": "ini", ".editorconfig": "ini", ".npmrc": "ini", "pipfile": "ini",
};
/** Extensions that aren't one of a grammar's own names or aliases. */
const extensions: Record<string, string> = {
  h: "c", hh: "cpp", hxx: "cpp", ipp: "cpp", mdx: "markdown", jsonc: "json", json5: "json", geojson: "json", webmanifest: "json",
  lock: "plaintext", txt: "plaintext", log: "plaintext", csv: "plaintext", svelte: "xml", vue: "xml", astro: "xml",
  pyi: "python", pyw: "python", gemspec: "ruby", rake: "ruby", ru: "ruby", kts: "kotlin", gradle: "kotlin", cjs: "javascript",
  mjs: "javascript", mts: "typescript", cts: "typescript", fish: "bash", ksh: "bash", conf: "ini", cfg: "ini", properties: "ini",
  env: "bash", pem: "plaintext", tf: "plaintext", proto: "plaintext",
};

/** Larger text shows plain: highlighting it would hold up the page for most of a second. */
export const HIGHLIGHT_LIMIT = 128 * 1024;

/** The grammar for a file, by its name; null when none of the bundled grammars fits. */
export function languageFor(path: string, registered: (name: string) => boolean): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (namedFiles[name]) return namedFiles[name];
  if (name.startsWith(".env.")) return "bash";
  if (name.startsWith("dockerfile")) return registered("dockerfile") ? "dockerfile" : "bash";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1);
  const language = extensions[extension] ?? extension;
  return registered(language) ? language : null;
}

function render(nodes: readonly Node[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === "text") return node.value;
    if (node.type !== "element") return null;
    const className = node.properties?.className;
    return <span key={index} className={Array.isArray(className) ? className.join(" ") : undefined}>{render(node.children as Node[])}</span>;
  });
}

/** `text` as highlighted spans once the grammars load, plain until then or when no grammar fits. */
function useHighlighted(text: string, path: string): Highlighted {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);
  useEffect(() => {
    let current = true;
    void loadHighlighter().then(value => { if (current) setHighlighter(value); }, () => { loading = undefined; });
    return () => { current = false; };
  }, []);
  return useMemo(() => highlighter ? highlightText(highlighter, text, path) : { content: text, language: null }, [highlighter, text, path]);
}

type Highlighted = { content: ReactNode; language: string | null; tooLarge?: true };

/** `text` as React nodes highlighted for `path`'s language, or as it is when no grammar fits or it is too large. */
export function highlightText(highlighter: Highlighter, text: string, path: string): Highlighted {
  const language = languageFor(path, name => highlighter.registered(name));
  if (!language || language === "plaintext") return { content: text, language: null };
  if (text.length > HIGHLIGHT_LIMIT) return { content: text, language: null, tooLarge: true };
  try { return { content: render(highlighter.highlight(language, text).children), language }; }
  catch { return { content: text, language: null }; }
}

/** The grammars, loaded once. */
export function loadHighlighter(): Promise<Highlighter> {
  return loading ??= load();
}

/** A file's text with line numbers, highlighted for its language; long lines scroll rather than wrap. */
export function CodeView({ text, path }: { text: string; path: string }) {
  const { content, language, tooLarge } = useHighlighted(text, path);
  const lines = useMemo(() => {
    const count = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return Array.from({ length: Math.max(count, 1) }, (_, index) => index + 1).join("\n");
  }, [text]);
  return <div className="stack">
    <div className="code-view" data-language={language ?? undefined}>
      <pre className="code-gutter" aria-hidden="true">{lines}</pre>
      <pre className="code-text"><code className={language ? `hljs language-${language}` : undefined}>{content}</code></pre>
    </div>
    {tooLarge && <p className="muted small">Highlighting is off for text over 128 KB.</p>}
  </div>;
}
