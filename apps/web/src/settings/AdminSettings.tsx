import { useState } from "react";
import type { AdminHost, AdminList, AdminOverview, AdminUser, AdminWorkspace } from "../../../../packages/shared/src/admin";
import { usernameWithId } from "../../../../packages/client/src/usernames";
import { api, segment } from "../api";
import { CardBody, confirmDialog, DropdownMenu, Feedback, IdentityBadge, RelativeTime, ResourceState, Row, Section, StatusBadge, StatusDot, useAction, useResource, type Tone } from "../ui";
import "./settings.css";

function count(value: number, singular: string, plural: string) {
  return `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
}

/** Whether a listed item mentions every word typed, case-insensitively. */
function matches(query: string, ...fields: (string | null)[]) {
  const text = fields.filter(Boolean).join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => text.includes(word));
}

function Truncated({ list }: { list: AdminList<unknown> | null }) {
  return list?.truncated ? <CardBody><span className="muted small">Only the newest {list.items.length.toLocaleString()} are listed</span></CardBody> : null;
}

export function AdminSettings() {
  const overview = useResource<{ overview: AdminOverview }>("/api/admin/overview");
  const users = useResource<AdminList<AdminUser>>("/api/admin/users");
  const workspaces = useResource<AdminList<AdminWorkspace>>("/api/admin/workspaces");
  const hosts = useResource<AdminList<AdminHost>>("/api/admin/hosts");
  const [query, setQuery] = useState("");
  const action = useAction();
  const totals = overview.data?.overview;

  function refresh() {
    overview.refresh(); users.refresh(); hosts.refresh();
  }
  async function suspend(user: AdminUser) {
    const confirmed = await confirmDialog({ title: "Suspend account", destructive: true, confirmLabel: "Suspend",
      message: `Suspend ${usernameWithId(user)}? They're signed out everywhere and can't sign in, their hosts are disconnected, and nobody can open the sessions they own until you unsuspend them. Nothing is deleted.` });
    if (!confirmed) return;
    void action.run(async () => {
      await api(`/api/admin/users/${segment(user.id)}/suspend`, { method: "POST" });
      refresh();
    }, "Account suspended.");
  }
  function unsuspend(user: AdminUser) {
    void action.run(async () => {
      await api(`/api/admin/users/${segment(user.id)}/unsuspend`, { method: "POST" });
      refresh();
    }, "Account unsuspended. They can sign in again and their hosts reconnect.");
  }

  const shownUsers = (users.data?.items ?? []).filter(user => matches(query, user.displayName, user.githubLogin, user.id));
  const shownWorkspaces = (workspaces.data?.items ?? []).filter(item => matches(query, item.name, item.ownerName, item.ownerGithubLogin, item.ownerId, item.id));
  const shownHosts = (hosts.data?.items ?? []).filter(host => matches(query, host.name, host.ownerName, host.ownerGithubLogin, host.ownerId, host.id));
  return <>
    <Section title="Overview" info="Totals for this whole Pistead server. You administer it because its operator lists your user ID in ADMIN_USER_IDS. Administration shows who uses the server and what they run it on, never what they work on: no session titles, prompts, repositories or credentials.">
      <ResourceState {...overview} retry={overview.refresh}>
        {totals && <>
          <Row title="Accounts" trailing={<>{totals.users.toLocaleString()}{totals.suspendedUsers > 0 && <StatusBadge tone="danger">{totals.suspendedUsers.toLocaleString()} suspended</StatusBadge>}</>} />
          <Row title="Workspaces" trailing={totals.workspaces.toLocaleString()} />
          <Row title="Hosts" trailing={`${totals.onlineHosts.toLocaleString()} online of ${totals.hosts.toLocaleString()}`} />
          <Row title="Sessions" trailing={`${totals.activeSessions.toLocaleString()} active of ${totals.sessions.toLocaleString()}`} />
        </>}
      </ResourceState>
    </Section>

    <input className="input admin-filter" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter by name, username or ID" aria-label="Filter accounts, workspaces and hosts" />

    <Section title="Accounts" info={<div className="stack">
      <p>Suspending an account signs it out everywhere, refuses its sign-ins, disconnects its hosts and closes the sessions it owns to everyone, as if it had left its workspaces. Nothing is deleted: unsuspending restores it as it was.</p>
      <p>Administrators can't be suspended here; remove them from ADMIN_USER_IDS first.</p>
    </div>}>
      <ResourceState {...users} retry={users.refresh}>
        {!shownUsers.length ? <CardBody><span className="muted">{query.trim() ? "No matching accounts" : "No accounts"}</span></CardBody>
          : shownUsers.map(user => <Row key={user.id}
            leading={<IdentityBadge name={user.displayName} id={user.id} />}
            title={user.displayName}
            hint={<>{usernameWithId(user)} · {count(user.workspaces, "workspace", "workspaces")} · {count(user.hosts, "host", "hosts")} · {count(user.sessions, "session", "sessions")} · Joined <RelativeTime value={user.createdAt} /></>}
            trailing={<>
              {user.instanceAdmin && <StatusBadge tone="success">Administrator</StatusBadge>}
              {user.suspendedAt && <StatusBadge tone="danger">Suspended</StatusBadge>}
              {!user.instanceAdmin && <DropdownMenu label={`Actions for ${user.displayName}`} items={[user.suspendedAt
                ? { label: "Unsuspend", icon: "refresh", disabled: action.busy, onSelect: () => unsuspend(user) }
                : { label: "Suspend", icon: "lock", destructive: true, disabled: action.busy, onSelect: () => void suspend(user) }]} />}
            </>} />)}
        <Truncated list={users.data} />
        {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
      </ResourceState>
    </Section>

    <Section title="Workspaces">
      <ResourceState {...workspaces} retry={workspaces.refresh}>
        {!shownWorkspaces.length ? <CardBody><span className="muted">{query.trim() ? "No matching workspaces" : "No workspaces"}</span></CardBody>
          : shownWorkspaces.map(item => <Row key={item.id}
            leading={<IdentityBadge name={item.name} id={item.id} />}
            title={item.name}
            hint={<>Owner {usernameWithId({ id: item.ownerId, githubLogin: item.ownerGithubLogin })} · {count(item.members, "member", "members")} · {count(item.repositories, "repository", "repositories")} · {count(item.hosts, "host", "hosts")} · {count(item.sessions, "session", "sessions")} · Created <RelativeTime value={item.createdAt} /></>} />)}
        <Truncated list={workspaces.data} />
      </ResourceState>
    </Section>

    <Section title="Hosts" info="Every paired host that hasn't been removed. A suspended account's hosts stay paired but can't connect until it is unsuspended.">
      <ResourceState {...hosts} retry={hosts.refresh}>
        {!shownHosts.length ? <CardBody><span className="muted">{query.trim() ? "No matching hosts" : "No hosts"}</span></CardBody>
          : shownHosts.map(host => {
            const [tone, label]: [Tone, string] = host.revokedAt ? ["danger", "Revoked"] : host.online ? ["success", "Online"] : ["neutral", "Offline"];
            return <Row key={host.id}
              leading={<StatusDot tone={tone} label={label} />}
              title={host.name}
              hint={<>{usernameWithId({ id: host.ownerId, githubLogin: host.ownerGithubLogin })} · {count(host.workspaces, "workspace", "workspaces")} · {count(host.sessions, "session", "sessions")}{host.lastSeenAt && <> · Last connected <RelativeTime value={host.lastSeenAt} /></>}</>}
              trailing={<StatusBadge tone={tone}>{label}</StatusBadge>} />;
          })}
        <Truncated list={hosts.data} />
      </ResourceState>
    </Section>
  </>;
}
