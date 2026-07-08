import { contextBridge, ipcRenderer } from "electron";
import type { SidecarEvent } from "@agent/sidecar/index.js";
import type { AgentBridge, AgentStatus } from "../shared/agent-bridge.js";
import type { WindowBridge } from "../shared/window-bridge.js";

const agentBridge: AgentBridge = {
  request: (type, payload) => ipcRenderer.invoke("agent.request", type, payload),
  getStatus: () => ipcRenderer.invoke("agent.status"),
  onEvent: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, evt: SidecarEvent) => {
      callback(evt);
    };
    ipcRenderer.on("agent.event", handler);
    return () => {
      ipcRenderer.removeListener("agent.event", handler);
    };
  },
  onStatusChange: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, status: AgentStatus) => {
      callback(status);
    };
    ipcRenderer.on("agent.sidecar-exit", handler);
    return () => {
      ipcRenderer.removeListener("agent.sidecar-exit", handler);
    };
  },
};

const windowBridge: WindowBridge = {
  minimize: () => ipcRenderer.send("win.minimize"),
  toggleMaximize: () => ipcRenderer.send("win.toggle-maximize"),
  close: () => ipcRenderer.send("win.close"),
  isMaximized: () => ipcRenderer.invoke("win.is-maximized"),
  onMaximizeChange: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) => {
      callback(maximized);
    };
    ipcRenderer.on("win.maximize-changed", handler);
    return () => {
      ipcRenderer.removeListener("win.maximize-changed", handler);
    };
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("agent", agentBridge);
contextBridge.exposeInMainWorld("windowControls", windowBridge);
