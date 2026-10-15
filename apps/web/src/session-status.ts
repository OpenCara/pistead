import type { SessionActivity, SessionRecord } from "../../../packages/shared/src/types";
import type { Tone } from "./ui";

export interface SessionStatus {
  tone: Tone;
  /** Absent for a ready session whose host does not report what its agent is doing. */
  label?: string;
}

const activityStatus: Record<SessionActivity, Required<SessionStatus>> = {
  working: { tone: "running", label: "In progress" },
  waiting: { tone: "warning", label: "Needs approval" },
  failed: { tone: "danger", label: "Failed" },
  done: { tone: "success", label: "Done" },
  idle: { tone: "neutral", label: "Idle" },
};

/**
 * What session lists show beside a session: its lifecycle while it starts, fails to start or is archived, otherwise what
 * its agent is doing. `activity` defaults to the one its host last reported; an open session passes its live view's.
 */
export function sessionStatus(session: Pick<SessionRecord, "status" | "activity">, activity = session.activity): SessionStatus {
  if (session.status === "archived") return { tone: "neutral", label: "Archived" };
  if (session.status === "provisioning") return { tone: "running", label: "Starting" };
  if (session.status === "error") return { tone: "danger", label: "Not started" };
  // Connectors that predate activity reports leave the agent's activity unknown; a live view's comes from its host as is.
  return activity && Object.hasOwn(activityStatus, activity) ? activityStatus[activity] : { tone: "success" };
}
