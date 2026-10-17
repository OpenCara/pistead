import type { RepositoryPreparationItem, RepositoryPreparationPhase, SessionView } from "../../shared/src/types";

/** Plain words for each phase; the host sends only these structured values, never Git's or a remote's text. */
const labels: Record<RepositoryPreparationPhase, string> = {
  queued: "Waiting its turn",
  authorizing: "Checking access",
  waiting: "Waiting for another session's fetch",
  connecting: "Connecting to the Git host",
  enumerating: "Enumerating objects",
  counting: "Counting objects",
  compressing: "Compressing objects",
  receiving: "Receiving objects",
  resolving: "Resolving deltas",
  verifying: "Verifying history",
  checking: "Checking files",
  "checking-out": "Checking out",
  done: "Ready",
};

export function repositoryPhaseLabel(phase: string): string {
  return Object.hasOwn(labels, phase) ? labels[phase as RepositoryPreparationPhase] : "Preparing";
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Binary units, as Git prints them. */
export function formatBytes(bytes: number): string {
  if (!count(bytes)) return "";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit && value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A determinate bar's value (0 to 100), or undefined while Git reports no percentage. */
export function repositoryProgressValue(item: RepositoryPreparationItem): number | undefined {
  if (item.phase === "done") return 100;
  return typeof item.percent === "number" && Number.isFinite(item.percent) ? Math.min(100, Math.max(0, Math.round(item.percent))) : undefined;
}

/** One line under a repository's bar, e.g. "Receiving objects · 45% · 4,500 of 10,000 · 12.3 MiB". */
export function repositoryProgressText(item: RepositoryPreparationItem): string {
  const parts = [repositoryPhaseLabel(item.phase)];
  const value = repositoryProgressValue(item);
  if (value !== undefined && item.phase !== "done") parts.push(`${value}%`);
  if (count(item.done) && count(item.total) && item.total > 0) parts.push(`${item.done.toLocaleString("en-US")} of ${item.total.toLocaleString("en-US")}`);
  else if (count(item.done) && item.done > 0) parts.push(item.done.toLocaleString("en-US"));
  if (count(item.bytes) && item.bytes > 0) parts.push(formatBytes(item.bytes));
  return parts.join(" · ");
}

/** Whether the host is still preparing this session's repositories (from its cache). */
export function preparingRepositories(view: Pick<SessionView, "repositories"> | null | undefined): boolean {
  return view?.repositories?.status === "preparing";
}
