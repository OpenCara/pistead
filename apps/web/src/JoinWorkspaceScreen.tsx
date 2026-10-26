import { useCallback, useEffect, useState } from "react";
import type { OwnJoinRequest, WorkspaceInvite } from "../../../packages/shared/src/invites";
import { api, errorMessage, segment } from "./api";
import { useApp } from "./app-context";
import { Logo } from "./icons";
import { href } from "./router";
import { Alert, Button, CardBody, Feedback, LinkButton, PageLoading, RelativeTime, Row, Section, confirmDialog, useAction, useResource } from "./ui";

/** Where a sign-in started from an invite link keeps its token: GitHub's callback returns to the app's root without the fragment. */
const pendingInviteKey = "pistead.pendingInvite";

/** Remember an invite token across sign-in. Session storage keeps it to this tab and drops it with the tab. */
export function rememberInvite(token: string): void {
  try { sessionStorage.setItem(pendingInviteKey, token); } catch { /* Storage may be unavailable; the link can be opened again. */ }
}

/** The invite token a sign-in started from, once: reading it forgets it. */
export function takeRememberedInvite(): string | null {
  try {
    const token = sessionStorage.getItem(pendingInviteKey);
    sessionStorage.removeItem(pendingInviteKey);
    return token;
  } catch { return null; }
}

/** The invite as the signed-in visitor sees it. The token travels in a header, never in a request path. */
function useInvite(token: string) {
  const [invite, setInvite] = useState<WorkspaceInvite | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<{ invite: WorkspaceInvite }>("/api/invite", { headers: { "x-invite-token": token }, signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setInvite(result.invite);
    }).catch(reason => {
      if (!controller.signal.aborted) { setInvite(null); setError(errorMessage(reason)); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, revision]);
  return { invite, setInvite, loading, error, refresh };
}

/**
 * The signed-in person's own requests to join, each with Withdraw. They don't need the link they came through, which may
 * have been turned off or replaced since. Shows nothing while there are none.
 */
export function OwnJoinRequests() {
  const resource = useResource<{ requests: OwnJoinRequest[] }>("/api/join-requests");
  const action = useAction();
  const requests = resource.data?.requests ?? [];
  async function withdraw(request: OwnJoinRequest) {
    if (action.busy) return;
    const confirmed = await confirmDialog({ title: "Withdraw request", message: `Stop waiting to join ${request.workspaceName}? You can ask again while you have a working invite link.`, confirmLabel: "Withdraw", destructive: true });
    if (!confirmed) return;
    void action.run(async () => {
      await api(`/api/join-requests/${segment(request.workspaceId)}`, { method: "DELETE" });
      resource.refresh();
    }, "Request withdrawn.");
  }
  if (!requests.length && !action.notice) return null;
  return <Section title="Your requests to join" info="Workspaces you asked to join through an invite link. An owner or admin of each accepts or declines you.">
    {!requests.length
      ? <CardBody><span className="muted">You aren't waiting to join any workspace</span></CardBody>
      : requests.map(request => <Row key={request.workspaceId} title={request.workspaceName} hint={<>Waiting for approval · asked <RelativeTime value={request.createdAt} /></>}
        trailing={<Button variant="outline" size="sm" disabled={action.busy} aria-label={`Withdraw request to join ${request.workspaceName}`} onClick={() => void withdraw(request)}>Withdraw</Button>} />)}
    {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
  </Section>;
}

/**
 * An invite link, opened while signed in: shows the workspace's name and lets the visitor ask to join. Asking makes them a
 * pending member, who can see and do nothing in the workspace until an owner or admin accepts them with a role.
 */
export function JoinWorkspaceScreen({ token }: { token: string }) {
  const { refreshWorkspaces } = useApp();
  const { invite, setInvite, loading, error, refresh } = useInvite(token);
  const action = useAction();
  useEffect(() => { if (invite?.status === "member") refreshWorkspaces(); }, [invite?.status, refreshWorkspaces]);

  function ask() {
    if (action.busy) return;
    void action.run(async () => {
      setInvite((await api<{ invite: WorkspaceInvite }>("/api/invite", { method: "POST", body: { token } })).invite);
    });
  }
  function withdraw() {
    if (action.busy) return;
    void action.run(async () => {
      setInvite((await api<{ invite: WorkspaceInvite }>("/api/invite", { method: "DELETE", headers: { "x-invite-token": token } })).invite);
    }, "Request withdrawn.");
  }

  if (loading && !invite) return <PageLoading />;
  return <div className="welcome">
    <div className="welcome-inner">
      <Logo size={40} />
      {!invite
        ? <>
          <h1>Join a workspace</h1>
          <Alert variant="error" title="Invite link not available" actions={<Button size="sm" onClick={refresh}>Try again</Button>}>{error}</Alert>
          <div className="actions"><LinkButton href={href({ name: "home" })}>Go to Pistead</LinkButton></div>
          {/* A request outlives a link that was turned off or replaced, so its requester can still withdraw it here. */}
          <OwnJoinRequests />
        </>
        : <>
          <h1>{invite.workspaceName}</h1>
          {invite.status === "none" && <>
            <p>You're invited to join this workspace. Ask to join, and an owner or admin reviews your request and chooses your role. Until they accept you, you can't see or do anything in it.</p>
            <div className="actions"><Button variant="default" size="lg" disabled={action.busy} onClick={ask}>{action.busy ? "Asking..." : "Ask to join"}</Button></div>
          </>}
          {invite.status === "pending" && <>
            <Alert variant="info" title="Waiting for approval" role="status">Your request to join was sent. Once an owner or admin of {invite.workspaceName} accepts you, the workspace appears in your sidebar.</Alert>
            <div className="actions">
              <Button disabled={action.busy || loading} onClick={refresh}>Check again</Button>
              <Button variant="ghost" disabled={action.busy} onClick={withdraw}>Withdraw request</Button>
            </div>
          </>}
          {invite.status === "member" && <>
            <Alert variant="success" title="You're a member" role="status">You're a member of {invite.workspaceName}.</Alert>
            <div className="actions"><LinkButton variant="default" href={invite.workspaceId ? href({ name: "settings", section: "workspaces", id: invite.workspaceId }) : href({ name: "home" })}>Open workspace</LinkButton></div>
          </>}
          <Feedback {...action} />
        </>}
    </div>
  </div>;
}
