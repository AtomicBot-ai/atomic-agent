import { ipcMain, type BrowserWindow } from "electron";
import type { RequestType, SidecarEvent } from "@agent/sidecar/index.js";
import type { SidecarClient } from "./sidecar-client.js";

export interface AgentStatus {
  running: boolean;
  error: string | null;
}

export function registerAgentIpc(
  getClient: () => SidecarClient | null,
  getStatus: () => AgentStatus,
  getWindow: () => BrowserWindow | null,
): (client: SidecarClient) => void {
  ipcMain.handle("agent.status", () => getStatus());

  ipcMain.handle(
    "agent.request",
    async (_event, type: RequestType, payload: unknown) => {
      const client = getClient();
      const status = getStatus();
      if (!client?.isRunning()) {
        throw new Error(status.error ?? "sidecar is not running");
      }
      return client.request(type, payload);
    },
  );

  return (client: SidecarClient): void => {
    client.on("event", (event: SidecarEvent) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send("agent.event", event);
      }
    });
    client.on("exit", (code, signal) => {
      const reason =
        signal !== null
          ? `sidecar exited via signal ${String(signal)}`
          : `sidecar exited with code ${String(code ?? "unknown")}`;
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send("agent.sidecar-exit", {
          running: false,
          error: reason,
        });
      }
    });
  };
}
