import type { SessionRecord, UserProfile } from "../../../packages/shared/src/types";
import { segment } from "./api";
import { ConnectionStatus, HostCapabilities, useConnections } from "./Connections";
import { Feedback } from "./ui";

export function SessionHost({ session, user }: { session: SessionRecord; user: UserProfile }) {
  const hosts = useConnections(session.connectorId ? `/api/workspaces/${segment(session.workspaceId)}/connectors` : null);
  const host = hosts.data?.connectors.find(item => item.id === session.connectorId);
  return <section className="session-host" aria-label="Agent host identity"><div className="section-heading"><h2>Agent host</h2>{host && <ConnectionStatus connector={host} />}</div>
    <p>Session owner: <strong>{session.ownerId === user.id ? "you" : session.ownerId}</strong>. This is the identity used for session work, not necessarily the person hosting the agent.</p>
    {!session.connectorId ? <p className="metadata">This is an existing operator-managed session; no local connector is pinned.</p> : <><p>Host: <strong>{host?.name ?? session.connectorId}</strong>. Host owner: <strong>{host?.ownerName ?? session.connectorOwnerId ?? "Unavailable"}</strong>{session.connectorOwnerId === user.id ? " (you)" : ""}.</p><p className="metadata">Connection ID: {session.connectorId}</p>{hosts.loading ? <p role="status">Checking host availability...</p> : host ? <HostCapabilities connector={host} /> : !hosts.error && <p className="notice">The pinned host is no longer in this workspace's shared catalog. It may have been unshared or revoked; new work is subject to current host authorization.</p>}<Feedback error={hosts.error} /><p className="metadata">The host operator can access prompts and files processed on this machine. Connection sharing never grants access to private local Pi history or other sessions.</p></>}
  </section>;
}
