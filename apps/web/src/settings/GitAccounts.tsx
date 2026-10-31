import { Fragment, useEffect, useState, type FormEvent } from "react";
import { gitProviderHosts, gitProviderNames, gitProviders, type GitAccount, type TokenGitProvider } from "../../../../packages/shared/src/repositories";
import { api, segment } from "../api";
import { useApp } from "../app-context";
import { GitHubMark, Icon } from "../icons";
import { gitAccountLabel, useGitAccounts } from "../repositories";
import { Button, CardBody, Feedback, Field, LinkButton, ResourceState, Row, Sheet, StatusBadge, confirmDialog, useAction } from "../ui";

const tokenProviders = gitProviders.filter((provider): provider is TokenGitProvider => provider !== "github");

const tokenScopes: Record<TokenGitProvider, string> = {
  "github-enterprise": "Fine-grained: Contents and Metadata read (or classic repo); opening pull requests needs Pull requests write, and pushing with your account Contents write (or classic repo)",
  gitlab: "read_api and read_repository; opening merge requests needs api, and pushing with your account write_repository (or api)",
  bitbucket: "API token with read:repository:bitbucket and read:user:bitbucket, connected with your Atlassian account email above; agent pushes need this API token (workspace or repository access tokens can browse but cannot pass the push owner check); opening pull requests needs write:pullrequest:bitbucket, and pushing with your account write:repository:bitbucket",
  "azure-devops": "Code (Read); opening pull requests or pushing with your account needs Code (Read & write)",
  gitea: "read:repository and read:user; opening pull requests or pushing with your account needs write:repository",
};

/** What the Git accounts are for, as part of the Connected accounts section's info. */
export const gitAccountsInfo = "Repositories you bind or pin are read with your Git accounts, and the pull requests your agents ask for are opened with them. Their tokens are encrypted on the server and never sent to other people's hosts. Where a workspace's push access uses the session owner's account, your own host receives yours in memory for each push in your sessions; Pistead resets your GitHub token when the push ends, so that copy stops working.";

/** Where a provider's accounts live: its fixed host, its default one, or self-hosted. */
function providerHost(provider: TokenGitProvider): string {
  const hosts = gitProviderHosts[provider];
  return hosts.fixed ?? (hosts.default ? `${hosts.default} or self-managed` : "Self-hosted");
}

/** The Git group of the profile's Connected accounts: one row per supported Git provider, like the document providers,
 * each with its connected accounts under it. GitHub is the sign-in account; the others connect with tokens. */
export function GitAccountsGroup() {
  const { user } = useApp();
  const { accounts, loading, error, refresh } = useGitAccounts();
  const action = useAction();
  const [connecting, setConnecting] = useState<TokenGitProvider | null>(null);
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
  return <div className="stack" id="git-accounts">
    <div className="section-header"><h3 className="section-title">Git</h3></div>
    <div className="card">
      {/* Continuing with GitHub would sign in as a separate GitHub account, so a password account isn't offered it here. */}
      {user.passwordSignIn
        ? <Row leading={<GitHubMark />} title={gitProviderNames.github}
            hint={`${gitProviderHosts.github.default} · Repositories on github.com need an account that signs in with GitHub; this account signs in with a password`}
            trailing={<StatusBadge tone="warning">Not available</StatusBadge>} />
        : <Row leading={<GitHubMark />} title={gitProviderNames.github}
            hint={user.githubConnected ? `${gitProviderHosts.github.default} · ${user.githubLogin ? `@${user.githubLogin} · ` : ""}signed in` : `${gitProviderHosts.github.default} · Not connected`}
            trailing={user.githubConnected
              ? <StatusBadge tone="success">Connected</StatusBadge>
              : <LinkButton variant="outline" size="sm" href="/api/auth/github">Sign in</LinkButton>} />}
      <ResourceState loading={loading && !accounts} error={error} retry={refresh}>
        {tokenProviders.map(provider => {
          const connected = accounts?.filter(account => account.provider === provider) ?? [];
          const name = gitProviderNames[provider];
          return <Fragment key={provider}>
            <Row leading={<Icon name="git-branch" size={16} />} title={name}
              hint={`${providerHost(provider)} · ${connected.length ? `${connected.length} connected` : "Not connected"}`}
              trailing={<>
                {connected.length > 0 && <StatusBadge tone="success">Connected</StatusBadge>}
                <Button variant={connected.length ? "ghost" : "outline"} size="sm" disabled={action.busy} aria-label={`Connect ${name}`} onClick={() => setConnecting(provider)}>{connected.length ? "Add another" : "Connect"}</Button>
              </>} />
            {connected.map(account => <Row key={account.id} leading={<span className="git-account-indent" aria-hidden />}
              title={`${account.host}${account.organization ? `/${account.organization}` : ""}`} hint={account.login}
              trailing={<Button variant="ghost" size="sm" disabled={action.busy} aria-label={`Remove ${gitAccountLabel(account)}`} onClick={() => void remove(account)}>Remove</Button>} />)}
          </Fragment>;
        })}
      </ResourceState>
      {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
    </div>
    <ConnectGitAccountSheet provider={connecting} close={() => setConnecting(null)} added={refresh} />
  </div>;
}

/** Connects a token account for one provider, chosen by its row. */
function ConnectGitAccountSheet({ provider, close, added }: { provider: TokenGitProvider | null; close: () => void; added: () => void }) {
  const [host, setHost] = useState("");
  const [organization, setOrganization] = useState("");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const action = useAction();
  const fixedHost = provider ? gitProviderHosts[provider].fixed : null;
  // Each opening starts from the provider's defaults.
  useEffect(() => {
    setHost(provider ? gitProviderHosts[provider].default ?? "" : "");
    setOrganization("");
    setUsername("");
    setToken("");
  }, [provider]);
  function dismiss() {
    if (action.busy) return;
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
      close();
    });
  }
  const ready = Boolean(provider && token && (fixedHost || host.trim()) && (provider !== "azure-devops" || organization.trim()));
  return <Sheet open={provider !== null} title={`Connect ${provider ? gitProviderNames[provider] : "Git"}`} onClose={dismiss} footer={<>
    <Button disabled={action.busy} onClick={dismiss}>Cancel</Button>
    <Button variant="default" type="submit" form="git-account-form" disabled={!ready || action.busy}>{action.busy ? "Verifying..." : "Connect"}</Button>
  </>}>
    <form id="git-account-form" className="stack" onSubmit={submit}>
      {provider && <>
        {!fixedHost && <Field label="Host" hint="HTTPS host name of the instance, without https://, for example git.example.com">
          <input className="input" required value={host} onChange={event => setHost(event.target.value)} disabled={action.busy} autoComplete="off" spellCheck={false} maxLength={253} placeholder="git.example.com" />
        </Field>}
        {provider === "azure-devops" && <Field label="Organization" hint={`From dev.azure.com/<organization>`}>
          <input className="input" required value={organization} onChange={event => setOrganization(event.target.value)} disabled={action.busy} autoComplete="off" spellCheck={false} maxLength={100} />
        </Field>}
        {provider === "bitbucket" && <Field label="Username or email" hint="Your Atlassian account email when using an API token (required for agent pushes); leave blank for a workspace or repository access token, which can browse but not push">
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
