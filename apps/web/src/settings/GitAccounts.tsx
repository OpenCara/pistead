import { useState, type FormEvent } from "react";
import { gitProviderHosts, gitProviderNames, gitProviders, type GitAccount, type TokenGitProvider } from "../../../../packages/shared/src/repositories";
import { api, segment } from "../api";
import { useApp } from "../app-context";
import { GitHubMark, Icon } from "../icons";
import { gitAccountLabel, useGitAccounts } from "../repositories";
import { Button, CardBody, Combobox, Feedback, Field, LinkButton, ResourceState, Row, Section, Sheet, StatusBadge, confirmDialog, useAction } from "../ui";

const tokenProviders = gitProviders.filter((provider): provider is TokenGitProvider => provider !== "github");

const tokenScopes: Record<TokenGitProvider, string> = {
  "github-enterprise": "Fine-grained: Contents and Metadata read (or classic repo)",
  gitlab: "read_api and read_repository",
  bitbucket: "API token with read:repository:bitbucket and read:user:bitbucket (enter your Atlassian email above), or a workspace/repository access token with repository read",
  "azure-devops": "Code (Read)",
  gitea: "read:repository and read:user",
};

/** Profile section listing the GitHub sign-in account and personal-access-token accounts for other Git providers. */
export function GitAccountsSection() {
  const { user } = useApp();
  const { accounts, loading, error, refresh } = useGitAccounts();
  const action = useAction();
  const [adding, setAdding] = useState(false);
  async function remove(account: GitAccount) {
    if (action.busy) return;
    const confirmed = await confirmDialog({
      title: "Remove Git account",
      message: `Remove ${gitAccountLabel(account)} (${account.login})? Its token is deleted from the server. New sessions you own can no longer read repositories through it; existing session snapshots are kept.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!confirmed) return;
    void action.run(async () => {
      await api(`/api/git/accounts/${segment(account.id)}`, { method: "DELETE" });
      refresh();
    }, "Git account removed.");
  }
  return <Section title="Git accounts"
    info="Repositories you bind or pin are read with these accounts. Tokens are encrypted on the server, used only to read repositories you bind or pin, and never sent to hosts. Your sign-in stays GitHub; viewing a session, sharing a host or publishing an agent never grants access to your accounts."
    action={<Button variant="outline" size="sm" icon="plus" onClick={() => setAdding(true)}>Add account</Button>}>
    <Row leading={<GitHubMark />} title={`${gitProviderNames.github} · ${gitProviderHosts.github.default}`} hint={user.githubLogin ? `@${user.githubLogin}` : undefined}
      trailing={<>
        <StatusBadge tone={user.githubConnected ? "success" : "warning"}>{user.githubConnected ? "Connected" : "Not connected"}</StatusBadge>
        {!user.githubConnected && <LinkButton variant="outline" size="sm" href="/api/auth/github">Connect GitHub</LinkButton>}
      </>} />
    <ResourceState loading={loading && !accounts} error={error} retry={refresh}>
      {accounts?.filter(account => account.provider !== "github").map(account => <Row key={account.id} leading={<Icon name="git-branch" size={16} />}
        title={gitAccountLabel(account)} hint={account.login}
        trailing={<Button variant="ghost" size="sm" disabled={action.busy} aria-label={`Remove ${gitAccountLabel(account)}`} onClick={() => void remove(account)}>Remove</Button>} />)}
    </ResourceState>
    {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
    <AddGitAccountSheet open={adding} close={() => setAdding(false)} added={refresh} />
  </Section>;
}

function AddGitAccountSheet({ open, close, added }: { open: boolean; close: () => void; added: () => void }) {
  const [provider, setProvider] = useState<TokenGitProvider | "">("");
  const [host, setHost] = useState("");
  const [organization, setOrganization] = useState("");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const action = useAction();
  const fixedHost = provider ? gitProviderHosts[provider].fixed : null;
  function choose(next: TokenGitProvider) {
    setProvider(next);
    setHost(gitProviderHosts[next].default ?? "");
    setOrganization("");
    setUsername("");
  }
  function dismiss() {
    if (action.busy) return;
    setProvider("");
    setHost("");
    setOrganization("");
    setUsername("");
    setToken("");
    close();
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!provider || action.busy) return;
    const body = {
      provider,
      token,
      ...(fixedHost ? {} : { host: host.trim() }),
      ...(provider === "azure-devops" ? { organization: organization.trim() } : {}),
      ...(provider === "bitbucket" && username.trim() ? { username: username.trim() } : {}),
    };
    void action.run(async () => {
      try {
        await api<{ account: GitAccount }>("/api/git/accounts", { method: "POST", body });
      } finally {
        setToken("");
      }
      added();
      setProvider("");
      setHost("");
      setOrganization("");
      setUsername("");
      close();
    });
  }
  const ready = Boolean(provider && token && (fixedHost || host.trim()) && (provider !== "azure-devops" || organization.trim()));
  return <Sheet open={open} title="Add Git account" onClose={dismiss} footer={<>
    <Button disabled={action.busy} onClick={dismiss}>Cancel</Button>
    <Button variant="default" type="submit" form="git-account-form" disabled={!ready || action.busy}>{action.busy ? "Verifying..." : "Add account"}</Button>
  </>}>
    <form id="git-account-form" className="stack" onSubmit={submit}>
      <div className="field"><span className="field-label">Provider</span>
        <Combobox<TokenGitProvider> label="Provider" placeholder="Choose a provider" value={provider} disabled={action.busy}
          options={tokenProviders.map(item => ({ value: item, label: gitProviderNames[item], hint: gitProviderHosts[item].fixed ?? gitProviderHosts[item].default ?? "Self-hosted" }))} onChange={choose} />
      </div>
      {provider && <>
        {!fixedHost && <Field label="Host" hint="HTTPS host name of the instance, without https://, for example git.example.com">
          <input className="input" required value={host} onChange={event => setHost(event.target.value)} disabled={action.busy} autoComplete="off" spellCheck={false} maxLength={253} placeholder="git.example.com" />
        </Field>}
        {provider === "azure-devops" && <Field label="Organization" hint={`From dev.azure.com/<organization>`}>
          <input className="input" required value={organization} onChange={event => setOrganization(event.target.value)} disabled={action.busy} autoComplete="off" spellCheck={false} maxLength={100} />
        </Field>}
        {provider === "bitbucket" && <Field label="Username or email" hint="Optional. Your Atlassian account email when using an API token; leave blank for a workspace or repository access token">
          <input className="input" value={username} onChange={event => setUsername(event.target.value)} disabled={action.busy} autoComplete="off" spellCheck={false} maxLength={254} />
        </Field>}
        <Field label="Token" hint={`Scopes: ${tokenScopes[provider]}. Verified with ${gitProviderNames[provider]}, then encrypted on the server`}>
          <input className="input" required type="password" value={token} onChange={event => setToken(event.target.value)} disabled={action.busy} autoComplete="off" spellCheck={false} />
        </Field>
      </>}
      <Feedback error={action.error} />
    </form>
  </Sheet>;
}
