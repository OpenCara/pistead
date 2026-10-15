import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionActivity, SessionRecord, UserProfile, Workspace } from "../../../packages/shared/src/types";
import { useResource } from "./ui";

const WORKSPACE_KEY = "pistead.workspace";

/** The activity in the live view of the session on screen. */
export interface LiveActivity {
  sessionId: string;
  activity: SessionActivity;
}

export interface AppState {
  user: UserProfile;
  setUser: (user: UserProfile) => void;
  signOut: () => void;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspacesError: string;
  refreshWorkspaces: () => void;
  /** The workspace new sessions default to; persisted across reloads. */
  currentWorkspace: Workspace | null;
  selectWorkspace: (id: string) => void;
  /** Every session the user can read, newest first. */
  sessions: SessionRecord[];
  sessionsLoading: boolean;
  refreshSessions: () => void;
  /** Session lists show this ahead of the listed activity, which is only as fresh as the last refresh. */
  liveActivity: LiveActivity | null;
  setLiveActivity: (value: LiveActivity | null) => void;
}

const Context = createContext<AppState | null>(null);

export function useApp(): AppState {
  const value = useContext(Context);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}

export function AppProvider({ user, setUser, signOut, children }: { user: UserProfile; setUser: (user: UserProfile) => void; signOut: () => void; children: ReactNode }) {
  const workspaces = useResource<{ workspaces: Workspace[] }>("/api/workspaces");
  const sessions = useResource<{ sessions: SessionRecord[] }>("/api/sessions");
  const [liveActivity, setLiveActivity] = useState<LiveActivity | null>(null);
  const [workspaceId, setWorkspaceId] = useState(() => {
    try { return localStorage.getItem(WORKSPACE_KEY) ?? ""; } catch { return ""; }
  });
  const selectWorkspace = useCallback((id: string) => {
    setWorkspaceId(id);
    try { localStorage.setItem(WORKSPACE_KEY, id); } catch { /* Private mode keeps the in-memory choice. */ }
  }, []);
  // Keep the sidebar current without a manual refresh, sooner while an agent is at work; paused while the tab is hidden.
  const refreshSessions = sessions.refresh;
  const working = (sessions.data?.sessions ?? []).some(session => session.status !== "archived" && session.activity === "working");
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) refreshSessions(); }, working ? 10_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [refreshSessions, working]);
  const list = workspaces.data?.workspaces ?? [];
  const current = list.find(workspace => workspace.id === workspaceId) ?? list[0] ?? null;
  const sorted = useMemo(() => [...(sessions.data?.sessions ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [sessions.data]);
  const value: AppState = {
    user, setUser, signOut,
    workspaces: list, workspacesLoading: workspaces.loading, workspacesError: workspaces.error, refreshWorkspaces: workspaces.refresh,
    currentWorkspace: current, selectWorkspace,
    // Keep the previous list visible while a background refresh is in flight.
    sessions: sorted, sessionsLoading: sessions.loading && !sessions.data, refreshSessions,
    liveActivity, setLiveActivity,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
