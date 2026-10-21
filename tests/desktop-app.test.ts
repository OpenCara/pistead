import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostInspection } from "../apps/runner/src/desktop-protocol.js";
import { HostController } from "../apps/desktop/src/main/host-controller.js";
import type { HostProcess } from "../apps/desktop/src/main/host-process.js";
import { navigationDecision, parseServerOrigin, windowOpenDecision } from "../apps/desktop/src/main/origin.js";
import { isLocalPage, parseStartInput } from "../apps/desktop/src/main/requests.js";
import { parseSettings, SettingsStore } from "../apps/desktop/src/main/settings.js";

const pairingId = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const code = "Z3AQnmLC6x9-xm2HZqXObhdMmKQhqLOKk3ST1ZuBYIw";

test("the configured server is an HTTPS origin, or plain HTTP on localhost and 127.0.0.1 only", () => {
  assert.deepEqual(parseServerOrigin(" https://pistead.example/ "), { ok: true, origin: "https://pistead.example" });
  assert.deepEqual(parseServerOrigin("http://127.0.0.1:8789"), { ok: true, origin: "http://127.0.0.1:8789" });
  assert.deepEqual(parseServerOrigin("http://localhost:3000/"), { ok: true, origin: "http://localhost:3000" });
  for (const refused of ["http://pistead.example", "http://[::1]:8789", "http://constructor/", "http://10.0.0.2", "ftp://pistead.example",
    "https://pistead.example/app", "https://pistead.example/?a=1", "https://pistead.example/#x", "https://user:pass@pistead.example", "pistead.example", ""]) {
    assert.equal(parseServerOrigin(refused).ok, false, refused);
  }
});

test("the Pistead window stays on its server and GitHub; other web links leave for the browser, anything else goes nowhere", () => {
  const server = "https://pistead.example";
  assert.equal(navigationDecision("https://pistead.example/sessions/1", server), "allow");
  assert.equal(navigationDecision("https://github.com/login/oauth/authorize?client_id=x", server), "allow");
  for (const external of ["https://github.com.evil.example/login", "http://github.com/login", "https://gist.github.com/x", "https://pistead.example.evil/", "http://pistead.example/", "mailto:a@b.example"]) {
    assert.equal(navigationDecision(external, server), "external", external);
  }
  for (const denied of ["file:///etc/passwd", "javascript:alert(1)", "pistead-app://local/host.html", "data:text/html,x", "https://user@pistead.example/", "not a url"]) {
    assert.equal(navigationDecision(denied, server), "deny", denied);
  }
  assert.equal(windowOpenDecision("https://github.com/o/r/pull/1"), "external");
  assert.equal(windowOpenDecision("file:///Applications"), "deny");
  assert.equal(windowOpenDecision("https://a:b@example.com/"), "deny");
});

test("bridge calls are honored only from the app's own page", () => {
  assert.equal(isLocalPage("pistead-app://local/host.html", "host.html"), true);
  assert.equal(isLocalPage("pistead-app://local/host.html?x#y", "host.html"), true);
  assert.equal(isLocalPage("pistead-app://local/settings.html", "host.html"), false);
  assert.equal(isLocalPage("pistead-app://other/host.html", "host.html"), false);
  assert.equal(isLocalPage("https://pistead.example/host.html", "host.html"), false);
  assert.equal(isLocalPage("file:///host.html", "host.html"), false);
});

test("start requests from the page are checked field by field, and a pasted code never passes as a pairing ID", () => {
  assert.deepEqual(parseStartInput({ replacePairing: false }), { ok: true, value: { replacePairing: false } });
  assert.deepEqual(parseStartInput({ pairing: { id: ` ${pairingId} `, code: `${code}\n` }, replacePairing: true }),
    { ok: true, value: { pairing: { id: pairingId, code }, replacePairing: true } });
  const refused = (value: unknown) => { const parsed = parseStartInput(value); assert.equal(parsed.ok, false, JSON.stringify(value)); return parsed.ok ? "" : parsed.error; };
  refused(undefined);
  refused([]);
  refused({ replacePairing: "yes" });
  refused({ replacePairing: false, unsandboxedConsent: true });
  refused({ replacePairing: false, pairing: { id: pairingId, code, server: "https://evil.example" } });
  refused({ replacePairing: false, pairing: { id: pairingId, code: 42 } });
  assert.match(refused({ replacePairing: true }), /new pairing ID and code/);
  assert.match(refused({ replacePairing: false, pairing: { id: code, code } }), /looks like the single-use pairing code/);
  assert.match(refused({ replacePairing: false, pairing: { id: "abc", code } }), /pairing ID/);
  assert.match(refused({ replacePairing: false, pairing: { id: pairingId, code: "" } }), /Enter the single-use pairing code/);
  assert.match(refused({ replacePairing: false, pairing: { id: pairingId, code: "short" } }), /not valid/);
  assert.match(refused({ replacePairing: false, pairing: { id: pairingId, code: "has spaces in it" } }), /not valid/);
});

test("a damaged settings file falls back to defaults field by field, never to an unchecked server", () => {
  assert.deepEqual(parseSettings(undefined), { server: "https://pistead.com", gitCredentials: false });
  assert.deepEqual(parseSettings({ server: "http://evil.example", gitCredentials: "true", windowBounds: { x: 0, y: 0, width: 10, height: 10 }, resumeHost: {} }),
    { server: "https://pistead.com", gitCredentials: false });
  assert.deepEqual(parseSettings({ server: "http://127.0.0.1:8789/", gitCredentials: true, windowBounds: { x: 10, y: 20, width: 900, height: 700 }, resumeHost: { unsandboxedConsent: true } }),
    { server: "http://127.0.0.1:8789", gitCredentials: true, windowBounds: { x: 10, y: 20, width: 900, height: 700 }, resumeHost: { unsandboxedConsent: true } });
});

test("resuming at launch reuses only the consent given at the owner's last start; a failure or the owner's stop ends it", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pistead-desktop-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new SettingsStore(join(directory, "settings.json"));
  let mode: HostInspection["mode"] = "unsandboxed";
  // Whether each start the host received carried the owner's unsandboxed consent.
  const consent: boolean[] = [];
  // The host process, answering as the real host does once this computer is paired with the configured server.
  const host = {
    running: true,
    async request(message: { type: string; unsandboxedConsent?: boolean }) {
      if (message.type === "start") consent.push(message.unsandboxedConsent === true);
      const inspection: HostInspection = { platform: "darwin", stateDir: directory, mode, prerequisites: [], models: [],
        pairedServer: settings.get().server, ...(mode === "unsandboxed" ? { unsandboxedWarning: "Runs directly as you" } : {}) };
      return { type: "result", id: 0, ok: true, ...(message.type === "inspect" ? { inspection } : {}) };
    },
  };
  const asked: string[] = [];
  let accept = false;
  const controller = new HostController({ title: "Pistead", settings, fixtureModels: false, confirmUnsandboxed: async warning => { asked.push(warning); return accept; } });
  controller.attach(host as unknown as HostProcess);

  // The owner's own start shows the CLI's warning, and declining it starts nothing.
  assert.deepEqual(await controller.start({ replacePairing: false }), { ok: false, error: "Unsandboxed mode was not confirmed; nothing was started." });
  accept = true;
  assert.deepEqual(await controller.start({ replacePairing: false }), { ok: true });
  assert.deepEqual(asked, ["Runs directly as you", "Runs directly as you"]);
  assert.deepEqual(consent, [true]);
  assert.deepEqual(settings.get().resumeHost, { unsandboxedConsent: true });

  // The next launch starts again without asking; quitting keeps that, a host failure ends it.
  await controller.resume();
  assert.equal(asked.length, 2);
  assert.deepEqual(consent, [true, true]);
  controller.handleExit(0, true);
  assert.deepEqual(settings.get().resumeHost, { unsandboxedConsent: true });
  controller.handleExit(1, false);
  assert.equal(settings.get().resumeHost, undefined);

  // A start that needed no consent (sandboxed) never covers a later unsandboxed one.
  mode = "sandboxed";
  assert.deepEqual(await controller.start({ replacePairing: false }), { ok: true });
  assert.deepEqual(settings.get().resumeHost, { unsandboxedConsent: false });
  mode = "unsandboxed";
  await controller.resume();
  assert.deepEqual(consent, [true, true, false], "nothing more was started");
  assert.equal(asked.length, 2, "and nobody was asked at launch");
  assert.equal(settings.get().resumeHost, undefined);

  // Stopping the host ends resuming too.
  assert.deepEqual(await controller.start({ replacePairing: false }), { ok: true });
  assert.deepEqual(settings.get().resumeHost, { unsandboxedConsent: true });
  assert.deepEqual(await controller.stop(), { ok: true });
  assert.equal(settings.get().resumeHost, undefined);
});
