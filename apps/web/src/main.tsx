import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { UserProfile, Workspace } from "../../../packages/shared/src/types";
import { api, ApiError, errorMessage } from "./api";
import { Feedback, useAction, useResource } from "./ui";
import { Profile } from "./Profile";
import { Workspaces } from "./Workspaces";
import { AgentLibrary } from "./AgentLibrary";
import { Sessions } from "./Sessions";
import { SessionDetail } from "./SessionDetail";
import { Connections } from "./Connections";
import "./styles.css";

type Page = "workspaces" | "agents" | "sessions" | "connections" | "profile";
const navigation: { id: Page; label: string; number: string }[] = [
  { id: "workspaces", label: "Workspaces", number: "01" },
  { id: "agents", label: "Agent Library", number: "02" },
  { id: "sessions", label: "Sessions", number: "03" },
  { id: "connections", label: "Connections", number: "04" },
  { id: "profile", label: "Profile", number: "05" },
];

function App() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [route, setRoute] = useState(window.location.hash.slice(1) || "workspaces");
  const [workspaceId, setWorkspaceId] = useState("");
  const logout = useAction();
  const workspaces = useResource<{ workspaces: Workspace[] }>(user ? "/api/workspaces" : null);
  const health = useResource<{ ok: boolean; githubConfigured?: boolean; runnerConfigured?: boolean }>(!user && !loading ? "/api/health" : null);
  const selectedWorkspace = workspaces.data?.workspaces.find(workspace => workspace.id === workspaceId) ?? workspaces.data?.workspaces[0] ?? null;
  const page = route.startsWith("session/") ? "sessions" : navigation.some(item => item.id === route) ? route as Page : "workspaces";
  let sessionId = "";
  if (route.startsWith("session/")) {
    try { sessionId = decodeURIComponent(route.slice(8)); } catch { sessionId = ""; }
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<{ user: UserProfile }>("/api/me", { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setUser(result.user);
    }).catch(reason => {
      if (controller.signal.aborted) return;
      setUser(null);
      if (!(reason instanceof ApiError && reason.status === 401)) setError(errorMessage(reason));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    const change = () => { setRoute(window.location.hash.slice(1) || "workspaces"); };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    document.title = `${sessionId ? "Session" : navigation.find(item => item.id === page)?.label ?? "Workspace"} | Agent Workspace`;
  }, [page, sessionId]);
  function navigate(destination: string) {
    window.location.hash = destination;
    setRoute(destination);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function openSession(id: string) {
    navigate(`session/${encodeURIComponent(id)}`);
  }
  const callbackError = new URLSearchParams(window.location.search).get("error");
  return <div className="app-shell">
    <a href="#main-content" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to content</a>
    <header className="masthead"><a className="brand" href="#workspaces" aria-label="Agent Workspace home"><span className="brand-mark" aria-hidden="true">aw.</span><span className="brand-name">Agent<br />Workspace</span></a><span className="header-meta">A shared place for deliberate work</span><div className="account">{user && <><span>{user.displayName}</span><button className="button secondary small" disabled={logout.busy} onClick={() => void logout.run(async () => { await api("/api/auth/logout", { method: "POST" }); setUser(null); setWorkspaceId(""); navigate("workspaces"); }, "Signed out.")}>{logout.busy ? "Signing out..." : "Log out"}</button></>}</div></header>
    <Feedback error={logout.error} />
    {loading ? <main id="main-content" className="page" tabIndex={-1}><p className="eyebrow">Agent Workspace</p><h1>Opening the workshop.</h1><p className="loading" role="status">Checking your sign-in...</p></main> : !user ? <main id="main-content" className="login-page" tabIndex={-1}><section className="login-intro"><p className="eyebrow">Think together. Act deliberately.</p><h1>Shared agents.<br />A signature<br />of your own.</h1><p className="lead">A workshop for agents worth reusing, and work worth doing together. Keep your identity. Choose what to share.</p><Feedback error={error || health.error || (callbackError ? `GitHub sign-in did not complete: ${callbackError.slice(0, 300)}` : "")} />{health.data?.githubConfigured === false ? <div className="notice" role="status"><strong>GitHub sign-in is not configured.</strong><p>The operator needs to configure the GitHub OAuth application, callback URL, and Worker authentication secrets. There is no test-login shortcut.</p></div> : <a className="button primary" href="/api/auth/github">Continue with GitHub</a>}{(error || health.error || health.data?.githubConfigured === false) && <div className="actions"><button className="button secondary" onClick={() => { setRevision(current => current + 1); health.refresh(); }}>Check connection again</button></div>}<p className="metadata">GitHub sign-in is handled by the server. Local model credentials stay on your Pi host.</p></section><aside className="login-aside"><span className="giant-number" aria-hidden="true">01 / 02</span><div className="section"><p className="eyebrow">01 / Reuse an agent</p><h2>Take the idea.<br />Start your own work.</h2><p>Choose a published definition to begin a fresh session under your own identity. No inherited history or credentials.</p></div><div className="section"><p className="eyebrow">02 / Share a session</p><h2>Join the work.<br />Respect the owner.</h2><p>Collaborate in an existing session with explicit read, ask, write, approve, or manage permissions.</p></div></aside></main> : <>
      <nav className="primary-nav" aria-label="Main navigation">{navigation.map(item => <button key={item.id} className={page === item.id ? "active" : ""} aria-current={page === item.id ? "page" : undefined} onClick={() => navigate(item.id)}><span className="mono">{item.number}</span> {item.label}</button>)}</nav>
      <div className="workspace-bar"><label htmlFor="workspace-selector">Current workspace</label><select id="workspace-selector" value={selectedWorkspace?.id ?? ""} onChange={event => setWorkspaceId(event.target.value)} disabled={workspaces.loading || !workspaces.data?.workspaces.length}><option value="" disabled>{workspaces.loading ? "Loading workspaces..." : "No workspace selected"}</option>{workspaces.data?.workspaces.map(workspace => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}</select><span className="workspace-context">{selectedWorkspace ? `${selectedWorkspace.role ?? "member"} / Workspace access is not session access` : "Create a workspace to begin"}</span></div>
      <main className="page" id="main-content" tabIndex={-1}>{workspaces.error && <div className="error" role="alert"><p>{workspaces.error}</p><button className="button secondary small" onClick={workspaces.refresh}>Reload workspaces</button></div>}
        {page === "profile" ? <Profile key={user.id} user={user} onSave={setUser} /> : page === "connections" ? <Connections user={user} workspaces={workspaces.data?.workspaces ?? []} workspace={selectedWorkspace} selectWorkspace={setWorkspaceId} /> : sessionId ? <SessionDetail key={sessionId} id={sessionId} user={user} openSession={openSession} selectWorkspace={setWorkspaceId} goBack={() => navigate("sessions")} /> : workspaces.loading ? <p className="loading" role="status">Loading your workspaces...</p> : page === "sessions" ? <Sessions user={user} workspace={selectedWorkspace} openSession={openSession} openLibrary={() => navigate("agents")} /> : page === "agents" ? <AgentLibrary user={user} key={selectedWorkspace?.id ?? "none"} workspace={selectedWorkspace} openSession={openSession} /> : <Workspaces user={user} workspaces={workspaces.data?.workspaces ?? []} workspace={selectedWorkspace} refresh={workspaces.refresh} select={setWorkspaceId} />}
      </main>
    </>}
    <footer className="footer"><span className="brand-name">Agent Workspace</span><p>Reusable definitions. Explicit access. Accountable work.</p><span className="mono">Identity follows the owner.</span></footer>
  </div>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing.");
createRoot(root).render(<StrictMode><App /></StrictMode>);
