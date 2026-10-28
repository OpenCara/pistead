import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { channels, type HostView, type SettingsView } from "../shared/bridge.js";
import { HostController } from "./host-controller.js";
import { HostProcess } from "./host-process.js";
import { LocalServerController } from "./local-server.js";
import { HostTray, installAppMenu, type MenuActions } from "./menu.js";
import { DEFAULT_SERVER, parseServerOrigin } from "./origin.js";
import { isLocalPage, parseBoolean, parseLocalStartInput, parseStartInput, parseString } from "./requests.js";
import { SettingsStore } from "./settings.js";
import { createLocalWindow, createMainWindow, hardenRemoteSession, registerLocalScheme, serveLocalPages } from "./windows.js";

const mac = process.platform === "darwin";
const hostTitle = mac ? "This Mac" : "This Computer";
// Development switches, honored only when the app runs unpackaged: a separate userData and connector state (so a
// developer's real pairing is untouched) and fixture models instead of Pi's.
const development = !app.isPackaged;
const developmentEnv = (name: string) => development ? process.env[name] || undefined : undefined;
const fixtureModels = developmentEnv("PISTEAD_DESKTOP_ALLOW_FAUX") === "1";
const stateDir = developmentEnv("PISTEAD_DESKTOP_STATE_DIR");
const serverStateDir = developmentEnv("PISTEAD_DESKTOP_SERVER_STATE_DIR");
const userData = developmentEnv("PISTEAD_DESKTOP_USER_DATA");
/** Writes PNGs of the windows into this directory, then quits: launch verification for any build. */
const smokeDirectory = process.env.PISTEAD_DESKTOP_SMOKE || undefined;

app.setName("Pistead");
if (userData) app.setPath("userData", userData);
registerLocalScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(main);
}

function main(): void {
  const appRoot = app.getAppPath();
  const assets = join(appRoot, "assets");
  const icon = mac ? undefined : join(assets, "icon.png");
  const preload = join(__dirname, "preload.js");
  const settings = new SettingsStore(join(app.getPath("userData"), "settings.json"));
  serveLocalPages(join(__dirname, "renderer"));

  let mainWindow: BrowserWindow | undefined;
  let hostWindow: BrowserWindow | undefined;
  let settingsWindow: BrowserWindow | undefined;

  const loginItemSupported = process.platform === "darwin" || process.platform === "win32";
  const controller = new HostController({
    title: hostTitle, settings, fixtureModels,
    async confirmUnsandboxed(warning) {
      const options = {
        type: "warning" as const, buttons: ["Cancel", "Run Unsandboxed"], defaultId: 0, cancelId: 0, noLink: true,
        title: "Run without a sandbox?",
        message: mac ? "This Mac has no isolated sandbox. Run agent work directly on it?" : "This computer has no isolated sandbox. Run agent work directly on it?",
        detail: warning.trim(),
      };
      const parent = hostWindow && !hostWindow.isDestroyed() ? hostWindow : undefined;
      const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      return response === 1;
    },
    ...(loginItemSupported ? { loginItem: {
      get: () => app.getLoginItemSettings().openAtLogin,
      set: (openAtLogin: boolean) => app.setLoginItemSettings({ openAtLogin }),
    } } : {}),
  });
  // Packaged: the connector staged into Resources with its production dependencies. Unpackaged: the app's own build of
  // the host, whose dependencies resolve from the workspace's node_modules.
  const hostEntry = app.isPackaged
    ? join(process.resourcesPath, "connector", "dist", "desktop-host.mjs")
    : join(appRoot, "dist", "host", "desktop-host.mjs");
  // Pistead on this computer: the local server, staged beside the connector host (it shares its dependencies).
  const serverEntry = app.isPackaged
    ? join(process.resourcesPath, "connector", "dist", "desktop-server.mjs")
    : join(appRoot, "dist", "host", "desktop-server.mjs");
  const localServer = new LocalServerController({
    entry: serverEntry, args: serverStateDir ? ["--state-dir", serverStateDir] : [], settings, testMode: fixtureModels,
    async confirmUnsandboxed(warning) {
      const options = {
        type: "warning" as const, buttons: ["Cancel", "Run Unsandboxed"], defaultId: 0, cancelId: 0, noLink: true,
        title: "Run sessions without a sandbox?",
        message: mac ? "This Mac has no isolated sandbox. Run your sessions directly on it?" : "This computer has no isolated sandbox. Run your sessions directly on it?",
        detail: `${warning.trim()}\n\nWithout your consent, Pistead still runs here, and you can pair another machine to run sessions.`,
      };
      const parent = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : undefined;
      const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      return response === 1;
    },
  });
  // Pistead on this computer while it runs, else the configured server: what the Pistead window shows.
  const activeServer = () => localServer.origin ?? settings.get().server;
  hardenRemoteSession(activeServer);

  const hostProcess = new HostProcess({
    entry: hostEntry, args: stateDir ? ["--state-dir", stateDir] : [],
    onEvent: event => {
      if (event.type === "status") controller.handleStatus(event.state, event);
      else if (event.type === "log") controller.log(event.level, event.message);
      else controller.handleFailure(event.error.message);
    },
    onOutput: line => controller.log("warning", line),
    onExit: (code, expected) => controller.handleExit(code, expected),
  });
  controller.attach(hostProcess);

  const showWindow = (window: BrowserWindow) => {
    if (mac) void app.dock?.show();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const openMain = () => {
    if (mainWindow && !mainWindow.isDestroyed()) { showWindow(mainWindow); return; }
    if (mac) void app.dock?.show();
    mainWindow = createMainWindow(settings, icon, activeServer, localServer.claimUrl ?? activeServer());
    mainWindow.on("closed", () => { mainWindow = undefined; });
  };
  const openHost = () => {
    if (hostWindow && !hostWindow.isDestroyed()) { showWindow(hostWindow); return; }
    if (mac) void app.dock?.show();
    hostWindow = createLocalWindow("host.html", { title: hostTitle, width: 620, height: 820, preload, icon });
    hostWindow.on("closed", () => { hostWindow = undefined; });
    void controller.refresh();
  };
  const openSettings = () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) { showWindow(settingsWindow); return; }
    if (mac) void app.dock?.show();
    settingsWindow = createLocalWindow("settings.html", { title: "Settings", width: 560, height: 720, preload, icon });
    settingsWindow.on("closed", () => { settingsWindow = undefined; });
    void localServer.inspect();
  };
  const startFromMenu = () => {
    void controller.start({ replacePairing: false }).then(outcome => { if (!outcome.ok) openHost(); });
  };
  const actions: MenuActions = { hostTitle, openMain, openHost, openSettings, startHost: startFromMenu, stopHost: () => void controller.stop() };
  installAppMenu(actions);
  const tray = new HostTray(actions, assets);

  const publish = () => {
    const view = controller.view();
    tray.update(view.state, view.error);
    if (hostWindow && !hostWindow.isDestroyed()) hostWindow.webContents.send(channels.hostUpdate, view);
  };
  controller.onChange(publish);
  publish();

  const settingsView = (): SettingsView => ({ server: settings.get().server, defaultServer: DEFAULT_SERVER, local: localServer.view() });
  // The Pistead window follows Pistead on this computer: there once it runs (its sign-in link while nobody has claimed
  // it), and back to the configured server once it stops.
  let shown = activeServer();
  localServer.onChange(() => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send(channels.settingsUpdate, settingsView());
    const next = activeServer();
    if (next === shown) return;
    shown = next;
    if (mainWindow && !mainWindow.isDestroyed()) void mainWindow.loadURL(localServer.claimUrl ?? next).catch(() => {});
  });

  /** Every call must come from the main frame of the named local window, still showing its bundled page. */
  const handle = <T>(channel: string, page: string, window: () => BrowserWindow | undefined, run: (payload: unknown) => T) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, payload: unknown) => {
      const target = window();
      const frame = event.senderFrame;
      if (!target || target.isDestroyed() || event.sender !== target.webContents || !frame || frame !== event.sender.mainFrame || !isLocalPage(frame.url, page)) {
        throw new Error("Refused: not the app's own page");
      }
      return run(payload);
    });
  };
  const host = () => hostWindow;
  const refused = { ok: false as const, error: "Invalid request." };
  handle(channels.hostView, "host.html", host, (): HostView => controller.view());
  handle(channels.hostRefresh, "host.html", host, async () => { await controller.refresh(); });
  handle(channels.hostStart, "host.html", host, payload => {
    const input = parseStartInput(payload);
    return input.ok ? controller.start(input.value) : { ok: false, error: input.error };
  });
  handle(channels.hostStop, "host.html", host, () => controller.stop());
  handle(channels.hostOpenAtLogin, "host.html", host, payload => {
    const enabled = parseBoolean(payload);
    return enabled.ok ? controller.setOpenAtLogin(enabled.value) : refused;
  });
  handle(channels.settingsView, "settings.html", () => settingsWindow, settingsView);
  handle(channels.localStart, "settings.html", () => settingsWindow, payload => {
    const input = parseLocalStartInput(payload);
    return input.ok ? localServer.start(input.value.github) : { ok: false, error: input.error };
  });
  handle(channels.localStop, "settings.html", () => settingsWindow, () => localServer.stop());
  handle(channels.settingsServer, "settings.html", () => settingsWindow, payload => {
    const input = parseString(payload, 2048);
    if (!input.ok) return refused;
    const origin = parseServerOrigin(input.value);
    if (!origin.ok) return origin;
    if (origin.origin !== settings.get().server) {
      settings.update({ server: origin.origin });
      shown = activeServer();
      if (mainWindow && !mainWindow.isDestroyed() && !localServer.origin) void mainWindow.loadURL(origin.origin).catch(() => {});
      void controller.refresh();
    }
    return { ok: true as const };
  });

  app.on("second-instance", openMain);
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().some(window => window.isVisible())) openMain(); });
  app.on("window-all-closed", () => {
    // A running host, or Pistead running on this computer, keeps the app alive in the menu bar (macOS keeps it anyway).
    if (controller.hostState !== "stopped" || localServer.running) { if (mac) app.dock?.hide(); return; }
    if (!mac) app.quit();
  });
  let quitting = false;
  app.on("before-quit", event => {
    if (quitting || (!hostProcess.running && !localServer.running)) return;
    event.preventDefault();
    quitting = true;
    void Promise.all([hostProcess.shutdown(10_000), localServer.shutdown(10_000)]).finally(() => app.quit());
  });

  openMain();
  if (smokeDirectory) {
    const windows = { main: () => mainWindow, host: () => { openHost(); return hostWindow; }, settings: () => { openSettings(); return settingsWindow; } };
    void smoke(smokeDirectory, windows, controller);
    return;
  }
  void controller.resume();
  void localServer.resume();
}

/** Captures the Pistead, host and Settings windows once they have rendered, then quits. */
async function smoke(directory: string, windows: Record<"main" | "host" | "settings", () => BrowserWindow | undefined>, controller: HostController): Promise<void> {
  mkdirSync(directory, { recursive: true });
  const capture = async (window: BrowserWindow | undefined, name: string) => {
    if (!window) throw new Error(`${name} window did not open`);
    if (window.webContents.isLoading()) {
      const loaded = Promise.withResolvers<void>();
      window.webContents.once("did-stop-loading", () => loaded.resolve());
      await loaded.promise;
    }
    // Let late layout and web fonts settle before the capture.
    await delay(1500);
    writeFileSync(join(directory, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await capture(windows.main(), "main");
    const host = windows.host();
    const inspected = Promise.withResolvers<void>();
    const check = () => { if (controller.view().inspection && !controller.view().inspecting) inspected.resolve(); };
    const unsubscribe = controller.onChange(check);
    check();
    await inspected.promise;
    unsubscribe();
    await capture(host, "host");
    await capture(windows.settings(), "settings");
  } catch (error) {
    process.stderr.write(`Smoke capture failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
  app.quit();
}
