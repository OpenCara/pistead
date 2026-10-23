import { useState, type FormEvent } from "react";
import type { UserProfile, Workspace, WorkspaceRole } from "../../../../packages/shared/src/types";
import { gitProviderNames, repositoryLimits, type GitAccount, type ProviderRepository, type ProviderRepositoryList, type WorkspaceRepository } from "../../../../packages/shared/src/repositories";
import { api, segment } from "../api";
import { useApp } from "../app-context";
import { useConnections } from "../hosts";
import { Icon } from "../icons";
import { NewWorkspaceSheet } from "../NewWorkspaceSheet";
import { gitAccountLabel, gitProviderLabel, RepositoryClonePolicy, useGitAccounts, useWorkspaceRepositories } from "../repositories";
import { href } from "../router";
import { Alert, Button, CardBody, Combobox, DropdownMenu, EmptyState, Feedback, Field, IdentityBadge, LinkButton, PageLoading, ResourceState, Row, Section, Sheet, StatusBadge, StatusDot, confirmDialog, useAction, useResource } from "../ui";
import { memberPerson, userIdFromInput, username, usernameWithId, type WorkspaceMember } from "../../../../packages/client/src/usernames";
import { NetworkAccess } from "./NetworkAccess";
import { PushAccess } from "./PushAccess";
import { WorkspaceDatabaseSection } from "./WorkspaceDatabase";

const roleLabel: Record<WorkspaceRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

export function WorkspacesSettings({ id }: { id?: string }) {
  const { user, workspaces, workspacesLoading, workspacesError, refreshWorkspaces } = useApp();
  const [creating, setCreating] = useState(false);
  const sheet = <NewWorkspaceSheet open={creating} onClose={() => setCreating(false)} />;
  if (id) {
    const workspace = workspaces.find(item => item.id === id);
    if (!workspace) {
      if (workspacesLoading) return <PageLoading />;
      return <>
        <BackLink />
        {workspacesError
          ? <Alert variant="error" title="Unable to load workspaces" actions={<Button variant="outline" size="sm" onClick={refreshWorkspaces}>Try again</Button>}>{workspacesError}</Alert>
          : <EmptyState title="Workspace not found" />}
      </>;
    }
    return <><BackLink /><WorkspaceDetail key={workspace.id} user={user} workspace={workspace} /></>;
  }
  if (workspacesLoading && !workspaces.length) return <PageLoading />;
  if (workspacesError && !workspaces.length) return <Alert variant="error" title="Unable to load workspaces" actions={<Button variant="outline" size="sm" onClick={refreshWorkspaces}>Try again</Button>}>{workspacesError}</Alert>;
  if (!workspaces.length) return <>
    <EmptyState title="No workspaces yet" action={<Button variant="default" icon="plus" onClick={() => setCreating(true)}>New workspace</Button>} />
    {sheet}
  </>;
  return <>
    <Section title="Workspaces" info="A shared home for your repositories, people, agents and sessions" action={<Button variant="outline" size="sm" icon="plus" onClick={() => setCreating(true)}>New workspace</Button>}>
      {workspaces.map(workspace => <Row key={workspace.id} leading={<IdentityBadge name={workspace.name} id={workspace.id} />} title={workspace.name} hint={roleLabel[workspaceRole(workspace, user)]} href={href({ name: "settings", section: "workspaces", id: workspace.id })} chevron />)}
    </Section>
    {sheet}
  </>;
}

function BackLink() {
  return <a className="btn ghost sm" href={href({ name: "settings", section: "workspaces" })}><Icon name="chevron-left" size={16} />Workspaces</a>;
}

function workspaceRole(workspace: Workspace, user: UserProfile): WorkspaceRole {
  return workspace.ownerId === user.id ? "owner" : workspace.role ?? "member";
}

function WorkspaceDetail({ user, workspace }: { user: UserProfile; workspace: Workspace }) {
  const role = workspaceRole(workspace, user);
  const admin = role === "owner" || role === "admin";
  const repositories = useWorkspaceRepositories(workspace.id);
  return <>
    <Section title="General">
      <Row title="Name" trailing={<span>{workspace.name}</span>} />
      <Row title="Your role" trailing={<StatusBadge tone={admin ? "success" : "neutral"}>{roleLabel[role]}</StatusBadge>} />
    </Section>
    <Setup user={user} workspace={workspace} admin={admin} repositoryCount={repositories.repositories?.length ?? null} />
    <Repositories workspace={workspace} admin={admin} {...repositories} />
    <PushAccess workspace={workspace} admin={admin} />
    <NetworkAccess workspace={workspace} admin={admin} />
    <WorkspaceDatabaseSection workspace={workspace} owner={role === "owner"} />
    <Members workspace={workspace} admin={admin} />
    {admin && <DataExport workspace={workspace} />}
  </>;
}

function DataExport({ workspace }: { workspace: Workspace }) {
  return <Section title="Data export" info={<div className="stack">
    <p>Downloads this workspace as JSON: its settings, members, models, published agents, repositories, push access, session database connection and activity, with your own sessions in full and the records of the other sessions you can view.</p>
    <p>Other members' private sessions are left out; their owners can export them. Secrets are never included, and a session's conversation is in its backups.</p>
    <p>The workspace owner can import exports into the workspace's session database.</p>
  </div>}>
    <Row title="Workspace data" hint="JSON, without secrets" trailing={<LinkButton variant="outline" size="sm" href={`/api/workspaces/${segment(workspace.id)}/export`} download>Export</LinkButton>} />
  </Section>;
}

function Setup({ user, workspace, admin, repositoryCount }: { user: UserProfile; workspace: Workspace; admin: boolean; repositoryCount: number | null }) {
  const { sessions, sessionsLoading } = useApp();
  const connectors = useConnections(`/api/workspaces/${segment(workspace.id)}/connectors`);
  // Only show the checklist once every signal is known, so it never flashes in and out.
  if (repositoryCount === null || !connectors.data || sessionsLoading) return null;
  const steps = [
    { label: "Bind a repository", done: repositoryCount > 0, hint: admin ? undefined : "An owner or admin does this", onClick: () => document.getElementById("workspace-repositories")?.scrollIntoView({ behavior: "smooth" }) },
    { label: "Pair a host", done: connectors.data.connectors.some(connector => !connector.revokedAt && connector.online && (connector.ownerId === user.id || connector.workspaceIds.includes(workspace.id))), link: href({ name: "settings", section: "hosts" }) },
    { label: "Start a session", done: sessions.some(session => session.workspaceId === workspace.id), link: href({ name: "new", workspaceId: workspace.id }) },
  ];
  if (steps.every(step => step.done)) return null;
  return <Section title="Setup" action={<span className="muted small">{steps.filter(step => step.done).length} / {steps.length}</span>}>
    {steps.map(step => <Row key={step.label} leading={<StatusDot tone={step.done ? "success" : "neutral"} label={step.done ? "Done" : "To do"} />} title={step.label} hint={step.done ? undefined : step.hint} href={step.done ? undefined : step.link} onClick={step.done ? undefined : step.onClick} chevron={!step.done} />)}
  </Section>;
}

function Repositories({ workspace, admin, repositories, loading, error, refresh }: { workspace: Workspace; admin: boolean; repositories: WorkspaceRepository[] | null; loading: boolean; error: string; refresh: () => void }) {
  const action = useAction();
  const accounts = useGitAccounts(admin);
  const [picking, setPicking] = useState(false);
  const full = (repositories?.length ?? 0) >= repositoryLimits.repositories;
  async function remove(repository: WorkspaceRepository) {
    if (action.busy || !admin) return;
    const last = repositories?.length === 1;
    const confirmed = await confirmDialog({
      title: "Remove repository",
      message: `Remove ${repository.fullName} from ${workspace.name}? Existing sessions keep their pinned snapshots.${last ? " With no repositories, new sessions, pairing and sharing will be disabled until an owner or admin adds a repository." : " This changes new sessions only."}`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!confirmed) return;
    void action.run(async () => {
      await api(`/api/workspaces/${segment(workspace.id)}/repositories/${segment(repository.id)}`, { method: "DELETE" });
      refresh();
    }, "Repository removed. Existing sessions keep their pinned snapshots.");
  }
  function setPushPolicy(repository: WorkspaceRepository, allowDefault: boolean) {
    if (action.busy || !admin) return;
    void action.run(async () => {
      await api(`/api/workspaces/${segment(workspace.id)}/repositories/${segment(repository.id)}/push-policy`, { method: "PUT", body: { forbidDefaultBranch: !allowDefault } });
      refresh();
    }, "Push policy saved.");
  }
  const canAdd = admin && Boolean(accounts.accounts?.length) && !full;
  return <Section bare title="Repositories" info={<div className="stack">
    {!admin && <p>Only workspace owners and admins can add or remove repositories.</p>}
    <p>Changes apply at once, in running sessions too: a removed repository can no longer be read or pushed. To change a ref, remove and re-add the repository.</p>
    <RepositoryClonePolicy />
  </div>} action={canAdd && <Button variant="outline" size="sm" icon="plus" disabled={loading || Boolean(error) || action.busy} onClick={() => setPicking(true)}>Add repository</Button>}>
    <div className="stack" id="workspace-repositories">
      <div className="card">
        <ResourceState loading={loading} error={error} retry={refresh}>
          {!repositories?.length
            ? <CardBody><span className="muted">{admin ? "No repositories yet. Add a repository to pair a host and start sessions" : "No repositories yet. Ask a workspace owner or admin to bind one"}</span></CardBody>
            : repositories.map(repository => <Row key={repository.id} title={repository.fullName} hint={<>{gitProviderLabel(repository.provider, repository.host)} · <code>{repository.ref}</code></>} trailing={<>
              <label className="inline small"><input type="checkbox" className="checkbox" checked={!repository.forbidDefaultBranchPush} disabled={!admin || action.busy} onChange={event => setPushPolicy(repository, event.target.checked)} />Allow agent pushes to the default branch</label>
              <StatusBadge>{repository.private ? "Private" : "Public"}</StatusBadge>
              {admin && <Button variant="outline" size="sm" disabled={action.busy} aria-label={`Remove ${repository.fullName}`} onClick={() => void remove(repository)}>Remove</Button>}
            </>} />)}
          {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
        </ResourceState>
      </div>
      {admin && accounts.error && <Alert variant="error" title="Unable to load Git accounts" actions={<Button variant="outline" size="sm" onClick={accounts.refresh}>Try again</Button>}>{accounts.error}</Alert>}
      {admin && accounts.accounts && !accounts.accounts.length && <Alert variant="warning" title="No Git accounts connected" actions={<LinkButton variant="outline" size="sm" href={href({ name: "settings", section: "profile" })}>Open profile</LinkButton>}>Connect GitHub or add a Git account in Settings → Profile before choosing repositories.</Alert>}
      {admin && Boolean(accounts.accounts?.length) && full && <Alert variant="info" title="Repository limit reached">The workspace has reached its {repositoryLimits.repositories}-repository limit. Remove a binding to choose another.</Alert>}
    </div>
    {canAdd && <RepositoryPicker open={picking} workspace={workspace} accounts={accounts.accounts ?? []} repositories={repositories ?? []} disabled={loading || Boolean(error) || action.busy} refresh={refresh} close={() => setPicking(false)} />}
  </Section>;
}

function RepositoryPicker({ open, workspace, accounts, repositories, disabled, refresh, close }: { open: boolean; workspace: Workspace; accounts: GitAccount[]; repositories: WorkspaceRepository[]; disabled: boolean; refresh: () => void; close: () => void }) {
  const [accountId, setAccountId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [ref, setRef] = useState("");
  // The API lists the GitHub sign-in account first when connected, so it is the default.
  const account = accounts.find(item => item.id === accountId) ?? accounts[0];
  const resource = useResource<ProviderRepositoryList>(open && account ? `/api/git/accounts/${segment(account.id)}/repositories` : null);
  const action = useAction();
  const selected = resource.data?.repositories.find(repository => repository.id === selectedId);
  const alreadyBound = (repository: ProviderRepository) => repositories.some(binding => binding.provider === account?.provider && binding.host === account.host
    && (binding.repositoryId === repository.id || binding.fullName.toLowerCase() === repository.fullName.toLowerCase()));
  const blocked = disabled || action.busy || resource.loading || Boolean(resource.error) || !account || !selected || alreadyBound(selected) || repositories.length >= repositoryLimits.repositories;
  const providerName = account ? gitProviderNames[account.provider] : "Git";
  function choose(id: string) { setSelectedId(id); setRef(""); }
  function chooseAccount(id: string) { setAccountId(id); choose(""); }
  function dismiss() {
    if (action.busy) return;
    setSelectedId("");
    setRef("");
    close();
  }
  function add(event: FormEvent) {
    event.preventDefault();
    if (blocked || !selected || !account) return;
    void action.run(async () => {
      await api(`/api/workspaces/${segment(workspace.id)}/repositories`, { method: "POST", body: { provider: account.provider, host: account.host, repositoryId: selected.id, fullName: selected.fullName, ...(ref.trim() ? { ref: ref.trim() } : {}) } });
      refresh();
      setSelectedId("");
      setRef("");
      close();
    });
  }
  return <Sheet open={open} title="Add repository" onClose={dismiss} footer={<>
    <Button disabled={action.busy} onClick={dismiss}>Cancel</Button>
    <Button variant="default" type="submit" form="repository-picker-form" disabled={blocked}>{action.busy ? "Binding..." : "Bind repository"}</Button>
  </>}>
    <form id="repository-picker-form" className="stack" onSubmit={add}>
      <div className="field"><span className="field-label">Account</span>
        <Combobox<string> label="Account" placeholder="Choose an account" value={account?.id ?? ""} disabled={disabled || action.busy}
          options={accounts.map(item => ({ value: item.id, label: gitAccountLabel(item), hint: item.login }))} onChange={chooseAccount} />
      </div>
      <p className="muted small">Only repositories this {providerName} account can access are listed. Sessions read them with their owner's own account for the same provider. Never paste a token or clone URL</p>
      <ResourceState {...resource} retry={resource.refresh}>
        {!resource.data?.repositories.length
          ? <EmptyState title="No repositories found">Check your {providerName} account and organization access</EmptyState>
          : <>
            <div className="field"><span className="field-label">{providerName} repository</span>
              <Combobox<string> label={`${providerName} repository`} placeholder="Choose a repository" value={selected?.id ?? ""} disabled={disabled || action.busy}
                options={resource.data.repositories.map(repository => ({ value: repository.id, label: repository.fullName, disabled: alreadyBound(repository),
                  hint: `${repository.private ? "Private" : "Public"}${alreadyBound(repository) ? " · Already configured" : ""}` }))} onChange={choose} />
              {resource.data.truncated && <span className="field-hint">Only the first {repositoryLimits.pickerRepositories.toLocaleString()} repositories this account can access are listed</span>}
            </div>
            <Field label="Branch, tag or commit" hint={`Optional. Leave blank to use ${selected ? `the default branch, ${selected.defaultBranch}` : "the repository's default branch"}. New sessions pin this ref to a commit; existing sessions never follow branch changes`}>
              <input className="input" value={ref} onChange={event => setRef(event.target.value)} disabled={disabled || action.busy || !selected} autoComplete="off" spellCheck={false} maxLength={255} placeholder={selected?.defaultBranch ?? "Repository default branch"} />
            </Field>
          </>}
      </ResourceState>
      {resource.error && <p className="muted small">Review your <a href={href({ name: "settings", section: "profile" })}>Git accounts</a> and repository access, then retry. An owner or admin with access can also configure this workspace</p>}
      <Feedback error={action.error} />
    </form>
  </Sheet>;
}

function Members({ workspace, admin }: { workspace: Workspace; admin: boolean }) {
  const path = `/api/workspaces/${segment(workspace.id)}/members`;
  const resource = useResource<{ members: WorkspaceMember[] }>(path);
  const [adding, setAdding] = useState(false);
  const action = useAction();
  async function remove(member: WorkspaceMember) {
    const confirmed = await confirmDialog({ title: "Remove member", message: `Remove ${usernameWithId(memberPerson(member))} from this workspace?`, confirmLabel: "Remove", destructive: true });
    if (!confirmed) return;
    void action.run(async () => {
      await api(`${path}/${segment(member.userId)}`, { method: "DELETE" });
      resource.refresh();
    }, "Membership removed.");
  }
  return <>
    <Section title="Members" info={<div className="stack">
      {!admin && <p>Only workspace owners and admins can manage membership.</p>}
      <p>Members can use published agents and follow workspace-visible sessions read-only, which shows prompts, tool output and repository content in the transcript. Private sessions, and ask, write, approve or manage permissions, require explicit grants.</p>
      <p>Membership never grants GitHub access, tool execution, or use of anyone's private Pi host.</p>
    </div>} action={admin && <Button variant="outline" size="sm" icon="plus" onClick={() => setAdding(true)}>Add member</Button>}>
      <ResourceState {...resource} retry={resource.refresh}>
        {!resource.data?.members.length
          ? <CardBody><span className="muted">No members to display</span></CardBody>
          : resource.data.members.map(member => {
            const person = memberPerson(member);
            const name = member.displayName || username(person);
            return <Row key={member.userId} leading={<IdentityBadge name={name} id={member.userId} />} title={name} hint={usernameWithId(person)} trailing={<>
              <StatusBadge tone={member.role === "member" ? "neutral" : "success"}>{roleLabel[member.role]}</StatusBadge>
              {admin && member.userId !== workspace.ownerId && <DropdownMenu label={`Actions for ${name}`} items={[{ label: "Remove", icon: "trash", destructive: true, disabled: action.busy, onSelect: () => void remove(member) }]} />}
            </>} />;
          })}
        {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
      </ResourceState>
    </Section>
    {admin && <AddMember open={adding} path={path} close={() => setAdding(false)} saved={resource.refresh} />}
  </>;
}

function AddMember({ open, path, close, saved }: { open: boolean; path: string; close: () => void; saved: () => void }) {
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const action = useAction();
  function save(event: FormEvent) {
    event.preventDefault();
    if (action.busy || !userId.trim()) return;
    void action.run(async () => {
      // Profiles show the ID as "username(id)", so a pasted label names its ID.
      await api(path, { method: "POST", body: { userId: userIdFromInput(userId), role } });
      setUserId("");
      saved();
      close();
    });
  }
  return <Sheet open={open} title="Add member" onClose={() => { if (!action.busy) close(); }} footer={<>
    <Button disabled={action.busy} onClick={close}>Cancel</Button>
    <Button variant="default" type="submit" form="add-member-form" disabled={action.busy || !userId.trim()}>{action.busy ? "Saving..." : "Save"}</Button>
  </>}>
    <form id="add-member-form" className="stack" onSubmit={save}>
      <Field label="User ID" hint="Copy it from their profile. Saving an existing member updates their role">
        <input className="input" required autoFocus value={userId} onChange={event => setUserId(event.target.value)} placeholder="User ID" autoComplete="off" spellCheck={false} />
      </Field>
      <Field label="Role">
        <select className="select" value={role} onChange={event => setRole(event.target.value as "member" | "admin")}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </Field>
      <Feedback error={action.error} />
    </form>
  </Sheet>;
}
