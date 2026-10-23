import { useMemo, useState, type FormEvent } from "react";
import type { SessionRecord } from "../../../packages/shared/src/types";
import { api, segment } from "./api";
import { useApp } from "./app-context";
import { href, navigate } from "./router";
import { sessionStatus } from "../../../packages/client/src/session-status";
import { Button, EmptyState, Feedback, Field, IdentityBadge, InfoTip, LinkButton, PageLoading, RelativeTime, Row, ScreenHeader, Section, Sheet, StatusDot, useAction } from "./ui";
import "./new-session.css";

const PAGE_SIZE = 50;

export function SessionsScreen() {
  const { user, sessions, sessionsLoading, workspaces, currentWorkspace } = useApp();
  const [query, setQuery] = useState("");
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [joinOpen, setJoinOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = useMemo(() => sessions.filter(session => session.status === "archived").length, [sessions]);

  // Newest-first sessions grouped by workspace: the current workspace first, then the sidebar order.
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const byWorkspace = new Map<string, SessionRecord[]>();
    for (const session of sessions) {
      if (session.status === "archived" && !showArchived) continue;
      if (needle && !session.title.toLowerCase().includes(needle)) continue;
      const list = byWorkspace.get(session.workspaceId);
      if (list) list.push(session);
      else byWorkspace.set(session.workspaceId, [session]);
    }
    const order = [currentWorkspace?.id, ...workspaces.map(workspace => workspace.id)];
    const rank = (id: string) => { const index = order.indexOf(id); return index < 0 ? order.length : index; };
    return [...byWorkspace.entries()].sort(([a], [b]) => rank(a) - rank(b)).map(([id, list]) => ({ id, name: workspaces.find(workspace => workspace.id === id)?.name ?? "Other workspace", sessions: list }));
  }, [sessions, query, showArchived, workspaces, currentWorkspace?.id]);

  const header = <ScreenHeader title="Sessions" actions={<>
    <InfoTip label="Who can see a session">
      <div className="stack">
        <p>Private sessions are visible to their owner and people with an explicit grant. Workspace-visible sessions can be viewed by every workspace member.</p>
        <p>Viewing never allows asking, writing, approving or managing; those need separate grants. Opening a session keeps its original owner identity and history.</p>
        <p>Only the owner can change visibility, which is separate from sharing a host.</p>
      </div>
    </InfoTip>
    {archivedCount > 0 && <Button variant="ghost" size="sm" icon="archive" aria-pressed={showArchived} onClick={() => setShowArchived(value => !value)}>
      {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
    </Button>}
    <Button variant="outline" size="sm" onClick={() => setJoinOpen(true)}>Open by ID</Button>
  </>} />;
  const sheet = <OpenSessionSheet open={joinOpen} onClose={() => setJoinOpen(false)} />;

  if (sessionsLoading) return <>{header}<PageLoading />{sheet}</>;
  if (!sessions.length) return <>{header}<EmptyState title="No sessions yet" action={currentWorkspace && <LinkButton variant="ghost" href={href({ name: "new", workspaceId: currentWorkspace.id })}>Start a session</LinkButton>} />{sheet}</>;

  return <>
    {header}
    <div className="content-column">
      <input className="input sessions-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search sessions" aria-label="Search sessions by title" />
      {!groups.length ? <EmptyState title={!query.trim() && !showArchived ? "All sessions are archived" : "No matching sessions"} /> : groups.map(group => {
        const limit = limits[group.id] ?? PAGE_SIZE;
        return <Section key={group.id} title={<span className="inline"><IdentityBadge name={group.name} id={group.id} />{group.name}</span>}>
          {group.sessions.slice(0, limit).map(session => {
            const isOwner = session.ownerId === user.id;
            const viewerOnly = !isOwner && session.permissions?.includes("read") && session.permissions.every(permission => permission === "read");
            const status = sessionStatus(session);
            return <Row key={session.id} href={href({ name: "session", sessionId: session.id })} chevron
              leading={<StatusDot tone={status.tone} label={status.label ? undefined : session.status} />}
              title={<span className="truncate">{session.title}</span>}
              hint={<>{status.label && <><span className={`session-status ${status.tone}`}>{status.label}</span> · </>}{isOwner ? "Yours" : viewerOnly ? "Viewer" : "Shared"} · {session.visibility === "workspace" ? "Workspace-visible" : "Private"} · <RelativeTime value={session.createdAt} /></>} />;
          })}
          {group.sessions.length > limit && <div className="sessions-more"><Button variant="ghost" size="sm" block onClick={() => setLimits(current => ({ ...current, [group.id]: limit + PAGE_SIZE }))}>Load more</Button></div>}
        </Section>;
      })}
    </div>
    {sheet}
  </>;
}

function OpenSessionSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [joinId, setJoinId] = useState("");
  const action = useAction();
  function join(event: FormEvent) {
    event.preventDefault();
    if (!joinId.trim() || action.busy) return;
    void action.run(async () => {
      const result = await api<{ session: SessionRecord }>(`/api/sessions/${segment(joinId.trim())}`);
      onClose();
      setJoinId("");
      navigate({ name: "session", sessionId: result.session.id });
    });
  }
  return <Sheet open={open} title="Open a session by ID" onClose={onClose} footer={<>
    <Button variant="ghost" onClick={onClose}>Cancel</Button>
    <Button type="submit" form="open-session-form" variant="default" disabled={action.busy || !joinId.trim()}>{action.busy ? "Checking access..." : "Open session"}</Button>
  </>}>
    <form id="open-session-form" className="stack" onSubmit={join}>
      <Field label="Session ID" hint="Ask the session owner for its ID">
        <input className="input" required autoFocus value={joinId} onChange={event => setJoinId(event.target.value)} autoComplete="off" />
      </Field>
      <Feedback error={action.error} />
    </form>
  </Sheet>;
}
