import { useState, type FormEvent } from "react";
import type { UserProfile } from "../../../../packages/shared/src/types";
import { api } from "../api";
import { useApp } from "../app-context";
import { Button, CardBody, CopyButton, Feedback, Field, Row, Section, useAction } from "../ui";
import { usernameWithId } from "../usernames";
import { GitAccountsSection } from "./GitAccounts";
import "./settings.css";

type EnvRow = { id: string; key: string; value: string };

export function ProfileSettings() {
  const { user, setUser, signOut } = useApp();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [gitName, setGitName] = useState(user.gitName);
  const [gitEmail, setGitEmail] = useState(user.gitEmail);
  const [rows, setRows] = useState<EnvRow[]>(() => Object.entries(user.env).map(([key, value]) => ({ id: crypto.randomUUID(), key, value })));
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
      setUser(response.user);
    }, "Profile saved. New sessions use your configured identity.");
  }
  const update = (id: string, change: Partial<EnvRow>) => setRows(current => current.map(item => item.id === id ? { ...item, ...change } : item));
  return <>
    <form className="settings-form" onSubmit={submit}>
      <Section title="Identity" info="Sessions you own act with this Git identity and your connected Git accounts. New sessions use the saved values.">
        <CardBody>
          <Field label="Display name"><input className="input" required maxLength={120} value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="name" /></Field>
          <Field label="Git author name"><input className="input" required maxLength={120} value={gitName} onChange={event => setGitName(event.target.value)} /></Field>
          <Field label="Git author email"><input className="input" required type="email" value={gitEmail} onChange={event => setGitEmail(event.target.value)} autoComplete="email" /></Field>
        </CardBody>
      </Section>
      <Section title="Environment" info="Nonsecret APP_ variables only. They are sent to the host of every session you own. Never put Git tokens, provider keys or other credentials here; model credentials belong in Pi on your host."
        action={<Button variant="outline" size="sm" icon="plus" onClick={() => setRows(current => [...current, { id: crypto.randomUUID(), key: "APP_", value: "" }])}>Add variable</Button>}>
        {!rows.length && <Row title="No variables" hint="Add APP_ variables your sessions need" />}
        {rows.map((row, index) => <Row key={row.id}
          title={<span className="env-row">
            <input className="input" aria-label={`Variable ${index + 1} name`} required pattern="APP_[A-Z0-9_]+" placeholder="APP_PROJECT" value={row.key} onChange={event => update(row.id, { key: event.target.value })} autoComplete="off" spellCheck={false} />
            <span className="muted">=</span>
            <input className="input" aria-label={`Variable ${index + 1} value`} value={row.value} onChange={event => update(row.id, { value: event.target.value })} autoComplete="off" />
          </span>}
          trailing={<Button variant="ghost" size="sm" icon="trash" aria-label={`Remove variable ${index + 1}`} title="Remove variable" onClick={() => setRows(current => current.filter(item => item.id !== row.id))} />} />)}
      </Section>
      <div className="settings-actions">
        <Feedback {...action} />
        <span className="spacer" />
        <Button type="submit" variant="default" disabled={action.busy}>{action.busy ? "Saving..." : "Save profile"}</Button>
      </div>
    </form>
    <GitAccountsSection />
    <Section title="Account">
      <Row title="User ID" hint={<code>{usernameWithId(user)}</code>} trailing={<CopyButton value={user.id} label="Copy user ID" />} />
      <Row title="Sign out" trailing={<Button variant="outline" size="sm" onClick={signOut}>Sign out</Button>} />
    </Section>
  </>;
}
