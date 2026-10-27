import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Which sandbox a host's sessions run in, besides the bubblewrap sandbox Linux (and WSL2) hosts use:
 * - `seatbelt`: macOS's kernel sandbox (sandbox-exec with a generated profile, see seatbelt.ts). Its shell commands have
 *   no hard memory or process limits, so, as on a Linux host without --resources, only the host's owner can let them
 *   run, in their own sessions.
 * - `windows`: native Windows 11 through Microsoft's MXC SDK on the OS process container (PSEC), with job-object limits
 *   (see windows-sandbox.ts). MXC isn't bundled: `runtime` is the directory it is installed in.
 * Both share the host's network, so their sessions reach the egress proxy on a loopback port with a token.
 */
export type SandboxBackendConfig =
  | { kind: "seatbelt" }
  | { kind: "windows"; runtime: string; limits: WindowsJobLimits };

/** The limits of every sandboxed step's job object on Windows: memory for all its processes, how many, and CPU. */
export interface WindowsJobLimits {
  memoryBytes: number;
  processes: number;
  /** Percent of the whole machine's CPU, 1–100. */
  cpuPercent: number;
}

export const DEFAULT_WINDOWS_LIMITS: Readonly<WindowsJobLimits> = Object.freeze({ memoryBytes: 4 * 1024 ** 3, processes: 256, cpuPercent: 50 });

/** The MXC SDK version the Windows backend is written against; others may change the request contract. */
export const MXC_SDK_VERSION = "1.0.1";

/** Where the connector looks for MXC: PISTEAD_MXC_RUNTIME, else a directory beside its state. */
export function windowsRuntimeDirectory(stateDir: string): string {
  return process.env.PISTEAD_MXC_RUNTIME || join(stateDir, "mxc");
}

/** The installed SDK's entry point in `runtime`, or undefined. */
export function mxcEntry(runtime: string): string | undefined {
  const entry = join(runtime, "node_modules", "@microsoft", "mxc-sdk", "dist", "v1", "index.js");
  return existsSync(entry) ? entry : undefined;
}

/** How to install the SDK where the connector looks for it. */
export function mxcInstallHint(runtime: string): string {
  return `npm install --prefix "${runtime}" @microsoft/mxc-sdk@${MXC_SDK_VERSION}`;
}

export function validWindowsLimits(limits: WindowsJobLimits): Readonly<WindowsJobLimits> {
  const { memoryBytes, processes, cpuPercent } = limits;
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 64 * 1024 ** 2) throw new Error("Windows sandbox memory limit must be at least 64 MiB");
  if (!Number.isSafeInteger(processes) || processes < 4 || processes > 65_536) throw new Error("Windows sandbox process limit must be 4–65536");
  if (!Number.isSafeInteger(cpuPercent) || cpuPercent < 1 || cpuPercent > 100) throw new Error("Windows sandbox CPU limit must be 1–100 percent");
  return Object.freeze({ memoryBytes, processes, cpuPercent });
}
