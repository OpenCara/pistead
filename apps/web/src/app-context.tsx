import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionRecord, UserProfile, Workspace } from "../../../packages/shared/src/types";
import { useResource } from "./ui";

const WORKSPACE_KEY = "pistead.workspace";

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
  const [workspaceId, setWorkspaceId] = useState(() => {
    try { return localStorage.getItem(WORKSPACE_KEY) ?? ""; } catch { return ""; }
  });
  const selectWorkspace = useCallback((id: string) => {
    setWorkspaceId(id);
    try { localStorage.setItem(WORKSPACE_KEY, id); } catch { /* Private mode keeps the in-memory choice. */ }
  }, []);
  // Keep the sidebar current without a manual refresh; paused while the tab is hidden.
  const refreshSessions = sessions.refresh;
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) refreshSessions(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [refreshSessions]);
  const list = workspaces.data?.workspaces ?? [];
  const current = list.find(workspace => workspace.id === workspaceId) ?? list[0] ?? null;
  const sorted = useMemo(() => [...(sessions.data?.sessions ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [sessions.data]);
  const value: AppState = {
    user, setUser, signOut,
    workspaces: list, workspacesLoading: workspaces.loading, workspacesError: workspaces.error, refreshWorkspaces: workspaces.refresh,
    currentWorkspace: current, selectWorkspace,
    // Keep the previous list visible while a background refresh is in flight.
    sessions: sorted, sessionsLoading: sessions.loading && !sessions.data, refreshSessions,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
