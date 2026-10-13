import { createContext, memo, useContext, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/** GitHub-flavored markdown; a single line break stays a line break, as in the plain-text transcript. */
const plugins = [remarkGfm, remarkBreaks];
/** The "Footnotes" heading GFM adds is for screen readers only. */
const rehypeOptions = { footnoteLabelProperties: { className: ["visually-hidden"] } };

/** Absolute links. Repository paths lead nowhere in the browser, and an in-page anchor would change the app's route. */
const openable = /^(?:https?|mailto):/i;

/** Set inside a link: an image there is part of the link text, so the link keeps its one target. */
const InsideLink = createContext(false);

/** Opens an absolute link in a new tab; anything else, including a URL dropped as unsafe, stays plain text. */
function Link({ href, title, children }: { href: string | undefined; title?: string; children: ReactNode }) {
  return <InsideLink value={true}>
    {href && openable.test(href)
      ? <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span title={title || href || undefined}>{children}</span>}
  </InsideLink>;
}

/** Markdown images are not loaded: each is a link the reader can choose to open, or plain text inside another link. */
function Image({ src, alt }: { src: string | undefined; alt: string | undefined }) {
  const text = alt || src;
  return useContext(InsideLink) ? <>{text}</> : <Link href={src}>{text}</Link>;
}

const components: Components = {
  a: ({ href, title, children }) => <Link href={href} title={title}>{children}</Link>,
  img: ({ src, alt }) => <Image src={typeof src === "string" ? src : undefined} alt={alt} />,
};

/** Model-written markdown. Raw HTML shows as text and unsafe link protocols are dropped (react-markdown's defaults). */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={plugins} remarkRehypeOptions={rehypeOptions} components={components}>{text}</ReactMarkdown></div>;
});
