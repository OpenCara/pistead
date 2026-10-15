import { useState, type FormEvent } from "react";
import type { Workspace, WorkspaceDatabase, WorkspaceDatabaseTls } from "../../../../packages/shared/src/types";
import { api, segment } from "../api";
import { Alert, Button, CardBody, DropdownMenu, Feedback, Field, ResourceState, Row, Section, Sheet, StatusBadge, confirmDialog, useAction, useResource, type MenuItem } from "../ui";

interface WorkspaceDatabaseResponse {
  /** The operator lets workspaces connect databases of their own. */
  available: boolean;
  /** Hosts on private networks, and unencrypted connections to them, are allowed. */
  privateHosts: boolean;
  database: WorkspaceDatabase | null;
}

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
  const data = resource.data;
  const database = data?.database ?? null;
  async function disconnect() {
    if (!database || action.busy) return;
    const confirmed = await confirmDialog({
      title: "Disconnect database",
      message: `Disconnect ${databaseLabel(database)}? New session backups go to the server's backup storage again. Backups already saved in that database stay there, but can't be downloaded or restored until it is connected again.`,
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (!confirmed) return;
    void action.run(async () => {
      await api(path, { method: "DELETE" });
      resource.refresh();
    }, "Database disconnected. New session backups go to the server's backup storage.");
  }
  const items: MenuItem[] = [
    ...(data?.available ? [{ label: "Replace", icon: "refresh" as const, disabled: action.busy, onSelect: () => setEditing(true) }] : []),
    { label: "Disconnect", icon: "trash", destructive: true, disabled: action.busy, onSelect: () => void disconnect() },
  ];
  const empty = !data?.available ? "This server doesn't connect to workspace databases, so session backups are kept in its backup storage"
    : owner ? "No database connected. Session backups are kept in the server's backup storage"
    : "Session backups are kept in the server's backup storage. Only the workspace owner can connect a database";
  return <Section title="Session database" info={<div className="stack">
    <p>The workspace owner can connect a Postgres database of their own. Backups of this workspace's sessions are then saved there, with each session's details, instead of in the server's backup storage, and downloads and restores read them back from it.</p>
    <p>Whoever can read that database can read the sessions saved there, private ones and their owners' personal environment values included. Other members confirm the database before each of their backups goes there, and again after it is pointed at another database.</p>
    <p>Pistead creates the tables <code>pistead_workspaces</code>, <code>pistead_sessions</code> and <code>pistead_session_backups</code> when they are missing. The password is write-only: it is never shown again after saving.</p>
  </div>} action={owner && data?.available && !database && <Button variant="outline" size="sm" icon="plus" onClick={() => setEditing(true)}>Connect database</Button>}>
    <ResourceState {...resource} retry={resource.refresh}>
      {database
        ? <Row title={databaseLabel(database)} hint={<>User <code>{database.user}</code> · {tlsLabel[database.tls]}{database.customCa ? " with a custom CA" : ""}</>} trailing={<>
          <StatusBadge tone={data?.available ? "success" : "warning"}>{data?.available ? "Connected" : "Unavailable"}</StatusBadge>
          {owner && <DropdownMenu label="Actions for the session database" items={items} />}
        </>} />
        : <CardBody><span className="muted">{empty}</span></CardBody>}
      {database && data && !data.available && <CardBody><Alert variant="warning" title="Workspace databases are turned off">
        This server no longer connects to workspace databases, so backups of this workspace's sessions can't be created, downloaded or restored. {owner ? "Disconnect the database to use the server's backup storage again." : "The workspace owner can disconnect it to use the server's backup storage again."}
      </Alert></CardBody>}
      {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
    </ResourceState>
    {owner && editing && data?.available && <DatabaseSheet path={path} privateHosts={data.privateHosts} existing={database} close={() => setEditing(false)} saved={resource.refresh} />}
  </Section>;
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
