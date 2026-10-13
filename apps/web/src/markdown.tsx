import { memo, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { Mermaid } from "mermaid";
import { useResolvedTheme, type ResolvedTheme } from "./theme";
import { Loading } from "./ui";

/** GitHub-flavored markdown; a single line break stays a line break, as in the plain-text transcript. */
const plugins = [remarkGfm, remarkBreaks];
/** The "Footnotes" heading GFM adds is for screen readers only. */
const rehypeOptions = { footnoteLabelProperties: { className: ["visually-hidden"] } };

/** Absolute links. Repository paths lead nowhere in the browser, and an in-page anchor would change the app's route. */
const openable = /^(?:https?|mailto):/i;

/** Opens an absolute link in a new tab; anything else, including a URL dropped as unsafe, stays plain text. */
function Link({ href, title, children }: { href: string | undefined; title?: string; children: ReactNode }) {
  return href && openable.test(href)
    ? <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>
    : <span title={title || href || undefined}>{children}</span>;
}

const components: Components = {
  a: ({ href, title, children }) => <Link href={href} title={title}>{children}</Link>,
  // Markdown images are not loaded: each is a link the reader can choose to open (the CSP blocks most image hosts anyway).
  img: ({ src, alt }) => {
    const url = typeof src === "string" ? src : undefined;
    return <Link href={url}>{alt || url}</Link>;
  },
  pre: ({ node, children }) => {
    const code = node?.children[0];
    if (code?.type === "element" && code.tagName === "code" && Array.isArray(code.properties.className) && code.properties.className.includes("language-mermaid")) {
      return <MermaidDiagram source={code.children.map(child => child.type === "text" ? child.value : "").join("")} />;
    }
    return <pre>{children}</pre>;
  },
};

/** Model-written markdown. Raw HTML shows as text and unsafe link protocols are dropped (react-markdown's defaults). */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={plugins} remarkRehypeOptions={rehypeOptions} components={components}>{text}</ReactMarkdown></div>;
});

let mermaid: Promise<Mermaid> | undefined;
let drawings = 0;

async function drawDiagram(source: string, theme: ResolvedTheme): Promise<string> {
  // Loaded on first use: Mermaid is several times the size of the app. A failed load is retried by the next diagram.
  mermaid ??= import("mermaid").then(module => module.default, (error: unknown) => {
    mermaid = undefined;
    throw error;
  });
  const api = await mermaid;
  // The configuration is global, so it is set before each queued render; a render overtaken by a theme change is discarded.
  api.initialize({
    startOnLoad: false,
    // Diagram text is model output: labels are escaped, click handlers are disabled and the SVG is sanitized.
    securityLevel: "strict",
    // A syntax error rejects instead of leaving Mermaid's error graphic in <body>.
    suppressErrorRendering: true,
    theme: theme === "dark" ? "dark" : "neutral",
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font").trim(),
  });
  return (await api.render(`mermaid-diagram-${++drawings}`, source)).svg;
}

/** A ```mermaid block drawn as its diagram; the source shows instead when Mermaid cannot draw it. */
function MermaidDiagram({ source }: { source: string }) {
  const theme = useResolvedTheme();
  // undefined while the first drawing is in progress; null when Mermaid could not draw the source.
  const [svg, setSvg] = useState<string | null>();
  useEffect(() => {
    let current = true;
    drawDiagram(source, theme).then(drawn => { if (current) setSvg(drawn); }, () => { if (current) setSvg(null); });
    return () => { current = false; };
  }, [source, theme]);
  if (svg === undefined) return <div className="markdown-diagram"><Loading>Rendering diagram...</Loading></div>;
  if (svg === null) {
    return <figure className="markdown-diagram-source">
      <pre><code className="language-mermaid">{source}</code></pre>
      <figcaption>Could not render this Mermaid diagram</figcaption>
    </figure>;
  }
  return <div className="markdown-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
