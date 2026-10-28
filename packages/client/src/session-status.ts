import type { SessionActivity, SessionRecord } from "../../shared/src/types";

/** How strongly a status reads; each app maps these onto its own colors. */
export type SessionStatusTone = "running" | "warning" | "danger" | "success" | "neutral" | "info";

export interface SessionStatus {
  tone: SessionStatusTone;
  /** Absent for a ready session whose host does not report what its agent is doing. */
  label?: string;
  /** Drawn instead of the status dot: `clock` for a session that waits for its next scheduled prompt. */
  icon?: "clock";
}

const activityStatus: Record<SessionActivity, Required<Omit<SessionStatus, "icon">>> = {
  working: { tone: "running", label: "In progress" },
  waiting: { tone: "warning", label: "Needs approval" },
  failed: { tone: "danger", label: "Failed" },
  done: { tone: "success", label: "Done" },
  idle: { tone: "neutral", label: "Idle" },
};

/**
 * What session lists show beside a session: its lifecycle while it starts, fails to start or is archived, otherwise what
 * its agent is doing, or that it is scheduled when it rests until a scheduled prompt wakes it. `activity` defaults to
 * the one its host last reported; an open session passes its live view's.
 */
export function sessionStatus(session: Pick<SessionRecord, "status" | "activity" | "nextScheduledAt">, activity = session.activity): SessionStatus {
  if (session.status === "archived") return { tone: "neutral", label: "Archived" };
  if (session.status === "provisioning") return { tone: "running", label: "Starting" };
  if (session.status === "error") return { tone: "danger", label: "Not started" };
  // At rest until a scheduled prompt wakes it: while it works, waits for an approval or failed, that says more.
  if (session.nextScheduledAt && activity !== "working" && activity !== "waiting" && activity !== "failed") {
    return { tone: "info", label: "Scheduled", icon: "clock" };
  }
  // Connectors that predate activity reports leave the agent's activity unknown; a live view's comes from its host as is.
  return activity && Object.hasOwn(activityStatus, activity) ? activityStatus[activity] : { tone: "success" };
}
