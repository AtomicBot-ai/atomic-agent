import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import {
  registerAgentIpc,
  type AgentStatus,
} from "./ipc.js";
import { SidecarClient } from "./sidecar-client.js";
import { resolveSidecarSpawnSpec } from "./sidecar-locator.js";
import {
  bindWindowMaximizeEvents,
  registerWindowControls,
} from "./window-controls.js";

let mainWindow: BrowserWindow | null = null;
let sidecarClient: SidecarClient | null = null;
let sidecarBootError: string | null = null;

const wireSidecarEvents = registerAgentIpc(
  () => sidecarClient,
  (): AgentStatus => ({
    running: sidecarClient?.isRunning() ?? false,
    error: sidecarBootError,
  }),
  () => mainWindow,
);

function onSidecarExit(code: number | null, signal: NodeJS.Signals | null): void {
  sidecarBootError =
    signal !== null
      ? `sidecar exited via signal ${signal}`
      : `sidecar exited with code ${String(code ?? "unknown")}`;
  sidecarClient = null;
  console.error(`[desktop] ${sidecarBootError}`);
}

function resolvePreloadPath(): string {
  const mjs = join(__dirname, "../preload/index.mjs");
  if (existsSync(mjs)) return mjs;
  return join(__dirname, "../preload/index.js");
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    frame: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 12, y: 14 },
    backgroundColor: "#171717",
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: "Atomic Agent",
  });

  bindWindowMaximizeEvents(mainWindow);

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function startSidecar(): Promise<void> {
  sidecarBootError = null;
  const spawnSpec = resolveSidecarSpawnSpec();
  console.info(
    `[desktop] spawning sidecar: ${spawnSpec.command} ${spawnSpec.args.join(" ")}`,
  );

  const client = new SidecarClient(spawnSpec);
  client.on("exit", onSidecarExit);
  wireSidecarEvents(client);
  await client.start();
  sidecarClient = client;
}

async function stopSidecar(): Promise<void> {
  if (!sidecarClient) return;
  await sidecarClient.shutdown();
  sidecarClient = null;
}

void app.whenReady().then(async () => {
  try {
    await startSidecar();
    console.info("[desktop] sidecar ready");
  } catch (err) {
    sidecarBootError =
      err instanceof Error ? err.message : String(err);
    sidecarClient = null;
    console.error(`[desktop] failed to start sidecar: ${sidecarBootError}`);
  }
  registerWindowControls(() => mainWindow);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    void stopSidecar().finally(() => app.quit());
  }
});

app.on("before-quit", () => {
  void stopSidecar();
});
