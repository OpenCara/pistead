import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate, constants as zlib } from "node:zlib";
import { hostAllowed, type NetworkPolicy } from "../../../packages/shared/src/network.js";
import { webLimits } from "../../../packages/shared/src/web.js";
import { publicUpstream, type ApiUpstream, type UpstreamResponse } from "./api-access.js";
import { RunnerError } from "./protocol.js";

/*
 * The agent's web_fetch tool: the host reads one https:// page for the session, as far as the workspace's network access
 * lets the session's sandboxed commands reach (hostAllowed, as the egress proxy's tunnels decide), at public addresses
 * only (publicUpstream), never with a credential or a cookie, and only with GET. Each redirect is checked like the first
 * request. HTML comes back as text with its links and headings kept; images as images; other text as it is.
 */

const USER_AGENT = "Mozilla/5.0 (compatible; Pistead-web_fetch; +https://github.com/OpenCara/pistead)";
/** How long one page may take to arrive, its headers and its body together. */
const FETCH_TIMEOUT_MS = 60_000;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export interface FetchEntry { target: string; outcome: "allowed" | "refused"; reason?: string }
export interface WebFetchOptions {
  /** The session's current network policy (its egress grant's). */
  policy: () => Promise<NetworkPolicy>;
  /** Overridable for tests: requests at public addresses only. */
  upstream?: ApiUpstream;
  signal?: AbortSignal;
  /** Each request's decision, for the session's egress status. */
  record?: (entry: FetchEntry) => void;
}
/** A fetched page: its text (HTML as text), or an image's bytes. */
export type WebPage = {
  url: string; status: number; contentType: string;
  /** Some of the page was left unread: it is larger than web_fetch downloads (webLimits). */
  truncated: boolean;
  /** The http:// URL asked for, read as https:// instead. */
  upgraded?: true;
} & ({ kind: "text"; text: string; title?: string } | { kind: "image"; bytes: Uint8Array; mimeType: string });

/** The https:// URL web_fetch reads for `input`: http:// becomes https://, the fragment goes; anything else is refused. */
export function webFetchUrl(input: string): { url: URL; upgraded: boolean } {
  if (input.length > webLimits.urlLength) throw new RunnerError(400, `The URL is longer than ${webLimits.urlLength} characters`);
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new RunnerError(400, "url must be an absolute https:// URL, such as https://example.com/docs"); }
  const upgraded = url.protocol === "http:";
  if (upgraded) {
    // The default port of http is dropped by URL; another one can't simply move to https.
    if (url.port && url.port !== "443") throw new RunnerError(400, "Only HTTPS on port 443 is reachable, so http:// URLs with a port can't be read");
    url = new URL(`https:${url.href.slice("http:".length)}`);
  }
  checkUrl(url);
  url.hash = "";
  return { url, upgraded };
}

function checkUrl(url: URL): void {
  if (url.protocol !== "https:") throw new RunnerError(400, `web_fetch reads only https:// URLs, not ${url.protocol.slice(0, 20)}`);
  if (url.username || url.password) throw new RunnerError(400, "web_fetch sends no credentials: the URL must not contain a user name or password");
  if (url.port && url.port !== "443") throw new RunnerError(403, `Only HTTPS on port 443 is reachable, not port ${url.port}`);
}

function policyRefusal(policy: NetworkPolicy, host: string): string {
  return policy.mode === "off"
    ? `${host} is not reachable: this workspace's network access is off. Its owners and admins can allow hosts under Settings → Workspaces → the workspace → Network access`
    : `${host} is not allowed by this workspace's network policy`;
}

/** Reads `input` as web_fetch does: the page at its final URL after redirects, or a RunnerError saying why not. */
export async function fetchPage(input: string, options: WebFetchOptions): Promise<WebPage> {
  const { url: first, upgraded } = webFetchUrl(input);
  const signal = AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
  const upstream = options.upstream ?? publicUpstream;
  const record = options.record ?? (() => {});
  let url = first;
  for (let hop = 0; ; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const target = `${url.origin}${url.pathname}`;
    const policy = await options.policy();
    if (!hostAllowed(policy, host)) {
      const reason = policyRefusal(policy, host);
      record({ target, outcome: "refused", reason });
      throw new RunnerError(403, reason);
    }
    let response: UpstreamResponse;
    try {
      response = await upstream({ url, method: "GET", signal, headers: {
        accept: "text/html,application/xhtml+xml,text/markdown,text/plain;q=0.9,application/json;q=0.9,image/*;q=0.8,*/*;q=0.5",
        "accept-encoding": "gzip, deflate, br", "user-agent": USER_AGENT, host: url.host,
      } });
    } catch (error) {
      const reason = signal.aborted ? `${host} did not answer in time` : error instanceof RunnerError ? error.message : `${host} could not be reached`;
      record({ target, outcome: "refused", reason });
      if (options.signal?.aborted) throw new RunnerError(499, "The fetch was stopped");
      throw new RunnerError(502, reason);
    }
    const location = [301, 302, 303, 307, 308].includes(response.status) ? response.headers.location : undefined;
    if (!location) {
      record({ target, outcome: "allowed", reason: `${response.status}` });
      return await page(url, response, signal, upgraded, options.signal);
    }
    response.body.destroy();
    record({ target, outcome: "allowed", reason: `${response.status} redirect` });
    if (hop >= webLimits.redirects) throw new RunnerError(502, `${input.slice(0, 200)} redirected more than ${webLimits.redirects} times`);
    let next: URL;
    try { next = new URL(String(location), url); } catch { throw new RunnerError(502, `${host} redirected to an invalid URL`); }
    if (next.protocol === "http:") throw new RunnerError(502, `${host} redirected to plain HTTP (${next.href.slice(0, 200)}), which web_fetch doesn't read`);
    checkUrl(next);
    next.hash = "";
    url = next;
  }
}

async function page(url: URL, response: UpstreamResponse, signal: AbortSignal, upgraded: boolean, stopped: AbortSignal | undefined): Promise<WebPage> {
  const header = (name: string) => { const value = response.headers[name]; return Array.isArray(value) ? value[0] : value; };
  const contentType = (header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const base = { url: url.href, status: response.status, contentType: contentType || "unknown", ...(upgraded ? { upgraded: true as const } : {}) };
  // An image or text type is read; anything else is refused before its body is.
  const image = IMAGE_TYPES.includes(contentType);
  if (contentType && !image && !textual(contentType)) {
    response.body.destroy();
    const length = Number(header("content-length"));
    throw new RunnerError(415, `${url.href.slice(0, 200)} is ${contentType}${Number.isFinite(length) && length > 0 ? ` (${length} bytes)` : ""}: web_fetch reads web pages, text and images. `
      + "Download other files with curl in bash, where the network access allows it.");
  }
  let body: { bytes: Buffer; truncated: boolean };
  try { body = await download(response.body, header("content-encoding"), signal); }
  catch (error) {
    if (stopped?.aborted) throw new RunnerError(499, "The fetch was stopped");
    if (error instanceof RunnerError) throw error;
    throw new RunnerError(502, signal.aborted ? `${url.host} did not send the page in time` : `${url.host} broke off sending the page`);
  }
  if (image) {
    if (body.truncated) throw new RunnerError(413, `The image at ${url.href.slice(0, 200)} is larger than web_fetch downloads`);
    return { ...base, truncated: false, kind: "image", bytes: body.bytes, mimeType: contentType };
  }
  // Without a type, only what decodes as text is read.
  if (!contentType && body.bytes.subarray(0, 8000).includes(0)) throw new RunnerError(415, `${url.href.slice(0, 200)} isn't text: web_fetch reads web pages, text and images`);
  const html = contentType === "text/html" || contentType === "application/xhtml+xml" || (!contentType && /^\s*<(!doctype html|html)/i.test(body.bytes.subarray(0, 1000).toString("latin1")));
  const decoded = decodeText(body.bytes, header("content-type"), html);
  if (!html) return { ...base, truncated: body.truncated, kind: "text", text: decoded };
  const converted = htmlToText(decoded, url);
  return { ...base, truncated: body.truncated, kind: "text", text: converted.text, ...(converted.title ? { title: converted.title } : {}) };
}

function textual(type: string): boolean {
  return type.startsWith("text/") || /^application\/(json|xml|xhtml\+xml|javascript|ecmascript|x-javascript|yaml|x-yaml|toml|x-toml|x-sh|sql|graphql|ld\+json|manifest\+json|x-ndjson|ndjson)$/.test(type)
    || /\+(json|xml)$/.test(type);
}

/** The body, within webLimits' download and decoded sizes; the rest is left unread (`truncated`). */
async function download(source: Readable, encoding: string | undefined, signal: AbortSignal): Promise<{ bytes: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  const abort = () => source.destroy(new Error("aborted"));
  if (signal.aborted) throw new Error("aborted");
  signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      if (size + chunk.length > webLimits.downloadBytes) {
        chunks.push(chunk.subarray(0, webLimits.downloadBytes - size));
        size = webLimits.downloadBytes;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      size += chunk.length;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    source.destroy();
  }
  if (signal.aborted) throw new Error("aborted");
  const raw = Buffer.concat(chunks);
  const coding = encoding?.trim().toLowerCase();
  if (!coding || coding === "identity") return { bytes: raw, truncated };
  const decoded = await decompress(raw, coding);
  return { bytes: decoded.bytes, truncated: truncated || decoded.truncated };
}

async function decompress(raw: Buffer, coding: string): Promise<{ bytes: Buffer; truncated: boolean }> {
  // A body cut short at the download limit still decodes as far as it goes.
  const stream = coding === "gzip" || coding === "x-gzip" ? createGunzip({ finishFlush: zlib.Z_SYNC_FLUSH })
    : coding === "deflate" ? createInflate({ finishFlush: zlib.Z_SYNC_FLUSH })
    : coding === "br" ? createBrotliDecompress({ finishFlush: zlib.BROTLI_OPERATION_FLUSH })
    : undefined;
  if (!stream) throw new RunnerError(502, `The page came with an encoding web_fetch can't decode (${coding.slice(0, 40)})`);
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  stream.end(raw);
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (size + chunk.length > webLimits.decodedBytes) {
        chunks.push(chunk.subarray(0, webLimits.decodedBytes - size));
        truncated = true;
        break;
      }
      chunks.push(chunk);
      size += chunk.length;
    }
  } catch {
    if (!chunks.length) throw new RunnerError(502, "The page's compressed content could not be decoded");
    truncated = true;
  } finally {
    stream.destroy();
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

/** Text in the charset its Content-Type (or, for HTML, its meta tag) names; UTF-8 otherwise or where that is unknown. */
export function decodeText(bytes: Uint8Array, contentType: string | undefined, html: boolean): string {
  let charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? "")?.[1];
  if (!charset && html) charset = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(Buffer.from(bytes.subarray(0, 4096)).toString("latin1"))?.[1];
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(charset ?? "utf-8"); } catch { decoder = new TextDecoder("utf-8"); }
  return decoder.decode(bytes).replaceAll("\0", "");
}

/** Latin-1's named characters, U+00A0 to U+00FF in order. */
const LATIN1 = ("nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil "
  + "sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc "
  + "Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring "
  + "aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml "
  + "yacute thorn yuml").split(" ");
const ENTITIES: Record<string, string> = {
  ...Object.fromEntries(LATIN1.map((name, index) => [name, String.fromCodePoint(0xa0 + index)])),
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", shy: "", trade: "™", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„", bull: "•", minus: "−", euro: "€", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔",
  le: "≤", ge: "≥", ne: "≠", zwj: "", zwnj: "", ensp: " ", emsp: " ", thinsp: " ", dagger: "†", Dagger: "‡", permil: "‰", prime: "′", infin: "∞",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[entity] ?? ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Elements whose content never reaches the text. Not `head`, whose end tag pages may leave out: what it holds is skipped anyway. */
const SKIPPED = new Set(["script", "style", "noscript", "template", "svg", "math", "iframe", "object", "canvas", "select", "datalist"]);
const BLOCKS = new Set(["p", "div", "section", "article", "header", "footer", "main", "nav", "aside", "ul", "ol", "dl", "dt", "dd", "table", "thead",
  "tbody", "tfoot", "blockquote", "figure", "figcaption", "form", "fieldset", "details", "summary", "address", "caption"]);

/** The most text a page converts to, in characters: as much as web_fetch decodes of it. */
const HTML_TEXT_LIMIT = webLimits.decodedBytes;
/** Nested lists indent this deep at most, so their markers never outgrow the page. */
const MAX_INDENT = 8;

/** Where `name`'s end tag starts at or after `from`, not a longer name's that begins the same (`</scripture>`); -1 for none. */
function closingTag(lower: string, name: string, from: number): number {
  for (let index = lower.indexOf(`</${name}`, from); index >= 0; index = lower.indexOf(`</${name}`, index + 1)) {
    if (!/[a-z0-9:-]/.test(lower[index + name.length + 2] ?? "")) return index;
  }
  return -1;
}

/**
 * HTML as text an agent reads well: script, style and other non-content elements dropped, headings as `#` lines, list
 * items as `-` lines, links as `[text](url)` resolved against `base`, preformatted blocks fenced, entities decoded and
 * whitespace collapsed. One pass over the tags, each looked at within a bounded length, so a malformed page never takes long.
 */
export function htmlToText(html: string, base: URL): { title?: string; text: string } {
  const lower = html.toLowerCase();
  const out: string[] = [];
  /** The output's length so far: conversion stops at HTML_TEXT_LIMIT, whatever the page holds. */
  let size = 0;
  const emit = (text: string) => { out.push(text); size += text.length; };
  const titleStart = lower.indexOf("<title");
  const titleOpen = titleStart < 0 ? -1 : lower.indexOf(">", titleStart);
  const titleEnd = titleOpen < 0 ? -1 : lower.indexOf("</title", titleOpen);
  const title = titleEnd < 0 ? undefined : decodeEntities(html.slice(titleOpen + 1, titleEnd)).replace(/\s+/g, " ").trim().slice(0, webLimits.titleLength) || undefined;
  let pre = 0;
  let lists = 0;
  let link: { href: string; start: number } | undefined;
  /** The output's last `count` characters, from its last parts. */
  const last = (count: number) => {
    let text = "";
    for (let index = out.length - 1; index >= 0 && text.length < count; index--) text = out[index]! + text;
    return text.slice(-count);
  };
  /** Ends the current line, and leaves `count - 1` blank lines after it; nothing at the very start. */
  const newlines = (count: number) => {
    const end = last(count);
    if (!end) return;
    const have = /\n*$/.exec(end)![0].length;
    if (have < count) emit("\n".repeat(count - have));
  };
  const write = (raw: string) => {
    if (pre) { emit(decodeEntities(raw)); return; }
    let text = decodeEntities(raw).replace(/[\s\u00a0]+/g, " ");
    const end = last(1);
    if (!end || end === "\n" || end === " ") text = text.trimStart();
    if (text) emit(text);
  };
  // A tag's attributes stop at the next `<`, so an unclosed one costs only the text up to the next tag.
  const tag = /<!--|<[!?][^<>]{0,1024}>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]{0,63})(?![a-zA-Z0-9:-])([^<>]{0,4096})>/g;
  let position = 0;
  for (let match = tag.exec(html); match && size < HTML_TEXT_LIMIT; match = tag.exec(html)) {
    if (match.index > position) write(html.slice(position, match.index));
    position = tag.lastIndex;
    if (match[0] === "<!--") {
      const end = html.indexOf("-->", position);
      position = end < 0 ? html.length : end + 3;
      tag.lastIndex = position;
      continue;
    }
    // A doctype, processing instruction or CDATA marker says nothing a reader needs.
    if (match[2] === undefined) continue;
    const closing = match[1] === "/";
    const name = match[2].toLowerCase();
    const attributes = match[3] ?? "";
    if (!closing && (SKIPPED.has(name) || name === "title")) {
      // Its content, up to its own end tag, is skipped whole; the title was read above.
      if (attributes.trimEnd().endsWith("/")) continue;
      const end = closingTag(lower, name, position);
      const close = end < 0 ? -1 : lower.indexOf(">", end);
      position = close < 0 ? html.length : close + 1;
      tag.lastIndex = position;
      continue;
    }
    if (/^h[1-6]$/.test(name)) {
      newlines(2);
      if (!closing) emit(`${"#".repeat(Number(name[1]))} `);
      continue;
    }
    switch (name) {
      case "br": emit("\n"); break;
      case "hr": newlines(2); emit("---"); newlines(2); break;
      case "li": if (!closing) { newlines(1); emit(`${"  ".repeat(Math.min(MAX_INDENT, Math.max(0, lists - 1)))}- `); } break;
      case "ul": case "ol": lists = Math.max(0, lists + (closing ? -1 : 1)); newlines(lists > 1 || (lists === 1 && closing) ? 1 : 2); break;
      case "tr": newlines(1); break;
      case "td": case "th": if (closing) emit(" | "); break;
      case "pre":
        if (!closing) { newlines(2); emit("```\n"); pre++; }
        else if (pre) { pre--; if (last(1) !== "\n") emit("\n"); emit("```"); newlines(2); }
        break;
      case "code": if (!pre) emit("`"); break;
      case "img": {
        const alt = attribute(attributes, "alt");
        if (alt && !closing) write(` [image: ${alt}] `);
        break;
      }
      case "a":
        if (!closing) {
          const href = attribute(attributes, "href");
          link = href !== undefined ? { href, start: out.length } : undefined;
        } else if (link) {
          const removed = out.splice(link.start).join("");
          size -= removed.length;
          const text = removed.replace(/\s+/g, " ").trim();
          const target = linkTarget(link.href, base);
          if (text) emit(target && target !== text ? `[${text}](${target})` : text);
          link = undefined;
        }
        break;
      default:
        if (BLOCKS.has(name)) newlines(2);
    }
  }
  if (position < html.length && size < HTML_TEXT_LIMIT) write(html.slice(position, position + HTML_TEXT_LIMIT));
  const text = out.join("").slice(0, HTML_TEXT_LIMIT).split("\n").map(line => line.replace(/[ \t]+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { ...(title ? { title } : {}), text };
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attributes);
  if (!match) return undefined;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim();
}

/** A link's absolute http(s) URL, or undefined for an anchor on the same page, a script or anything unusable. */
function linkTarget(href: string, base: URL): string | undefined {
  if (!href || href.startsWith("#")) return undefined;
  try {
    const url = new URL(href, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href.slice(0, webLimits.urlLength) : undefined;
  } catch { return undefined; }
}
