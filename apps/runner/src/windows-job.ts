import { createRequire } from "node:module";
import { join } from "node:path";
import type { WindowsJobLimits } from "./sandbox-backend.js";

/**
 * Windows job objects for sandboxed steps: what cgroups are on Linux. Every process a step starts, its container
 * included, inherits the job, which caps their memory together, how many there may be, and their share of the CPU,
 * and kills them all when the runner closes it. MXC puts the container in a kill-on-close job of its own, inside
 * this one (jobs nest since Windows 8).
 *
 * The Win32 calls go through koffi, which MXC's SDK already depends on, loaded from where the SDK is installed.
 */
const JobObjectExtendedLimitInformation = 9;
const JobObjectCpuRateControlInformation = 15;
const JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x0008;
const JOB_OBJECT_LIMIT_JOB_MEMORY = 0x0200;
const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x0400;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x1;
const JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP = 0x4;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Koffi = any;
interface Kernel32 {
  CreateJobObjectW(attributes: null, name: null): unknown;
  SetExtendedLimits(job: unknown, kind: number, info: object, size: number): boolean;
  SetCpuRate(job: unknown, kind: number, info: object, size: number): boolean;
  OpenProcess(access: number, inherit: boolean, pid: number): unknown;
  AssignProcessToJobObject(job: unknown, process: unknown): boolean;
  TerminateJobObject(job: unknown, code: number): boolean;
  CloseHandle(handle: unknown): boolean;
  GetLastError(): number;
  extendedSize: number;
  cpuSize: number;
}

let kernel32: Kernel32 | undefined;
function load(runtime: string): Kernel32 {
  if (kernel32) return kernel32;
  if (process.platform !== "win32") throw new Error("Job objects exist only on Windows");
  const require = createRequire(join(runtime, "node_modules", "@microsoft", "mxc-sdk", "package.json"));
  const koffi = require("koffi") as Koffi;
  const library = koffi.load("kernel32.dll");
  const IO_COUNTERS = koffi.struct("PISTEAD_IO_COUNTERS", {
    ReadOperationCount: "uint64", WriteOperationCount: "uint64", OtherOperationCount: "uint64",
    ReadTransferCount: "uint64", WriteTransferCount: "uint64", OtherTransferCount: "uint64",
  });
  const BASIC = koffi.struct("PISTEAD_JOBOBJECT_BASIC_LIMIT_INFORMATION", {
    PerProcessUserTimeLimit: "int64", PerJobUserTimeLimit: "int64", LimitFlags: "uint32",
    MinimumWorkingSetSize: "size_t", MaximumWorkingSetSize: "size_t", ActiveProcessLimit: "uint32",
    Affinity: "uintptr_t", PriorityClass: "uint32", SchedulingClass: "uint32",
  });
  const EXTENDED = koffi.struct("PISTEAD_JOBOBJECT_EXTENDED_LIMIT_INFORMATION", {
    BasicLimitInformation: BASIC, IoInfo: IO_COUNTERS, ProcessMemoryLimit: "size_t", JobMemoryLimit: "size_t",
    PeakProcessMemoryUsed: "size_t", PeakJobMemoryUsed: "size_t",
  });
  // ControlFlags, then a union whose CpuRate member is a DWORD.
  const CPU = koffi.struct("PISTEAD_JOBOBJECT_CPU_RATE_CONTROL_INFORMATION", { ControlFlags: "uint32", CpuRate: "uint32" });
  kernel32 = {
    CreateJobObjectW: library.func("void * __stdcall CreateJobObjectW(void *attributes, void *name)"),
    SetExtendedLimits: library.func("SetInformationJobObject", "bool", ["void *", "int", koffi.pointer(EXTENDED), "uint32"]),
    SetCpuRate: library.func("SetInformationJobObject", "bool", ["void *", "int", koffi.pointer(CPU), "uint32"]),
    OpenProcess: library.func("void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)"),
    AssignProcessToJobObject: library.func("bool __stdcall AssignProcessToJobObject(void *job, void *process)"),
    TerminateJobObject: library.func("bool __stdcall TerminateJobObject(void *job, uint32 code)"),
    CloseHandle: library.func("bool __stdcall CloseHandle(void *handle)"),
    GetLastError: library.func("uint32 __stdcall GetLastError()"),
    extendedSize: koffi.sizeof(EXTENDED),
    cpuSize: koffi.sizeof(CPU),
  };
  return kernel32;
}

/** One job, holding one sandboxed step's processes. */
export class WindowsJob {
  readonly #api: Kernel32;
  #handle: unknown;

  private constructor(api: Kernel32, handle: unknown) {
    this.#api = api;
    this.#handle = handle;
  }

  static create(runtime: string, limits: Readonly<WindowsJobLimits>): WindowsJob {
    const api = load(runtime);
    const handle = api.CreateJobObjectW(null, null);
    if (!handle) throw new Error(`CreateJobObject failed (${api.GetLastError()})`);
    const job = new WindowsJob(api, handle);
    try {
      const extended = {
        BasicLimitInformation: {
          PerProcessUserTimeLimit: 0, PerJobUserTimeLimit: 0, MinimumWorkingSetSize: 0, MaximumWorkingSetSize: 0, Affinity: 0, PriorityClass: 0, SchedulingClass: 0,
          LimitFlags: JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
          ActiveProcessLimit: limits.processes,
        },
        IoInfo: { ReadOperationCount: 0, WriteOperationCount: 0, OtherOperationCount: 0, ReadTransferCount: 0, WriteTransferCount: 0, OtherTransferCount: 0 },
        ProcessMemoryLimit: 0, JobMemoryLimit: limits.memoryBytes, PeakProcessMemoryUsed: 0, PeakJobMemoryUsed: 0,
      };
      if (!api.SetExtendedLimits(handle, JobObjectExtendedLimitInformation, extended, api.extendedSize)) throw new Error(`Job limits could not be set (${api.GetLastError()})`);
      // In hundredths of a percent of the whole machine.
      const cpu = { ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, CpuRate: limits.cpuPercent * 100 };
      if (!api.SetCpuRate(handle, JobObjectCpuRateControlInformation, cpu, api.cpuSize)) throw new Error(`Job CPU limit could not be set (${api.GetLastError()})`);
      return job;
    } catch (error) {
      job.close();
      throw error;
    }
  }

  /** Puts a process in the job; it and everything it starts from then on are bound by it. */
  assign(pid: number): void {
    if (!this.#handle) throw new Error("Job is closed");
    const process = this.#api.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
    if (!process) throw new Error(`The sandbox runner could not be opened (${this.#api.GetLastError()})`);
    try {
      if (!this.#api.AssignProcessToJobObject(this.#handle, process)) throw new Error(`The sandbox runner could not be put in its job (${this.#api.GetLastError()})`);
    } finally { this.#api.CloseHandle(process); }
  }

  /** Ends every process in the job, then releases it. */
  close(): void {
    const handle = this.#handle;
    if (!handle) return;
    this.#handle = undefined;
    this.#api.TerminateJobObject(handle, 1);
    this.#api.CloseHandle(handle);
  }
}
