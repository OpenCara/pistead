import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

export interface GitHttpOptions { protocolV2?: boolean; authorization?: string }

/** Serves `git http-backend` as CGI over node:http for repositories below `projectRoot`. */
export async function startGitHttpServer(projectRoot: string, options: GitHttpOptions = {}): Promise<{ url(repo: string): string; close(): Promise<void> }> {
  const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();
  const backend = join(execPath, "git-http-backend");
  const server = createServer((request, response) => serve(request, response));

  function serve(request: IncomingMessage, response: ServerResponse): void {
    if (options.authorization !== undefined && request.headers.authorization !== options.authorization) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' }).end();
      request.resume();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: process.env.HOME,
      GIT_PROJECT_ROOT: projectRoot, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: "pistead", REMOTE_ADDR: "127.0.0.1",
      PATH_INFO: decodeURIComponent(url.pathname), QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method ?? "GET",
      CONTENT_TYPE: request.headers["content-type"] ?? "", GATEWAY_INTERFACE: "CGI/1.1", SERVER_PROTOCOL: "HTTP/1.1",
    };
    if (request.headers["content-length"]) env.CONTENT_LENGTH = request.headers["content-length"];
    const protocol = request.headers["git-protocol"];
    if (options.protocolV2 !== false && typeof protocol === "string") env.GIT_PROTOCOL = protocol;
    const child = spawn(backend, [], { env, stdio: ["pipe", "pipe", "ignore"] });
    request.pipe(child.stdin);
    child.stdin.on("error", () => {});
    let header = Buffer.alloc(0);
    let started = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (started) { response.write(chunk); return; }
      header = Buffer.concat([header, chunk]);
      const crlf = header.indexOf("\r\n\r\n"), lf = header.indexOf("\n\n");
      const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf : lf;
      if (end < 0) return;
      const rest = header.subarray(end + (end === crlf ? 4 : 2));
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of header.subarray(0, end).toString("latin1").split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const name = line.slice(0, colon).trim(), value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = parseInt(value, 10);
        else headers[name] = value;
      }
      started = true;
      response.writeHead(status, headers);
      if (rest.length) response.write(rest);
    });
    child.on("close", () => { if (!started) response.writeHead(502); response.end(); });
    child.on("error", () => { if (!started) response.writeHead(500); response.end(); });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (repo) => `http://127.0.0.1:${port}/${repo}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
