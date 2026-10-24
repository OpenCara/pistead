import type { IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';

/** The request URL as the client sees it: forwarded scheme/host only when the operator trusts the proxy. */
export function requestUrl(request: IncomingMessage, trustProxy: boolean): URL {
  const forwarded = (name: string) => trustProxy ? String(request.headers[name] ?? '').split(',')[0]!.trim() : '';
  const proto = forwarded('x-forwarded-proto');
  const scheme = proto === 'https' || proto === 'http' ? proto : (request.socket as TLSSocket).encrypted ? 'https' : 'http';
  const host = forwarded('x-forwarded-host') || request.headers.host;
  if (!host) throw new Error('Missing host header');
  return new URL(`${scheme}://${host}${request.url ?? '/'}`);
}

/**
 * The request at the URL the client used behind a trusted proxy. It is rebuilt from its parts: `@hono/node-server`
 * hands over a lightweight stand-in for a Request, and passing that as a RequestInit makes undici read getters such
 * as `duplex` off the real Request.prototype with the wrong `this`, which Node 26 rejects (ERR_INVALID_THIS, #71).
 */
export function forwardedRequest(request: Request, incoming: IncomingMessage): Request {
  const url = requestUrl(incoming, true);
  if (url.href === request.url) return request;
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? request.body : null,
    duplex: 'half',
    // The adaptor aborts this when the client goes away; live event streams rely on it.
    signal: request.signal,
  } as RequestInit);
}

/**
 * Wraps the app's fetch for the node adaptor so that it sees forwarded URLs. A request that can't be rebuilt (a
 * malformed X-Forwarded-Host, say) gets a 400: an error thrown here is outside the app's error handler and would
 * otherwise reach the client as a bare, unlogged 500. The error is logged, so one that isn't the client's fault (a
 * runtime that rejects the rebuilt request, as Node 26 did in #71) shows up rather than as silent 400s.
 */
export function trustForwardedHeaders(
  fetch: (request: Request) => Response | Promise<Response>,
): (request: Request, bindings: { incoming: unknown }) => Response | Promise<Response> {
  return (request, bindings) => {
    let forwarded: Request;
    // createAdaptorServer defaults to node:http, so the incoming message is always HTTP/1.
    try { forwarded = forwardedRequest(request, bindings.incoming as IncomingMessage); } catch (error) {
      console.error('pistead: could not rebuild a forwarded request:', error instanceof Error ? error.message : error);
      return Response.json({ error: 'Invalid request.', code: 'invalid_request' }, { status: 400 });
    }
    return fetch(forwarded);
  };
}
