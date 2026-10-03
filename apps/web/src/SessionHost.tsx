import type { SessionRecord, UserProfile } from "../../../packages/shared/src/types";
import { segment } from "./api";
import { ConnectionStatus, HostCapabilities, useConnections } from "./Connections";
import { Details, Feedback } from "./ui";

export function SessionHost({ session, user }: { session: SessionRecord; user: UserProfile }) {
  const hosts = useConnections(session.connectorId ? `/api/workspaces/${segment(session.workspaceId)}/connectors` : null);
  const host = hosts.data?.connectors.find(item => item.id === session.connectorId);
  return <>
    <Details summary={<>Host{host ? <ConnectionStatus connector={host} /> : session.hostUnsandboxed && <span className="badge danger">Unsandboxed</span>}</>}>
      {!session.connectorId ? <p>Operator-managed session; no local host is pinned.</p> : <>
        <p><strong>{host?.name ?? "Pinned host"}</strong>, hosted by <strong>{host?.ownerName ?? session.connectorOwnerId ?? "unknown"}</strong>{session.connectorOwnerId === user.id ? " (you)" : ""}.</p>
        {hosts.loading ? <p role="status">Checking host availability...</p> : host ? <HostCapabilities connector={host} /> : !hosts.error && <p className="notice">This host isn't in your connection list. It may be private to its owner, unshared, or revoked. Viewing a session doesn't let you use its host.</p>}
        <p className="metadata">Connection ID: <code>{session.connectorId}</code></p>
      </>}
      <p className="metadata">Work runs as the session owner ({session.ownerId === user.id ? "you" : session.ownerId}), not the host owner. The host operator can access prompts and files processed on it. Sharing a host doesn't change who can view or control this session, and doesn't expose its owner's local history.</p>
    </Details>
    <Feedback error={hosts.error} />
  </>;
}
