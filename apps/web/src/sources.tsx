import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  documentKindNames, documentKinds, secretKinds, sourceLimits,
  type DocumentItemType, type DocumentKind, type FeishuDomain, type SourceAccountList, type WorkspaceDocumentSource, type WorkspaceSourceList,
} from "../../../packages/shared/src/sources";
import { api, segment } from "./api";
import { href } from "./router";
import { Icon } from "./icons";
import { Alert, Button, CardBody, Combobox, Feedback, Field, LinkButton, ResourceState, Row, Section, Sheet, StatusBadge, confirmDialog, useAction, useResource } from "./ui";

/** The caller's connected accounts other than Git (Notion, Google Drive, Feishu/Lark). */
export function useSourceAccounts(enabled = true) {
  const resource = useResource<SourceAccountList>(enabled ? "/api/source-accounts" : null);
  return { accounts: resource.data?.accounts ?? null, loading: resource.loading, error: resource.error, refresh: resource.refresh };
}

/** A workspace's sources other than its repositories. */
export function useWorkspaceSources(workspaceId: string | null) {
  const resource = useResource<WorkspaceSourceList>(workspaceId ? `/api/workspaces/${segment(workspaceId)}/sources` : null);
  return { sources: resource.data?.sources ?? null, loading: resource.loading, error: resource.error, refresh: resource.refresh };
}

const setup: Record<DocumentKind, ReactNode> = {
  notion: <>Create an internal integration at notion.so/profile/integrations with Read content, and share the pages it may read with it (a page's ••• menu → Connections).</>,
  "google-drive": <>Create a service account in Google Cloud with the Drive API enabled, download its JSON key, and share the folders and files it may read with the service account's email, as Viewer.</>,
  feishu: <>Create a custom app in the Feishu or Lark developer console with read access to Drive, Docs and Wiki, publish it, and add it to the folders, documents or wiki spaces it may read.</>,
  dropbox: <>Sign in to Dropbox. Sessions read the folders and files under the workspace's Dropbox sources that your account can see.</>,
  onedrive: <>Sign in with your Microsoft account. Sessions read the OneDrive and SharePoint folders and files under the workspace's sources that you can open.</>,
  "tencent-docs": <>Sign in to Tencent Docs. Sessions read the folders and documents under the workspace's Tencent Docs sources that you can open.</>,
};

const itemLabels: Record<DocumentItemType, string> = {
  page: "Page", database: "Database", folder: "Folder", document: "Document", spreadsheet: "Spreadsheet", presentation: "Presentation", file: "File", wiki: "Wiki page",
};

/** Profile section: the accounts sessions you own read the workspaces' document sources with. */
export function ConnectedAccountsSection() {
  const resource = useResource<SourceAccountList>("/api/source-accounts");
  const { accounts, loading, error, refresh } = { accounts: resource.data?.accounts ?? null, loading: resource.loading, error: resource.error, refresh: resource.refresh };
  const signIn = resource.data?.oauth ?? [];
  const action = useAction();
  const [connecting, setConnecting] = useState<DocumentKind | null>(null);
  const [returned, setReturned] = useState<{ kind: DocumentKind; ok: boolean; reason: string } | null>(null);
  // Back from a provider's sign-in: say how it went, once, and take it out of the address.
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const kind = query.get("source_account") as DocumentKind | null;
    if (!kind || !documentKinds.includes(kind)) return;
    setReturned({ kind, ok: query.get("result") === "connected", reason: query.get("reason") ?? "" });
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
  }, []);
  const shown = documentKinds.filter(kind => secretKinds.includes(kind) || signIn.includes(kind) || accounts?.some(account => account.provider === kind));
  async function remove(provider: DocumentKind, name: string) {
    if (action.busy) return;
    const confirmed = await confirmDialog({
      title: `Disconnect ${documentKindNames[provider]}`,
      message: `Disconnect ${documentKindNames[provider]} (${name})? Its secret is deleted from the server, and sessions you own can no longer read the workspaces' ${documentKindNames[provider]} sources.`,
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (!confirmed) return;
    void action.run(async () => {
      await api(`/api/source-accounts/${provider}`, { method: "DELETE" });
      refresh();
    }, `${documentKindNames[provider]} disconnected.`);
  }
  return <Section title="Connected accounts"
    info={<div className="stack">
      <p>Sessions you own read the workspaces' document sources with your own connections here, through Pistead. Sign in to a provider, or for Notion, Google Drive and Feishu/Lark paste a secret. Tokens and secrets are encrypted on the server, refreshed there, and never sent to any host, yours included.</p>
      <p>Each provider lets its connection read only what you share with it, and sessions read only what lies under the workspace's sources.</p>
    </div>}>
    <ResourceState loading={loading && !accounts} error={error} retry={refresh}>
      {shown.map(provider => {
        const account = accounts?.find(item => item.provider === provider);
        const oauth = signIn.includes(provider);
        const paste = secretKinds.includes(provider);
        const connect = <>
          {oauth && <LinkButton variant={account ? "ghost" : "outline"} size="sm" href={`/api/source-accounts/${provider}/oauth/start`}>{account ? "Sign in again" : "Sign in"}</LinkButton>}
          {paste && <Button variant={account || oauth ? "ghost" : "outline"} size="sm" disabled={action.busy} onClick={() => setConnecting(provider)}>{oauth ? "Paste secret" : account ? "Replace" : "Connect"}</Button>}
        </>;
        return <Row key={provider} leading={<Icon name="file" size={16} />} title={documentKindNames[provider]}
          hint={account ? `${account.name}${account.method === "oauth" ? " · signed in" : ""}` : "Not connected"}
          trailing={account
            ? <><StatusBadge tone="success">Connected</StatusBadge>{connect}<Button variant="ghost" size="sm" disabled={action.busy} aria-label={`Disconnect ${documentKindNames[provider]}`} onClick={() => void remove(provider, account.name)}>Disconnect</Button></>
            : connect} />;
      })}
    </ResourceState>
    {returned && <CardBody><Feedback {...(returned.ok
      ? { notice: `${documentKindNames[returned.kind]} connected.`, error: "" }
      : { notice: "", error: `${documentKindNames[returned.kind]} wasn't connected${returned.reason === "access_denied" ? ": the sign-in was cancelled" : returned.reason ? ` (${returned.reason})` : ""}. Try again.` })} /></CardBody>}
    {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
    <ConnectSheet provider={connecting} close={() => setConnecting(null)} connected={refresh} />
  </Section>;
}

function ConnectSheet({ provider, close, connected }: { provider: DocumentKind | null; close: () => void; connected: () => void }) {
  const [secret, setSecret] = useState("");
  const [appId, setAppId] = useState("");
  const [domain, setDomain] = useState<FeishuDomain>("feishu");
  const action = useAction();
  function reset() { setSecret(""); setAppId(""); setDomain("feishu"); }
  function dismiss() {
    if (action.busy) return;
    reset();
    close();
  }
  const ready = Boolean(secret.trim() && (provider !== "feishu" || appId.trim()));
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!provider || !ready || action.busy) return;
    const body = provider === "notion" ? { token: secret.trim() } : provider === "google-drive" ? { key: secret } : { appId: appId.trim(), appSecret: secret.trim(), domain };
    void action.run(async () => {
      try { await api(`/api/source-accounts/${provider}`, { method: "PUT", body }); }
      finally { setSecret(""); }
      reset();
      connected();
      close();
    });
  }
  const name = provider ? documentKindNames[provider] : "";
  return <Sheet open={provider !== null} title={`Connect ${name}`} onClose={dismiss} footer={<>
    <Button disabled={action.busy} onClick={dismiss}>Cancel</Button>
    <Button variant="default" type="submit" form="source-account-form" disabled={!ready || action.busy}>{action.busy ? "Verifying..." : "Connect"}</Button>
  </>}>
    <form id="source-account-form" className="stack" onSubmit={submit}>
      {provider && <p className="muted small">{setup[provider]} Pistead verifies it with {name}, then encrypts it on the server.</p>}
      {provider === "notion" && <Field label="Internal integration secret">
        <input className="input" required type="password" value={secret} onChange={event => setSecret(event.target.value)} disabled={action.busy} autoComplete="off" spellCheck={false} placeholder="ntn_…" />
      </Field>}
      {provider === "google-drive" && <Field label="Service account JSON key" hint="The whole key file. Only its email and private key are kept">
        <textarea className="input" required rows={6} value={secret} onChange={event => setSecret(event.target.value)} disabled={action.busy} autoComplete="off" spellCheck={false} placeholder='{"type": "service_account", …}' />
      </Field>}
      {provider === "feishu" && <>
        <div className="field"><span className="field-label">Platform</span>
          <Combobox<FeishuDomain> label="Platform" value={domain} disabled={action.busy}
            options={[{ value: "feishu", label: "Feishu", hint: "open.feishu.cn" }, { value: "lark", label: "Lark", hint: "open.larksuite.com" }]} onChange={setDomain} />
        </div>
        <Field label="App ID">
          <input className="input" required value={appId} onChange={event => setAppId(event.target.value)} disabled={action.busy} autoComplete="off" spellCheck={false} placeholder="cli_…" />
        </Field>
        <Field label="App Secret">
          <input className="input" required type="password" value={secret} onChange={event => setSecret(event.target.value)} disabled={action.busy} autoComplete="off" spellCheck={false} />
        </Field>
      </>}
      <Feedback error={action.error} />
    </form>
  </Sheet>;
}

/** The document part of a workspace's Sources: its Notion, Google Drive and Feishu/Lark items, which owners and admins add and remove. */
export function DocumentSources({ workspaceId, workspaceName, admin, sources, loading, error, refresh, changed }: {
  workspaceId: string; workspaceName: string; admin: boolean; sources: WorkspaceDocumentSource[] | null; loading: boolean; error: string; refresh: () => void; changed: () => void;
}) {
  const action = useAction();
  const accounts = useSourceAccounts(admin);
  const [adding, setAdding] = useState(false);
  const connected = documentKinds.filter(kind => accounts.accounts?.some(account => account.provider === kind));
  const full = (sources?.length ?? 0) >= sourceLimits.documents;
  async function remove(source: WorkspaceDocumentSource) {
    if (action.busy || !admin) return;
    const confirmed = await confirmDialog({
      title: "Remove source",
      message: `Remove ${source.title} (${documentKindNames[source.kind]}) from ${workspaceName}? Sessions, running ones too, can no longer read it or what is under it.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!confirmed) return;
    void action.run(async () => {
      await api(`/api/workspaces/${segment(workspaceId)}/sources/${segment(source.id)}`, { method: "DELETE" });
      refresh(); changed();
    }, "Source removed.");
  }
  return <div className="stack">
    <div className="section-header"><h3 className="section-title">Documents</h3><span className="spacer" />
      {admin && connected.length > 0 && !full && <Button variant="outline" size="sm" icon="plus" disabled={loading || Boolean(error) || action.busy} onClick={() => setAdding(true)}>Add document source</Button>}
    </div>
    <div className="card">
      <ResourceState loading={loading} error={error} retry={refresh}>
        {!sources?.length
          ? <CardBody><span className="muted">No documents yet. Sessions read a bound Notion page, Google Drive folder or Feishu/Lark folder, document or wiki page, and what is under it, with their owner's own connection</span></CardBody>
          : sources.map(source => <Row key={source.id} leading={<Icon name="file" size={16} />} title={source.title}
            hint={<>{documentKindNames[source.kind]} · {itemLabels[source.itemType]} · <a href={source.url} target="_blank" rel="noreferrer">Open</a></>}
            trailing={admin && <Button variant="outline" size="sm" disabled={action.busy} aria-label={`Remove ${source.title}`} onClick={() => void remove(source)}>Remove</Button>} />)}
        {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
      </ResourceState>
    </div>
    {admin && accounts.accounts && !connected.length && <Alert variant="info" title="Connect an account to add documents" actions={<LinkButton variant="outline" size="sm" href={href({ name: "settings", section: "profile" })}>Open profile</LinkButton>}>Pistead checks each item you add with your own Notion, Google Drive or Feishu/Lark connection, in Settings → Profile → Connected accounts.</Alert>}
    {admin && full && <Alert variant="info" title="Document source limit reached">A workspace has at most {sourceLimits.documents} document sources. Remove one to add another.</Alert>}
    {admin && connected.length > 0 && <AddSourceSheet open={adding} kinds={connected} workspaceId={workspaceId} close={() => setAdding(false)} added={() => { refresh(); changed(); }} />}
  </div>;
}

const linkHints: Record<DocumentKind, string> = {
  notion: "A page or database link (Share → Copy link). It must be shared with your Notion integration",
  "google-drive": "A folder, file, Google Doc, Sheet or Slides link. It must be shared with your service account",
  feishu: "A folder, docx document or wiki page link. Your app must be added to it",
  dropbox: "A folder or file link, or its path in your Dropbox (/Specs). Shared folders must be added to your Dropbox",
  onedrive: "A OneDrive or SharePoint folder or file link",
  "tencent-docs": "A Tencent Docs folder or document link (docs.qq.com/…)",
};

function AddSourceSheet({ open, kinds, workspaceId, close, added }: { open: boolean; kinds: DocumentKind[]; workspaceId: string; close: () => void; added: () => void }) {
  const [kind, setKind] = useState<DocumentKind | "">("");
  const [target, setTarget] = useState("");
  const action = useAction();
  const chosen = kind || (kinds.length === 1 ? kinds[0]! : "");
  function dismiss() {
    if (action.busy) return;
    setTarget(""); setKind("");
    close();
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!chosen || !target.trim() || action.busy) return;
    void action.run(async () => {
      await api(`/api/workspaces/${segment(workspaceId)}/sources`, { method: "POST", body: { kind: chosen, target: target.trim() } });
      setTarget(""); setKind("");
      added();
      close();
    });
  }
  return <Sheet open={open} title="Add document source" onClose={dismiss} footer={<>
    <Button disabled={action.busy} onClick={dismiss}>Cancel</Button>
    <Button variant="default" type="submit" form="document-source-form" disabled={!chosen || !target.trim() || action.busy}>{action.busy ? "Checking..." : "Add source"}</Button>
  </>}>
    <form id="document-source-form" className="stack" onSubmit={submit}>
      <div className="field"><span className="field-label">Provider</span>
        <Combobox<DocumentKind> label="Provider" placeholder="Choose a provider" value={chosen} disabled={action.busy}
          options={kinds.map(item => ({ value: item, label: documentKindNames[item] }))} onChange={setKind} />
      </div>
      {chosen && <Field label="Link" hint={`${linkHints[chosen]}. Each session reads it with its owner's own connection`}>
        <input className="input" required value={target} onChange={event => setTarget(event.target.value)} disabled={action.busy} autoComplete="off" spellCheck={false} placeholder="https://…" />
      </Field>}
      <Feedback error={action.error} />
    </form>
  </Sheet>;
}
