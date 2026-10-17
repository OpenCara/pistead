export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function decode(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    // Cloudflare answers with an HTML page, e.g. error 1027 once a Workers Free account has spent its daily requests.
    if (response.status === 429) throw new ApiError(429, "RATE_LIMITED", "Pistead is over its request limit right now (HTTP 429). Try again later.");
    throw new ApiError(response.status, "BACKEND_UNAVAILABLE", `The API is not available (HTTP ${response.status}). Start the Worker on localhost:8787 for development, or configure the deployed Worker and its bindings.`);
  }
  const body = await response.json() as { error?: string | { code?: string; message?: string }; code?: string };
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : body.error?.message;
    const code = typeof body.error === "object" ? body.error.code : body.code;
    throw new ApiError(response.status, code ?? "REQUEST_FAILED", message ?? `Request failed (${response.status}).`);
  }
  return body;
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { ...options.headers, Accept: "application/json" };
  if (method !== "GET") {
    // Obtain a fresh token so logout/login and another browser tab cannot leave stale CSRF state.
    const token = await decode(await fetch("/api/auth/csrf", { credentials: "same-origin", signal: options.signal })) as { csrfToken: string };
    headers["x-csrf-token"] = token.csrfToken;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
  }
  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    signal: options.signal,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 204 && response.ok) return undefined as T;
  return await decode(response) as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return "Could not reach the backend. Check your connection and the Worker configuration, then try again.";
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export const segment = (value: string) => encodeURIComponent(value);
