import { useState, type FormEvent } from "react";
import type { PushIdentity, PushIdentityKind, Workspace } from "../../../../packages/shared/src/types";
import { gitProviderHosts, gitProviderNames, gitProviders, pushIdentityKindsByProvider, type GitProvider } from "../../../../packages/shared/src/repositories";
import { api, segment } from "../api";
import { gitProviderLabel } from "../repositories";
import { Alert, Button, CardBody, CopyField, DropdownMenu, Feedback, Field, LinkButton, ResourceState, Row, Section, Sheet, StatusBadge, confirmDialog, useAction, useResource } from "../ui";

interface PushIdentitiesResponse {
  identities: PushIdentity[];
  oidc: { issuer: string; subject: string } | null;
  redirectUri: string | null;
  githubApp: { slug: string; installUrl: string } | null;
}

const kindLabel: Record<PushIdentityKind, string> = {
  "github-app": "GitHub App",
  "entra-federation": "Entra workload identity federation",
  "bitbucket-client-credentials": "Bitbucket OAuth consumer",
  "oauth-refresh": "OAuth app authorized by a bot account",
  "forgejo-integration": "Forgejo authorized integration",
};

const entraAudience = "api://AzureADTokenExchange";

/** Workspace push identities: the app/bot accounts that mint short-lived push credentials for agent pushes. */
export function PushAccess({ workspace, admin }: { workspace: Workspace; admin: boolean }) {
  const path = `/api/workspaces/${segment(workspace.id)}/push-identities`;
  const resource = useResource<PushIdentitiesResponse>(path);
  const action = useAction();
  const [editing, setEditing] = useState<{ provider: GitProvider; identity?: PushIdentity } | null>(null);
  async function remove(identity: PushIdentity) {
    const confirmed = await confirmDialog({ title: "Remove push identity", message: `Remove the ${kindLabel[identity.kind]} for ${scopeLabel(identity)}? Agents can no longer push to these repositories until another identity is configured.`, confirmLabel: "Remove", destructive: true });
    if (!confirmed) return;
    void action.run(async () => {
      await api(`${path}/${segment(identity.id)}`, { method: "DELETE" });
      resource.refresh();
    }, "Push identity removed.");
  }
  function authorize(identity: PushIdentity) {
    void action.run(async () => {
      const result = await api<{ url: string }>(`${path}/${segment(identity.id)}/authorize`, { method: "POST" });
      window.location.assign(result.url);
    });
  }
  const data = resource.data;
  return <Section title="Push access" info={<div className="stack">
    {!admin && <p>Only workspace owners and admins can manage push identities.</p>}
    <p>Agents push with short-lived credentials minted from these workspace app or bot identities, held only in the host's memory. The session owner must also be able to push to the repository, and to the branch where the host reports branch permissions; pull requests are opened as the session owner.</p>
    <p>Except for GitHub, the minted token carries everything the identity can reach until it expires, and the host running the session receives it. Give bot accounts, OAuth consumers, service principals and integrations access only to this workspace's repositories; for Forgejo integrations, add claim rules on the <code>repository</code> and <code>ref</code> claims.</p>
    <p>Secrets are write-only: they are never shown again after saving.</p>
  </div>} action={admin && <Button variant="outline" size="sm" icon="plus" onClick={() => setEditing({ provider: "github" })}>Add identity</Button>}>
    <ResourceState {...resource} retry={resource.refresh}>
      {data?.githubApp && <Row title={`Operator GitHub App (${data.githubApp.slug})`} hint="Used for github.com repositories without a workspace GitHub App. Install it on the repositories agents should push to" trailing={<LinkButton variant="outline" size="sm" href={data.githubApp.installUrl} target="_blank" rel="noreferrer">Install</LinkButton>} />}
      {!data?.identities.length
        ? !data?.githubApp && <CardBody><span className="muted">{admin ? "No push identities yet. Add one per provider so agents can push" : "No push identities yet. Ask a workspace owner or admin to add one"}</span></CardBody>
        : data.identities.map(identity => <Row key={identity.id} title={scopeLabel(identity)} hint={<>{kindLabel[identity.kind]}{identity.config.slug ? <> · <code>{identity.config.slug}</code></> : null}{identity.config.login ? <> · bot <code>{identity.config.login}</code></> : null}</>} trailing={<>
          <StatusBadge tone={identity.status === "ready" ? "success" : "warning"}>{identity.status === "ready" ? "Ready" : "Authorization required"}</StatusBadge>
          {admin && identity.kind === "oauth-refresh" && <Button variant="outline" size="sm" disabled={action.busy} onClick={() => authorize(identity)}>Authorize</Button>}
          {admin && <DropdownMenu label={`Actions for ${scopeLabel(identity)}`} items={[
            { label: "Replace", icon: "refresh", disabled: action.busy, onSelect: () => setEditing({ provider: identity.provider, identity }) },
            { label: "Remove", icon: "trash", destructive: true, disabled: action.busy, onSelect: () => void remove(identity) },
          ]} />}
        </>} />)}
      {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
    </ResourceState>
    {admin && editing && <PushIdentitySheet key={editing.identity?.id ?? "new"} path={path} oidc={data?.oidc ?? null} redirectUri={data?.redirectUri ?? null} initial={editing} close={() => setEditing(null)} saved={resource.refresh} />}
  </Section>;
}

function scopeLabel(identity: PushIdentity): string {
  return `${gitProviderLabel(identity.provider, identity.host)}${identity.scope ? ` · ${identity.scope}` : ""}`;
}

function PushIdentitySheet({ path, oidc, redirectUri, initial, close, saved }: { path: string; oidc: PushIdentitiesResponse["oidc"]; redirectUri: string | null; initial: { provider: GitProvider; identity?: PushIdentity }; close: () => void; saved: () => void }) {
  const existing = initial.identity;
  const [provider, setProvider] = useState<GitProvider>(initial.provider);
  const [kind, setKind] = useState<PushIdentityKind>(existing?.kind ?? pushIdentityKindsByProvider[initial.provider][0]);
  const [host, setHost] = useState(existing?.host ?? gitProviderHosts[initial.provider].default ?? "");
  const [scope, setScope] = useState(existing?.scope ?? "");
  const [config, setConfig] = useState<Record<string, string>>(existing ? { ...existing.config } : {});
  const [secret, setSecret] = useState("");
  const [created, setCreated] = useState<PushIdentity | null>(null);
  const action = useAction();
  const fixedHost = gitProviderHosts[provider].fixed;
  const scoped = provider === "azure-devops" || provider === "bitbucket";
  const field = (name: string) => config[name] ?? "";
  const setField = (name: string, value: string) => setConfig(current => ({ ...current, [name]: value }));
  function chooseProvider(next: GitProvider) {
    setProvider(next);
    setKind(pushIdentityKindsByProvider[next][0]);
    setHost(gitProviderHosts[next].default ?? "");
    setScope("");
    setConfig({});
    setSecret("");
  }
  const configFields: Record<PushIdentityKind, string[]> = { "github-app": ["appId", "slug"], "entra-federation": ["tenantId", "clientId"], "bitbucket-client-credentials": ["key"], "oauth-refresh": ["clientId"], "forgejo-integration": ["audience"] };
  const needsSecret = kind === "github-app" || kind === "bitbucket-client-credentials" || kind === "oauth-refresh";
  const ready = Boolean((fixedHost || host.trim()) && (!scoped || scope.trim()) && configFields[kind].every(name => field(name).trim()) && (!needsSecret || secret.trim()));
  function dismiss() { if (!action.busy) close(); }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!ready || action.busy) return;
    const body = {
      provider, kind,
      ...(fixedHost ? {} : { host: host.trim() }),
      ...(scoped ? { scope: scope.trim() } : {}),
      config: Object.fromEntries(configFields[kind].map(name => [name, field(name).trim()])),
      ...(needsSecret ? { secret: kind === "github-app" ? secret : secret.trim() } : {}),
    };
    void action.run(async () => {
      const result = await api<{ identity: PushIdentity }>(path, { method: "POST", body });
      setSecret("");
      saved();
      if (result.identity.kind === "oauth-refresh") setCreated(result.identity);
      else close();
    });
  }
  function authorize(identity: PushIdentity) {
    void action.run(async () => {
      const result = await api<{ url: string }>(`${path}/${segment(identity.id)}/authorize`, { method: "POST" });
      window.location.assign(result.url);
    });
  }
  const text = (name: string, label: string, hint?: string, placeholder?: string) => <Field label={label} hint={hint}>
    <input className="input" required value={field(name)} onChange={event => setField(name, event.target.value)} autoComplete="off" spellCheck={false} placeholder={placeholder} />
  </Field>;
  const issuerBlock = (audience: string) => oidc
    ? <div className="stack">
      <CopyField label="Issuer" value={oidc.issuer} />
      <CopyField label="Subject" value={oidc.subject} />
      {audience && <CopyField label="Audience" value={audience} />}
    </div>
    : <Alert variant="warning" title="OIDC issuer unavailable">The operator has not configured Pistead's OIDC signing key, so this identity cannot be used yet.</Alert>;
  return <Sheet open title={existing ? "Replace push identity" : "Add push identity"} onClose={dismiss} footer={created ? <>
    <Button disabled={action.busy} onClick={close}>Later</Button>
    <Button variant="default" disabled={action.busy} onClick={() => authorize(created)}>Authorize</Button>
  </> : <>
    <Button disabled={action.busy} onClick={dismiss}>Cancel</Button>
    <Button variant="default" type="submit" form="push-identity-form" disabled={!ready || action.busy}>{action.busy ? "Verifying..." : "Save"}</Button>
  </>}>
    {created
      ? <div className="stack"><p>Saved. Sign in to {gitProviderLabel(created.provider, created.host)} as the bot account, then authorize the OAuth app so Pistead can mint push tokens.</p><Feedback error={action.error} /></div>
      : <form id="push-identity-form" className="stack" onSubmit={save}>
        <Field label="Provider" hint={existing ? "Saving replaces the identity for the same provider, host and scope" : undefined}>
          <select className="select" value={provider} disabled={Boolean(existing)} onChange={event => chooseProvider(event.target.value as GitProvider)}>
            {gitProviders.map(item => <option key={item} value={item}>{gitProviderNames[item]}</option>)}
          </select>
        </Field>
        {pushIdentityKindsByProvider[provider].length > 1 && <Field label="Identity type">
          <select className="select" value={kind} onChange={event => { setKind(event.target.value as PushIdentityKind); setConfig({}); setSecret(""); }}>
            {pushIdentityKindsByProvider[provider].map(item => <option key={item} value={item}>{kindLabel[item]}</option>)}
          </select>
        </Field>}
        {!fixedHost && <Field label="Host" hint="Hostname of the instance, for example git.example.com">
          <input className="input" required value={host} disabled={Boolean(existing)} onChange={event => setHost(event.target.value)} autoComplete="off" spellCheck={false} placeholder="git.example.com" />
        </Field>}
        {scoped && <Field label={provider === "azure-devops" ? "Azure DevOps organization" : "Bitbucket workspace"}>
          <input className="input" required value={scope} disabled={Boolean(existing)} onChange={event => setScope(event.target.value)} autoComplete="off" spellCheck={false} />
        </Field>}
        {kind === "github-app" && <>
          <p className="muted small">Create a GitHub App with Repository contents read & write and install it on the repositories agents push to.</p>
          {text("appId", "App ID")}
          {text("slug", "App slug", "From the app's public URL: github.com/apps/<slug>")}
          <Field label="Private key" hint="PEM file contents. Write-only"><textarea className="textarea mono" required value={secret} onChange={event => setSecret(event.target.value)} autoComplete="off" spellCheck={false} placeholder="-----BEGIN RSA PRIVATE KEY-----" /></Field>
        </>}
        {kind === "entra-federation" && <>
          <p className="muted small">Register a Microsoft Entra app, add its service principal to the Azure DevOps organization with Code (Read & write) on the repositories, and add a federated credential with these values:</p>
          {issuerBlock(entraAudience)}
          {text("tenantId", "Tenant ID", undefined, "00000000-0000-0000-0000-000000000000")}
          {text("clientId", "Client ID", undefined, "00000000-0000-0000-0000-000000000000")}
        </>}
        {kind === "bitbucket-client-credentials" && <>
          <p className="muted small">Create an OAuth consumer in the Bitbucket workspace settings with the Repositories: Write permission, marked as a private consumer.</p>
          {text("key", "Key")}
          <Field label="Secret" hint="Write-only"><input className="input" type="password" required value={secret} onChange={event => setSecret(event.target.value)} autoComplete="new-password" /></Field>
        </>}
        {kind === "oauth-refresh" && <>
          <p className="muted small">Register an OAuth application on the instance ({provider === "gitlab" ? "scopes write_repository and read_user" : "scopes write:repository and read:user, Gitea 1.23 or later"}) with this redirect URI. After saving, sign in as a dedicated bot account with push access and authorize it.</p>
          {redirectUri
            ? <CopyField label="Redirect URI" value={redirectUri} />
            : <Alert variant="warning" title="Redirect URI unavailable">The operator has not configured Pistead's application origin, so this identity cannot be authorized yet.</Alert>}
          {text("clientId", "Client ID")}
          <Field label="Client secret" hint="Write-only"><input className="input" type="password" required value={secret} onChange={event => setSecret(event.target.value)} autoComplete="new-password" /></Field>
        </>}
        {kind === "forgejo-integration" && <>
          <p className="muted small">As a bot account with push access (Forgejo 16 or later), create a Generic JWT authorized integration trusting this issuer and subject, then enter its audience.</p>
          {issuerBlock("")}
          {text("audience", "Audience")}
        </>}
        <Feedback error={action.error} />
      </form>}
  </Sheet>;
}
