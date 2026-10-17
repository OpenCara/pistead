import type { PisteadBridge } from "../shared/bridge.js";
import { element, setText } from "./dom.js";

declare global { interface Window { pistead: PisteadBridge } }

const bridge = window.pistead.settings;
const form = element<HTMLFormElement>("server-form");
const server = element<HTMLInputElement>("server");
const message = element("message");
const useDefault = element<HTMLButtonElement>("default");
let defaultServer = "";

function show(text: string, kind: "error" | "saved"): void {
  message.hidden = false;
  message.className = kind === "error" ? "banner error" : "banner note";
  setText(message, text);
}

async function save(origin: string): Promise<void> {
  const outcome = await bridge.setServer(origin);
  if (!outcome.ok) { show(outcome.error, "error"); return; }
  server.value = (await bridge.view()).server;
  show("Saved. The Pistead window now opens this server.", "saved");
}

form.addEventListener("submit", event => { event.preventDefault(); void save(server.value); });
useDefault.addEventListener("click", () => { server.value = defaultServer; void save(defaultServer); });
void bridge.view().then(view => { server.value = view.server; defaultServer = view.defaultServer; });
