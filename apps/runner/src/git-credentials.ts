import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";

/** A definite failure to read the host's Git credential. Messages are fixed and never carry the credential. */
export class HostCredentialError extends Error {
  constructor(message: string) { super(message); this.name = "HostCredentialError"; }
}

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * The host user's Git credential for a push remote, as an Authorization header. `git credential fill` asks the credential
 * helpers the owner configured (gh, the macOS keychain, Git Credential Manager, a store file) as their own `git push`
 * would, outside any repository, and never prompts: no terminal, askpass program or credential manager window.
 */
export async function hostGitAuthorization(remote: string, options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<string> {
  let url: URL;
  try { url = new URL(remote); } catch { throw new HostCredentialError("Git remote URL is invalid"); }
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash || /[\0\r\n]/.test(remote)) {
    throw new HostCredentialError("Git remote URL is invalid");
  }
  // An empty GIT_ASKPASS also stops Git falling back to core.askPass and SSH_ASKPASS.
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GCM_INTERACTIVE: "never" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[name];
  const fields = new Map<string, string>();
  for (const line of (await fill(`url=${remote}\n\n`, env, url.host, options.signal)).split("\n")) {
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    if (separator > 0 && !fields.has(key)) fields.set(key, line.slice(separator + 1).replace(/\r$/, ""));
  }
  const username = fields.get("username") ?? "";
  const password = fields.get("password") ?? "";
  if (!username || !password || /[\0-\x1f\x7f:]/.test(username) || /[\0-\x1f\x7f]/.test(password)) {
    throw new HostCredentialError(`The Git credentials for ${url.host} on this host have no usable user name and password`);
  }
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function fill(input: string, env: NodeJS.ProcessEnv, host: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(new HostCredentialError("Reading the host's Git credentials was interrupted"));
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  // Its own process group, so a credential helper that hangs is killed with Git. "/" keeps repository config out.
  const child = spawn("git", ["credential", "fill"], { cwd: "/", env, detached: true, stdio: ["pipe", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  let size = 0;
  let failure: HostCredentialError | undefined;
  const stop = (reason: HostCredentialError) => {
    failure ??= reason;
    if (!child.pid) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  };
  const timer = setTimeout(() => stop(new HostCredentialError("Reading the host's Git credentials timed out")), TIMEOUT_MS);
  const abort = () => stop(new HostCredentialError("Reading the host's Git credentials was interrupted"));
  signal?.addEventListener("abort", abort, { once: true });
  const settle = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_OUTPUT_BYTES) stop(new HostCredentialError("Git returned too much credential data"));
    else chunks.push(chunk);
  });
  child.stdin.on("error", () => { /* Early exit closes stdin; the exit status is authoritative. */ });
  child.once("error", () => { settle(); reject(new HostCredentialError("Git could not be started on this host")); });
  child.once("close", code => {
    settle();
    if (failure) reject(failure);
    // Without a helper that knows the remote, Git would prompt; prompts are off, so it exits non-zero instead.
    else if (code !== 0) reject(new HostCredentialError(`No Git credentials for ${host} are set up on this host (for example with gh auth setup-git or a credential helper)`));
    else resolve(Buffer.concat(chunks).toString("utf8"));
  });
  child.stdin.end(input);
  return promise;
}
