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

async function decode(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    // A proxy or CDN in front of the server answers with an HTML page, e.g. when it rate limits.
    if (response.status === 429) throw new ApiError(429, "RATE_LIMITED", "Pistead is over its request limit right now (HTTP 429). Try again later.");
    throw new ApiError(response.status, "BACKEND_UNAVAILABLE", `The Pistead API is not available (HTTP ${response.status}). Try again later.`);
  }
  const body = await response.json() as { error?: string | { code?: string; message?: string }; code?: string };
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : body.error?.message;
    const code = typeof body.error === "object" ? body.error.code : body.code;
    throw new ApiError(response.status, code ?? "REQUEST_FAILED", message ?? `Request failed (${response.status}).`);
  }
  return body;
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
