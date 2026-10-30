import { contextBridge, ipcRenderer } from "electron";
import { channels, type HostView, type PisteadBridge, type SettingsView } from "../shared/bridge.js";

// Loaded only into the app's local pages. Each function forwards one typed call; the main process checks the sender
// and validates every payload, so nothing here is trusted.

const bridge: PisteadBridge = {
  host: {
    view: () => ipcRenderer.invoke(channels.hostView),
    refresh: () => ipcRenderer.invoke(channels.hostRefresh),
    start: input => ipcRenderer.invoke(channels.hostStart, input),
    stop: () => ipcRenderer.invoke(channels.hostStop),
    setOpenAtLogin: enabled => ipcRenderer.invoke(channels.hostOpenAtLogin, enabled),
    onUpdate: listener => {
      const forward = (_event: unknown, view: HostView) => listener(view);
      ipcRenderer.on(channels.hostUpdate, forward);
      return () => { ipcRenderer.off(channels.hostUpdate, forward); };
    },
  },
  settings: {
    view: () => ipcRenderer.invoke(channels.settingsView),
    setServer: origin => ipcRenderer.invoke(channels.settingsServer, origin),
    startLocal: input => ipcRenderer.invoke(channels.localStart, input),
    stopLocal: () => ipcRenderer.invoke(channels.localStop),
    onUpdate: listener => {
      const forward = (_event: unknown, view: SettingsView) => listener(view);
      ipcRenderer.on(channels.settingsUpdate, forward);
      return () => { ipcRenderer.off(channels.settingsUpdate, forward); };
    },
  },
};

contextBridge.exposeInMainWorld("pistead", bridge);
