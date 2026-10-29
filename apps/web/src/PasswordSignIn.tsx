import { useState, type FormEvent } from "react";
import { Button, Feedback, Field } from "./ui";

/**
 * Signs in, or signs up, with a username and password, on servers whose operator turned PASSWORD_AUTH on. Signed out,
 * there is no CSRF token to fetch: the server checks the request's origin instead, and sets the session cookie.
 */
async function passwordRequest(path: string, body: Record<string, string>): Promise<void> {
  const response = await fetch(path, {
    method: "POST", credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (response.ok) return;
  const answer = await response.json().catch(() => null) as { error?: unknown } | null;
  throw new Error(typeof answer?.error === "string" ? answer.error : `Sign-in failed (HTTP ${response.status}). Try again.`);
}

export function PasswordSignIn({ signedIn }: { signedIn: () => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const signingUp = mode === "signup";
  function submit(event: FormEvent) {
    event.preventDefault();
    if (signingUp && password !== confirm) { setError("The passwords don't match."); return; }
    setBusy(true);
    setError("");
    passwordRequest(signingUp ? "/api/auth/password/signup" : "/api/auth/password/login", { username, password })
      .then(signedIn, reason => { setError(reason instanceof Error ? reason.message : "Sign-in failed. Try again."); setBusy(false); });
  }
  function switchMode() {
    setMode(signingUp ? "signin" : "signup");
    setError("");
    setConfirm("");
  }
  return <form className="password-sign-in" onSubmit={submit}>
    <Field label="Username" hint={signingUp ? "3 to 39 letters, digits, - and _. Your user ID is password: and this name; it can't be changed." : undefined}>
      <input className="input" required value={username} onChange={event => setUsername(event.target.value)}
        autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={60} />
    </Field>
    <Field label="Password" hint={signingUp ? "At least 12 characters. A few unrelated words make a good one." : undefined}>
      <input className="input" type="password" required value={password} onChange={event => setPassword(event.target.value)}
        autoComplete={signingUp ? "new-password" : "current-password"} minLength={signingUp ? 12 : 1} maxLength={256} />
    </Field>
    {signingUp && <Field label="Confirm password">
      <input className="input" type="password" required value={confirm} onChange={event => setConfirm(event.target.value)} autoComplete="new-password" maxLength={256} />
    </Field>}
    <Feedback error={error} />
    <Button type="submit" variant="default" size="lg" block disabled={busy}>
      {busy ? (signingUp ? "Creating account..." : "Signing in...") : (signingUp ? "Create account" : "Sign in")}
    </Button>
    <Button variant="ghost" size="sm" onClick={switchMode} disabled={busy}>
      {signingUp ? "Have an account? Sign in" : "New here? Create an account"}
    </Button>
  </form>;
}
