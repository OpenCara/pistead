import { stateLabels, type HostView, type PisteadBridge } from "../shared/bridge.js";
import { element, setText } from "./dom.js";

declare global { interface Window { pistead: PisteadBridge } }

const bridge = window.pistead.host;

const title = element("title");
const status = element("status");
const error = element("error");
const start = element<HTMLButtonElement>("start");
const stop = element<HTMLButtonElement>("stop");
const refresh = element<HTMLButtonElement>("refresh");
const form = element<HTMLFormElement>("pair-form");
const pairingId = element<HTMLInputElement>("pairing-id");
const pairingCode = element<HTMLInputElement>("pairing-code");
const replace = element<HTMLInputElement>("replace");
const pair = element<HTMLButtonElement>("pair");
const gitCredentials = element<HTMLInputElement>("git-credentials");
const openAtLogin = element<HTMLInputElement>("open-at-login");
let busy = false;
let current: HostView | undefined;
/** A local failure (validation, a refused start) shown until the next view says otherwise. */
let localError: string | undefined;

function item(text: string, detail?: string, mark?: "ok" | "missing"): HTMLLIElement {
  const li = document.createElement("li");
  if (mark) { const icon = li.appendChild(document.createElement("span")); icon.className = `mark ${mark}`; icon.textContent = mark === "ok" ? "✓" : "✕"; icon.setAttribute("aria-label", mark === "ok" ? "Present" : "Missing"); }
  li.appendChild(document.createElement("span")).textContent = text;
  if (detail) { const small = li.appendChild(document.createElement("span")); small.className = "muted"; small.textContent = detail; }
  return li;
}

function render(view: HostView): void {
  current = view;
  const inspection = view.inspection;
  const stopped = view.state === "stopped";
  document.title = view.title;
  setText(title, view.title);
  setText(status, stateLabels[view.state]);
  status.dataset.state = view.state;
  const message = localError ?? view.error;
  error.hidden = !message;
  setText(error, message ?? "");
  element("development").hidden = !view.fixtureModels;

  setText(element("server"), view.server);
  const paired = inspection?.pairedServer;
  setText(element("paired"), inspection ? paired ?? inspection.pairingError ?? "Not paired yet" : "…");
  const isolation = view.running ? (view.running.unsandboxed ? "unsandboxed" : "sandboxed") : inspection?.mode;
  setText(element("isolation"), inspection?.unsupported ?? (isolation === "sandboxed"
    ? "Sandboxed: agent work runs in bubblewrap, verified per session."
    : isolation === "unsandboxed" ? "Unsandboxed: agent work runs directly as you on this computer, after your consent." : "…"));

  start.disabled = busy || !stopped || !inspection || !paired || !!inspection.unsupported;
  stop.disabled = busy || stopped || view.state === "stopping";
  refresh.disabled = view.inspecting;
  for (const input of [pairingId, pairingCode, replace]) input.disabled = busy || !stopped;
  pair.disabled = busy || !stopped || !!inspection?.unsupported;
  // A saved pairing that can't be read (another server's, a damaged file) can still be replaced with a new code.
  element("replace-row").hidden = !paired && !inspection?.pairingError;
  setText(element("pair-server"), `Pairs with ${view.server}`);
  gitCredentials.checked = view.gitCredentials;
  element("login-row").hidden = view.openAtLogin === undefined;
  openAtLogin.checked = view.openAtLogin === true;

  const models = element("models");
  const note = element("models-note");
  models.replaceChildren(...(inspection?.models ?? []).map(model => item(model.name, `${model.provider}/${model.modelId}${model.thinkingLevel ? ` · starts at ${model.thinkingLevel}` : ""}`)));
  setText(note, !inspection ? "Checking Pi's models…" : inspection.modelsError ?? (inspection.models.length
    ? "From Pi on this computer: its enabledModels setting, or every model with configured authentication. Pistead never receives your provider credentials."
    : ""));

  const prerequisites = element("prerequisites");
  const prerequisitesNote = element("prerequisites-note");
  const sandboxMissing = inspection?.sandboxPrerequisites?.filter(entry => !entry.ok).map(entry => entry.name);
  prerequisitesNote.hidden = !sandboxMissing?.length && !inspection?.prerequisitesError;
  setText(prerequisitesNote, inspection?.prerequisitesError ?? (sandboxMissing?.length ? `The isolated sandbox needs ${sandboxMissing.join(", ")}; without it the host runs unsandboxed.` : ""));
  prerequisites.replaceChildren(...(inspection?.prerequisites ?? []).map(entry => item(entry.name, undefined, entry.ok ? "ok" : "missing")));

  const logs = element("logs");
  logs.replaceChildren(...view.logs.slice(-100).reverse().map(line => {
    const li = document.createElement("li");
    li.className = line.level;
    const time = li.appendChild(document.createElement("time"));
    time.dateTime = new Date(line.time).toISOString();
    time.textContent = new Date(line.time).toLocaleTimeString();
    li.appendChild(document.createElement("span")).textContent = line.message;
    return li;
  }));
  if (!view.logs.length) logs.replaceChildren(item("Nothing yet."));
}

/** Runs one owner action at a time, keeping the buttons disabled until it settles. */
async function act(run: () => Promise<{ ok: true } | { ok: false; error: string } | void>): Promise<boolean> {
  if (busy) return false;
  busy = true;
  localError = undefined;
  if (current) render(current);
  try {
    const outcome = await run();
    if (outcome && !outcome.ok) localError = outcome.error;
    return !outcome || outcome.ok;
  } finally {
    busy = false;
    render(await bridge.view());
  }
}

start.addEventListener("click", () => { void act(() => bridge.start({ replacePairing: false })); });
stop.addEventListener("click", () => { void act(() => bridge.stop()); });
refresh.addEventListener("click", () => { void act(() => bridge.refresh()); });
form.addEventListener("submit", event => {
  event.preventDefault();
  const pairing = { id: pairingId.value, code: pairingCode.value };
  void act(() => bridge.start({ pairing, replacePairing: replace.checked })).then(started => {
    // The code is single use: once the host has it, nothing here keeps it.
    if (started) { pairingCode.value = ""; pairingId.value = ""; replace.checked = false; }
  });
});
gitCredentials.addEventListener("change", () => { void act(() => bridge.setGitCredentials(gitCredentials.checked)); });
openAtLogin.addEventListener("change", () => { void act(() => bridge.setOpenAtLogin(openAtLogin.checked)); });

bridge.onUpdate(view => { if (!busy) render(view); else current = view; });
void bridge.view().then(render);
