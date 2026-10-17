import { join } from "node:path";
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";
import type { HostState } from "../../../runner/src/desktop-protocol.js";
import { stateLabels } from "../shared/bridge.js";

export interface MenuActions {
  hostTitle: string;
  openMain(): void;
  openHost(): void;
  openSettings(): void;
  startHost(): void;
  stopHost(): void;
}

/** Standard app, edit, view and window menus; macOS keeps app-level items in the app menu, others in File. */
export function installAppMenu(actions: MenuActions): void {
  const mac = process.platform === "darwin";
  const ellipsis = `${actions.hostTitle}…`;
  const appItems: MenuItemConstructorOptions[] = [
    { label: "Settings…", accelerator: "CommandOrControl+,", click: actions.openSettings },
    { label: ellipsis, click: actions.openHost },
  ];
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" as const, submenu: [
      { role: "about" as const }, { type: "separator" as const }, ...appItems, { type: "separator" as const },
      { role: "services" as const }, { type: "separator" as const },
      { role: "hide" as const }, { role: "hideOthers" as const }, { role: "unhide" as const }, { type: "separator" as const }, { role: "quit" as const },
    ] }] : []),
    { label: "File", submenu: [
      { label: "Open Pistead", accelerator: "CommandOrControl+N", click: actions.openMain },
      ...(mac ? [] : [{ type: "separator" as const }, ...appItems]),
      { type: "separator" }, mac ? { role: "close" } : { role: "quit" },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [
      { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" },
    ] },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** The menu bar (macOS) or notification-area item: host status and the few actions that need no window. */
export class HostTray {
  private readonly tray: Tray;

  constructor(private readonly actions: MenuActions, assets: string) {
    // macOS tints "Template" images for light and dark menu bars; elsewhere the full-color mark reads on any panel.
    const image = nativeImage.createFromPath(join(assets, process.platform === "darwin" ? "trayTemplate.png" : "tray.png"));
    if (process.platform === "darwin") image.setTemplateImage(true);
    this.tray = new Tray(image);
    // Windows opens a tray item's menu on right-click only; a left click should too.
    if (process.platform === "win32") this.tray.on("click", () => this.tray.popUpContextMenu());
  }

  update(state: HostState, error: string | undefined): void {
    const stopped = state === "stopped";
    const status = `Host: ${error && stopped ? "Stopped (error)" : stateLabels[state]}`;
    this.tray.setToolTip(`Pistead — ${status}`);
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: "separator" },
      { label: "Open Pistead", click: this.actions.openMain },
      { label: `${this.actions.hostTitle}…`, click: this.actions.openHost },
      stopped ? { label: "Start Host", click: this.actions.startHost } : { label: "Stop Host", enabled: state !== "stopping", click: this.actions.stopHost },
      { type: "separator" },
      { label: `Quit ${app.name}`, role: "quit" },
    ]));
  }
}
