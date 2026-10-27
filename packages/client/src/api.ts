export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Extra headers, such as a share link's; Accept and the authentication headers always take precedence. */
  headers?: Record<string, string>;
}

/** One JSON request to the Pistead API; `path` starts with /api/. Rejects with ApiError on an error answer. */
export type Api = <T>(path: string, options?: RequestOptions) => Promise<T>;

export interface ApiOptions {
  /** The server origin, e.g. https://pistead.com; empty for a browser page served by that server. */
  baseUrl?: string;
  /**
   * How requests authenticate. "cookie": the browser's session cookie, with a fresh CSRF token for every change.
   * A function: the native app's bearer token, or null while signed out. Bearer requests send no cookies.
   */
  auth: "cookie" | (() => string | null);
  /** Defaults to the global fetch at call time. */
  fetch?: typeof fetch;
}

const statusNames: Record<number, string> = {
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 408: "Request Timeout",
  409: "Conflict", 413: "Payload Too Large", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway",
  503: "Service Unavailable", 504: "Gateway Timeout", 520: "Unknown Error", 521: "Web Server Is Down", 522: "Connection Timed Out",
  523: "Origin Is Unreachable", 524: "A Timeout Occurred",
};

const DETAIL_LIMIT = 200;

/** One short line of plain text from an upstream answer: an HTML page's title or heading, else its text; never markup. */
function plainDetail(raw: string): string {
  const html = /<(?:!doctype|html|head|body|title|h1|div|p)\b/i.test(raw);
  let text = raw;
  if (html) {
    const pick = (tag: string) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(raw)?.[1];
    text = pick("title") ?? pick("h1") ?? raw.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
    text = text.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  // Control characters (other than whitespace) are dropped so nothing odd reaches the page.
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT - 1)}…` : text;
}

/** The message in a JSON error answer that isn't Pistead's own shape, such as a hosting proxy's `{message}`. */
function foreignJsonDetail(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const record = body as Record<string, unknown>;
  for (const key of ["message", "detail", "error_description", "title", "reason", "status"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return plainDetail(value);
  }
  const error = record.error;
  if (error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string") {
    return plainDetail((error as { message: string }).message);
  }
  return "";
}

/**
 * Describes an answer that didn't come from Pistead's API (its errors always carry a message): the HTTP status, what the
 * answering proxy said, and what that likely means, so the user sees exactly what failed instead of a bare status code.
 */
function upstreamError(response: Response, detail: string): ApiError {
  const status = response.status;
  const name = response.statusText || statusNames[status] || "";
  const said = detail && detail.toLowerCase() !== name.toLowerCase() && detail !== String(status) ? `: "${detail}"` : "";
  const answer = `HTTP ${status}${name ? ` ${name}` : ""}${said}`;
  if (status === 429) {
    return new ApiError(429, "RATE_LIMITED", `Pistead is over its request limit right now (${answer}). Try again later.`);
  }
  if (status === 408 || status === 504 || status === 522 || status === 524) {
    return new ApiError(status, "UPSTREAM_TIMEOUT", `The proxy in front of Pistead stopped waiting for the server (${answer}). `
      + "The request took too long, but the server may have accepted it and still be working on it: check the result before retrying.");
  }
  if (status === 502 || status === 503 || status === 520 || status === 521 || status === 523) {
    return new ApiError(status, "BACKEND_UNAVAILABLE", `The proxy in front of Pistead got no valid answer from the server (${answer}). `
      + "The server may have restarted, crashed or taken too long while handling this request; if it changes something, check the result before retrying.");
  }
  if (response.ok) {
    return new ApiError(status, "BACKEND_UNAVAILABLE", `The Pistead API answered with something other than JSON (${answer}). Try again later.`);
  }
  return new ApiError(status, "REQUEST_FAILED", `The request failed before reaching Pistead's API (${answer}).`);
}

async function decode(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    // A proxy or CDN in front of the server answers with an HTML or text page, e.g. when it rate limits or times out.
    const raw = await response.text().catch(() => "");
    throw upstreamError(response, plainDetail(raw));
  }
  if (response.ok) return await response.json();
  const raw = await response.text().catch(() => "");
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw upstreamError(response, plainDetail(raw)); }
  const shaped = (body && typeof body === "object" ? body : {}) as { error?: unknown; code?: unknown };
  const error = shaped.error;
  const message = typeof error === "string" ? error
    : error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : undefined;
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code
    : typeof shaped.code === "string" ? shaped.code : undefined;
  // Pistead's own errors always name the problem; anything else came from in front of it, so say what it said.
  if (!message) throw upstreamError(response, foreignJsonDetail(body));
  throw new ApiError(response.status, code ?? "REQUEST_FAILED", message);
}

export function createApi(options: ApiOptions): Api {
  const base = options.baseUrl ?? "";
  const call = (input: string, init: RequestInit) => (options.fetch ?? globalThis.fetch)(input, init);
  return async function api<T>(path: string, request: RequestOptions = {}): Promise<T> {
    const method = request.method ?? "GET";
    const headers: Record<string, string> = { ...request.headers, Accept: "application/json" };
    const init: RequestInit = { method, headers, signal: request.signal };
    if (options.auth === "cookie") {
      init.credentials = "same-origin";
      if (method !== "GET") {
        // Obtain a fresh token so logout/login and another browser tab cannot leave stale CSRF state.
        const token = await decode(await call(`${base}/api/auth/csrf`, { credentials: "same-origin", signal: request.signal })) as { csrfToken: string };
        headers["x-csrf-token"] = token.csrfToken;
      }
    } else {
      init.credentials = "omit";
      const token = options.auth();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    if (request.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(request.body);
    }
    const response = await call(`${base}${path}`, init);
    if (response.status === 204 && response.ok) return undefined as T;
    return await decode(response) as T;
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return "Could not reach Pistead. Check your connection and try again.";
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export const segment = (value: string) => encodeURIComponent(value);
