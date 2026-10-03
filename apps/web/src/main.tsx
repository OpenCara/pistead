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
import { GitHubMark, Icon, Logo, type IconName } from "./icons";
import "./styles.css";

type Page = "workspaces" | "agents" | "sessions" | "connections" | "profile";
const navigation: { id: Page; label: string; icon: IconName }[] = [
  { id: "workspaces", label: "Workspaces", icon: "workspaces" },
  { id: "agents", label: "Agent library", icon: "agents" },
  { id: "sessions", label: "Sessions", icon: "sessions" },
  { id: "connections", label: "Connections", icon: "connections" },
  { id: "profile", label: "Profile", icon: "profile" },
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
    document.title = `${sessionId ? "Session" : navigation.find(item => item.id === page)?.label ?? "Workspaces"} · Pistead`;
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
  const skipLink = <a href="#main-content" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to content</a>;
  if (loading) return <div className="splash">{skipLink}<main id="main-content" className="splash-card" tabIndex={-1}><Logo /><h1>Pistead</h1><p className="loading" role="status">Checking your sign-in...</p></main></div>;
  if (!user) return <div className="login-shell">{skipLink}
    <main id="main-content" className="login-page" tabIndex={-1}>
      <section className="login-intro"><div className="brand"><Logo /><span className="brand-name">Pistead</span></div><h1>A shared homestead for your Pi agents.</h1><p className="lead">A workshop for agents worth reusing, and work worth doing together. Keep your Pi and agents private. Let your workspace follow sessions read-only, with explicit grants for collaboration.</p><Feedback error={logout.error || error || health.error || (callbackError ? `GitHub sign-in did not complete: ${callbackError.slice(0, 300)}` : "")} notice={logout.notice} />{health.data?.githubConfigured === false ? <div className="notice" role="status"><strong>GitHub sign-in is not configured.</strong><p>The operator needs to configure the GitHub OAuth application, callback URL, and Worker authentication secrets. There is no test-login shortcut.</p></div> : <a className="button primary large" href="/api/auth/github"><GitHubMark />Continue with GitHub</a>}{(error || health.error || health.data?.githubConfigured === false) && <div className="actions"><button className="button secondary" onClick={() => { setRevision(current => current + 1); health.refresh(); }}>Check connection again</button></div>}<p className="metadata">GitHub sign-in is handled by the server. Local model credentials stay on your Pi host.</p></section>
      <section className="login-features" aria-label="How Pistead works">
        <article className="feature"><span className="feature-icon"><Icon name="agents" /></span><h2>Run your own agent</h2><p>Connect your private Pi, then run your own unpublished agent or reuse a published definition. Every new session runs under your identity without inherited history or credentials.</p></article>
        <article className="feature"><span className="feature-icon"><Icon name="sessions" /></span><h2>Let the workspace follow</h2><p>Sessions are workspace-visible by default: members can read prompts, tool output and repository content shown in the transcript, without direct GitHub access or tool execution. This does not share your Pi or publish your agent. Private sessions require explicit access; ask, write, approve and manage permissions always require explicit session grants.</p></article>
        <article className="feature"><span className="feature-icon"><Icon name="connections" /></span><h2>Keep the keys at home</h2><p>Your Pi host runs the work. Model credentials stay on it, and GitHub tokens stay on the server.</p></article>
      </section>
    </main>
  </div>;
  const initials = user.displayName.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]!.toUpperCase()).join("") || "?";
  return <div className="app-shell">{skipLink}
    <aside className="sidebar">
      <a className="brand" href="#workspaces" aria-label="Pistead home"><Logo /><span className="brand-name">Pistead</span></a>
      <div className="workspace-switcher"><label htmlFor="workspace-selector">Workspace</label><select id="workspace-selector" value={selectedWorkspace?.id ?? ""} onChange={event => setWorkspaceId(event.target.value)} disabled={workspaces.loading || !workspaces.data?.workspaces.length}><option value="" disabled>{workspaces.loading ? "Loading workspaces..." : "No workspace selected"}</option>{workspaces.data?.workspaces.map(workspace => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}</select><span className="workspace-context">{selectedWorkspace ? `${selectedWorkspace.role ?? "member"} · Workspace-visible sessions: read-only unless granted more` : "Create a workspace to begin"}</span></div>
      <nav className="primary-nav" aria-label="Main navigation">{navigation.map(item => <button key={item.id} className={page === item.id ? "active" : ""} aria-current={page === item.id ? "page" : undefined} onClick={() => navigate(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</nav>
      <div className="account"><span className="avatar" aria-hidden="true">{initials}</span><span className="account-name"><strong>{user.displayName}</strong>{user.githubLogin && <span className="metadata">@{user.githubLogin}</span>}</span><button className="icon-button" aria-label={logout.busy ? "Signing out..." : "Log out"} title="Log out" disabled={logout.busy} onClick={() => void logout.run(async () => { await api("/api/auth/logout", { method: "POST" }); setUser(null); setWorkspaceId(""); navigate("workspaces"); }, "Signed out.")}><Icon name="logout" /></button></div>
    </aside>
    <main className="page" id="main-content" tabIndex={-1}><Feedback error={logout.error} />{workspaces.error && <div className="error" role="alert"><p>{workspaces.error}</p><button className="button secondary small" onClick={workspaces.refresh}>Reload workspaces</button></div>}
      {page === "profile" ? <Profile key={user.id} user={user} onSave={setUser} /> : page === "connections" ? <Connections user={user} workspaces={workspaces.data?.workspaces ?? []} workspace={selectedWorkspace} selectWorkspace={setWorkspaceId} /> : sessionId ? <SessionDetail key={sessionId} id={sessionId} user={user} openSession={openSession} selectWorkspace={setWorkspaceId} goBack={() => navigate("sessions")} /> : workspaces.loading ? <p className="loading" role="status">Loading your workspaces...</p> : page === "sessions" ? <Sessions user={user} workspace={selectedWorkspace} openSession={openSession} openLibrary={() => navigate("agents")} /> : page === "agents" ? <AgentLibrary user={user} key={selectedWorkspace?.id ?? "none"} workspace={selectedWorkspace} openSession={openSession} /> : <Workspaces user={user} workspaces={workspaces.data?.workspaces ?? []} workspace={selectedWorkspace} refresh={workspaces.refresh} select={setWorkspaceId} />}
    </main>
  </div>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing.");
createRoot(root).render(<StrictMode><App /></StrictMode>);
