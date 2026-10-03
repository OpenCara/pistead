import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SessionRecord } from "../../../packages/shared/src/types";
import { api, errorMessage, segment } from "./api";
import { Feedback, ResourceState, Timestamp, useResource } from "./ui";

export type Backup = { id: string; sessionId: string; size: number; sha256: string; createdAt: string };
type Attempt = { requestId: string; title?: string; targetSessionId?: string };
type RestoreResponse = {
  session: SessionRecord;
  restore: { id: string; status: "completed"; sourceSessionId: string; backupId: string; targetSessionId: string };
};
type Props = { sourceId: string; ownerId: string; latestBackup: Backup | null; openSession?: (id: string) => void };

// Keep uncertain mutations stable across selection changes and component remounts.
const attempts = new Map<string, Attempt>();

function restoreKey(ownerId: string, sourceId: string, backupId: string) {
  return `session-backup-restore:${JSON.stringify([ownerId, sourceId, backupId])}`;
}

function getAttempt(key: string): Attempt | undefined {
  const cached = attempts.get(key);
  if (cached) return cached;
  const stored = sessionStorage.getItem(key);
  if (!stored) return undefined;
  const parsed: unknown = JSON.parse(stored);
  if (!parsed || typeof parsed !== "object" || !("requestId" in parsed) || typeof parsed.requestId !== "string"
    || ("title" in parsed && typeof parsed.title !== "string")
    || ("targetSessionId" in parsed && typeof parsed.targetSessionId !== "string")) {
    throw new Error("The saved restore request could not be read. Restore is paused to avoid creating a duplicate session.");
  }
  const attempt = parsed as Attempt;
  attempts.set(key, attempt);
  return attempt;
}

export function BackupRestore({ sourceId, ownerId, latestBackup, openSession }: Props) {
  const base = `/api/sessions/${segment(sourceId)}`;
  const backups = useResource<{ backups: Backup[] }>(`${base}/backups`);
  const [selectedId, setSelectedId] = useState("");
  const [title, setTitle] = useState("");
  const [attempt, setAttempt] = useState<Attempt | undefined>();
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const selected = backups.data?.backups.find(backup => backup.id === selectedId);

  useEffect(() => {
    if (latestBackup) backups.refresh();
  }, [latestBackup, backups.refresh]);

  function chooseBackup(id: string) {
    setSelectedId(id);
    setError("");
    setStorageError("");
    setAttempt(undefined);
    setTitle("");
    if (!id) return;
    try {
      const saved = getAttempt(restoreKey(ownerId, sourceId, id));
      setAttempt(saved);
      setTitle(saved?.title ?? "");
    } catch (reason) {
      setStorageError(`Cannot safely resume restore: ${errorMessage(reason)}`);
    }
  }

  async function restore(event: FormEvent) {
    event.preventDefault();
    if (!selected || !openSession || inFlight.current || storageError) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const key = restoreKey(ownerId, sourceId, selected.id);
      let request = getAttempt(key);
      if (!request) {
        const newTitle = title.trim();
        if (newTitle.length > 200 || newTitle.includes("\0")) {
          throw new Error("Use a title of at most 200 characters with no NUL characters, or leave it blank.");
        }
        request = { requestId: crypto.randomUUID(), ...(newTitle ? { title: newTitle } : {}) };
        // Persist before sending: reloads and network errors must not mint another target.
        sessionStorage.setItem(key, JSON.stringify(request));
        attempts.set(key, request);
      }
      setAttempt(request);
      if (request.targetSessionId) {
        openSession(request.targetSessionId);
        return;
      }
      const result = await api<RestoreResponse>(`${base}/backups/${segment(selected.id)}/restore`, {
        method: "POST", body: { requestId: request.requestId, ...(request.title ? { title: request.title } : {}) },
      });
      if (!result.session?.id || result.session.id === sourceId || result.restore?.status !== "completed"
        || result.restore.sourceSessionId !== sourceId || result.restore.backupId !== selected.id
        || result.restore.targetSessionId !== result.session.id) {
        throw new Error("The server did not confirm a completed restore into a new session. Retry this same request to resolve its outcome.");
      }
      const completed = { ...request, targetSessionId: result.session.id };
      attempts.set(key, completed);
      setAttempt(completed);
      // The persisted request ID is already sufficient to recover a completed restore.
      try { sessionStorage.setItem(key, JSON.stringify(completed)); } catch { /* Keep the original retry identity. */ }
      openSession(result.session.id);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return <>
    <div className="section-heading">
      <h3>Restore to a new session</h3>
      <button type="button" className="button secondary small" disabled={backups.loading || pending} onClick={backups.refresh}>Refresh backups</button>
    </div>
    <p className="metadata">Restore creates a new private session and never overwrites this one. It doesn't replay approvals or run operations, and needs the original host to be available. Listing and downloading work while offline.</p>
    {!openSession && <p className="notice">Restore isn't available in this view. You can still download backups.</p>}
    <ResourceState {...backups} retry={backups.refresh}>
      {backups.data && (backups.data.backups.length ? <form onSubmit={restore}>
        <fieldset disabled={pending}>
          <label className="field">Source backup
            <select value={selectedId} onChange={event => chooseBackup(event.target.value)} required>
              <option value="">Choose a backup</option>
              {backups.data.backups.map(backup => <option key={backup.id} value={backup.id}>{backup.createdAt} - {backup.id} - {backup.size} bytes</option>)}
            </select>
          </label>
          {selected && <>
            <p className="metadata">Created <Timestamp value={selected.createdAt} />; {selected.size} bytes; SHA-256 <code>{selected.sha256}</code></p>
            <a className="button secondary" href={`${base}/backups/${segment(selected.id)}/download`}>Download backup</a>
            <label className="field">New session title (optional)
              <input autoComplete="off" maxLength={200} value={title} disabled={Boolean(attempt) || Boolean(storageError)} onChange={event => setTitle(event.target.value)} />
            </label>
            {attempt && <p className="metadata">Restore request <code>{attempt.requestId}</code>. Retrying reuses this request ID and title, so it resolves the same new session instead of creating another.</p>}
            <button className="button primary" disabled={!openSession || Boolean(storageError)}>
              {pending ? "Restoring..." : attempt?.targetSessionId ? "Open restored session" : attempt ? "Retry same restore" : "Restore into new private session"}
            </button>
          </>}
        </fieldset>
      </form> : <p>No backups yet.</p>)}
    </ResourceState>
    <Feedback error={storageError || error} />
    {error && attempt && !attempt.targetSessionId && <p className="notice">The outcome is not confirmed. Retry the same restore; an error doesn't mean no session was created.</p>}
    {attempt?.targetSessionId && <p role="status">Restored session: <code>{attempt.targetSessionId}</code>. It is private; only its owner can change visibility.</p>}
    {pending && <p role="status">Waiting for the server to confirm the new session...</p>}
  </>;
}
