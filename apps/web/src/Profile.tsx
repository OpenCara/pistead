import { useState, type FormEvent } from "react";
import type { UserProfile } from "../../../packages/shared/src/types";
import { api } from "./api";
import { CopyButton, Details, Feedback, PageHeading, useAction } from "./ui";

type EnvRow = { id: string; key: string; value: string };

export function Profile({ user, onSave }: { user: UserProfile; onSave: (user: UserProfile) => void }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [gitName, setGitName] = useState(user.gitName);
  const [gitEmail, setGitEmail] = useState(user.gitEmail);
  const [rows, setRows] = useState<EnvRow[]>(Object.entries(user.env).map(([key, value]) => ({ id: crypto.randomUUID(), key, value })));
  const action = useAction();
  function submit(event: FormEvent) {
    event.preventDefault();
    void action.run(async () => {
      const environment: Record<string, string> = {};
      for (const row of rows) {
        if (!/^APP_[A-Z0-9_]+$/.test(row.key)) throw new Error("Environment names must start with APP_ and contain only uppercase letters, digits, and underscores.");
        if (Object.hasOwn(environment, row.key)) throw new Error(`Duplicate environment name: ${row.key}`);
        environment[row.key] = row.value;
      }
      const response = await api<{ user: UserProfile }>("/api/me", { method: "PATCH", body: { displayName, gitName, gitEmail, env: environment } });
      onSave(response.user);
    }, "Profile saved. New sessions use your configured identity.");
  }
  return <>
    <PageHeading title="Profile">Your name, Git identity and session environment.</PageHeading>
    <div className="split-layout"><form className="section" onSubmit={submit}>
      <div className="section-heading"><h2>Identity</h2></div>
      <div className="form-grid">
        <label className="field field-wide">Display name<input required maxLength={120} value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="name" /></label>
        <label className="field">Git author name<input required maxLength={120} value={gitName} onChange={event => setGitName(event.target.value)} /></label>
        <label className="field">Git author email<input required type="email" value={gitEmail} onChange={event => setGitEmail(event.target.value)} autoComplete="email" /></label>
      </div>
      <div className="section-heading"><h2>Application environment</h2></div>
      <p className="muted">Nonsecret APP_ variables only. Never put tokens or keys here.</p>
      <Details summary="Where these variables go"><p>They are sent to the host of every session you own. GitHub tokens, provider keys and other credentials must never go here; model credentials belong in Pi on your local host.</p></Details>
      {rows.map((row, index) => <div className="env-row" key={row.id}>
        <label className="field">Variable {index + 1}<input required pattern="APP_[A-Z0-9_]+" placeholder="APP_PROJECT" value={row.key} onChange={event => setRows(current => current.map(item => item.id === row.id ? { ...item, key: event.target.value } : item))} autoComplete="off" spellCheck={false} /></label>
        <label className="field">Value<input value={row.value} onChange={event => setRows(current => current.map(item => item.id === row.id ? { ...item, value: event.target.value } : item))} autoComplete="off" /></label>
        <button type="button" className="button secondary small" aria-label={`Remove variable ${index + 1}`} onClick={() => setRows(current => current.filter(item => item.id !== row.id))}>Remove</button>
      </div>)}
      <div className="actions"><button type="button" className="button secondary" onClick={() => setRows(current => [...current, { id: crypto.randomUUID(), key: "APP_", value: "" }])}>Add variable</button></div>
      <Feedback {...action} />
      <div className="actions"><button className="button primary" disabled={action.busy}>{action.busy ? "Saving..." : "Save profile"}</button></div>
    </form><aside className="rail"><p className="eyebrow">Connected identity</p><h2>{user.githubLogin ? `@${user.githubLogin}` : user.displayName}</h2><p><span className={`badge ${user.githubConnected ? "success" : "warning"}`}>{user.githubConnected ? "GitHub connected" : "GitHub not connected"}</span></p>{!user.githubConnected && <a className="button secondary" href="/api/auth/github">Connect GitHub</a>}<p className="metadata">User ID: <code>{user.id}</code> <CopyButton value={user.id} /></p>
      <Details summary="How your identity is used"><p>Your login and user ID are managed by the server. Sessions you own act with your Git and GitHub identity. Members can view workspace-visible sessions read-only (prompts, tool output and repository content in the transcript) without direct GitHub access or tool execution; more requires explicit session grants. Viewing a session, sharing a Pi or publishing an agent never replaces the session owner's identity or grants GitHub access.</p></Details>
    </aside></div>
  </>;
}
