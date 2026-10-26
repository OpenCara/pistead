import { useState } from "react";
import type { ConnectorInfo, HostCommandGrant } from "../../../../packages/shared/src/connector";
import type { HostCommandLevel } from "../../../../packages/shared/src/types";
import { memberPerson, usernameWithId, type WorkspaceMember } from "../../../../packages/client/src/usernames";
import { api, segment } from "../api";
import { useApp } from "../app-context";
import { Button, Combobox, confirmDialog, Feedback, Row, Section, StatusBadge, Timestamp, useAction, useResource } from "../ui";

/*
 * Host sharing beyond its owner: admins, who manage the host's shares and host command grants, and the grants
 * themselves, which let members of a shared workspace decide host commands or run their own without asking.
 */

const levelLabels: Record<HostCommandLevel, { label: string; hint: string }> = {
  approve: { label: "Approve host commands", hint: "Decides each host command in sessions they can approve" },
  auto: { label: "Auto-approve host commands", hint: "Also runs the host commands of their own Auto-approve messages without asking" },
};

const expiries = [
  { value: "never", label: "No expiry", days: 0 },
  { value: "1", label: "1 day", days: 1 },
  { value: "7", label: "7 days", days: 7 },
  { value: "30", label: "30 days", days: 30 },
] as const;
type Expiry = (typeof expiries)[number]["value"];

const EVERYONE = "*";

function useMembers(workspaceId: string | undefined) {
  return useResource<{ members: WorkspaceMember[] }>(workspaceId ? `/api/workspaces/${segment(workspaceId)}/members` : null);
}

/** Who manages this host's sharing besides its owner. Only the owner adds or removes them; an admin may step down. */
export function HostAdminsSection({ connector, refresh }: { connector: ConnectorInfo; refresh: () => void }) {
  const { user, workspaces } = useApp();
  const action = useAction();
  const owner = connector.role === "owner";
  const admins = connector.admins ?? [];
  // Candidates come from the workspaces the host is connected to, where the owner can see members.
  const connected = workspaces.filter(workspace => (connector.connectedWorkspaceIds ?? connector.workspaceIds).includes(workspace.id));
  const [workspaceId, setWorkspaceId] = useState("");
  const source = connected.find(workspace => workspace.id === workspaceId) ?? connected[0];
  const members = useMembers(owner ? source?.id : undefined);
  const candidates = (members.data?.members ?? []).filter(member => member.userId !== connector.ownerId && !admins.some(admin => admin.userId === member.userId));
  const [userId, setUserId] = useState("");
  const chosen = candidates.find(member => member.userId === userId) ?? candidates[0];

  function add() {
    if (!chosen) return;
    void (async () => {
      if (!await confirmDialog({ title: `Make ${usernameWithId(memberPerson(chosen))} an admin?`, message: `They will manage ${connector.name}'s sharing: share it with workspaces you both belong to, and grant members host commands there, including themselves. Host commands run on your machine with your files, credentials and network. Only you can add admins, revoke or remove the host.`, confirmLabel: "Add admin", destructive: true })) return;
      await action.run(async () => {
        await api(`/api/connectors/${segment(connector.id)}/admins/${segment(chosen.userId)}`, { method: "PUT", body: {} });
        refresh();
      }, "Admin added.");
    })();
  }
  function remove(adminId: string) {
    const self = adminId === user.id;
    void (async () => {
      if (!await confirmDialog({ title: self ? "Stop managing this host?" : "Remove this admin?", message: self ? "You will no longer manage its sharing. Grants already given stay until someone removes them." : "They will no longer manage its sharing. Grants they gave stay until someone removes them.", confirmLabel: self ? "Step down" : "Remove admin" })) return;
      await action.run(async () => {
        await api(`/api/connectors/${segment(connector.id)}/admins/${segment(adminId)}`, { method: "DELETE" });
        refresh();
      }, self ? "You no longer manage this host." : "Admin removed.");
    })();
  }

  return <Section title="Admins" bare info="Admins manage this host's sharing for you: its workspace shares and host command grants. They hold no host command access of their own unless a grant gives it to them, and only the owner can add admins, revoke or remove the host.">
    <div className="card">
      {!admins.length && <Row title="No admins" hint={owner ? "Only you manage this host" : undefined} />}
      {admins.map(admin => <Row key={admin.userId} title={admin.name || admin.userId} hint={<>Admin since <Timestamp value={admin.createdAt} /></>}
        trailing={(owner || admin.userId === user.id) && <Button variant="outline" size="sm" disabled={action.busy} onClick={() => remove(admin.userId)}>{admin.userId === user.id ? "Step down" : "Remove"}</Button>} />)}
      {owner && !connector.revokedAt && (connected.length ? <Row title="Add admin" hint={members.loading ? "Loading members..." : !candidates.length ? `No other members in ${source?.name ?? "this workspace"}` : "A member of a workspace this host is connected to"} trailing={<>
        {connected.length > 1 && <Combobox label="Workspace" value={source?.id ?? ""} options={connected.map(workspace => ({ value: workspace.id, label: workspace.name }))} onChange={value => { setWorkspaceId(value); setUserId(""); }} disabled={action.busy} />}
        {candidates.length > 0 && <Combobox label="Member" value={chosen?.userId ?? ""} options={candidates.map(member => ({ value: member.userId, label: usernameWithId(memberPerson(member)) }))} onChange={setUserId} disabled={action.busy} />}
        <Button variant="outline" size="sm" disabled={action.busy || !chosen} onClick={add}>Add</Button>
      </>} /> : <Row title="Add admin" hint="Connect the host to a workspace first" />)}
    </div>
    <Feedback error={action.error} notice={action.notice} />
  </Section>;
}

function grantHint(grant: HostCommandGrant) {
  return <>{levelLabels[grant.level].hint}{grant.expiresAt ? <> · expires <Timestamp value={grant.expiresAt} /></> : " · no expiry"}</>;
}

/** Who may decide host commands, or run their own without asking, in the workspaces this host is shared with. */
export function HostCommandGrantsSection({ connector, refresh }: { connector: ConnectorInfo; refresh: () => void }) {
  const { workspaces } = useApp();
  const action = useAction();
  const grants = connector.hostGrants ?? [];
  const names = new Map(workspaces.map(workspace => [workspace.id, workspace.name]));
  const shared = workspaces.filter(workspace => connector.workspaceIds.includes(workspace.id));
  const [workspaceId, setWorkspaceId] = useState("");
  const target = shared.find(workspace => workspace.id === workspaceId) ?? shared[0];
  const members = useMembers(target?.id);
  const eligible = (members.data?.members ?? []).filter(member => member.userId !== connector.ownerId && member.role !== "viewer");
  const [grantee, setGrantee] = useState(EVERYONE);
  const [level, setLevel] = useState<HostCommandLevel>("approve");
  const [expiry, setExpiry] = useState<Expiry>("7");
  const member = eligible.find(item => item.userId === grantee);
  const who = member ? usernameWithId(memberPerson(member)) : `every member of ${target?.name ?? "the workspace"}`;

  function grant() {
    if (!target) return;
    void (async () => {
      const auto = level === "auto";
      if (!await confirmDialog({
        title: auto ? "Grant automatic host commands?" : "Grant host command approval?",
        message: auto
          ? `${who} will be able to run host_bash on ${connector.name} OUTSIDE the sandbox without anyone approving each command, whenever they send a message with Auto-approve. Commands run on the owner's machine as its user, with its files, credentials and network, and no resource limits.`
          : `${who} will be able to approve host_bash commands on ${connector.name}, which run OUTSIDE the sandbox on the owner's machine with its files, credentials and network.`,
        confirmLabel: "Grant", destructive: auto,
      })) return;
      const days = expiries.find(item => item.value === expiry)!.days;
      await action.run(async () => {
        await api(`/api/connectors/${segment(connector.id)}/host-grants/${segment(target.id)}`, { method: "PUT", body: {
          ...(member ? { userId: member.userId } : {}), level, ...(days ? { expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() } : {}),
        } });
        refresh();
      }, "Host command access granted.");
    })();
  }
  function revoke(item: HostCommandGrant) {
    void action.run(async () => {
      const query = item.userId ? `?userId=${encodeURIComponent(item.userId)}` : "";
      await api(`/api/connectors/${segment(connector.id)}/host-grants/${segment(item.workspaceId)}${query}`, { method: "DELETE" });
      refresh();
    }, "Host command access removed.");
  }

  return <Section title="Host command access" bare info="host_bash runs OUTSIDE the sandbox, on this machine as its user. By default only the owner decides those commands. Grant members of a shared workspace the right to approve them, or to run their own without asking under Auto-approve. Grants end when they expire, when you remove them, or when the host stops being shared there.">
    <div className="card">
      {!grants.length && <Row title="Only the owner" hint="No one else decides host commands on this host" />}
      {grants.map(item => <Row key={`${item.workspaceId}:${item.userId ?? ""}`}
        title={<>{item.userId ? item.userName ?? item.userId : "All members"} <span className="muted">· {names.get(item.workspaceId) ?? item.workspaceId}</span></>}
        hint={grantHint(item)}
        trailing={<>
          <StatusBadge tone={item.level === "auto" ? "warning" : "neutral"}>{item.level === "auto" ? "Auto-approve" : "Approve"}</StatusBadge>
          <Button variant="outline" size="sm" disabled={action.busy} onClick={() => revoke(item)}>Remove</Button>
        </>} />)}
      {!connector.revokedAt && (shared.length ? <Row title="Grant access" hint={members.loading ? "Loading members..." : levelLabels[level].hint} trailing={<>
        {shared.length > 1 && <Combobox label="Workspace" value={target?.id ?? ""} options={shared.map(workspace => ({ value: workspace.id, label: workspace.name }))} onChange={value => { setWorkspaceId(value); setGrantee(EVERYONE); }} disabled={action.busy} />}
        <Combobox label="Member" value={member ? member.userId : EVERYONE} options={[{ value: EVERYONE, label: "All members" }, ...eligible.map(item => ({ value: item.userId, label: usernameWithId(memberPerson(item)) }))]} onChange={setGrantee} disabled={action.busy} />
        <Combobox<HostCommandLevel> label="Access" value={level} options={(["approve", "auto"] as const).map(value => ({ value, label: levelLabels[value].label }))} onChange={setLevel} disabled={action.busy} />
        <Combobox<Expiry> label="Expires" value={expiry} options={expiries.map(item => ({ value: item.value, label: item.label }))} onChange={setExpiry} disabled={action.busy} />
        <Button variant="outline" size="sm" disabled={action.busy || !target} onClick={grant}>Grant</Button>
      </>} /> : <Row title="Grant access" hint="Share the host with a workspace first" />)}
    </div>
    {!connector.capabilities.hostGrants && <Row title="Update the host's connector" hint="This host's connector predates grants: until it is updated (npx pistead@latest connect), only the owner decides its host commands." />}
    <Feedback error={action.error} notice={action.notice} />
  </Section>;
}
