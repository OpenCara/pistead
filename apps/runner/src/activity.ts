import type { ApprovalRecord, SessionActivity } from "../../../packages/shared/src/types.js";

/** The parts of a queued message that say what its session is doing. */
export interface ActivityRun {
  mode: "write" | "ask";
  status: "queued" | "admitting" | "running" | "settled" | "interrupted";
  sequence?: number;
  startEntry: number;
  failure?: unknown;
  /** Someone stopped it; `pending` while its host still ends its work. */
  stopped?: { pending?: boolean };
}

/** The last entry of the shared conversation: its transcript id, and whether its model request failed. */
export interface ActivityEntry {
  id: number;
  failed: boolean;
}

const activeRuns: readonly ActivityRun["status"][] = ["queued", "admitting", "running"];

/** The shared message sent last. Side asks run on branches of their own and leave the session's work as it was. */
export function latestSharedRun<T extends ActivityRun>(runs: Iterable<T>): T | undefined {
  let latest: T | undefined;
  // Runs from before sequence numbers keep their submission order, so the later of two equal ones wins.
  for (const run of runs) if (run.mode === "write" && (!latest || (run.sequence ?? 0) >= (latest.sequence ?? 0))) latest = run;
  return latest;
}

/**
 * What a session's agent is doing (see SessionActivity), from its queue, its approvals and, once the latest shared
 * message has settled, the last entry of the shared conversation.
 */
export function sessionActivity(runs: readonly ActivityRun[], approvals: readonly Pick<ApprovalRecord, "status" | "operation">[], last?: ActivityEntry): SessionActivity {
  // A stop still ending its work makes the cards of its calls moot: they are interrupted with it.
  if (runs.some(run => run.stopped?.pending)) return "working";
  // A tool call waiting on a card holds its message: the work needs a person rather than more time. A card requested
  // outside a message waits for a decision too.
  if (approvals.some(approval => approval.status === "pending")) return "waiting";
  if (runs.some(run => activeRuns.includes(run.status)) || approvals.some(approval => approval.status === "executing")) return "working";
  const latest = latestSharedRun(runs);
  // A stopped message did not fail: the session waits for the next one.
  if (!latest || latest.stopped) return "idle";
  if (latest.failure !== undefined || latest.status === "interrupted") return "failed";
  // Only an entry the message wrote itself can say that its model request failed.
  return last !== undefined && last.id > latest.startEntry && last.failed ? "failed" : "done";
}

export interface ActivityTiming {
  /** How long a burst of changes may take to settle into one report. */
  settleMs: number;
  /** The first retry of a failed report; later ones double up to `maxRetryMs`. */
  firstRetryMs: number;
  maxRetryMs: number;
}

export const activityTiming: ActivityTiming = { settleMs: 300, firstRetryMs: 2_000, maxRetryMs: 60_000 };

/**
 * Tells the control plane what a session's agent is doing while the session is open. It sends only changes, one report
 * at a time and always the activity as it is when sent, so a burst of changes becomes one report and an older activity
 * never lands after a newer one. A failed report is retried, with the then-current activity, until the session closes.
 */
export class ActivityReporter {
  readonly #read: () => Promise<SessionActivity>;
  readonly #send: (activity: SessionActivity) => Promise<void>;
  readonly #timing: ActivityTiming;
  #sent: SessionActivity | undefined;
  #dirty = false;
  #sending = false;
  #open = false;
  #failures = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(read: () => Promise<SessionActivity>, send: (activity: SessionActivity) => Promise<void>, timing: ActivityTiming = activityTiming) {
    this.#read = read;
    this.#send = send;
    this.#timing = timing;
  }

  /** The session opened: report its activity unless it was the last one reported, then every change until `stop`. */
  start(): void {
    this.#open = true;
    this.changed();
  }

  /** Something the activity depends on changed. */
  changed(): void {
    if (!this.#open) return;
    this.#dirty = true;
    this.#schedule(this.#timing.settleMs);
  }

  /** The session is closing: report nothing more until it opens again. A report already on its way still lands. */
  stop(): void {
    this.#open = false;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(delay: number): void {
    if (this.#timer !== undefined || this.#sending) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#flush();
    }, delay);
    this.#timer.unref();
  }

  async #flush(): Promise<void> {
    if (this.#sending || !this.#open) return;
    this.#sending = true;
    let failed = false;
    try {
      while (this.#dirty && this.#open) {
        this.#dirty = false;
        const activity = await this.#read();
        if (activity === this.#sent || !this.#open) continue;
        await this.#send(activity);
        this.#sent = activity;
        this.#failures = 0;
      }
    } catch {
      // Retry with whatever the activity is by then; the session's own view shows it meanwhile.
      this.#dirty = true;
      failed = true;
    } finally {
      this.#sending = false;
    }
    if (!this.#open || !this.#dirty) return;
    this.#schedule(failed ? Math.min(this.#timing.maxRetryMs, this.#timing.firstRetryMs * 2 ** this.#failures++) : this.#timing.settleMs);
  }
}
