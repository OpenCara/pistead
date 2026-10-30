import { useState, type FormEvent } from "react";
import { sourceLimits, type SourceAccountList, type WorkspaceNotionSource, type WorkspaceSourceList } from "../../../packages/shared/src/sources";
import { api, segment } from "./api";
import { href } from "./router";
import { Icon } from "./icons";
import { Alert, Button, CardBody, Feedback, Field, LinkButton, ResourceState, Row, Section, Sheet, StatusBadge, confirmDialog, useAction, useResource } from "./ui";

/** The caller's connected accounts other than Git (today: Notion). */
export function useSourceAccounts(enabled = true) {
  const resource = useResource<SourceAccountList>(enabled ? "/api/source-accounts" : null);
  return { accounts: resource.data?.accounts ?? null, loading: resource.loading, error: resource.error, refresh: resource.refresh };
}

/** A workspace's sources other than its repositories (today: Notion pages and databases). */
export function useWorkspaceSources(workspaceId: string | null) {
  const resource = useResource<WorkspaceSourceList>(workspaceId ? `/api/workspaces/${segment(workspaceId)}/sources` : null);
  return { sources: resource.data?.sources ?? null, loading: resource.loading, error: resource.error, refresh: resource.refresh };
}

/** Profile section: the Notion account sessions you own read Notion sources with. */
export function ConnectedAccountsSection() {
  const { accounts, loading, error, refresh } = useSourceAccounts();
  const action = useAction();
  const [connecting, setConnecting] = useState(false);
  const notion = accounts?.find(account => account.provider === "notion") ?? null;
  async function remove() {
    if (action.busy || !notion) return;
    const confirmed = await confirmDialog({
      title: "Disconnect Notion",
      message: `Disconnect Notion (${notion.name})? Its secret is deleted from the server, and sessions you own can no longer read the workspaces' Notion sources.`,
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (!confirmed) return;
    void action.run(async () => {
      await api("/api/source-accounts/notion", { method: "DELETE" });
      refresh();
    }, "Notion disconnected.");
  }
  return <Section title="Connected accounts"
    info={<div className="stack">
      <p>Sessions you own read the workspaces' Notion sources with your own Notion connection, through Pistead: the secret is encrypted on the server and never sent to any host, yours included.</p>
      <p>Create an internal integration at notion.so/profile/integrations with Read content, and share the pages it may read with it (a page's ••• menu → Connections). Notion lets it read only those pages and the pages under them.</p>
    </div>}>
    <ResourceState loading={loading && !accounts} error={error} retry={refresh}>
      <Row leading={<Icon name="file" size={16} />} title="Notion" hint={notion ? notion.name : "Not connected"}
        trailing={notion
          ? <><StatusBadge tone="success">Connected</StatusBadge><Button variant="ghost" size="sm" disabled={action.busy} onClick={() => setConnecting(true)}>Replace</Button><Button variant="ghost" size="sm" disabled={action.busy} aria-label="Disconnect Notion" onClick={() => void remove()}>Disconnect</Button></>
          : <Button variant="outline" size="sm" disabled={action.busy} onClick={() => setConnecting(true)}>Connect</Button>} />
    </ResourceState>
    {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
    <ConnectNotionSheet open={connecting} close={() => setConnecting(false)} connected={refresh} />
  </Section>;
}

function ConnectNotionSheet({ open, close, connected }: { open: boolean; close: () => void; connected: () => void }) {
  const [token, setToken] = useState("");
  const action = useAction();
  function dismiss() {
    if (action.busy) return;
    setToken("");
    close();
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!token.trim() || action.busy) return;
    void action.run(async () => {
      try { await api("/api/source-accounts/notion", { method: "PUT", body: { token: token.trim() } }); }
      finally { setToken(""); }
      connected();
      close();
    });
  }
  return <Sheet open={open} title="Connect Notion" onClose={dismiss} footer={<>
    <Button disabled={action.busy} onClick={dismiss}>Cancel</Button>
    <Button variant="default" type="submit" form="notion-account-form" disabled={!token.trim() || action.busy}>{action.busy ? "Verifying..." : "Connect"}</Button>
  </>}>
    <form id="notion-account-form" className="stack" onSubmit={submit}>
      <Field label="Internal integration secret" hint="From notion.so/profile/integrations, with the Read content capability. Verified with Notion, then encrypted on the server">
        <input className="input" required type="password" value={token} onChange={event => setToken(event.target.value)} disabled={action.busy} autoComplete="off" spellCheck={false} placeholder="ntn_…" />
      </Field>
      <Feedback error={action.error} />
    </form>
  </Sheet>;
}

/** The Notion part of a workspace's Sources: its bound pages and databases, which owners and admins add and remove. */
export function NotionSources({ workspaceId, workspaceName, admin, sources, loading, error, refresh, changed }: {
  workspaceId: string; workspaceName: string; admin: boolean; sources: WorkspaceNotionSource[] | null; loading: boolean; error: string; refresh: () => void; changed: () => void;
}) {
  const action = useAction();
  const accounts = useSourceAccounts(admin);
  const [adding, setAdding] = useState(false);
  const connected = Boolean(accounts.accounts?.some(account => account.provider === "notion"));
  const full = (sources?.length ?? 0) >= sourceLimits.notion;
  async function remove(source: WorkspaceNotionSource) {
    if (action.busy || !admin) return;
    const confirmed = await confirmDialog({
      title: "Remove Notion source",
      message: `Remove ${source.title} from ${workspaceName}? Sessions, running ones too, can no longer read it or the pages under it.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!confirmed) return;
    void action.run(async () => {
      await api(`/api/workspaces/${segment(workspaceId)}/sources/${segment(source.id)}`, { method: "DELETE" });
      refresh(); changed();
    }, "Notion source removed.");
  }
  return <div className="stack">
    <div className="section-header"><h3 className="section-title">Notion</h3><span className="spacer" />
      {admin && connected && !full && <Button variant="outline" size="sm" icon="plus" disabled={loading || Boolean(error) || action.busy} onClick={() => setAdding(true)}>Add Notion page</Button>}
    </div>
    <div className="card">
      <ResourceState loading={loading} error={error} retry={refresh}>
        {!sources?.length
          ? <CardBody><span className="muted">No Notion pages yet. Sessions read a bound page or database, and the pages under it, with their owner's own Notion connection</span></CardBody>
          : sources.map(source => <Row key={source.id} leading={<Icon name="file" size={16} />} title={source.title}
            hint={<>{source.object === "database" ? "Database" : "Page"} · <a href={source.url} target="_blank" rel="noreferrer">Open in Notion</a></>}
            trailing={admin && <Button variant="outline" size="sm" disabled={action.busy} aria-label={`Remove ${source.title}`} onClick={() => void remove(source)}>Remove</Button>} />)}
        {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
      </ResourceState>
    </div>
    {admin && accounts.accounts && !connected && <Alert variant="info" title="Connect Notion to add pages" actions={<LinkButton variant="outline" size="sm" href={href({ name: "settings", section: "profile" })}>Open profile</LinkButton>}>Pistead checks each page you add with your own Notion connection, in Settings → Profile → Connected accounts.</Alert>}
    {admin && full && <Alert variant="info" title="Notion source limit reached">A workspace has at most {sourceLimits.notion} Notion sources. Remove one to add another.</Alert>}
    {admin && connected && <AddNotionSheet open={adding} workspaceId={workspaceId} close={() => setAdding(false)} added={() => { refresh(); changed(); }} />}
  </div>;
}

function AddNotionSheet({ open, workspaceId, close, added }: { open: boolean; workspaceId: string; close: () => void; added: () => void }) {
  const [target, setTarget] = useState("");
  const action = useAction();
  function dismiss() {
    if (action.busy) return;
    setTarget("");
    close();
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!target.trim() || action.busy) return;
    void action.run(async () => {
      await api(`/api/workspaces/${segment(workspaceId)}/sources`, { method: "POST", body: { kind: "notion", target: target.trim() } });
      setTarget("");
      added();
      close();
    });
  }
  return <Sheet open={open} title="Add Notion page" onClose={dismiss} footer={<>
    <Button disabled={action.busy} onClick={dismiss}>Cancel</Button>
    <Button variant="default" type="submit" form="notion-source-form" disabled={!target.trim() || action.busy}>{action.busy ? "Checking..." : "Add page"}</Button>
  </>}>
    <form id="notion-source-form" className="stack" onSubmit={submit}>
      <Field label="Page or database link" hint="Copy it with Share → Copy link in Notion. It must be shared with your Notion integration; each session reads it with its owner's own connection">
        <input className="input" required value={target} onChange={event => setTarget(event.target.value)} disabled={action.busy} autoComplete="off" spellCheck={false} placeholder="https://www.notion.so/…" />
      </Field>
      <Feedback error={action.error} />
    </form>
  </Sheet>;
}
