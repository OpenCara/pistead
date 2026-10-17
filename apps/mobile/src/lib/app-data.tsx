import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionActivity, SessionRecord, Workspace } from "../../../../packages/shared/src/types";
import { useResource } from "./resource";

/** What the open session's live view says its agent is doing; fresher than the list's last fetch. */
export interface LiveActivity {
  sessionId: string;
  activity: SessionActivity;
}

interface AppData {
  /** Every session the user can read, newest first. */
  sessions: SessionRecord[];
  sessionsLoading: boolean;
  /** A reload is in flight, including background ones. */
  sessionsReloading: boolean;
  sessionsError: string;
  refreshSessions: () => void;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspacesError: string;
  refreshWorkspaces: () => void;
  /** The workspace the last session was started in; new sessions default to it. */
  lastWorkspaceId: string;
  setLastWorkspaceId: (id: string) => void;
  liveActivity: LiveActivity | null;
  setLiveActivity: (value: LiveActivity | null) => void;
}

const AppDataContext = createContext<AppData | null>(null);

export function useAppData(): AppData {
  const value = useContext(AppDataContext);
  if (!value) throw new Error("useAppData must be used inside AppDataProvider");
  return value;
}

/** Lists shared by the session list, the session header and the new-session form. Mounted only while signed in. */
export function AppDataProvider({ children }: { children: ReactNode }) {
  // Kept current like the web sidebar, sooner while an agent is at work, here or as last listed; paused in the
  // background. Waiting lasts as long as an undecided approval card, so it keeps the slower pace.
  const [fast, setFast] = useState(false);
  const sessions = useResource<{ sessions: SessionRecord[] }>("/api/sessions", fast ? 10_000 : 30_000);
  const workspaces = useResource<{ workspaces: Workspace[] }>("/api/workspaces");
  const [lastWorkspaceId, setLastWorkspaceId] = useState("");
  const [liveActivity, setLiveActivity] = useState<LiveActivity | null>(null);
  const working = liveActivity?.activity === "working"
    || (sessions.data?.sessions ?? []).some(session => session.status !== "archived" && session.activity === "working");
  useEffect(() => { setFast(working); }, [working]);
  const sorted = useMemo(() => [...(sessions.data?.sessions ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [sessions.data]);
  const value: AppData = {
    sessions: sorted,
    // Keep the previous list visible while a background refresh is in flight.
    sessionsLoading: sessions.loading && !sessions.data,
    sessionsReloading: sessions.loading,
    sessionsError: sessions.error,
    refreshSessions: sessions.refresh,
    workspaces: workspaces.data?.workspaces ?? [],
    workspacesLoading: workspaces.loading && !workspaces.data,
    workspacesError: workspaces.error,
    refreshWorkspaces: workspaces.refresh,
    lastWorkspaceId,
    setLastWorkspaceId,
    liveActivity,
    setLiveActivity,
  };
  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}
