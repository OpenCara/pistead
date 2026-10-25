import { MAX_OUTPUT_BYTES } from "../../../packages/shared/src/types.js";

export { MAX_OUTPUT_BYTES };

export class SandboxProcessError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    message: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    stdout: string,
    stderr: string,
  ) {
    super(message);
    this.name = "SandboxProcessError";
    this.exitCode = exitCode;
    this.signal = signal;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}
