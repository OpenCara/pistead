import type { LocalView, PisteadBridge, SettingsView } from "../shared/bridge.js";
import { element, setText } from "./dom.js";

declare global { interface Window { pistead: PisteadBridge } }

const bridge = window.pistead.settings;
const form = element<HTMLFormElement>("server-form");
const server = element<HTMLInputElement>("server");
const message = element("message");
const useDefault = element<HTMLButtonElement>("default");
const local = {
  status: element("local-status"), facts: element("local-facts"), origin: element("local-origin"), host: element("local-host"),
  stateDir: element("local-state-dir"), form: element<HTMLFormElement>("local-form"), githubSaved: element("github-saved"),
  clientId: element<HTMLInputElement>("client-id"), clientSecret: element<HTMLInputElement>("client-secret"),
  message: element("local-message"), start: element<HTMLButtonElement>("local-start"), stop: element<HTMLButtonElement>("local-stop"),
  logs: element("local-logs"),
};
let defaultServer = "";
let busy = false;

function show(target: HTMLElement, text: string, kind: "error" | "saved"): void {
  target.hidden = false;
  target.className = kind === "error" ? "banner error" : "banner note";
  setText(target, text);
}

const serverLabels: Record<LocalView["status"]["state"], string> = { stopped: "Off", starting: "Starting…", running: "Running", stopping: "Stopping…" };
const hostLabels: Record<LocalView["status"]["host"], string> = {
  off: "Not on this computer", waiting: "On this computer, once you have signed in", connecting: "On this computer (connecting…)",
  connected: "On this computer", disconnected: "On this computer (reconnecting…)", stopped: "Stopped", failed: "This computer could not run them",
};

function render(view: SettingsView): void {
  const { status, inspection, error } = view.local;
  const running = status.state !== "stopped";
  setText(local.status, serverLabels[status.state]);
  local.status.dataset.state = status.state === "running" ? "connected" : "";
  local.facts.hidden = !running && !inspection;
  setText(local.origin, status.origin ?? `http://127.0.0.1:${inspection?.port ?? 7878}`);
  setText(local.host, running ? hostLabels[status.host] : inspection?.hostProblem ? `Not on this computer: ${inspection.hostProblem}`
    : inspection?.hostMode === "unsandboxed" ? "On this computer, without a sandbox (asks for your consent)" : "On this computer");
  setText(local.stateDir, inspection?.stateDir ?? "");
  local.githubSaved.hidden = !inspection?.githubClientId;
  setText(local.githubSaved, inspection?.githubClientId ? `Saved: client ID ${inspection.githubClientId}. Enter both again only to replace it.` : "");
  local.start.hidden = running;
  local.stop.hidden = !running;
  local.start.disabled = busy;
  local.stop.disabled = busy || status.state === "stopping";
  for (const input of [local.clientId, local.clientSecret]) input.disabled = running;
  if (error) show(local.message, error, "error");
  else if (status.state === "running" && status.claimUrl) show(local.message, "Running. The Pistead window opened its sign-in: the GitHub account you sign in with becomes its owner, and the only one that can sign in.", "saved");
  else local.message.hidden = true;
  const logs = view.local.logs.slice(-30);
  local.logs.hidden = logs.length === 0;
  local.logs.replaceChildren(...logs.map(line => {
    const item = document.createElement("li");
    item.className = line.level;
    const time = document.createElement("time");
    time.textContent = new Date(line.time).toLocaleTimeString();
    const text = document.createElement("span");
    text.textContent = line.message;
    item.append(time, text);
    return item;
  }));
}

async function save(origin: string): Promise<void> {
  const outcome = await bridge.setServer(origin);
  if (!outcome.ok) { show(message, outcome.error, "error"); return; }
  const view = await bridge.view();
  server.value = view.server;
  show(message, view.local.status.state === "running"
    ? "Saved. The Pistead window opens this server once you stop Pistead on this computer." : "Saved. The Pistead window now opens this server.", "saved");
}

async function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>): Promise<void> {
  busy = true;
  render(await bridge.view());
  try {
    const outcome = await action();
    if (outcome.ok) local.clientSecret.value = "";
    const view = await bridge.view();
    render(view);
    if (!outcome.ok) show(local.message, outcome.error, "error");
  } finally {
    busy = false;
    render(await bridge.view());
  }
}

form.addEventListener("submit", event => { event.preventDefault(); void save(server.value); });
useDefault.addEventListener("click", () => { server.value = defaultServer; void save(defaultServer); });
local.form.addEventListener("submit", event => {
  event.preventDefault();
  const clientId = local.clientId.value.trim();
  const clientSecret = local.clientSecret.value.trim();
  void run(() => bridge.startLocal(clientId || clientSecret ? { github: { clientId, clientSecret } } : {}));
});
local.stop.addEventListener("click", () => { void run(() => bridge.stopLocal()); });
bridge.onUpdate(render);
void bridge.view().then(view => { server.value = view.server; defaultServer = view.defaultServer; render(view); });
