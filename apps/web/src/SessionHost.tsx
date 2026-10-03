import type { SessionRecord, UserProfile } from "../../../packages/shared/src/types";
import { segment } from "./api";
import { ConnectionStatus, HostCapabilities, useConnections } from "./Connections";
import { Feedback } from "./ui";

export function SessionHost({ session, user }: { session: SessionRecord; user: UserProfile }) {
  const hosts = useConnections(session.connectorId ? `/api/workspaces/${segment(session.workspaceId)}/connectors` : null);
  const host = hosts.data?.connectors.find(item => item.id === session.connectorId);
  return <section className="session-host" aria-label="Agent host identity"><div className="section-heading"><h2>Agent host</h2>{host && <ConnectionStatus connector={host} />}</div>
    <p>Session owner: <strong>{session.ownerId === user.id ? "you" : session.ownerId}</strong>. This is the identity used for session work, not necessarily the person hosting the agent.</p>
    {session.hostUnsandboxed && !host && <p className="notice danger">This session's host runs without a sandbox: approved work executes directly on the host owner's machine with their full user permissions, network access and no resource limits.</p>}
    {!session.connectorId ? <p className="metadata">This is an existing operator-managed session; no local connector is pinned.</p> : <><p>Host: <strong>{host?.name ?? session.connectorId}</strong>. Host owner: <strong>{host?.ownerName ?? session.connectorOwnerId ?? "Unavailable"}</strong>{session.connectorOwnerId === user.id ? " (you)" : ""}.</p><p className="metadata">Connection ID: {session.connectorId}</p>{hosts.loading ? <p role="status">Checking host availability...</p> : host ? <HostCapabilities connector={host} /> : !hosts.error && <p className="notice">The pinned host is not available in your connection catalog. A private, owner-only Pi may be hidden from you even while this session is workspace-visible. The host may also have been unshared or revoked. Viewing a session does not grant permission to use its host; new work is subject to current host authorization.</p>}<Feedback error={hosts.error} /><p className="metadata">The host operator can access prompts and files processed on this machine. Sharing a Pi lets members run their own sessions on it; it does not change session visibility or permissions, or expose private local Pi history. Workspace-visible sessions are read-only for members unless explicitly granted more permissions, and do not grant use of a private host.</p></>}
  </section>;
}
