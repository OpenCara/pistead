import { join } from "node:path";
import { BrowserWindow, Menu, net, protocol, screen, session, shell, type MenuItemConstructorOptions, type Session, type WebContents } from "electron";
import { pathToFileURL } from "node:url";
import { navigationDecision, windowOpenDecision } from "./origin.js";
import { APP_HOST, APP_SCHEME } from "./requests.js";
import type { Bounds, SettingsStore } from "./settings.js";

// Two kinds of windows. The Pistead window shows the remote server with no preload and no Node, in its own persistent
// session. Local windows (This Mac, Settings) show pages bundled with the app, served by the app's own scheme in the
// default session, with a preload exposing only the typed bridge.

export const REMOTE_PARTITION = "persist:pistead";
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const LOCAL_FILES: Record<string, string> = {
  "/host.html": "text/html; charset=utf-8",
  "/host.js": "text/javascript; charset=utf-8",
  "/settings.html": "text/html; charset=utf-8",
  "/settings.js": "text/javascript; charset=utf-8",
  "/style.css": "text/css; charset=utf-8",
};

/** Before `ready`: the local scheme behaves like a secure, standard origin so CSP 'self' and relative URLs work. */
export function registerLocalScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);
}

/** Serves only the bundled renderer files, on the default session; the remote session cannot load them. */
export function serveLocalPages(rendererDirectory: string): void {
  protocol.handle(APP_SCHEME, async request => {
    const url = new URL(request.url);
    const type = Object.hasOwn(LOCAL_FILES, url.pathname) ? LOCAL_FILES[url.pathname] : undefined;
    if (url.host !== APP_HOST || !type || request.method !== "GET") return new Response("Not found", { status: 404 });
    const file = await net.fetch(pathToFileURL(join(rendererDirectory, url.pathname.slice(1))).href);
    return new Response(file.body, { headers: { "content-type": type, "content-security-policy": CSP, "x-content-type-options": "nosniff" } });
  });
}

/** The remote session grants no permissions beyond clipboard writes (Copy buttons) for the server itself. */
export function hardenRemoteSession(server: () => string): Session {
  const remote = session.fromPartition(REMOTE_PARTITION);
  const allowed = (permission: string, origin: string) => permission === "clipboard-sanitized-write" && origin === server();
  remote.setPermissionRequestHandler((_contents, permission, callback, details) => callback(allowed(permission, URL.parse(details.requestingUrl)?.origin ?? "")));
  remote.setPermissionCheckHandler((_contents, permission, origin) => allowed(permission, URL.parse(origin)?.origin ?? ""));
  return remote;
}

function openExternally(url: string): void {
  void shell.openExternal(url).catch(() => {});
}

/** Keeps the remote window on the server and GitHub OAuth; other links open in the default browser. */
function guardRemote(contents: WebContents, server: () => string): void {
  const guard = (event: { preventDefault(): void; url: string; isMainFrame: boolean }) => {
    if (!event.isMainFrame) return;
    const decision = navigationDecision(event.url, server());
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") openExternally(event.url);
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
  contents.setWindowOpenHandler(({ url }) => {
    if (windowOpenDecision(url) === "external") openExternally(url);
    return { action: "deny" };
  });
}

/** Local pages never navigate or open windows. */
function guardLocal(contents: WebContents): void {
  contents.on("will-navigate", event => event.preventDefault());
  contents.on("will-redirect", event => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/** Restores saved bounds only when they still fit on a connected display, else just the size, within the display. */
function visibleBounds(bounds: Bounds | undefined): Partial<Bounds> {
  if (!bounds) return {};
  const area = screen.getDisplayMatching(bounds).workArea;
  const fits = bounds.x >= area.x - 50 && bounds.y >= area.y - 50 && bounds.x + bounds.width <= area.x + area.width + 50 && bounds.y + bounds.height <= area.y + area.height + 50;
  return fits ? bounds : { width: Math.min(bounds.width, area.width), height: Math.min(bounds.height, area.height) };
}

/** The browser's own right-click menu: spelling suggestions, then the edit commands that apply where you clicked. */
function editContextMenu(window: BrowserWindow): void {
  window.webContents.on("context-menu", (_event, params) => {
    const spelling: MenuItemConstructorOptions[] = params.misspelledWord ? [
      ...params.dictionarySuggestions.map(word => ({ label: word, click: () => window.webContents.replaceMisspelling(word) })),
      { label: "Add to Dictionary", click: () => window.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
      { type: "separator" },
    ] : [];
    const { canCut, canCopy, canPaste, canSelectAll } = params.editFlags;
    const editing: MenuItemConstructorOptions[] = [
      ...(params.isEditable ? [{ role: "cut", enabled: canCut } as const] : []),
      { role: "copy", enabled: canCopy },
      ...(params.isEditable ? [{ role: "paste", enabled: canPaste } as const] : []),
      { type: "separator" },
      { role: "selectAll", enabled: canSelectAll },
    ];
    Menu.buildFromTemplate([...spelling, ...editing]).popup({ window });
  });
}

export function createMainWindow(settings: SettingsStore, icon: string | undefined): BrowserWindow {
  const server = () => settings.get().server;
  const window = new BrowserWindow({
    width: 1280, height: 860, minWidth: 420, minHeight: 480, title: "Pistead", show: false,
    ...(icon ? { icon } : {}),
    ...visibleBounds(settings.get().windowBounds),
    webPreferences: { partition: REMOTE_PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: true },
  });
  guardRemote(window.webContents, server);
  editContextMenu(window);
  let saving: NodeJS.Timeout | undefined;
  const save = () => {
    clearTimeout(saving);
    saving = setTimeout(() => { if (!window.isDestroyed() && !window.isMinimized() && !window.isFullScreen()) settings.update({ windowBounds: window.getNormalBounds() }); }, 400);
  };
  window.on("resize", save);
  window.on("move", save);
  window.on("close", () => { clearTimeout(saving); if (!window.isMinimized() && !window.isFullScreen()) settings.update({ windowBounds: window.getNormalBounds() }); });
  window.once("ready-to-show", () => window.show());
  // A slow server still gets a visible window rather than none.
  setTimeout(() => { if (!window.isDestroyed() && !window.isVisible()) window.show(); }, 3000);
  // An unreachable server would leave a blank window: say so, with a link back that the navigation guard allows.
  window.webContents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || URL.parse(url)?.origin !== server()) return;
    void window.loadURL(offlinePage(server())).catch(() => {});
  });
  void window.loadURL(server()).catch(() => {});
  return window;
}

function offlinePage(server: string): string {
  const escaped = server.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Pistead</title>`
    + `<style>body{font:15px -apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f5f1;color:#1d1f1d}`
    + `@media(prefers-color-scheme:dark){body{background:#111311;color:#e8e6e1}}main{max-width:28rem;padding:2rem;text-align:center}a{color:#c0491d}</style>`
    + `<main><h1>Pistead can't reach the server</h1><p>${escaped} did not answer. Check your connection, or change the server in Pistead's Settings.</p><p><a href="${escaped}/">Try again</a></p></main>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function createLocalWindow(page: string, options: { title: string; width: number; height: number; preload: string; icon: string | undefined }): BrowserWindow {
  const window = new BrowserWindow({
    width: options.width, height: options.height, minWidth: 380, minHeight: 360, title: options.title, show: false,
    ...(options.icon ? { icon: options.icon } : {}),
    webPreferences: { preload: options.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false },
  });
  guardLocal(window.webContents);
  window.once("ready-to-show", () => window.show());
  void window.loadURL(`${APP_SCHEME}://${APP_HOST}/${page}`).catch(() => {});
  return window;
}
