import type { RepositoryPreparationView } from "../../../packages/shared/src/types";
import { api, segment } from "./api";
import { repositoryProgressText, repositoryProgressValue } from "../../../packages/client/src/repository-progress";
import { Alert, Button, Feedback, Spinner, useAction } from "./ui";

/**
 * A cache host preparing this session's repositories (its configuration keeps a repository cache): one bar per repository while it clones or
 * fetches, checks and checks out. If that failed, its reason, and for the owner a way to try again.
 */
export function RepositoryPreparationCard({ sessionId, preparation, canRestart, onRestarted }: {
  sessionId: string; preparation: RepositoryPreparationView; canRestart: boolean; onRestarted: () => void;
}) {
  const action = useAction();
  if (preparation.status === "failed") {
    const restart = () => void action.run(async () => {
      await api(`/api/sessions/${segment(sessionId)}/restart`, { method: "POST" });
      onRestarted();
    });
    return <Alert variant="error" title="Repositories could not be prepared"
      actions={canRestart ? <Button variant="outline" size="sm" disabled={action.busy} onClick={restart}>{action.busy ? "Restarting..." : "Restart session"}</Button> : undefined}>
      <span className="stack">
        <span>{preparation.error ?? "The host could not prepare this session's repositories."}</span>
        <span className="muted small">{canRestart
          ? "Fix the cause on the host, then restart the session. Queued messages run once the repositories are ready."
          : "The session owner can restart the session once the cause is fixed."}</span>
        <Feedback error={action.error} />
      </span>
    </Alert>;
  }
  return <section className="repository-preparation card" aria-label="Preparing repositories">
    <div className="repository-preparation-head"><Spinner />Preparing repositories</div>
    <ul className="repository-preparation-items">
      {preparation.items.map(item => {
        const value = repositoryProgressValue(item);
        const text = repositoryProgressText(item);
        return <li key={item.path}>
          <div className="repository-preparation-row"><code>{item.path}</code><span className="muted small">{text}</span></div>
          {/* Without a value the bar is indeterminate: Git reports no percentage in this phase. */}
          <progress className="repository-progress" max={100} value={value} aria-label={`${item.path}: ${text}`} />
        </li>;
      })}
    </ul>
    <p className="muted small">The first session on a host clones each repository with its full history; later sessions fetch only what changed. Messages sent now run when this is done.</p>
  </section>;
}
