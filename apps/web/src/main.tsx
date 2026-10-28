// First import: the stylesheet declares the cascade layer order before any screen CSS registers a layer.
import "./styles.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { UserProfile } from "../../../packages/shared/src/types";
import { api, ApiError, errorMessage } from "./api";
import { AppProvider, useApp } from "./app-context";
import { GitHubMark, Icon, Logo } from "./icons";
import { JoinWorkspaceScreen, OwnJoinRequests, rememberInvite, takeRememberedInvite } from "./JoinWorkspaceScreen";
import { NewSession } from "./NewSession";
import { NewWorkspaceSheet } from "./NewWorkspaceSheet";
import { navigate, useRoute, type Route } from "./router";
import { SessionScreen } from "./SessionScreen";
import { SessionsScreen } from "./SessionsScreen";
import { SettingsScreen } from "./SettingsScreen";
import { SharedSessionScreen } from "./SharedSessionScreen";
import { Sidebar } from "./Sidebar";
import { applyTheme, useTheme } from "./theme";
import { Alert, Button, PageLoading, useResource } from "./ui";

applyTheme();

const skipLink = <a href="#main-content" className="btn secondary sm skip-link" onClick={event => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to content</a>;

function title(route: Route): string {
  switch (route.name) {
    case "home": return "Pistead";
    case "sessions": return "Sessions · Pistead";
    case "new": return "New session · Pistead";
    case "session": return "Session · Pistead";
    case "settings": return "Settings · Pistead";
    case "shared": return "Shared session · Pistead";
    case "join": return "Join workspace · Pistead";
  }
}

function SignIn({ error, retry, invited }: { error: string; retry: () => void; invited?: boolean }) {
  const health = useResource<{ githubConfigured?: boolean; localServer?: { claimed: boolean } }>("/api/health");
  const callbackError = new URLSearchParams(window.location.search).get("error");
  const problem = error || health.error || (callbackError ? `GitHub sign-in did not complete: ${callbackError.slice(0, 300)}` : "");
  const unconfigured = health.data?.githubConfigured === false;
  const local = health.data?.localServer;
  return <div className="welcome">{skipLink}
    <main id="main-content" className="welcome-inner" tabIndex={-1}>
      <Logo size={40} />
      <h1>Pistead</h1>
      <p>Run Pi agents on your own machine, and work on them together with your team.</p>
      {invited && <Alert variant="info" title="You're invited to a workspace" role="status">Sign in to ask to join it. An owner or admin accepts you before you can see anything in it.</Alert>}
      {problem && <Alert variant="error" title="Sign-in problem">{problem}</Alert>}
      {unconfigured && (local
        ? <Alert variant="warning" title="GitHub sign-in is not set up">This Pistead runs on this computer and needs a GitHub OAuth app of yours to sign you in. Add one where you started it: run <code>pistead serve</code> again in a terminal, which shows how, or use the Pistead app's Settings.</Alert>
        : <Alert variant="warning" title="GitHub sign-in is not configured">The operator needs to configure the GitHub OAuth app, its callback URL and the server's GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and VAULT_KEY settings.</Alert>)}
      {!unconfigured && local && !local.claimed && <Alert variant="info" title="Set up this Pistead" role="status">This Pistead runs on this computer and has no owner yet. Sign in with the link <code>pistead serve</code> printed when it started, or from the Pistead app, which opens it for you: your GitHub account becomes its owner, and the only one that can sign in.</Alert>}
      <div className="actions">
        {!unconfigured && <a className="btn default lg" href="/api/auth/github"><GitHubMark />Continue with GitHub</a>}
        {(problem || unconfigured) && <Button onClick={() => { retry(); health.refresh(); }}>Try again</Button>}
      </div>
      <p className="welcome-footnote">Model credentials stay on your host. GitHub tokens stay on the server, or go only to your own hosts when you push with your account.</p>
    </main>
  </div>;
}

function Home() {
  const { workspaces, workspacesLoading, workspacesError, refreshWorkspaces, currentWorkspace } = useApp();
  const [creating, setCreating] = useState(false);
  if (workspacesLoading) return <PageLoading />;
  if (workspacesError) return <div className="content-column"><Alert variant="error" title="Could not load workspaces" actions={<Button size="sm" onClick={refreshWorkspaces}>Try again</Button>}>{workspacesError}</Alert></div>;
  if (currentWorkspace) return <NewSession key={currentWorkspace.id} workspaceId={currentWorkspace.id} />;
  return <div className="welcome">
    <div className="welcome-inner">
      <Logo size={40} />
      <h1>Welcome to Pistead</h1>
      <p>Create a workspace for your team, add a repository and pair a host to start your first session.</p>
      <div className="actions"><Button variant="default" size="lg" onClick={() => setCreating(true)}>New workspace</Button></div>
      <p className="welcome-footnote">Joining a team? Open the invite link an owner or admin shared, or ask them to add you with your User ID from Settings.</p>
      <OwnJoinRequests />
    </div>
    <NewWorkspaceSheet open={creating} onClose={() => setCreating(false)} />
  </div>;
}

function Shell() {
  const route = useRoute();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEffect(() => { document.title = title(route); }, [route]);
  useEffect(() => { document.getElementById("main-content")?.scrollTo({ top: 0 }); }, [route]);
  // A sign-in started from an invite link returns to the app's root; pick the invite up where it left off.
  useEffect(() => {
    const token = takeRememberedInvite();
    if (token && route.name !== "join") navigate({ name: "join", token });
  }, []); // Only once, on the first render after signing in.
  const screen = route.name === "session" ? <SessionScreen key={route.sessionId} sessionId={route.sessionId} />
    : route.name === "join" ? <JoinWorkspaceScreen key={route.token} token={route.token} />
    : route.name === "new" ? <NewSession key={route.workspaceId} workspaceId={route.workspaceId} />
    : route.name === "sessions" ? <SessionsScreen />
    : route.name === "settings" ? <SettingsScreen key={`${route.section}/${route.id ?? ""}`} section={route.section} id={route.id} />
    : <Home />;
  return <div className={`app${sidebarOpen ? " sidebar-open" : ""}`}>{skipLink}
    <header className="mobile-header">
      <button type="button" className="btn ghost sm icon-only" aria-label="Open navigation" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button>
      <span className="screen-title">Pistead</span>
    </header>
    <Sidebar route={route} onNavigate={() => setSidebarOpen(false)} />
    <div className="scrim" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
    <main id="main-content" className={`main${route.name === "session" ? " no-scroll" : ""}`} tabIndex={-1}>{screen}</main>
  </div>;
}

function App() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
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
  async function signOut() {
    try { await api("/api/auth/logout", { method: "POST" }); } catch (reason) { setError(errorMessage(reason)); return; }
    setUser(null);
    navigate({ name: "home" });
  }
  const route = useRoute();
  // GitHub's callback drops the fragment, so an invite link opened while signed out is remembered for after sign-in.
  useEffect(() => { if (!loading && !user && route.name === "join") rememberInvite(route.token); }, [loading, user, route]);
  if (loading) return <PageLoading />;
  if (!user) return <SignIn error={error} retry={() => setRevision(value => value + 1)} invited={route.name === "join"} />;
  return <AppProvider key={user.id} user={user} setUser={setUser} signOut={() => void signOut()}><Shell /></AppProvider>;
}

function Root() {
  useTheme();
  const route = useRoute();
  // A share link opens its read-only view for anyone who has it, signed in or not, without loading the app.
  return route.name === "shared" ? <SharedSessionScreen key={route.token} token={route.token} /> : <App />;
}

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing.");
createRoot(root).render(<StrictMode><Root /></StrictMode>);
