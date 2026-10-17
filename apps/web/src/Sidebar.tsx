import { useState } from "react";
import type { SessionRecord, Workspace } from "../../../packages/shared/src/types";
import { useApp } from "./app-context";
import { Icon, Logo } from "./icons";
import { NewWorkspaceSheet } from "./NewWorkspaceSheet";
import { href, type Route } from "./router";
import { sessionStatus } from "./session-status";
import { DropdownMenu, IdentityBadge, Loading, RelativeTime, StatusDot } from "./ui";

const SESSIONS_PER_WORKSPACE = 6;
const COLLAPSED_KEY = "pistead.collapsedWorkspaces";

function readCollapsed(): string[] {
  try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]; } catch { return []; }
}

function WorkspaceGroup({ workspace, sessions, route, collapsed, toggle, onNavigate }: { workspace: Workspace; sessions: SessionRecord[]; route: Route; collapsed: boolean; toggle: () => void; onNavigate: () => void }) {
  const { user, selectWorkspace, liveActivity } = useApp();
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? sessions : sessions.slice(0, SESSIONS_PER_WORKSPACE);
  const newHref = href({ name: "new", workspaceId: workspace.id });
  return <div className="workspace-group">
    <div className="workspace-row">
      <button type="button" className="nav-item" onClick={toggle} aria-expanded={!collapsed} title={workspace.name}>
        <IdentityBadge name={workspace.name} id={workspace.id} />
        <span className="label">{workspace.name}</span>
      </button>
      <div className="row-actions">
        <a className="btn ghost xs icon-only" href={newHref} aria-label={`New session in ${workspace.name}`} title="New session" onClick={() => { selectWorkspace(workspace.id); onNavigate(); }}><Icon name="plus" size={14} /></a>
        <DropdownMenu label={`${workspace.name} options`} items={[
          { label: "New session", icon: "plus", onSelect: () => { selectWorkspace(workspace.id); window.location.hash = newHref; onNavigate(); } },
          { label: "Workspace settings", icon: "settings", onSelect: () => { window.location.hash = href({ name: "settings", section: "workspaces", id: workspace.id }); onNavigate(); } },
        ]} />
      </div>
    </div>
    {!collapsed && <ul>
      {visible.map(session => {
        const current = route.name === "session" && route.sessionId === session.id;
        const relation = session.ownerId === user.id ? null : session.permissions?.every(permission => permission === "read") ? "Viewer" : "Shared";
        // The session on screen shows what its live view shows, not what the list last fetched.
        const status = sessionStatus(session, liveActivity?.sessionId === session.id ? liveActivity.activity : undefined);
        return <li key={session.id}>
          <a className="nav-item session-item" href={href({ name: "session", sessionId: session.id })} aria-current={current ? "page" : undefined} onClick={() => { selectWorkspace(workspace.id); onNavigate(); }}>
            <StatusDot tone={status.tone} label={status.label ? undefined : session.status} />
            <span className="label">
              <span className="title">{session.title}</span>
              {(status.label || relation) && <span className="sub">
                {status.label && <span className={`session-status ${status.tone}`}>{status.label}</span>}
                {status.label && relation && " · "}{relation}
              </span>}
            </span>
            <span className="meta"><RelativeTime value={session.createdAt} /></span>
          </a>
        </li>;
      })}
      {sessions.length > SESSIONS_PER_WORKSPACE && <li><button type="button" className="nav-item sidebar-more" onClick={() => setExpanded(value => !value)}><span className="label muted">{expanded ? "Show less" : `Show ${sessions.length - SESSIONS_PER_WORKSPACE} more`}</span></button></li>}
      {!sessions.length && <li><a className="nav-item session-item" href={newHref} onClick={() => { selectWorkspace(workspace.id); onNavigate(); }}><span className="label muted">Start a session</span></a></li>}
    </ul>}
  </div>;
}

export function Sidebar({ route, onNavigate }: { route: Route; onNavigate: () => void }) {
  const { user, workspaces, workspacesLoading, workspacesError, sessions, sessionsLoading, currentWorkspace } = useApp();
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  function toggle(id: string) {
    setCollapsed(current => {
      const next = current.includes(id) ? current.filter(item => item !== id) : [...current, id];
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)); } catch { /* Ephemeral is fine. */ }
      return next;
    });
  }
  const newSessionHref = currentWorkspace ? href({ name: "new", workspaceId: currentWorkspace.id }) : undefined;
  return <aside className="sidebar" aria-label="Workspaces and sessions">
    <div className="sidebar-top">
      <a className="nav-item" href="#/" onClick={onNavigate}><Logo size={20} /><span className="label" style={{ color: "var(--foreground)", fontWeight: 500 }}>Pistead</span></a>
      {newSessionHref && <a className="nav-item" href={newSessionHref} onClick={onNavigate} aria-current={route.name === "new" ? "page" : undefined}><Icon name="plus" /><span className="label">New session</span></a>}
      <a className="nav-item" href={href({ name: "sessions" })} onClick={onNavigate} aria-current={route.name === "sessions" ? "page" : undefined}><Icon name="history" /><span className="label">Sessions</span></a>
    </div>
    <nav className="sidebar-scroll" aria-label="Workspaces">
      {workspacesLoading ? <div style={{ padding: 8 }}><Loading /></div>
        : workspacesError ? <p className="field-error" style={{ padding: 8 }}>{workspacesError}</p>
        : !workspaces.length ? <div className="empty-card">
          <div className="title">No workspaces yet</div>
          <div className="description">A workspace groups people, repositories, hosts and sessions.</div>
          <button type="button" className="btn secondary xs" onClick={() => setCreating(true)}>New workspace</button>
        </div>
        : workspaces.map(workspace => <WorkspaceGroup key={workspace.id} workspace={workspace} route={route} onNavigate={onNavigate}
          // Archived sessions live on the Sessions screen; the one being viewed stays listed so the sidebar keeps its place.
          sessions={sessions.filter(session => session.workspaceId === workspace.id
            && (session.status !== "archived" || (route.name === "session" && route.sessionId === session.id)))}
          collapsed={collapsed.includes(workspace.id)} toggle={() => toggle(workspace.id)} />)}
      {sessionsLoading && workspaces.length > 0 && <div style={{ padding: 8 }}><Loading>Loading sessions...</Loading></div>}
      {!workspacesLoading && workspaces.length > 0 && <button type="button" className="nav-item" style={{ marginTop: 12 }} onClick={() => setCreating(true)}><Icon name="plus" size={14} /><span className="label">New workspace</span></button>}
    </nav>
    <div className="sidebar-footer">
      <a className="nav-item host-chip" href={href({ name: "settings", section: "profile" })} onClick={onNavigate} title={user.displayName}>
        <IdentityBadge name={user.displayName} id={user.id} />
        <span className="label">{user.githubLogin ? `@${user.githubLogin}` : user.displayName}</span>
      </a>
      <a className="btn ghost sm icon-only" href={href({ name: "settings", section: "hosts" })} onClick={onNavigate} aria-label="Hosts" title="Hosts"><Icon name="server" /></a>
      <a className="btn ghost sm icon-only" href={href({ name: "settings", section: "profile" })} onClick={onNavigate} aria-label="Settings" title="Settings" aria-current={route.name === "settings" ? "page" : undefined}><Icon name="settings" /></a>
    </div>
    <NewWorkspaceSheet open={creating} onClose={() => { setCreating(false); onNavigate(); }} />
  </aside>;
}
