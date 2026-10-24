import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BackupLocation, SessionRecord } from "../../../packages/shared/src/types";
import { api, errorMessage, segment } from "./api";
import { Button, Feedback, Field, LinkButton, Loading, Row, Timestamp, Alert } from "./ui";
import { Icon } from "./icons";

/** `unavailable`: listed, but saved in a store this server can't read now, so it can't be downloaded or restored. */
export type Backup = { id: string; sessionId: string; size: number; sha256: string; createdAt: string; location?: BackupLocation; unavailable?: boolean;
  /** Taken on the workspace's schedule rather than by its owner. */
  automatic?: boolean };

/** "Workspace database" for backups saved in the database the workspace owner connected; "Automatic" for scheduled ones. */
export function backupLocationLabel(backup: Backup): string {
  return `${backup.location === "workspace-database" ? " · Workspace database" : ""}${backup.automatic ? " · Automatic" : ""}`;
}

/**
 * The database the workspace's owner connected, where new backups of its sessions go. `confirm`: ask before each backup;
 * `consented`: you confirmed it once for all your backups in the workspace settings.
 */
export type BackupDatabase = { id: string; host: string; port: number; database: string; confirm: boolean; consented?: boolean };

/** The workspace's automatic backups and this session's part in them; `included`: its owner confirmed the database. */
export type AutomaticBackups = { minutes: number; included: boolean; attemptedAt: string | null; backupId: string | null; error: string | null; pending: boolean };

export function backupDatabaseLabel(database: BackupDatabase): string {
  return `${database.host.includes(":") ? `[${database.host}]` : database.host}:${database.port}/${database.database}`;
}

/** What `GET /api/sessions/:id/backups` returns: the session's backups, where a new one goes and whether it can be saved. */
export type BackupListing = { backups: Backup[]; destination?: BackupLocation; workspaceDatabase?: BackupDatabase; enabled?: boolean;
  automaticBackups?: AutomaticBackups };

function everyLabel(minutes: number): string {
  return minutes === 15 ? "every 15 minutes" : minutes === 60 ? "every hour" : minutes === 360 ? "every 6 hours" : minutes === 1440 ? "every day" : `every ${minutes} minutes`;
}

/** What the workspace's schedule does for this session, and how its last automatic attempt went. */
function automaticHint(automatic: AutomaticBackups): string {
  if (!automatic.included) {
    return `The workspace backs up changed sessions ${everyLabel(automatic.minutes)}, but not yours until you confirm its database under Settings → Workspaces → Session database`;
  }
  const last = automatic.error ? `The last attempt failed (${automatic.error}); it is retried within 15 minutes`
    : automatic.pending ? "Changed since the last one: it is saved once the session is idle and due" : "Up to date";
  return `Saved ${everyLabel(automatic.minutes)} when the session changed. ${last}`;
}
/** The owner's backup listing, loaded once per session screen and shared by its header menu and panel. */
export type BackupListingResource = { data: BackupListing | null; loading: boolean; error: string; refresh: () => void };

/** Why no new backup can be saved, by where it would have gone. */
export function backupsOffHint(destination: BackupLocation | undefined): string {
  return destination === "workspace-database"
    ? "This workspace keeps its backups in its own database, which this server no longer connects to. The workspace owner can disconnect it in the workspace settings"
    : "This server keeps no session backups: its operator hasn't set up backup storage (STORAGE_URL)";
}

/** Why a listed backup can't be downloaded or restored now, by where it was saved. */
export function backupUnavailableHint(backup: Backup): string {
  return backup.location === "workspace-database"
    ? "This backup was saved in the workspace's own database, which this server can't use now, so it can't be downloaded or restored"
    : "This backup was saved in the server's backup storage, which isn't set up now (STORAGE_URL), so it can't be downloaded or restored";
}
type Attempt = { requestId: string; title?: string; targetSessionId?: string };
type RestoreResponse = {
  session: SessionRecord;
  restore: { id: string; status: "completed"; sourceSessionId: string; backupId: string; targetSessionId: string };
};

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

export function backupDownloadHref(sessionId: string, backupId: string) {
  return `/api/sessions/${segment(sessionId)}/backups/${segment(backupId)}/download`;
}

/** Backup rows inside the Backups card; selecting one reveals download and restore-into-new-session. */
export function BackupList({ sourceId, ownerId, backups, latestBackup, refreshKey, openSession }: {
  sourceId: string; ownerId: string; backups: BackupListingResource; latestBackup: Backup | null; refreshKey: number; openSession: (id: string) => void;
}) {
  const base = `/api/sessions/${segment(sourceId)}`;
  const [selectedId, setSelectedId] = useState("");
  const [title, setTitle] = useState("");
  const [attempt, setAttempt] = useState<Attempt | undefined>();
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const selected = backups.data?.backups.find(backup => backup.id === selectedId);
  // A backup in a store this server can't read now can't be restored; one restored before still opens its session.
  const unreadable = Boolean(selected?.unavailable) && !attempt?.targetSessionId;

  useEffect(() => {
    if (latestBackup || refreshKey) backups.refresh();
  }, [latestBackup, refreshKey, backups.refresh]);

  function chooseBackup(id: string) {
    if (pending) return;
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
    if (!selected || inFlight.current || storageError || unreadable) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const key = restoreKey(ownerId, sourceId, selected.id);
      let request = getAttempt(key);
      if (!request) {
        const newTitle = title.trim();
        if (newTitle.length > 200 || newTitle.includes("\0")) {
          throw new Error("Use a title of at most 200 characters with no NUL characters, or leave it blank");
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

  if (backups.loading) return <Row title={<Loading>Loading backups...</Loading>} />;
  if (backups.error) return <Row title="Unable to load backups" hint={backups.error} trailing={<Button variant="outline" size="sm" onClick={backups.refresh}>Try again</Button>} />;
  const list = backups.data?.backups ?? [];
  const enabled = backups.data?.enabled !== false;
  // Shown before the next backup: whoever can read the workspace owner's database can read what is saved there.
  const target = backups.data?.workspaceDatabase;
  const destination = !enabled ? <Row leading={<Icon name="info" size={16} />} title="Backups are off" hint={backupsOffHint(backups.data?.destination)} />
    : target && <Row
    leading={<Icon name="server" size={16} />}
    title="Saved to the workspace database"
    hint={target.confirm
      ? `New backups of this session go to ${backupDatabaseLabel(target)}, which the workspace owner connected. Whoever can read it can read them, including your personal environment values; you confirm before each backup`
      : target.consented
        ? `New backups of this session go to ${backupDatabaseLabel(target)}, which the workspace owner connected and you confirmed. Whoever can read it can read them, including your personal environment values`
        : `New backups of this session go to ${backupDatabaseLabel(target)}, the database you connected for this workspace`}
  />;
  const automatic = enabled && backups.data?.automaticBackups;
  const schedule = automatic && <Row leading={<Icon name={automatic.error ? "info" : "refresh"} size={16} />} title="Automatic backups" hint={automaticHint(automatic)} />;
  if (!list.length) return <>{destination}{schedule}{enabled && <Row title="No backups yet" hint="Listing and downloading work while the host is offline" />}</>;
  return <>
    {destination}
    {schedule}
    {list.map(backup => <div key={backup.id} className="backup-item">
      <Row
        leading={<Icon name="archive" size={16} />}
        title={<Timestamp value={backup.createdAt} />}
        hint={`${backup.size} bytes${backupLocationLabel(backup)}${backup.unavailable ? " · Unavailable" : ""}`}
        trailing={<Icon name={backup.id === selectedId ? "chevron-down" : "chevron-right"} size={16} />}
        onClick={() => chooseBackup(backup.id === selectedId ? "" : backup.id)}
      />
      {selected?.id === backup.id && <form className="backup-detail" onSubmit={restore}>
        <fieldset disabled={pending} className="stack">
          <p className="muted small">ID <code>{selected.id}</code>; SHA-256 <code>{selected.sha256}</code></p>
          {selected.unavailable
            ? <p className="small">{backupUnavailableHint(selected)}</p>
            : <div className="inline"><LinkButton variant="outline" size="sm" icon="external" href={backupDownloadHref(sourceId, selected.id)}>Download backup</LinkButton></div>}
          <Field label="New session title" hint="Optional. Restore creates a new private session and never overwrites this one">
            <input className="input" autoComplete="off" maxLength={200} value={title} disabled={Boolean(attempt) || Boolean(storageError) || unreadable} onChange={event => setTitle(event.target.value)} />
          </Field>
          {attempt && <p className="muted small">Restore request <code>{attempt.requestId}</code>. Retrying reuses this request ID and title, so it resolves the same new session instead of creating another.</p>}
          <div className="inline">
            <Button type="submit" variant="secondary" size="sm" disabled={Boolean(storageError) || unreadable}>
              {pending ? "Restoring..." : attempt?.targetSessionId ? "Open restored session" : attempt ? "Retry same restore" : "Restore into new private session"}
            </Button>
            {pending && <Loading>Waiting for the server to confirm the new session...</Loading>}
          </div>
          <Feedback error={storageError || error} />
          {error && attempt && !attempt.targetSessionId && <Alert variant="warning" title="Outcome not confirmed">Retry the same restore; an error doesn't mean no session was created.</Alert>}
          {attempt?.targetSessionId && <p className="muted small" role="status">Restored session: <code>{attempt.targetSessionId}</code>. It is private; only its owner can change visibility.</p>}
        </fieldset>
      </form>}
    </div>)}
  </>;
}
