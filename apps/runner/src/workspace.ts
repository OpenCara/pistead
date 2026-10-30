import type { HostCommandOperation, Operation } from "../../../packages/shared/src/types.js";
import type { BrowseResult } from "./file-browser.js";
import type { FileContent } from "./images.js";
import type { ClonePushWorkspace } from "./push.js";
import type { CloneBackup, SandboxAuthorize, SandboxExecutionOptions, SandboxIdentity, SnapshotFile } from "./sandbox.js";

/**
 * What a session needs from where its work lives, whatever keeps it there: the bubblewrap sandbox on Linux
 * (`Sandbox`), the host's own environment (`HostWorkspace`), and later the macOS and native Windows sandboxes. Every
 * method waits for `authorize` before it touches anything, and operations of one session run one at a time.
 */
export interface SessionWorkspace {
  /** False for the host's own environment, where only path checks confine the file tools. */
  readonly isolated: boolean;
  readonly home: string;
  readonly worktree: string;
  identity(authorize: SandboxAuthorize): Promise<Readonly<SandboxIdentity>>;
  initialize(): Promise<void>;
  readFile(path: string, authorize: SandboxAuthorize): Promise<string>;
  readContent(path: string, authorize: SandboxAuthorize): Promise<FileContent>;
  writeFile(path: string, content: string, authorize: SandboxAuthorize): Promise<void>;
  listFiles(path: string | undefined, authorize: SandboxAuthorize): Promise<string[]>;
  browse(path: string, authorize: SandboxAuthorize): Promise<BrowseResult>;
  execute(operation: Operation, readOnly: boolean, authorize: SandboxAuthorize, options?: SandboxExecutionOptions): Promise<string>;
  /** The worktree's files, without the clones named in `clones` (an isolated workspace keeps those as bundles instead). */
  snapshot(authorize: SandboxAuthorize, clones?: readonly string[]): Promise<SnapshotFile[]>;
  /** A host command: always outside any isolation, as the connector's user. */
  executeHost(operation: HostCommandOperation, authorize: SandboxAuthorize, signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

/**
 * A workspace that confines the session: its clones are read, packed, backed up and restored by steps that run inside
 * the isolation, never by the runner reading the session's files itself.
 */
export interface IsolatedWorkspace extends SessionWorkspace, ClonePushWorkspace {
  readonly isolated: true;
  cloneHead(path: string, authorize: SandboxAuthorize): Promise<{ commit: string; origin: string | null }>;
  cloneBackup(authorize: SandboxAuthorize): Promise<{ clones: CloneBackup[]; found: string[] }>;
  clonePending(authorize: SandboxAuthorize): Promise<{ path: string; origin: string | null }[]>;
  cloneRestore(path: string, url: string, reference: string | null, authorize: SandboxAuthorize): Promise<void>;
}

/** The workspace's isolated operations; a host workspace has none, and asking for them is a caller's mistake. */
export function isolatedWorkspace(workspace: SessionWorkspace): IsolatedWorkspace {
  if (!workspace.isolated) throw new Error("This step needs the sandbox, and the session runs on the host");
  return workspace as IsolatedWorkspace;
}
