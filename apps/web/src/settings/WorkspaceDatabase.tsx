import { useState, type FormEvent } from "react";
import type { Workspace, WorkspaceDatabase, WorkspaceDatabaseTls } from "../../../../packages/shared/src/types";
import { api, segment } from "../api";
import { Alert, Button, CardBody, DropdownMenu, Feedback, Field, ResourceState, Row, Section, Sheet, StatusBadge, Timestamp, confirmDialog, useAction, useResource, type MenuItem } from "../ui";

interface WorkspaceDatabaseResponse {
  /** The operator lets workspaces connect databases of their own. */
  available: boolean;
  /** Hosts on private networks, and unencrypted connections to them, are allowed. */
  privateHosts: boolean;
  /** The server has backup storage of its own (STORAGE_URL) for workspaces without a database. */
  backupStorage: boolean;
  database: WorkspaceDatabase | null;
}

/** Where backups go without a workspace database, as the end of a sentence. */
function withoutDatabase(backupStorage: boolean): string {
  return backupStorage ? "session backups are kept in the server's backup storage"
    : "this server keeps no session backups, as it has no backup storage of its own (STORAGE_URL)";
}

/** What the server reports after importing a dump into the workspace database. */
interface ImportSummary {
  format: "session" | "workspace";
  exportedAt: string;
  sessions: number;
  sessionDetails: number;
  auditEntries: number;
  workspaceSettings: boolean;
}

/** The largest dump the server takes from the web app; the operator imports larger ones with --import-dump. */
const maxUploadBytes = 32 * 1024 * 1024;

const tlsLabel: Record<WorkspaceDatabaseTls, string> = {
  "verify-full": "TLS, server certificate verified",
  require: "TLS, server certificate not verified",
  disable: "Unencrypted",
};

function databaseLabel(database: WorkspaceDatabase): string {
  return `${database.host.includes(":") ? `[${database.host}]` : database.host}:${database.port}/${database.database}`;
}

/** Splits a postgres:// connection URL into the form's fields; the server only ever receives the fields. */
function connectionUrl(value: string): { host: string; port: string; database: string; user: string; password: string; unencrypted: boolean } {
  const text = value.trim();
  const scheme = /^postgres(?:ql)?:\/\//i.exec(text);
  if (!scheme) throw new Error("Use a postgres:// or postgresql:// URL.");
  // Read as http: so every browser parses the authority of the otherwise opaque postgres: scheme (port 80 reads as default).
  const url = new URL(`http://${text.slice(scheme[0].length)}`);
  if (!url.hostname) throw new Error("The URL has no host.");
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"), port: url.port || "5432", database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), unencrypted: url.searchParams.get("sslmode") === "disable",
  };
}

/** The Postgres database a workspace owner connects, so that backups of the workspace's sessions are saved there. */
export function WorkspaceDatabaseSection({ workspace, owner }: { workspace: Workspace; owner: boolean }) {
  const path = `/api/workspaces/${segment(workspace.id)}/database`;
  const resource = useResource<WorkspaceDatabaseResponse>(path);
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [importing, setImporting] = useState(false);
  const data = resource.data;
  const database = data?.database ?? null;
  async function disconnect() {
    if (!database || action.busy) return;
    const confirmed = await confirmDialog({
      title: "Disconnect database",
      message: `Disconnect ${databaseLabel(database)}? ${data?.backupStorage ? "New session backups go to the server's backup storage again." : "This server has no backup storage of its own, so no new session backups can be saved."} Backups already saved in that database stay there, but can't be downloaded or restored until it is connected again.`,
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (!confirmed) return;
    void action.run(async () => {
      await api(path, { method: "DELETE" });
      resource.refresh();
    }, data?.backupStorage ? "Database disconnected. New session backups go to the server's backup storage."
      : "Database disconnected. This server keeps no session backups without one.");
  }
  const items: MenuItem[] = [
    ...(data?.available ? [
      { label: "Import dump", icon: "folder" as const, hint: "A session or workspace export", disabled: action.busy, onSelect: () => setImporting(true) },
      { label: "Replace", icon: "refresh" as const, disabled: action.busy, onSelect: () => setEditing(true) },
    ] : []),
    { label: "Disconnect", icon: "trash", destructive: true, disabled: action.busy, onSelect: () => void disconnect() },
  ];
  // Session databases are an operator setting: say who can turn them on rather than implying they can't exist here.
  const fallback = withoutDatabase(data?.backupStorage ?? false);
  const empty = !data?.available
    ? `Session databases are turned off on this server, so ${fallback}. The server's operator can turn them on with WORKSPACE_DATABASES=true`
    : owner ? `No database connected, so ${fallback}`
    : `No database connected, so ${fallback}. Only the workspace owner can connect one`;
  return <Section title="Session database" info={<div className="stack">
    <p>The workspace owner can connect a Postgres database of their own. Backups of this workspace's sessions are then saved there, with each session's details, instead of in the server's own backup storage (if it has any), and downloads and restores read them back from it.</p>
    <p>Whoever can read that database can read the sessions saved there, private ones and their owners' personal environment values included. Other members confirm the database before each of their backups goes there, and again after it is pointed at another database.</p>
    <p>The owner can also import a session or workspace export into it, adding session details and activity. Pistead creates the tables <code>pistead_workspaces</code>, <code>pistead_sessions</code>, <code>pistead_session_backups</code> and <code>pistead_audit</code> when they are missing. The password is write-only: it is never shown again after saving.</p>
  </div>} action={owner && data?.available && !database && <Button variant="outline" size="sm" icon="plus" onClick={() => setEditing(true)}>Connect database</Button>}>
    <ResourceState {...resource} retry={resource.refresh}>
      {database
        ? <Row title={databaseLabel(database)} hint={<>User <code>{database.user}</code> · {tlsLabel[database.tls]}{database.customCa ? " with a custom CA" : ""}</>} trailing={<>
          <StatusBadge tone={data?.available ? "success" : "warning"}>{data?.available ? "Connected" : "Unavailable"}</StatusBadge>
          {owner && <DropdownMenu label="Actions for the session database" items={items} />}
        </>} />
        : <CardBody><span className="muted">{empty}</span></CardBody>}
      {database && data && !data.available && <CardBody><Alert variant="warning" title="Workspace databases are turned off">
        This server no longer connects to workspace databases, so backups of this workspace's sessions can't be created, downloaded or restored. {!data.backupStorage ? "The server's operator can turn them on again with WORKSPACE_DATABASES=true."
          : owner ? "Disconnect the database to use the server's backup storage again, or ask the server's operator to turn workspace databases on again."
          : "The workspace owner can disconnect it to use the server's backup storage again."}
      </Alert></CardBody>}
      {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
    </ResourceState>
    {owner && editing && data?.available && <DatabaseSheet path={path} privateHosts={data.privateHosts} existing={database} close={() => setEditing(false)} saved={resource.refresh} />}
    {owner && importing && data?.available && database && <ImportSheet path={path} database={database} close={() => setImporting(false)} />}
  </Section>;
}

/** Imports an export of this workspace, or of one of its sessions, into the connected database. */
function ImportSheet({ path, database, close }: { path: string; database: WorkspaceDatabase; close: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [imported, setImported] = useState<ImportSummary | null>(null);
  const action = useAction();
  function dismiss() { if (!action.busy) close(); }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || action.busy) return;
    setImported(null);
    void action.run(async () => {
      if (file.size > maxUploadBytes) throw new Error("This dump is larger than 32 MiB. The server's operator can import it with the --import-dump option.");
      let document: unknown;
      try {
        document = JSON.parse(await file.text());
      } catch {
        throw new Error("This file is not a JSON dump.");
      }
      const result = await api<{ imported: ImportSummary }>(`${path}/import`, { method: "POST", body: document });
      setImported(result.imported);
    });
  }
  return <Sheet open title="Import a dump" onClose={dismiss} footer={<>
    <Button disabled={action.busy} onClick={dismiss}>{imported ? "Done" : "Cancel"}</Button>
    {!imported && <Button variant="default" type="submit" form="workspace-import-form" disabled={!file || action.busy}>{action.busy ? "Importing..." : "Import"}</Button>}
  </>}>
    <form id="workspace-import-form" className="stack" onSubmit={submit}>
      <p className="muted small">Adds an export of this workspace, or of one of its sessions, to {databaseLabel(database)}: session records and details (grants, approvals, pushes, backups and restores), their activity and the workspace's settings. A record replaces an older one of the same session; activity is added once, so importing a dump again changes nothing. Pistead itself is unchanged.</p>
      <Field label="Dump file" hint="A JSON export from Pistead, up to 32 MiB">
        <input className="input" type="file" accept="application/json,.json" disabled={action.busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setImported(null); }} />
      </Field>
      {imported && <Alert variant="success" title="Imported" role="status">
        {imported.sessions} session record{imported.sessions === 1 ? "" : "s"} ({imported.sessionDetails} with details) and {imported.auditEntries} activity entr{imported.auditEntries === 1 ? "y" : "ies"}{imported.workspaceSettings ? ", with the workspace's settings," : ""} from the {imported.format} export of <Timestamp value={imported.exportedAt} />.
      </Alert>}
      <Feedback error={action.error} />
    </form>
  </Sheet>;
}

function DatabaseSheet({ path, privateHosts, existing, close, saved }: { path: string; privateHosts: boolean; existing: WorkspaceDatabase | null; close: () => void; saved: () => void }) {
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState("");
  const [host, setHost] = useState(existing?.host ?? "");
  const [port, setPort] = useState(String(existing?.port ?? 5432));
  const [database, setDatabase] = useState(existing?.database ?? "");
  const [user, setUser] = useState(existing?.user ?? "");
  const [password, setPassword] = useState("");
  const [tls, setTls] = useState<WorkspaceDatabaseTls>(existing && (existing.tls !== "disable" || privateHosts) ? existing.tls : "verify-full");
  const [ca, setCa] = useState("");
  const action = useAction();
  const portNumber = Number(port);
  const ready = Boolean(host.trim() && database.trim() && user.trim() && password) && Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  function dismiss() { if (!action.busy) close(); }
  function fill() {
    try {
      const parsed = connectionUrl(url);
      setHost(parsed.host);
      setPort(parsed.port);
      if (parsed.database) setDatabase(parsed.database);
      if (parsed.user) setUser(parsed.user);
      if (parsed.password) setPassword(parsed.password);
      if (parsed.unencrypted && privateHosts) setTls("disable");
      setUrl("");
      setUrlError("");
    } catch (reason) {
      setUrlError(reason instanceof Error ? reason.message : "The connection URL could not be read.");
    }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!ready || action.busy) return;
    const body = { host: host.trim(), port: portNumber, database: database.trim(), user: user.trim(), password, tls,
      ...(tls === "verify-full" && ca.trim() ? { caCertificate: ca.trim() } : {}) };
    void action.run(async () => {
      await api(path, { method: "PUT", body });
      setPassword("");
      saved();
      close();
    });
  }
  return <Sheet open title={existing ? "Replace session database" : "Connect session database"} onClose={dismiss} footer={<>
    <Button disabled={action.busy} onClick={dismiss}>Cancel</Button>
    <Button variant="default" type="submit" form="workspace-database-form" disabled={!ready || action.busy}>{action.busy ? "Connecting..." : "Save"}</Button>
  </>}>
    <form id="workspace-database-form" className="stack" onSubmit={save}>
      <p className="muted small">Pistead connects when you save, to check the settings and create its tables. From then on, backups of this workspace's sessions are saved in this database{existing ? "; backups saved before stay where they are" : ""}.</p>
      <Field label="Connection URL" hint="Optional. Paste a postgres:// URL and fill in the fields below from it; the URL itself isn't sent">
        <input className="input" value={url} onChange={event => setUrl(event.target.value)} autoComplete="off" spellCheck={false} placeholder="postgres://user:password@db.example.com:5432/pistead" />
      </Field>
      <div className="inline"><Button variant="outline" size="sm" disabled={!url.trim() || action.busy} onClick={fill}>Fill in from URL</Button></div>
      <Feedback error={urlError} />
      <Field label="Host" hint="Host name or IP address, without a scheme or port">
        <input className="input" required value={host} onChange={event => setHost(event.target.value)} autoComplete="off" spellCheck={false} placeholder="db.example.com" />
      </Field>
      <Field label="Port">
        <input className="input" required inputMode="numeric" value={port} onChange={event => setPort(event.target.value)} autoComplete="off" spellCheck={false} />
      </Field>
      <Field label="Database">
        <input className="input" required value={database} onChange={event => setDatabase(event.target.value)} autoComplete="off" spellCheck={false} />
      </Field>
      <Field label="User" hint="Needs to create Pistead's tables, or SELECT, INSERT and UPDATE on them if you create them yourself">
        <input className="input" required value={user} onChange={event => setUser(event.target.value)} autoComplete="off" spellCheck={false} />
      </Field>
      <Field label="Password" hint="Write-only. Needed every time the connection is saved">
        <input className="input" type="password" required value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" />
      </Field>
      <Field label="Encryption" hint={privateHosts ? undefined : "This server only connects to databases on the public internet, always encrypted"}>
        <select className="select" value={tls} onChange={event => setTls(event.target.value as WorkspaceDatabaseTls)}>
          <option value="verify-full">TLS, verify the server certificate (recommended)</option>
          <option value="require">TLS, don't verify the server certificate</option>
          {privateHosts && <option value="disable">Unencrypted, private networks only</option>}
        </select>
      </Field>
      {tls === "verify-full" && <Field label="CA certificate" hint={existing?.customCa
        ? "Paste it again to keep verifying with it: saving replaces the connection's CA certificate"
        : "Optional. PEM certificates of a private CA, such as your cloud provider's bundle. The public roots are used otherwise"}>
        <textarea className="textarea mono" value={ca} onChange={event => setCa(event.target.value)} autoComplete="off" spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" />
      </Field>}
      {tls === "require" && <Alert variant="warning" title="Certificate not verified">The connection is encrypted, but whoever can intercept it could pose as the database and read the password and the sessions saved there.</Alert>}
      {tls === "disable" && <Alert variant="warning" title="Unencrypted">The password and the sessions cross the network in the clear. Use this only on a network you trust.</Alert>}
      <Feedback error={action.error} />
    </form>
  </Sheet>;
}
