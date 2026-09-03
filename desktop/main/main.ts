import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";   // item 5: the attachment strip stats what a turn wrote, nothing else
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AgentClient } from "./agent-client.js";
import { buildMenu } from "./menu.js";
import {
  configGet,
  configSet,
  hostRamGb,
  modelsList,
  modelsPull,
  modelsUse,
  PROVIDER_KEY_ENV,
  modelsSearch,
  upsertProvider,
  setProviderModel,
  type ProviderEntry,
  providerModels,
  modelsStart,
  traceUsage,
  traceTools,
  // Lane B — backend switch
  chatModelsList,
  configSetWhole,
  localDaemonRunning,
  modelsStop,
  providerHasKey,
  providersReady,
  setActiveTextProvider,
  setExternalLlamaUrl,
  useManagedMode,
  type UserConfigShape,
  // Lane B — context before the first message (item 3)
  modelWindow,
  traceBaseline,
} from "./agent-cli.js";
import {
  activateProvider,
  selectCloudModel,
  selectLocalModel,
  switchBackend,
  type SwitchResult,
} from "./backend-switch.js";
// Lane B — context before the first message (item 3): the no-trace smoke dir.
import { mkdirSync, rmSync } from "node:fs";
// Item 7 (settings surface)
import {
  configUnset,
  configGetKey,
  taskCreate,
  skillList,
  configSetPath,
  skillShow,
  skillSetDisabled,
  skillBrowse,
  skillInstall,
  // Item 7 part C (LLM / Telegram / Import tabs); modelsStop is imported above with lane B's set
  modelsStatus,
  modelsListEmbeddings,
  modelsRemove,
  modelsPullEmbedding,
  modelsUseEmbedding,
  modelsUpdate,
  modelsDevices,
  modelsUseDevice,
  importRun,
  llamaLogTail,
  llamaProbe,
  dotenvKeys,
  dotenvSet,
  envPresent,
  type ImportRunInput,
} from "./agent-cli.js";
import { validateCreateForm, type TaskCreateFormInput } from "./task-schedule.js";
// Item 7 part B (Skills / Memory / MCP tabs)
import { clawhubSkillDetail } from "./clawhub.js";
import { memoryQuery } from "./memory-db.js";

const DEV = process.argv.includes("--dev");
/** `--smoke` boots, waits for first paint, writes a screenshot, and exits. */
const SMOKE = process.argv.includes("--smoke");
/** `--onboarding` re-runs the setup wizard even on a configured install. */
const FORCE_ONBOARDING = process.argv.includes("--onboarding");
/** `--models` drives the Models pane end to end and asserts config changed. */
const MODELS_TEST = process.argv.includes("--models");

let win: BrowserWindow | null = null;
let agent: AgentClient | null = null;
let pull: { done: Promise<unknown>; cancel: () => void } | null = null;

// Lane B — backend switch: the llm route `atag serve` booted with. serve
// pins its provider at boot, so a switch whose write found the file already
// naming that provider (the TUI or a hand edit moved the file while this
// window was open) still has to restart when serve is behind the file.
interface BootRoute { provider: string; model: string | null }
let bootRoute: Promise<BootRoute | null> = Promise.resolve(null);
async function snapshotBootRoute(client: AgentClient): Promise<BootRoute | null> {
  try {
    const body = (await client.config()) as { config?: UserConfigShape };
    const llm = body.config?.llm;
    // No llm block: the runtime synthesizes a single local-llama entry.
    const provider = llm?.activeTextProvider ?? "local-llama";
    const entry = (llm?.providers ?? []).find((p) => p.id === provider);
    return { provider, model: entry?.defaultChatModel ?? entry?.model ?? null };
  } catch {
    return null;
  }
}

function send(channel: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* --- Item 6 (sidebar): the viewer's own sidebar state ---------------------
   Pinning and "I have read this" exist nowhere in the agent: no route and no
   store field records them, and the agent's config.json is the operator's
   file, not a place for one window's view state. So they live in Electron's
   userData as prefs.json, per machine and per viewer, and are honestly empty
   on first run — every historical chat then draws unread until it is opened.
   Never write this through `atag config set`. */
type SidebarPrefs = { pinned: string[]; seen: Record<string, number> };
const PREFS_PATH = () => join(app.getPath("userData"), "prefs.json");

function coercePrefs(raw: unknown): SidebarPrefs {
  const out: SidebarPrefs = { pinned: [], seen: {} };
  if (!raw || typeof raw !== "object") return out;
  const src = raw as { pinned?: unknown; seen?: unknown };
  if (Array.isArray(src.pinned)) {
    for (const id of src.pinned) if (typeof id === "string" && id) out.pinned.push(id);
  }
  if (src.seen && typeof src.seen === "object") {
    for (const [id, at] of Object.entries(src.seen as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) out.seen[id] = at;
    }
  }
  return out;
}

function readPrefs(): SidebarPrefs {
  try {
    return coercePrefs(JSON.parse(readFileSync(PREFS_PATH(), "utf8")));
  } catch {
    return { pinned: [], seen: {} };
  }
}

function writePrefs(raw: unknown): { ok: boolean; error?: string } {
  try {
    writeFileSync(PREFS_PATH(), JSON.stringify(coercePrefs(raw)));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: "#191C21",
    // The design draws its own 52px toolbar, so the frame keeps only the
    // traffic lights and insets them into that band.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 20 },
    vibrancy: "sidebar",
    webPreferences: {
      preload: join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  // Renderer faults must never be silent: they surface in the app log
  // and, under --smoke, on stdout where CI can see them.
  window.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 2 || SMOKE) {
      const where = sourceId ? ` (${sourceId}:${line})` : "";
      process.stderr.write(`RENDERER[${level}] ${message}${where}\n`);
    }
  });
  window.webContents.on("render-process-gone", (_e, details) =>
    process.stderr.write(`RENDERER GONE ${JSON.stringify(details)}\n`),
  );

  window.once("ready-to-show", () => {
    window.show();
    if (DEV) window.webContents.openDevTools({ mode: "detach" });
  });

  // The renderer is local and must never navigate anywhere else.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  void window.loadFile(join(__dirname, "..", "renderer", "index.html"));
  return window;
}

function wireIpc(client: AgentClient): void {
  ipcMain.handle("agent:status", () => client.status);
  ipcMain.handle("agent:start", () => client.start());
  ipcMain.handle("agent:restart", async () => {
    await client.stop();
    return client.start();
  });

  const resource = <T>(name: string, fn: () => Promise<T>) => {
    ipcMain.handle(`agent:${name}`, async () => {
      try {
        return { ok: true, data: await fn() };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  };
  resource("capabilities", () => client.capabilities());
  resource("config", () => client.config());
  resource("skills", () => client.skills());
  resource("tasks", () => client.tasks());
  resource("sessions", () => client.sessions());
  resource("models", () => client.models());
  ipcMain.handle("agent:session", (_event, id: unknown) =>
    typeof id === "string" ? client.session(id).then((data) => ({ ok: true, data })).catch((e) => ({ ok: false, error: String(e) })) : { ok: false, error: "id required" },
  );
  // Item 6 (sidebar): a real delete. Splicing the array only made the row come
  // back on the next load — the route is idempotent, so an unknown id is a 200.
  ipcMain.handle("agent:deleteSession", (_event, id: unknown) =>
    typeof id === "string" && id
      ? client.deleteSession(id).then((data) => ({ ok: true, data })).catch((e) => ({ ok: false, error: String(e) }))
      : { ok: false, error: "id required" },
  );
  ipcMain.handle("agent:codingMode", (_event, mode: unknown) =>
    client.codingMode(typeof mode === "string" ? mode : undefined),
  );

  ipcMain.handle("agent:chat", (_event, payload: unknown) => {
    const { messages, sessionId } = payload as {
      messages?: Array<{ role: string; content: string }>;
      sessionId?: string;
    };
    if (!Array.isArray(messages) || messages.length === 0) {
      return { ok: false, error: "messages must be a non-empty array" };
    }
    const clean = messages
      .filter((m) => m && typeof m.role === "string" && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content }));
    if (!clean.length) return { ok: false, error: "no usable messages" };
    const turnId = randomUUID();
    void client.chat(turnId, clean, typeof sessionId === "string" ? sessionId : undefined);
    return { ok: true, turnId };
  });

  ipcMain.handle("agent:cancel", (_event, turnId: unknown) =>
    typeof turnId === "string" ? client.cancel(turnId) : false,
  );

  ipcMain.handle("agent:approve", async (_event, payload: unknown) => {
    const { approvalId, decision, reason } = payload as {
      approvalId?: string;
      decision?: string;
      reason?: string;
    };
    if (typeof approvalId !== "string") return { ok: false, error: "approvalId required" };
    if (decision !== "allow-once" && decision !== "deny") {
      return { ok: false, error: "decision must be allow-once or deny" };
    }
    try {
      return { ok: true, data: await client.resolveApproval(approvalId, decision, reason) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("app:chooseWorkspace", async () => {
    if (!win) return null;
    const picked = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: client.status.workingDir,
      message: "Choose the folder the agent may work in",
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    const dir = picked.filePaths[0];
    // Telling the user to restart while the child keeps its old cwd is a lie;
    // move it here instead.
    client.status.workingDir = dir;
    await client.stop();
    void client.start();
    return dir;
  });

  // --- setup wizard: config writes and the local model catalogue ---
  ipcMain.handle("cli:configGet", () => configGet());
  ipcMain.handle("cli:configSet", (_event, payload: unknown) => {
    const { key, value } = payload as { key?: unknown; value?: unknown };
    if (typeof key !== "string" || typeof value !== "string") {
      return { ok: false, error: "key and value must be strings" };
    }
    return configSet(key, value);
  });
  ipcMain.handle("cli:modelsList", () => modelsList());
  // Review fix (item 5): the chat route's half of the catalogue, subtracted
  // by the CLI's own embedding catalogue instead of by a guess at names.
  ipcMain.handle("cli:chatModelsList", () => chatModelsList());
  ipcMain.handle("cli:modelsUse", (_event, id: unknown) =>
    typeof id === "string" ? modelsUse(id) : { ok: false, error: "model id required" },
  );
  ipcMain.handle("cli:modelsPull", (_event, id: unknown) => {
    if (typeof id !== "string") return { ok: false, error: "model id required" };
    if (pull) return { ok: false, error: "a download is already running" };
    const started = modelsPull(id, (line) => send("cli:pull", { id, line }));
    pull = started;
    void started.done.then((res) => {
      pull = null;
      send("cli:pull", { id, done: true, ok: res.ok, error: res.error ?? null });
    });
    return { ok: true, started: true };
  });
  ipcMain.handle("cli:cancelPull", () => {
    if (!pull) return false;
    pull.cancel();
    return true;
  });
  ipcMain.handle("cli:modelsSearch", (_event, payload: unknown) => {
    const { query, provider, limit } = (payload ?? {}) as {
      query?: unknown; provider?: unknown; limit?: unknown;
    };
    return modelsSearch(
      typeof query === "string" ? query : "",
      typeof provider === "string" ? provider : undefined,
      typeof limit === "number" ? limit : 40,
    );
  });
  ipcMain.handle("cli:upsertProvider", (_event, entry: unknown) => {
    const e = entry as Partial<ProviderEntry>;
    if (!e || typeof e.id !== "string" || typeof e.kind !== "string") {
      return { ok: false, error: "id and kind are required" };
    }
    return upsertProvider(e as ProviderEntry);
  });
  ipcMain.handle("cli:setProviderModel", (_event, payload: unknown) => {
    const { id, model } = (payload ?? {}) as { id?: unknown; model?: unknown };
    if (typeof id !== "string" || typeof model !== "string") {
      return { ok: false, error: "id and model are required" };
    }
    return setProviderModel(id, model);
  });
  ipcMain.handle("cli:providerModels", (_event, payload: unknown) => {
    const { id, kind } = (payload ?? {}) as { id?: unknown; kind?: unknown };
    if (typeof id !== "string") return { ok: false, error: "provider id required" };
    return providerModels(id, typeof kind === "string" ? kind : "");
  });
  ipcMain.handle("cli:modelsStart", () => modelsStart());
  ipcMain.handle("cli:traceUsage", (_event, payload: unknown) => {
    const { stateDir, sessionId } = (payload ?? {}) as { stateDir?: unknown; sessionId?: unknown };
    if (typeof stateDir !== "string" || typeof sessionId !== "string") {
      return { ok: false, error: "stateDir and sessionId are required" };
    }
    return traceUsage(stateDir, sessionId);
  });
  // item 4: per-call tool durations from the trace
  ipcMain.handle("cli:traceTools", (_event, payload: unknown) => {
    const { stateDir, sessionId } = (payload ?? {}) as { stateDir?: unknown; sessionId?: unknown };
    if (typeof stateDir !== "string" || typeof sessionId !== "string") {
      return { ok: false, error: "stateDir and sessionId are required" };
    }
    return traceTools(stateDir, sessionId);
  });
  ipcMain.handle("app:hostRam", () => hostRamGb());
  ipcMain.handle("app:keyEnv", () => PROVIDER_KEY_ENV);

  // Item 6 (sidebar): pin + read state, in userData — never in the agent config.
  ipcMain.handle("app:prefsGet", () => ({ ok: true, data: readPrefs() }));
  ipcMain.handle("app:prefsSet", (_event, prefs: unknown) => writePrefs(prefs));
  // The row's right-click menu. `Menu` is not a top-level import here, so it is
  // required inside the handler exactly as app:fileMenu does.
  ipcMain.handle("app:sessionMenu", (event, payload: unknown) => {
    const { id, pinned } = (payload ?? {}) as { id?: unknown; pinned?: unknown };
    if (typeof id !== "string" || !id) return;
    const { Menu } = require("electron") as typeof import("electron");
    const menu = Menu.buildFromTemplate([
      { label: pinned ? "Unpin" : "Pin", click: () => send("app:menu", (pinned ? "unpin:" : "pin:") + id) },
      { type: "separator" },
      { label: "Delete…", click: () => send("app:menu", "delask:" + id) },
    ]);
    const sender = BrowserWindow.fromWebContents(event.sender);
    menu.popup(sender ? { window: sender } : {});
  });

  // --- Lane B — backend switch ---
  // The write is only half of a switch: `atag serve` pins its provider at
  // boot and has no reload route on 0.5.4, so a result that says
  // `restart` is followed by the same stop+start `agent:restart` does.
  const applySwitch = async (res: SwitchResult) => {
    // The file moved (res.restart), or serve booted on a different route
    // than the file now names — for a cloud route the chat model counts
    // too, since serve pins the provider entry it read at boot.
    const boot = await bootRoute;
    const behind = !!res.ok && !!res.providerId && !!boot
      && (boot.provider !== res.providerId
        || (res.transport === "native_tools" && (boot.model ?? null) !== (res.model ?? null)));
    const restart = !!res.ok && (!!res.restart || behind);
    if (restart) {
      await client.stop();
      await client.start();
    }
    return { ...res, restart, status: client.status };
  };
  ipcMain.handle("cli:switchBackend", async (_event, kind: unknown) => {
    if (kind !== "cloud" && kind !== "local") return { ok: false, error: "backend must be cloud or local" };
    return applySwitch(await switchBackend(kind));
  });
  ipcMain.handle("cli:activateProvider", async (_event, id: unknown) => {
    if (typeof id !== "string") return { ok: false, error: "provider id required" };
    return applySwitch(await activateProvider(id));
  });
  ipcMain.handle("cli:selectCloudModel", async (_event, payload: unknown) => {
    const { id, model } = (payload ?? {}) as { id?: unknown; model?: unknown };
    if (typeof id !== "string" || typeof model !== "string") return { ok: false, error: "id and model are required" };
    return applySwitch(await selectCloudModel(id, model));
  });
  ipcMain.handle("cli:selectLocalModel", async (_event, id: unknown) => {
    if (typeof id !== "string") return { ok: false, error: "model id required" };
    return applySwitch(await selectLocalModel(id));
  });
  ipcMain.handle("cli:useManagedMode", () => useManagedMode());
  // Review fix (item 5): Settings › LLM › External writes mode + url + the
  // local-llama provider url in one whole-file write, as the TUI's
  // persistUserLocalLlmUrl does. Two leaf writes left the provider url stale.
  ipcMain.handle("cli:setExternalLlamaUrl", (_event, url: unknown) =>
    typeof url === "string" ? setExternalLlamaUrl(url) : { ok: false, changed: false, error: "url required" },
  );
  ipcMain.handle("cli:providersReady", () => providersReady());

  // --- Lane B — context before the first message (item 3) ---
  ipcMain.handle("cli:traceBaseline", (_event, payload: unknown) => {
    const { stateDir, model, workingDir } = (payload ?? {}) as { stateDir?: unknown; model?: unknown; workingDir?: unknown };
    if (typeof stateDir !== "string") return { ok: false, error: "stateDir is required" };
    return traceBaseline(stateDir, {
      model: typeof model === "string" && model ? model : null,
      workingDir: typeof workingDir === "string" && workingDir ? workingDir : null,
    });
  });
  ipcMain.handle("cli:modelWindow", async (_event, payload: unknown) => {
    const { providerId, kind, model } = (payload ?? {}) as { providerId?: unknown; kind?: unknown; model?: unknown };
    if (typeof providerId !== "string" || typeof model !== "string") return { ok: false, window: null, error: "providerId and model are required" };
    return { ok: true, window: await modelWindow(providerId, typeof kind === "string" ? kind : "", model) };
  });
  ipcMain.handle("agent:llamaProps", (_event, payload: unknown) => {
    const { url, apiKey } = (payload ?? {}) as { url?: unknown; apiKey?: unknown };
    if (typeof url !== "string") return { ok: false, n_ctx: null, error: "url is required" };
    return client.llamaProps(url, typeof apiKey === "string" && apiKey ? apiKey : undefined);
  });
  ipcMain.handle("agent:contextPreview", (_event, payload: unknown) => {
    const { sessionId, message } = (payload ?? {}) as { sessionId?: unknown; message?: unknown };
    return client.contextPreview(typeof sessionId === "string" && sessionId ? sessionId : null, typeof message === "string" ? message : "");
  });

  // Files the agent produced: open, reveal, copy, save elsewhere.
  const safePath = (p: unknown): string | null => {
    if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0")) return null;
    return p;
  };
  ipcMain.handle("app:openPath", async (_event, p: unknown) => {
    const path = safePath(p);
    if (!path) return { ok: false, error: "not a path" };
    const err = await shell.openPath(path);
    return err ? { ok: false, error: err } : { ok: true };
  });
  // Item 5 (file attachments): read-only existence check for the paths a turn's
  // write tools reported. fs.stat and nothing else — never open, never create.
  // Cap: 64 paths per call; the renderer chunks longer lists so a 65th written
  // file is not silently dropped.
  ipcMain.handle("app:statPaths", async (_event, list: unknown) => {
    if (!Array.isArray(list)) return { ok: false, error: "not a list" };
    const files: Array<{ path: string; exists: boolean; kind: "file" | "dir" | null; size: number; mtimeMs: number }> = [];
    for (const raw of list.slice(0, 64)) {
      const expanded = typeof raw === "string" && raw.startsWith("~/") ? homedir() + raw.slice(1) : raw;
      const path = safePath(expanded);
      if (!path) continue;
      try {
        const st = await stat(path);
        files.push({ path, exists: true, kind: st.isDirectory() ? "dir" : "file", size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        files.push({ path, exists: false, kind: null, size: 0, mtimeMs: 0 });
      }
    }
    return { ok: true, files };
  });

  ipcMain.handle("app:fileMenu", (event, p: unknown) => {
    const path = safePath(p);
    if (!path) return;
    const { clipboard, Menu } = require("electron") as typeof import("electron");
    const menu = Menu.buildFromTemplate([
      { label: "Open", click: () => void shell.openPath(path) },
      { label: "Show in Finder", click: () => shell.showItemInFolder(path) },
      { type: "separator" },
      { label: "Copy Path", click: () => clipboard.writeText(path) },
      {
        label: "Save As…",
        click: async () => {
          if (!win) return;
          const { basename } = await import("node:path");
          const picked = await dialog.showSaveDialog(win, { defaultPath: basename(path) });
          if (picked.canceled || !picked.filePath) return;
          const { copyFile } = await import("node:fs/promises");
          await copyFile(path, picked.filePath);
        },
      },
    ]);
    const sender = BrowserWindow.fromWebContents(event.sender);
    menu.popup(sender ? { window: sender } : {});
  });

  ipcMain.handle("app:openExternal", (_event, url: unknown) => {
    if (typeof url === "string" && /^https?:\/\//.test(url)) void shell.openExternal(url);
  });

  // --- Item 7 (settings surface): tasks, health, config unset, schedule preview ---
  const taskId = (id: unknown): string | null =>
    typeof id === "string" && /^[\w.-]{1,64}$/.test(id) ? id : null;
  const wrap = async <T>(fn: () => Promise<T>) => {
    try {
      return { ok: true, data: await fn() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
  ipcMain.handle("agent:task", (_event, id: unknown) => {
    const clean = taskId(id);
    return clean ? wrap(() => client.task(clean)) : { ok: false, error: "task id required" };
  });
  ipcMain.handle("agent:cancelTask", (_event, id: unknown) => {
    const clean = taskId(id);
    return clean ? wrap(() => client.cancelTask(clean)) : { ok: false, error: "task id required" };
  });
  ipcMain.handle("agent:runTask", (_event, id: unknown) => {
    const clean = taskId(id);
    return clean ? wrap(() => client.runTask(clean)) : { ok: false, error: "task id required" };
  });
  ipcMain.handle("agent:health", () => wrap(() => client.health()));
  // The menu's Quit: the app quits and `before-quit` stops the agent, as the TUI's /quit does.
  ipcMain.handle("app:quit", () => { app.quit(); });
  ipcMain.handle("cli:taskCreate", (_event, input: unknown) => {
    const { message, kind, expression, tz } = (input ?? {}) as {
      message?: unknown; kind?: unknown; expression?: unknown; tz?: unknown;
    };
    if (typeof message !== "string" || !message.trim()) return { ok: false, error: "message required" };
    if (kind !== "cron" && kind !== "interval" && kind !== "at") return { ok: false, error: "kind must be cron, interval or at" };
    if (typeof expression !== "string" || !expression.trim()) return { ok: false, error: "schedule required" };
    return taskCreate(
      { message, kind, expression, ...(typeof tz === "string" && tz.trim() ? { tz: tz.trim() } : {}) },
      client.status.workingDir,
    );
  });
  ipcMain.handle("cli:skillList", () => skillList(client.status.workingDir));
  ipcMain.handle("cli:configGetKey", (_event, key: unknown) =>
    typeof key === "string" ? configGetKey(key) : { ok: false, error: "key must be a string" },
  );
  // Pure: the TUI's form validator + cron-parser preview, no store access.
  ipcMain.handle("app:taskPreview", (_event, payload: unknown) => {
    const { form, now } = (payload ?? {}) as { form?: Record<string, unknown>; now?: unknown };
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const kindRaw = str(form?.kind);
    const kind = kindRaw === "interval" || kindRaw === "at" ? kindRaw : "cron";
    const input: TaskCreateFormInput = {
      kind,
      cronExpression: str(form?.cronExpression),
      intervalSeconds: str(form?.intervalSeconds),
      atIsoOrMs: str(form?.atIsoOrMs),
      tz: str(form?.tz),
      message: str(form?.message),
    };
    try {
      return { ok: true, ...validateCreateForm(input, typeof now === "number" ? now : Date.now()) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // --- Item 7 part B (Skills / Memory / MCP tabs) ---
  const skillName = (v: unknown): string | null =>
    typeof v === "string" && /^[\w.-]{1,64}$/.test(v) ? v : null;
  ipcMain.handle("agent:skill", (_event, name: unknown) => {
    const clean = skillName(name);
    return clean ? wrap(() => client.skill(clean)) : { ok: false, error: "skill name required" };
  });
  ipcMain.handle("agent:uninstallSkill", (_event, payload: unknown) => {
    const { name, source } = (payload ?? {}) as { name?: unknown; source?: unknown };
    const clean = skillName(name);
    if (!clean) return { ok: false, error: "skill name required" };
    return wrap(() => client.uninstallSkill(clean, source === "project" ? "project" : "global"));
  });
  // Whole-file write of one dotted key (llm.* and mcp.servers have no leaf on 0.5.4).
  ipcMain.handle("cli:configSetPath", (_event, payload: unknown) => {
    const { key, value } = (payload ?? {}) as { key?: unknown; value?: unknown };
    if (typeof key !== "string") return { ok: false, error: "key must be a string" };
    if (value === undefined) return { ok: false, error: "value required" };
    return configSetPath(key, value);
  });
  ipcMain.handle("cli:skillShow", (_event, name: unknown) => {
    const clean = skillName(name);
    return clean ? skillShow(clean, client.status.workingDir) : { ok: false, error: "skill name required" };
  });
  ipcMain.handle("cli:skillSetDisabled", (_event, payload: unknown) => {
    const { name, disabled } = (payload ?? {}) as { name?: unknown; disabled?: unknown };
    const clean = skillName(name);
    if (!clean) return { ok: false, error: "skill name required" };
    return skillSetDisabled(clean, disabled === true);
  });
  ipcMain.handle("cli:skillBrowse", (_event, query: unknown) =>
    skillBrowse(typeof query === "string" ? query.slice(0, 200) : "", client.status.workingDir),
  );
  ipcMain.handle("cli:skillInstall", (_event, payload: unknown) => {
    const { identifier, acknowledgeRisk } = (payload ?? {}) as { identifier?: unknown; acknowledgeRisk?: unknown };
    if (typeof identifier !== "string" || !identifier.trim()) return { ok: false, error: "identifier required" };
    return skillInstall(identifier, acknowledgeRisk === true, client.status.workingDir);
  });
  ipcMain.handle("app:clawhubSkillDetail", (_event, payload: unknown) => {
    const { apiBase, slug, owner } = (payload ?? {}) as { apiBase?: unknown; slug?: unknown; owner?: unknown };
    if (typeof apiBase !== "string" || typeof slug !== "string") return { ok: false, error: "apiBase and slug are required" };
    return clawhubSkillDetail(apiBase, slug, typeof owner === "string" && owner ? owner : null);
  });
  // Read-only sqlite over <stateDir>/memory.sqlite; the statement is named, never free SQL.
  ipcMain.handle("app:memoryQuery", (_event, payload: unknown) => {
    const { stateDir, name, params } = (payload ?? {}) as { stateDir?: unknown; name?: unknown; params?: unknown };
    if (typeof stateDir !== "string" || typeof name !== "string") return { ok: false, error: "stateDir and name are required" };
    return memoryQuery(stateDir, name, Array.isArray(params) ? params : []);
  });

  // --- Item 7 part C (LLM / Telegram / Import tabs) ---
  ipcMain.handle("cli:modelsStatus", () => modelsStatus());
  ipcMain.handle("cli:modelsListEmbeddings", () => modelsListEmbeddings());
  ipcMain.handle("cli:modelsStop", () => modelsStop());
  ipcMain.handle("cli:modelsRemove", (_event, id: unknown) =>
    typeof id === "string" ? modelsRemove(id) : { ok: false, error: "model id required" },
  );
  // Shares the one `pull` slot and the `cli:pull` stream with `cli:modelsPull`.
  ipcMain.handle("cli:modelsPullEmbedding", (_event, id: unknown) => {
    if (typeof id !== "string") return { ok: false, error: "model id required" };
    if (pull) return { ok: false, error: "a download is already running" };
    const started = modelsPullEmbedding(id, (line) => send("cli:pull", { id, line }));
    pull = started;
    void started.done.then((res) => {
      pull = null;
      send("cli:pull", { id, done: true, ok: res.ok, error: res.error ?? null });
    });
    return { ok: true, started: true };
  });
  ipcMain.handle("cli:modelsUseEmbedding", (_event, id: unknown) =>
    typeof id === "string" ? modelsUseEmbedding(id) : { ok: false, error: "embedding model id required" },
  );
  ipcMain.handle("cli:modelsUpdate", () => modelsUpdate());
  ipcMain.handle("cli:modelsDevices", () => modelsDevices());
  ipcMain.handle("cli:modelsUseDevice", (_event, id: unknown) =>
    typeof id === "string" ? modelsUseDevice(id) : { ok: false, error: "device id required" },
  );
  // `atag config unset <leaf>` — the Telegram tab's `O clear owner` (telegram.ownerUserId back to its null default).
  ipcMain.handle("cli:configUnset", (_event, key: unknown) =>
    typeof key === "string" ? configUnset(key) : { ok: false, error: "key must be a string" },
  );
  ipcMain.handle("cli:importRun", (_event, input: unknown) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const clean: ImportRunInput = {
      source: i["source"] === "openclaw" ? "openclaw" : "hermes",
      dir: typeof i["dir"] === "string" ? i["dir"] : "",
      exclude: Array.isArray(i["exclude"]) ? (i["exclude"] as unknown[]).filter((x): x is string => typeof x === "string") : [],
      secrets: i["secrets"] === true,
      overwrite: i["overwrite"] === true,
      limit: typeof i["limit"] === "string" ? i["limit"] : "",
      execute: i["execute"] === true,
    };
    return importRun(clean, client.status.workingDir);
  });
  // import-panel-state.ts defaultSourceDir: the env override or ~/.hermes / ~/.openclaw.
  ipcMain.handle("app:importDefaults", () => ({
    hermes: process.env["HERMES_STATE_DIR"] ?? join(homedir(), ".hermes"),
    openclaw: process.env["OPENCLAW_STATE_DIR"] ?? join(homedir(), ".openclaw"),
  }));
  ipcMain.handle("app:llamaLogTail", (_event, dataDir: unknown) =>
    typeof dataDir === "string" && dataDir.startsWith("/") ? llamaLogTail(dataDir) : { ok: false, error: "data dir required" },
  );
  ipcMain.handle("app:llamaProbe", (_event, url: unknown) =>
    typeof url === "string" ? llamaProbe(url) : { ok: false, error: "url required" },
  );
  ipcMain.handle("app:dotenvKeys", (_event, stateDir: unknown) =>
    typeof stateDir === "string" && stateDir.startsWith("/") ? dotenvKeys(stateDir) : { ok: false, keys: [], exists: false, error: "state dir required" },
  );
  ipcMain.handle("app:envPresent", (_event, names: unknown) =>
    envPresent(Array.isArray(names) ? names.filter((n): n is string => typeof n === "string").slice(0, 64) : []),
  );
  // The one key the desktop writes into .env: the Telegram bot token (the TUI's telegram-settings.ts setToken).
  ipcMain.handle("app:dotenvSet", (_event, payload: unknown) => {
    const { stateDir, key, value } = (payload ?? {}) as { stateDir?: unknown; key?: unknown; value?: unknown };
    if (typeof stateDir !== "string" || !stateDir.startsWith("/")) return { ok: false, error: "state dir required" };
    if (key !== "TELEGRAM_BOT_TOKEN") return { ok: false, error: "only TELEGRAM_BOT_TOKEN may be written from the desktop" };
    if (value !== null && typeof value !== "string") return { ok: false, error: "value must be a string or null" };
    return dotenvSet(stateDir, key, value);
  });

  client.on("status", (status) => send("agent:status", status));
  client.on("chat", (event) => send("agent:chat", event));
  client.on("approval", (event) => send("agent:approval", event));
  client.on("log", (event) => send("agent:log", event));

  // Lane B — backend switch: snapshot the route serve booted with, as soon
  // as it is healthy; a stopped or dead child has none.
  client.on("status", (status: { state?: string }) => {
    if (status.state === "connected") bootRoute = snapshotBootRoute(client);
    else if (status.state === "stopped" || status.state === "error") bootRoute = Promise.resolve(null);
  });
}

/** Item 6 (sidebar): what `window.__sidebar()` hands back. */
type Sb = {
  headers: string[];
  navrows: number;
  skillsRow: boolean;
  subtitles: number;
  onRows: number;
  counter: string;
  tasksEmpty: string;
  chats: Array<{ id: string; dot: string; pinned: boolean; name: string; status: string; updatedAt: number }>;
  hiddenChats: number;
  tasks: Array<{ id: string; dot: string; status: string; name: string; seen: number }>;
  hiddenTasks: number;
  running: number;
  loadMore: boolean;
  page: number;
  total: number;
};

async function smokeTest(): Promise<void> {
  if (!win) return;
  const js = <T,>(code: string) => win!.webContents.executeJavaScript(code) as Promise<T>;
  const fail: string[] = [];
  const check = (name: string, ok: boolean, detail = "") => {
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}\n`);
    if (!ok) fail.push(name);
  };

  await new Promise((r) => setTimeout(r, 1500));
  // Item 6: the sidebar is two headed lists, so there are no nav rows left to
  // count. This is still the "render() finished without a TDZ ReferenceError"
  // canary that the .navrow count used to be.
  const sb0 = await js<Sb | null>("window.__sidebar ? window.__sidebar() : null");
  check(
    "renderer painted",
    !!sb0 && sb0.navrows === 0 && JSON.stringify(sb0.headers) === '["Tasks","Chats"]' && sb0.subtitles === 0 && !sb0.skillsRow,
    sb0 ? `headers ${JSON.stringify(sb0.headers)}, navrows ${sb0.navrows}, "N turns" lines ${sb0.subtitles}, skills row ${sb0.skillsRow}` : "no __sidebar hook",
  );
  check("toolbar titled", (await js<string>("document.querySelector('.tb-title b').textContent")) === "Chat");
  check("bridge exposed", await js<boolean>("!!window.atomic"));
  check(
    "no demo content",
    !/Teletubbies|Tinky|Laa-Laa|Tubby|Noo-noo|custard/i.test(
      await js<string>("document.body.innerText"),
    ),
  );
  // The window frame draws the menu bar and the traffic lights; the page
  // must not draw its own, and the toolbar has to be the drag handle.
  check(
    "no duplicate menu bar",
    (await js<string>("getComputedStyle(document.getElementById('menubar')).display")) === "none",
  );
  check(
    "no duplicate traffic lights",
    (await js<string>("getComputedStyle(document.querySelector('.lights')).display")) === "none",
  );
  check(
    "toolbar is draggable",
    (await js<string>("getComputedStyle(document.getElementById('toolbar')).webkitAppRegion")) === "drag",
  );

  // Wait for the supervised agent to come up.
  const deadline = Date.now() + 60_000;
  let state = "";
  while (Date.now() < deadline) {
    state = (await js<string>("window.__live && window.__live()")) ?? "";
    if (state === "connected" || state === "missing-binary" || state === "error") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check("agent connected", state === "connected", `state=${state}`);

  if (state === "connected") {
    // Item 6: boot state. Nothing has been opened, so no row may be drawn as
    // the current one — the old code pointed at the newest session without
    // opening it. Asserted here, before the first __openSession of the run.
    const bootDeadline = Date.now() + 20_000;
    let boot = await js<Sb>("window.__sidebar()");
    while (Date.now() < bootDeadline && boot.total === 0) {
      await new Promise((r) => setTimeout(r, 500));
      boot = await js<Sb>("window.__sidebar()");
    }
    check("no chat is highlighted at boot", boot.onRows === 0, `${boot.total} chats loaded, ${boot.onRows} highlighted`);
  }

  if (FORCE_ONBOARDING) {
    const title = await js<string>(
      "document.querySelector('#onboarding .ob-title')?.textContent ?? ''",
    );
    const options = await js<number>("document.querySelectorAll('#onboarding .ob-opt').length");
    // Lane B — backend switch: two choices; the custom endpoint is not offered by the desktop.
    check("wizard opens", title.length > 0 && options === 2, `${JSON.stringify(title)} options=${options}`);
  }

  // --- Lane B — context before the first message (item 3) ---
  // Nothing has been sent yet, so this block has to run BEFORE the first
  // __ask: the chip must already carry a labelled projection (or the TUI's
  // "not measured yet" state) — never a zero, never a guessed window.
  type PreCtx = {
    tokens: number; source: string | null; window: number | null; windowLabel: string; stablePrefix: number;
    draftTokens: number; previewSupported: boolean | null;
    baseline: { sessionId: string; at: number; modelId: string | null; workspaceMatch: boolean; modelMatch: boolean } | null;
  };
  let pre: PreCtx | null = null;
  if (state === "connected") {
    await js<void>("window.__ctxRefresh()");
    await new Promise((r) => setTimeout(r, 4000));
    pre = await js<PreCtx>("window.__ctx()");
    check(
      "context has a basis before the first message",
      pre.source === "projected" || pre.source === "built" || (pre.source === null && pre.tokens === 0),
      JSON.stringify(pre),
    );
    if (pre.source === "projected") {
      check(
        "projection names its baseline",
        !!pre.baseline && !!pre.baseline.sessionId && pre.baseline.at > 0 && pre.tokens >= pre.stablePrefix && pre.stablePrefix > 1000,
        `${pre.tokens} from ${pre.baseline?.sessionId} (${pre.baseline?.modelId}, workspace=${pre.baseline?.workspaceMatch})`,
      );
      // 52 chars / 8 words → max(ceil(52/3.6)=15, ceil(8*1.4)=12) = 15 with the runtime's estimator.
      const sentence = "hello there, please summarise this repository for me";
      const withDraft = await js<number>(`window.__ctxDraft(${JSON.stringify(sentence)})`);
      check("draft moves the projection by its estimate", withDraft === pre.stablePrefix + 15, `${pre.stablePrefix} + 15 → ${withDraft}`);
      const chip = await js<{ label: string; proj: boolean } | null>("window.__ctxChip()");
      check("projected chip is marked as such", !!chip && chip.proj && chip.label.startsWith("~"), JSON.stringify(chip));
      const cleared = await js<number>("window.__ctxDraft('')");
      check("empty draft returns to the scaffold", cleared === pre.stablePrefix, `${cleared} vs ${pre.stablePrefix}`);
    }
    // The bundled catalogues (openrouter, aimlapi) know their models' windows
    // without the picker ever opening; any other kind may honestly not know.
    const cfgForWindow = (await configGet()).config as UserConfigShape | undefined;
    const activeForWindow = (cfgForWindow?.llm?.providers ?? []).find((p) => p.id === cfgForWindow?.llm?.activeTextProvider);
    const bundledModel = !!activeForWindow && (activeForWindow.kind === "aimlapi" || activeForWindow.kind === "openrouter") && !!activeForWindow.defaultChatModel;
    check(
      "window resolved without opening the picker",
      bundledModel ? pre.window! > 0 && pre.window !== 128000 : pre.window === null || pre.window > 0,
      `window=${pre.window} (${pre.windowLabel || "unknown"}) provider=${activeForWindow?.kind ?? "none"}`,
    );
    const dial = await js<boolean>("window.__ctxOpen()");
    check("panel opens with the dial before any turn", dial === true);
    const title = await js<string>("window.__ctxTitle()");
    check(
      "panel title states its basis",
      pre.source === null
        ? title === "context · not measured yet"
        : pre.source === "built" ? title.startsWith("context · ") : title.startsWith("context · ~") && /· projected$/.test(title),
      title,
    );
    if (pre.source === "projected") {
      const basis = await js<string>("window.__ctxBasis()");
      check(
        "panel basis line names the baseline",
        basis.startsWith("projected from the last prompt this agent built ") && basis.endsWith("The real figure comes from the prompt the agent actually builds.") && !/, not /.test(basis),
        basis,
      );
    }
    await js<void>("window.__ctxClose()");

    // No trace at all (a fresh install, tracing off, or pruned): the same
    // refresh against a real, empty state dir must land on the TUI's own
    // pre-measurement screen — chip hidden, never a zero, never a constant.
    // A branch agent with the preview route still answers "built" there,
    // because the route needs no trace; that is the honest answer too.
    const noTraceDir = join(app.getPath("temp"), `atag-smoke-notrace-${process.pid}`);
    mkdirSync(noTraceDir, { recursive: true });
    try {
      const none = await js<PreCtx>(`window.__ctxEmpty(${JSON.stringify(noTraceDir)})`);
      const noneChip = await js<boolean>("!!document.querySelector('.cfoot .ctxbtn')");
      const noneOpen = await js<boolean>("window.__ctxOpen()");
      const noneTitle = await js<string>("window.__ctxTitle()");
      const noneLine = await js<boolean>(
        "((document.querySelector('.popover') || {}).textContent || '').includes('send a message — the breakdown comes from the prompt the agent actually builds')",
      );
      await js<void>("window.__ctxClose()");
      check(
        "no trace → not measured yet, chip hidden",
        none.previewSupported === true
          ? none.source === "built"
          : none.source === null && none.tokens === 0 && !noneChip && noneOpen && noneTitle === "context · not measured yet" && noneLine,
        `source=${none.source} tokens=${none.tokens} chip=${noneChip} dial=${noneOpen} title=${JSON.stringify(noneTitle)} line=${noneLine}`,
      );
    } finally {
      rmSync(noTraceDir, { recursive: true, force: true });
      // Back to the real state dir before anything else reads the chip.
      await js<void>("window.__ctxRefresh()");
    }
    const restored = await js<PreCtx>("window.__ctx()");
    check(
      "projection returns after the no-trace probe",
      restored.source === pre.source && restored.tokens === pre.tokens,
      `source=${restored.source} tokens=${restored.tokens} (was ${pre.source} ${pre.tokens})`,
    );
  }

  if (state === "connected") {
    check("skills loaded", (await js<number>("window.__skills && window.__skills()")) > 0);
    await js<void>(
      "window.__ask && window.__ask('Reply with exactly: hello there friend')",
    );
    const replyDeadline = Date.now() + 120_000;
    let reply = "";
    while (Date.now() < replyDeadline) {
      reply = (await js<string>("window.__lastReply && window.__lastReply()")) ?? "";
      if (reply.trim()) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    check("agent replied", reply.toLowerCase().includes("hello"), JSON.stringify(reply.slice(0, 80)));
  }

  if (state === "connected") {
    // The gauge must read a real measurement out of the agent's trace.
    await js<void>("window.__ctxRefresh()");
    await new Promise((r) => setTimeout(r, 2500));
    const ctx = await js<{ tokens: number; source: string | null; stablePrefix: number }>("window.__ctx()");
    check(
      "context measured from the trace",
      ctx.tokens > 0 && !!ctx.source,
      `${ctx.tokens} tokens (${ctx.source}), scaffold ${ctx.stablePrefix}`,
    );
    // Lane B — item 3: after a reply the figure is a measurement, never the
    // projection. tokens >= stablePrefix is deliberately NOT asserted: on
    // llama the provider's promptTokens is the KV-cache miss count.
    check(
      "context after the reply is measured, not projected",
      ctx.tokens > 0 && ["provider", "estimate", "built"].includes(ctx.source ?? ""),
      `source=${ctx.source}`,
    );
    const chipAfter = await js<{ label: string; proj: boolean } | null>("window.__ctxChip()");
    check("measured chip drops the projection mark", !!chipAfter && !chipAfter.proj && !chipAfter.label.startsWith("~"), JSON.stringify(chipAfter));
    // A new thread flips back to the projection, still on a real baseline.
    // Review fix: the baseline's session id is NOT compared with the one read
    // before the turn — traceBaseline ranks the newest turn-0 prompt in this
    // workspace, so the run's own reply (a new api-<hash> session) legitimately
    // becomes the new baseline and the old assertion went red for a correct
    // projection. What the feature promises is the projection itself: the
    // scaffold of SOME prompt this agent really built here.
    const fresh = await js<PreCtx>("window.__ctxNew()");
    check(
      "session:new flips back to the projection",
      pre?.source !== "projected"
        ? fresh.source === pre?.source
        : fresh.source === "projected" && !!fresh.baseline?.sessionId && fresh.tokens === fresh.stablePrefix,
      `source=${fresh.source} tokens=${fresh.tokens} scaffold=${fresh.stablePrefix} baseline=${fresh.baseline?.sessionId} (was ${pre?.baseline?.sessionId})`,
    );

    await js<void>("window.__selOpen('backend')");
    const back = await js<{ rows: number; backend: string }>("window.__sel()");
    // Three rows since the review fix put the TUI's `custom` back (cloud,
    // local, custom — composer-switch-rows.ts backendRows).
    check("selector: backend pane", back.rows === 3, `backend=${back.backend}, ${back.rows} rows`);

    await js<void>("window.__selTab('model')");
    await new Promise((r) => setTimeout(r, 9000));
    const models = await js<{ rows: number; err: string | null }>("window.__sel()");
    check("selector: model pane lists models", models.rows > 0, `${models.rows} rows${models.err ? " err=" + models.err : ""}`);

    // Clicking a session must actually open it.
    const opened = await js<{ turns: number; id: string }>(
      "(async () => { const r = await window.atomic.sessions();"
      + " const list = (r.data && r.data.sessions) || [];"
      + " const pick = list.slice().sort((a,b) => (b.turnCount||0)-(a.turnCount||0))[0];"
      + " if (!pick) return {turns:0,id:''};"
      + " await window.__openSession(pick.id);"
      + " return {turns: window.__logLen(), id: pick.id}; })()",
    );
    check("session opens from the sidebar", opened.turns > 1, `${opened.turns} entries from ${opened.id}`);

    // The context dials must write config, not just repaint.
    // The dial test must leave the operator's setting exactly as it found it,
    // even if an assertion in between throws.
    const before = await js<{ pairs: number }>("window.__ctxCfg()");
    try {
      await js<void>("window.__ctxAdjust('agent.conversationMaxPairs:1')");
      await new Promise((r) => setTimeout(r, 4000));
      const after = await js<{ pairs: number }>("window.__ctxCfg()");
      check("context dial writes config", after.pairs === before.pairs + 1, `${before.pairs} → ${after.pairs}`);
    } finally {
      await configSet("agent.conversationMaxPairs", String(before.pairs));
      await js<void>("window.__ctxRefreshCfg && window.__ctxRefreshCfg()");
    }

    // Item 6 (coding mode). The old check here passed on exactly the
    // failure it was meant to catch: `supported === false` short-circuited
    // to PASS. Now the mode is driven through the REAL client rather than
    // the renderer, so what is asserted is the agent, and the whole block
    // restores `default` in a `finally` — the diagnostics check further
    // down compares the renderer's level with a LIVE capabilities read,
    // and would fail if this left the ladder moved.
    const modeState = await js<{
      supported: boolean | null; current: string;
      approvalLevel: number | null; baseLevel: number | null;
    }>("window.__modeState()");
    // The locally built agent the desktop prefers. `supported === false`
    // while running THAT binary is the exact regression this item is
    // about: the capable agent is installed and the route is missing.
    const preferredAgent = join(homedir(), "atag-agent", "bin", "atag");
    check(
      "coding mode is live or honestly unavailable",
      modeState.supported === true
        ? ["default", "plan", "auto", "bypass"].includes(modeState.current)
        : agent!.status.binary !== preferredAgent,
      `supported=${modeState.supported} current=${modeState.current} agent=${agent!.status.binary ?? "none"}`,
    );

    const caps0 = (await agent!.capabilities()) as {
      agent: { approvalLevel: number };
      paths: { userConfigFile: string };
    };
    const modeSeed = await agent!.codingMode();
    if (modeSeed.supported && typeof modeSeed.baseLevel === "number") {
      const modeBase = modeSeed.baseLevel;
      const cfgBefore = readFileSync(caps0.paths.userConfigFile);
      // resolveCodingMode, restated: plan leaves the ladder and raises the
      // plan flag; auto raises to at least 2 and never lowers; bypass is 5;
      // default restores the configured base.
      const wantFor = (m: string) =>
        m === "plan" ? { level: modeBase, plan: true }
          : m === "auto" ? { level: Math.max(modeBase, 2), plan: false }
          : m === "bypass" ? { level: 5, plan: false }
            : { level: modeBase, plan: false };
      try {
        const notes: string[] = [];
        let roundTrip = true;
        let resolvesRight = true;
        for (const m of ["default", "plan", "auto", "bypass"]) {
          const posted = await agent!.codingMode(m);
          const readBack = await agent!.codingMode();
          // Cross-checked through a different handler, so the numbers do
          // not rest on the one that produced them.
          const live = (await agent!.capabilities()) as { agent: { approvalLevel: number } };
          const want = wantFor(m);
          if (!(posted.ok && posted.mode === m && readBack.mode === m)) roundTrip = false;
          if (!(posted.approvalLevel === want.level && posted.planMode === want.plan
            && live.agent.approvalLevel === want.level)) resolvesRight = false;
          notes.push(`${m}→post ${posted.mode}/get ${readBack.mode} L${posted.approvalLevel} plan=${posted.planMode} caps L${live.agent.approvalLevel}`);
        }
        // The assertion that catches the base-5 collision: before the route
        // held the chosen stance in its closure, POST auto answered bypass.
        check("coding mode round-trips every mode through the agent", roundTrip, notes.join("; "));
        check(`coding mode resolves against the configured base L${modeBase}`, resolvesRight, notes.join("; "));

        const levelBeforeBad = ((await agent!.capabilities()) as { agent: { approvalLevel: number } }).agent.approvalLevel;
        const badMode = await agent!.codingMode("yolo");
        const levelAfterBad = ((await agent!.capabilities()) as { agent: { approvalLevel: number } }).agent.approvalLevel;
        check(
          "coding mode refuses an unknown mode and changes nothing",
          badMode.ok === false && badMode.error === "HTTP 400" && levelAfterBad === levelBeforeBad,
          `error=${badMode.error ?? "none"} level ${levelBeforeBad} → ${levelAfterBad}`,
        );

        const cfgAfter = readFileSync(caps0.paths.userConfigFile);
        check(
          "coding mode writes nothing to config.json",
          cfgBefore.equals(cfgAfter),
          `${cfgBefore.length} → ${cfgAfter.length} bytes at ${caps0.paths.userConfigFile}`,
        );
      } finally {
        await agent!.codingMode("default").catch(() => undefined);
      }
    } else {
      // Without an `else` the four checks above just vanish and the run
      // reports four fewer checks with nothing said about it — invisible
      // unless someone diffs the counts. One explicit line instead, so
      // the log stays self-describing about what it did NOT assert.
      check(
        "coding mode round-trip skipped: agent has no route",
        modeSeed.supported === false,
        `supported=${modeSeed.supported} baseLevel=${String(modeSeed.baseLevel)} agent=${agent!.status.binary ?? "none"}`,
      );
    }

    // Finding 3's fix: the reconnect re-assert is NOT the click path. It
    // must leave an overlay the operator opened alone — a backend switch
    // restarts the agent and fires this without them asking.
    const reassert = await js<{ before: string | null; after: string | null; mode: string }>(
      "(async () => { const before = window.__modeOpenPopover();"
      + " window.__modeReassert('default');"
      + " await new Promise((r) => setTimeout(r, 1500));"
      + " return {before, after: window.__overlayNow(), mode: window.__modeState().current}; })()",
    );
    await js<void>("window.__overlayClose()");
    check(
      "coding-mode re-assert leaves an open overlay alone",
      reassert.before === "modes" && reassert.after === "modes",
      `overlay ${String(reassert.before)} → ${String(reassert.after)}, mode=${reassert.mode}`,
    );

    // The other half of the re-assert, which the check above cannot reach:
    // S.busy is false for the whole run, so the wait-for-the-turn branch,
    // the coalescing of a second reconnect and the cancel-on-click path
    // were asserted by nothing. Driving S.busy directly is exactly what
    // the branch under test reads, and it needs no real turn.
    if (modeSeed.supported) {
      const q = await js<{
        start: string; queued: string | null; coalesced: string | null;
        duringBusy: string; afterWait: string; cancelled: boolean; afterCancel: string;
      }>(
        "(async () => {"
        + " const start = window.__modeState().current;"
        + " window.__modeBusy(true);"
        + " window.__modeReassert('plan');"
        + " const queued = window.__modeQueue();"
        + " window.__modeReassert('bypass');"
        + " const coalesced = window.__modeQueue();"
        + " const duringBusy = window.__modeState().current;"
        + " window.__modeBusy(false);"
        + " await new Promise((r) => setTimeout(r, 2500));"
        + " const afterWait = window.__modeState().current;"
        + " window.__modeBusy(true); window.__modeReassert('plan'); window.__modeBusy(false);"
        + " await window.__modeSet('default');"
        + " const cancelled = window.__modeQueue() === null;"
        + " await new Promise((r) => setTimeout(r, 1500));"
        + " return {start, queued: queued && queued.mode, coalesced: coalesced && coalesced.mode,"
        + "   duringBusy, afterWait, cancelled, afterCancel: window.__modeState().current}; })()",
      );
      check(
        "coding-mode re-assert waits for the turn, coalesces, and yields to a click",
        q.queued === "plan" && q.coalesced === "bypass" && q.duringBusy === q.start
          && q.afterWait === "bypass" && q.cancelled && q.afterCancel === "default",
        `queued=${String(q.queued)} coalesced=${String(q.coalesced)} duringBusy=${q.duringBusy}`
          + ` afterWait=${q.afterWait} cancelled=${q.cancelled} afterCancel=${q.afterCancel}`,
      );
    } else {
      check(
        "coding-mode queued re-assert skipped: agent has no route",
        modeSeed.supported === false,
        `supported=${modeSeed.supported} agent=${agent!.status.binary ?? "none"}`,
      );
    }

    // Review fix: the connect-time GET needed a seq ticket of its own.
    // Staged exactly as the failure runs — the window last chose `auto`,
    // the agent is moved to `default` behind its back (what an agent
    // restart does), then the reconnect's GET and an operator click race.
    // Unguarded, the GET's stale reply repainted the chip and re-asserted
    // `auto`, which outranked the click and silently threw the choice
    // away. `plan` must survive, in the window AND on the agent.
    if (modeSeed.supported) {
      try {
        await js<void>("window.__modeSet('auto')");
        await agent!.codingMode("default");
        const race = await js<{ last: string | null; current: string; queued: unknown }>(
          "(async () => { const load = window.__modeLoad(); const click = window.__modeSet('plan');"
          + " await Promise.all([load, click]);"
          + " await new Promise((r) => setTimeout(r, 900));"
          + " return {last: window.__modeLast(), current: window.__modeState().current, queued: window.__modeQueue()}; })()",
        );
        const live = await agent!.codingMode();
        check(
          "coding-mode reconnect GET yields to a click instead of undoing it",
          race.current === "plan" && race.last === "plan" && race.queued === null && live.mode === "plan",
          `chip=${race.current} last=${String(race.last)} queued=${JSON.stringify(race.queued)} agent=${String(live.mode)}`,
        );
      } finally {
        await js<void>("window.__modeSet('default')").catch(() => undefined);
        await agent!.codingMode("default").catch(() => undefined);
      }
    }

    // The unavailable presentation is real, not merely claimed: force the
    // renderer into the state a routeless agent produces and read the
    // chip's own markup back.
    const wasSupported = modeState.supported;
    try {
      const chipOff = await js<string>(
        "(() => { window.__modeOverride({supported:false}); return window.__chipHTML(); })()",
      );
      // The visible text only: the markup carries `data-act="modes"` and a
      // tooltip, neither of which is what the operator reads.
      const chipText = chipOff.replace(/<[^>]*>/g, "").trim();
      const dimRule = readFileSync(join(__dirname, "..", "renderer", "styles.css"), "utf8");
      const dimmed = /\.poprow\.dim\s*\{/.test(dimRule);
      check(
        "coding mode chip says 'mode —' when the agent has no route",
        chipText === "mode —" && !/default|bypass|plan|auto/.test(chipText) && dimmed,
        `chip=${JSON.stringify(chipText)}, .poprow.dim rule ${dimmed ? "present" : "MISSING"}`,
      );
      // The other half of item 6: the binary is named in the UNSUPPORTED
      // case too. That is the case the operator actually needs it in —
      // "coding modes need an agent build that carries the route" is only
      // actionable next to the path of the build that answered.
      const diagOff = await js<{ line: string }>("window.__diag()");
      check(
        "diagnostics names the agent binary even when the route is missing",
        / \| agent [^|]+ \| approval L/.test(diagOff.line),
        diagOff.line,
      );
    } finally {
      await js<void>(`window.__modeOverride({supported:${JSON.stringify(wasSupported)}})`);
    }

    // "claude haiku" must find claude/haiku, claude.haiku, claude-3-haiku…
    const hits = await js<number>("window.__search('claude haiku')");
    check("search tokenizes across separators", hits > 0, `${hits} hits`);
    await js<void>("window.__search('')");

    const wiz = await js<{ rows: number; selected: number }>("window.__wizOpen()");
    check("wizard lists kinds, none preselected", wiz.rows >= 4 && wiz.selected === 0, `${wiz.rows} kinds, ${wiz.selected} selected`);
    await js<void>("window.__closeAll && window.__closeAll()");

    // A tool-using turn: cards must carry the real args and a duration.
    // Integration: three lanes each moved this turn onto a fresh thread
    // (lane A: session:new + nonce with one retry; lane B: __ctxNew + nonce;
    // lane C: a client-minted session id via __sessionNew). The merged
    // harness uses lane A's helper — a nonce makes the agent-derived id
    // genuinely fresh, and the reopen/probe checks below key on that id.
    // item 4: the agent derives a session id from the first prompt, so a fixed
    // prompt lands on one ever-growing session across runs, where the model
    // eventually answers "done" from memory without calling a tool. The turn
    // runs on a fresh session instead — "New session" plus a first prompt that
    // carries a nonce — so the id is unique, the trace holds only this run's
    // rows, and the model has nothing to answer from. One retry if it still
    // skipped the tool.
    type Card = { name: string; args: string; argsKey: string | null; ms: number; source: string | null; ok: boolean | null; live: boolean; traceTs: number | null; startedAt: number | null };
    const toolTurn = async (prompt: string): Promise<Card[]> => {
      await js<void>(`window.__ask(${JSON.stringify(prompt)})`);
      const toolDeadline = Date.now() + 150_000;
      let cs: Card[] = [];
      while (Date.now() < toolDeadline) {
        await new Promise((r) => setTimeout(r, 2000));
        cs = await js<Card[]>("window.__cards()");
        const reply = await js<string>("window.__lastReply()");
        const born = cs.filter((c) => c.live);
        if (born.length && born.every((c) => c.ok !== null) && /done/i.test(reply)) break;
        if (!born.length && /done/i.test(reply) && !(await js<boolean>("window.__busy()"))) break;   // answered without a tool
      }
      // Once the turn is stored, every live card must switch from the wall time
      // this window observed to the agent's own number out of the trace. A turn
      // that made no call has nothing to switch: do not wait out the deadline.
      if (!cs.some((c) => c.live)) return cs;
      const traceDeadline = Date.now() + 8000;
      while (Date.now() < traceDeadline) {
        cs = await js<Card[]>("window.__cards()");
        const born = cs.filter((c) => c.live);
        if (born.length && born.every((c) => c.source === "trace")) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      return cs;
    };
    const nonce = Math.random().toString(36).slice(2, 8);
    const listPrompt = `Run ${nonce}: call your file-listing tool on the current directory right now (do not answer from memory), then say done.`;
    await js<number>("window.__newSession()");
    let cards = await toolTurn(listPrompt);
    if (!cards.some((c) => c.live)) {
      process.stdout.write(`DIAG first tool turn made no tool call on ${await js<string>("window.__session()")}; retrying once\n`);
      cards = await toolTurn(listPrompt);
    }
    const live = cards.filter((c) => c.live);
    const withArgs = live.filter((c) => /[{"]/.test(c.args) && c.args.length > 4);
    const timed = live.filter((c) => c.source === "trace" && c.ms > 0);
    check("tool cards carry args", live.length > 0 && withArgs.length === live.length, `${withArgs.length}/${live.length} with real args`);
    check("tool cards carry durations", live.length > 0 && timed.length === live.length, `${timed.length}/${live.length} timed from the trace: ${live.map((c) => c.ms + "ms").join(", ")}`);
    if (live.length === 0 || timed.length !== live.length) {
      // Say what the cards held and what the store held, so a failure here is diagnosable from the log alone.
      process.stdout.write(`DIAG cards=${JSON.stringify(cards)}\n`);
      process.stdout.write(`DIAG store=${await js<string>("window.__storeDiag ? window.__storeDiag() : 'no hook'")}\n`);
    }

    // item 5: that turn listed files, it wrote none. os.fs.list / os.shell.run are
    // not write tools, so the reply gets no "Saved to" strip no matter which
    // existing paths it happens to name.
    const attachedAfterList = await js<string[]>("window.__attach()");
    check("a read-only turn attaches nothing", attachedAfterList.length === 0, JSON.stringify(attachedAfterList));

    // item 4: a fresh window on a session that already exists. "New session"
    // empties the transcript; the same first prompt derives the same id, so the
    // trace already holds an identical os.fs.list row from the turn above. The
    // live card must take its own row (trace ts after the card was born), never
    // the stale one — that number would be shown as the agent's measurement.
    // Proved without the model (it may answer from memory and skip the tool):
    // __probeTrace pushes a live-shaped card born now plus a store-shaped copy of
    // the same call onto the emptied transcript and runs the real merge.
    const sidFirst = await js<string>("window.__session()");
    const firstCard = live[0];
    if (firstCard && firstCard.traceTs !== null) {
      // The live card's lower bound is startedAt − 2 s: make sure the stale row is older than that.
      const settle = firstCard.traceTs + 2500 - Date.now();
      if (settle > 0) await new Promise((r) => setTimeout(r, settle));
    }
    await js<number>("window.__newSession()");
    type Probe = { changed: boolean; live: { source: string | null; traceTs: number | null; ms: number | null; startedAt: number | null }; stored: { source: string | null; traceTs: number | null; ms: number | null } } | null;
    const probe = firstCard && firstCard.argsKey
      ? await js<Probe>(`window.__probeTrace(${JSON.stringify(sidFirst)}, ${JSON.stringify(firstCard.name)}, ${JSON.stringify(firstCard.argsKey)})`)
      : null;
    check(
      "live card never takes a stale trace row",
      !!probe && probe.live.source === null && probe.live.traceTs === null
        && probe.stored.source === "trace" && probe.stored.traceTs === firstCard.traceTs && Number.isFinite(probe.stored.ms),
      probe
        ? `live card born ${probe.live.startedAt} stayed ${probe.live.source === null ? "unmeasured" : probe.live.source + " " + probe.live.traceTs}; store copy took row ${probe.stored.traceTs} (${probe.stored.ms}ms) on ${sidFirst}`
        : "no live card with a trace row to probe against",
    );

    // item 4: a missing trace file must come back as a rejection, never hang the
    // merge (readFile, not a readline stream over a stream that never opens).
    const missing = await Promise.race([
      js<{ ok: boolean; error?: string }>("window.atomic.traceTools(window.__stateDir(), 'no-such-session')"),
      new Promise<{ ok: boolean; error?: string }>((r) => setTimeout(() => r({ ok: true, error: "timed out after 5 s" }), 5000)),
    ]);
    check("missing trace file rejects, never hangs", missing.ok === false && typeof missing.error === "string" && missing.error.length > 0, JSON.stringify(missing));

    const chips = await js<number>("window.__pushAssistant('Saved the report to /Users/valerii/Desktop/report.pdf and the notes to ~/notes/summary.md.')");
    check("file paths render as chips", chips === 2, `${chips} chips`);

    // --- item 5: the attachment strip. Real files, real fs.stat, real collector. ---
    // The harness writes its own temp file (as it does for the screenshot); the
    // missing sibling is never created, so a chip for it would be a fabricated one.
    const attachFile = join(app.getPath("temp"), "atomic-desktop-attach.txt");
    writeFileSync(attachFile, "smoke\n");
    const attachMissing = attachFile + ".missing";
    // Review fix: the trash card names a SECOND, really-existing file of its
    // own. It used to name the same path the write card had already produced,
    // so turnFilePaths' dedupe made the check pass whatever cardWrittenPaths
    // did with os.fs.trash — adding it to WRITE_TOOLS would not have been
    // caught. This file exists on disk and is never written by this turn, so
    // it may only be absent from the strip because trash is not a write tool.
    const attachTrashed = join(app.getPath("temp"), "atomic-desktop-attach-trashed.txt");
    writeFileSync(attachTrashed, "smoke\n");
    type Strip = { chips: number; lines: number; label: string; paths: string[] };
    const strip = await js<Strip>(
      "window.__pushAssistantFiles('Done.', ["
      + `{tool:'os.fs.write', args:{path:${JSON.stringify(attachFile)}, content:'smoke\\n'}, out:'wrote 6 bytes to ${attachFile} (replace)'},`
      + `{tool:'os.fs.write', args:{path:${JSON.stringify(attachMissing)}, content:'x'}, out:'wrote 1 bytes to ${attachMissing} (replace)'},`
      + `{tool:'os.fs.trash', args:{paths:[${JSON.stringify(attachTrashed)}]}, out:'moved 1 path(s) to Trash'}])`,
    );
    check(
      "attachment strip: one chip for the file that is really there",
      strip.chips === 1 && strip.paths.length === 1 && strip.paths[0] === attachFile && !strip.paths.includes(attachTrashed),
      `${JSON.stringify(strip)} (the trashed sibling ${attachTrashed} exists on disk and must not be a chip)`,
    );
    check("attachment strip: the line says where", strip.label === "Saved to " + attachFile, JSON.stringify(strip.label));
    // A path the reply only mentions was read, not written: inline chip, no strip.
    const proseOnly = await js<Strip>(`window.__pushAssistantFiles('I read ' + ${JSON.stringify(attachFile)} + ' and it is fine.', [])`);
    check(
      "attachment strip: a mentioned file is never called saved",
      proseOnly.chips === 0 && proseOnly.label === "" && proseOnly.paths.length === 0,
      JSON.stringify(proseOnly),
    );
    // Cached on the item by signature: re-rendering neither duplicates the strip nor re-stats.
    const stable = await js<{ strips: number; chips: number }>(
      "(() => { render(); render(); render();"
      + " const el = document.querySelectorAll('[data-attach]');"
      + " return {strips: el.length, chips: document.querySelectorAll('.attach .filechip').length}; })()",
    );
    check("attachment strip: stable across re-renders", stable.strips === 1 && stable.chips === 1, JSON.stringify(stable));
    // Review fix: the chip is clickable — the real delegator hands the strip's
    // absolute path to the same opener an inline chip uses. Nothing is opened:
    // the opener is in dry-run for this click.
    const clickedChip = await js<{ file: string; opened: string | null; hasMenu: boolean } | null>("window.__clickAttachChip()");
    check(
      "attachment strip: a chip opens the file it names",
      !!clickedChip && clickedChip.file === attachFile && clickedChip.opened === attachFile && clickedChip.hasMenu,
      clickedChip ? JSON.stringify(clickedChip) : "no chip to click",
    );
    // Review fix: the strip is cached by signature, so a file trashed AFTER it
    // was drawn used to keep its "Saved to" line and its chip forever. A later
    // os.fs.trash naming an attached path now expires that cache.
    await js<number>(`window.__pushTool('os.fs.trash', {paths:[${JSON.stringify(attachFile)}]}, 'moved 1 path(s) to Trash', false)`);
    rmSync(attachFile, { force: true });
    const afterTrash = await js<{ paths: string[]; chips: number; labels: number }>("window.__reattach()");
    check(
      "attachment strip: a file trashed later stops being called saved",
      afterTrash.chips === 0 && afterTrash.labels === 0 && afterTrash.paths.length === 0,
      JSON.stringify(afterTrash),
    );
    rmSync(attachTrashed, { force: true });

    // item 4: a reopened session carries the trace's durations for every card
    // (the TUI shows 0ms here; the desktop shows the agent's number). A trace can
    // legitimately say 0ms, so the only ms > 0 assertion is on the os.fs.list
    // turn this run itself made. Known-data check (api-7a8e32e75a4f9298 →
    // 9,8,10,71,111,434,17,56,86,668,15) is a manual step, not a smoke assertion.
    // Reopened here, before the fold checks, so those run on a transcript that
    // is known to carry cards instead of inheriting the tool turn's outcome.
    const sid = sidFirst;
    await js<void>(`window.__openSession(${JSON.stringify(sid)})`);
    await new Promise((r) => setTimeout(r, 1500));
    const reopened = await js<typeof cards>("window.__cards()");
    const traced = reopened.filter((c) => !c.live && c.source === "trace" && Number.isFinite(c.ms) && /[{"]/.test(c.args));
    check(
      "reopened session carries trace durations",
      reopened.length > 0 && traced.length === reopened.length,
      `${traced.length}/${reopened.length} cards from the trace in ${sid}`,
    );
    const listed = reopened.filter((c) => c.name === "os.fs.list");
    check(
      "reopened os.fs.list turn is timed",
      listed.length > 0 && listed.every((c) => c.ms > 0),
      listed.map((c) => c.ms + "ms").join(", ") || "no os.fs.list card",
    );
    if (traced.length !== reopened.length || !listed.every((c) => c.ms > 0)) {
      process.stdout.write(`DIAG reopened=${JSON.stringify(reopened)}\n`);
    }
    // Every finished duration cell reads as the TUI prints it (<n>ms) or is empty.
    const cells = await js<string[]>("window.__overflow().durations");
    check(
      "durations read as the TUI prints them",
      cells.length > 0 && cells.every((t) => /^\d+ms$/.test(t) || t === "" || t === "\u2026"),
      JSON.stringify(cells.slice(0, 12)),
    );

    // Scroll-stable cards: folding a card must not move the transcript — the
    // head stays put. The hooks click the real head button, so these fail if
    // the [data-toggle] branch ever goes back to a full render().
    // item 4: the card under test is pushed between the fillers (a real, closed,
    // store-shaped card) so it has room above to scroll to and room below — a
    // 1-turn session's own card sits at the top and cannot be placed at 120 px.
    for (let n = 0; n < 6; n++) await js<void>(`window.__pushAssistant('filler ${n} ${"x".repeat(400)}')`);
    await js<number>("window.__pushTool('os.fs.list', {path:'.'}, 'listed 3 entries', false)");
    for (let n = 6; n < 12; n++) await js<void>(`window.__pushAssistant('filler ${n} ${"x".repeat(400)}')`);
    const last = (await js<number>("window.__cards().length")) - 1;
    const placed = await js<{ scrollTop: number; stick: boolean; below: number } | null>(`window.__scrollCardTo(${last}, 120)`);
    check(
      "transcript scrollable for the fold test",
      !!placed && placed.scrollTop > 0 && !placed.stick && placed.below > 400,
      JSON.stringify(placed),
    );
    type Tg = { open: boolean; flipped: boolean; body: boolean; headBefore: number; headAfter: number; scrollBefore: number; scrollAfter: number } | null;
    const tgOpen = await js<Tg>(`window.__toggleCard(${last})`);
    check(
      "expand keeps the card head in place",
      !!tgOpen && tgOpen.open && tgOpen.flipped && tgOpen.body
        && Math.abs(tgOpen.headAfter - tgOpen.headBefore) <= 1 && tgOpen.scrollAfter === tgOpen.scrollBefore,
      JSON.stringify(tgOpen),
    );
    const tgClose = await js<Tg>(`window.__toggleCard(${last})`);
    check(
      "collapse keeps the card head in place",
      !!tgClose && !tgClose.open && tgClose.flipped && !tgClose.body
        && Math.abs(tgClose.headAfter - tgClose.headBefore) <= 1 && tgClose.scrollAfter === tgClose.scrollBefore,
      JSON.stringify(tgClose),
    );
    // The open state and the scroll position must both survive a whole-DOM render.
    await js<void>(`window.__toggleCard(${last})`);
    const s0 = await js<{ top: number } | null>("window.__scroll()");
    await js<void>("window.__pushAssistant('repaint')");
    const s1 = await js<{ top: number } | null>("window.__scroll()");
    const fold = await js<{ open: boolean; body: boolean } | null>(`window.__foldState(${last})`);
    const kept = !!fold && fold.open && fold.body;
    check(
      "open state and scroll survive a re-render",
      kept && !!s0 && !!s1 && s1.top === s0.top,
      `open kept=${kept} scroll ${s0 ? s0.top : "?"} → ${s1 ? s1.top : "?"}`,
    );
    // A folded run (>= 3 same-name cards) unfolds in place through the real
    // [data-group] click. Review fix: the reopened session never produced a
    // run of three, so this used to read "nothing to assert" in every run and
    // the [data-group] branch was covered by inspection only. The run is now a
    // deterministic fixture — three consecutive same-name closed cards, which
    // is exactly what renderItems folds — with fillers after it so the group
    // has room below to be placed 120 px from the top.
    type Groups = Array<{ id: string; head: string }>;
    const groupsBefore = await js<Groups>("window.__groups()");
    for (let n = 0; n < 3; n++) {
      await js<number>(`window.__pushTool('os.fs.list', {path:'./fold-fixture-${n}'}, 'listed ${n} entries', false)`);
    }
    for (let n = 12; n < 18; n++) await js<void>(`window.__pushAssistant('filler ${n} ${"x".repeat(400)}')`);
    const groupsAfter = await js<Groups>("window.__groups()");
    const mine = groupsAfter.find((g) => !groupsBefore.some((b) => b.id === g.id));
    check(
      "three same-name cards in a row fold into one line",
      groupsAfter.length === groupsBefore.length + 1 && !!mine && mine.head === "3 \u00d7 os.fs.list",
      `${groupsBefore.length} → ${groupsAfter.length} folded runs; new head ${JSON.stringify(mine ? mine.head : null)}`,
    );
    type Grp = { members: boolean; headBefore: number; headAfter: number; scrollBefore: number; scrollAfter: number; cardsBefore: number; cardsAfter: number; groupsBefore: number; groupsAfter: number } | null;
    const grp = await js<Grp>(mine ? `window.__unfoldGroup(${JSON.stringify(mine.id)})` : "window.__unfoldGroup()");
    check(
      "unfolding a run keeps its head in place",
      !!grp && grp.members && Math.abs(grp.headAfter - grp.headBefore) <= 1 && grp.scrollAfter === grp.scrollBefore
        && grp.cardsAfter === grp.cardsBefore + 2 && grp.groupsAfter === grp.groupsBefore - 1,
      grp ? JSON.stringify(grp) : "no folded run on screen",
    );

    // item 4: nothing widens the transcript column — a card with a 300-char
    // argument and a 260-char path summary, a reply with a 300-char URL.
    await js<number>("window.__pushTool('os.shell.run', {cmd:'python3', args:['-c', 'x'.repeat(300)]}, '/Users/valerii/' + 'a'.repeat(260) + '.tsx')");
    type Ov = { sw: number; cw: number; colRight: number; colWidth: number; track: number; maxRight: number; durations: string[]; lastTitle: string };
    const ov = await js<Ov>("window.__overflow()");
    // item 4: that card is store-shaped (finished, no trace row) — it must print
    // nothing and say so, never the TUI's fabricated 0ms.
    check(
      "no fake zero for an untraced call",
      ov.durations.length > 0 && ov.durations[ov.durations.length - 1] === "" && ov.lastTitle === "no trace for this call",
      `text ${JSON.stringify(ov.durations[ov.durations.length - 1])}, title ${JSON.stringify(ov.lastTitle)}`,
    );
    check(
      "tool cards keep inside the panel",
      ov.sw === ov.cw && ov.maxRight <= ov.colRight + 1 && ov.track > 0 && ov.track <= ov.colWidth,
      `scrollWidth ${ov.sw} vs clientWidth ${ov.cw}, max right ${ov.maxRight} vs column ${ov.colRight}, track ${ov.track}px of ${ov.colWidth}`,
    );
    // Review fix: the same payload as a COLLAPSED card, so the assertion also
    // covers `.cardsum` — the summary line whose nowrap/ellipsis rules had to
    // go for the column to stop widening. __pushTool defaults to open, so the
    // card above only ever exercised `.ar` and `.cardbody pre`.
    await js<number>("window.__pushTool('os.shell.run', {cmd:'python3', args:['-c', 'x'.repeat(300)]}, '/Users/valerii/' + 'b'.repeat(260) + '.tsx', false)");
    const ov3 = await js<Ov & { sums: number[] }>("window.__overflow()");
    check(
      "a collapsed card's summary keeps inside the panel",
      ov3.sums.length > 0 && ov3.sw === ov3.cw && ov3.maxRight <= ov3.colRight + 1 && Math.max(...ov3.sums) <= ov3.colRight + 1,
      `${ov3.sums.length} collapsed summaries, widest right ${Math.max(...ov3.sums)} vs column ${ov3.colRight}; scrollWidth ${ov3.sw} vs clientWidth ${ov3.cw}`,
    );
    await js<number>("window.__pushAssistant('see https://example.com/' + 'a'.repeat(300))");
    const ov2 = await js<Ov>("window.__overflow()");
    check("long URLs keep inside the panel", ov2.sw === ov2.cw && ov2.maxRight <= ov2.colRight + 1, `scrollWidth ${ov2.sw} vs clientWidth ${ov2.cw}, max right ${ov2.maxRight} vs column ${ov2.colRight}`);
    // item 4: the screenshot must show the wrapped card and URL just asserted. The fold
    // checks left the scroller pinned (S.stick false), so bring the bottom into frame
    // and give the compositor a moment before capturePage. A plain delay, not a
    // requestAnimationFrame round-trip: an occluded window never fires rAF and would hang here.
    const frame = await js<{ top: number; height: number; client: number; cards: number } | null>(
      "(() => { const sc = document.getElementById('scroller'); if (!sc) return null; sc.scrollTop = sc.scrollHeight;"
      + " return {top: sc.scrollTop, height: sc.scrollHeight, client: sc.clientHeight, cards: document.querySelectorAll('.card').length}; })()",
    );
    // An occluded window stops painting and capturePage returns its last frame
    // (other windows cover this one while several smokes run side by side), so
    // stop the throttling that halts paints, re-show the window and repaint.
    win.webContents.setBackgroundThrottling(false);
    win.show();
    win.moveTop();
    win.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 800));
    // Several lanes share the screenshot path, so the frame state is also logged here.
    process.stdout.write(`DIAG screenshot frame: ${frame ? `scrollTop ${frame.top} of ${frame.height} (viewport ${frame.client}), ${frame.cards} cards, bottom in frame=${frame.height - frame.top - frame.client < 2}` : "no scroller"}\n`);



    // --- Item 7 (settings surface): the TUI menu tree, the Manage tabs, Privacy and Tasks ---
    await settingsTest(js, check);
    // --- Item 7 part B: the Skills, Memory and MCP tabs ---
    await settingsTestPartB(js, check);
    // --- Item 7 part C: the LLM, Telegram and Import tabs ---
    await settingsTestPartC(js, check);

    // --- Item 6: the sidebar's two lists ---
    await sidebarTest(js, check);

    // --- Lane B — backend switch (last: it restarts `atag serve` four times) ---
    // A round trip through the renderer's own switch path: to local and
    // back, with the file, the chips, the restarted agent and the daemon
    // all asserted. Everything is restored in finally — the whole file,
    // the daemon state, and a fresh agent — so an assertion throw cannot
    // leave the route changed.
    await backendSwitchTest(js, check);
  }

  if (MODELS_TEST) await modelsTest(js, check);

  const image = await win.webContents.capturePage();
  const out = join(app.getPath("temp"), "atomic-desktop-smoke.png");
  writeFileSync(out, image.toPNG());
  process.stdout.write(`SMOKE screenshot=${out} failures=${fail.length}\n`);
  app.exit(fail.length === 0 ? 0 : 1);
}

/**
 * Item 6 (the sidebar). Every list here comes from the live agent; the two
 * things the desktop owns — the pin list and the read stamps in
 * userData/prefs.json — are captured first and written back in `finally`, so
 * a smoke run leaves the operator's sidebar exactly as it found it.
 */
async function sidebarTest(
  js: <T>(code: string) => Promise<T>,
  check: (name: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const prefsBefore = readPrefs();
  let fixture: TaskFixture | null = null;
  try {
    let sb = await js<Sb>("window.__sidebar()");
    check(
      "sidebar is Tasks over Chats, with no nav rows",
      JSON.stringify(sb.headers) === '["Tasks","Chats"]' && sb.navrows === 0 && !sb.skillsRow && sb.subtitles === 0,
      `headers ${JSON.stringify(sb.headers)}, navrows ${sb.navrows}, skills row ${sb.skillsRow}, "N turns" lines ${sb.subtitles}`,
    );
    // Review fix: `subtitles === 0` above can only catch a reintroduced `.t2`
    // class. This measures the row the user asked for — 30 px, one text line,
    // and dot + name (+ pin on a chat row) as its only children.
    type RowShape = { rows: number; minHeight: number; maxHeight: number; children: string[]; titleHeight: number; titleLineHeight: number; nowrap: boolean } | null;
    const shape = await js<RowShape>("window.__rowShape()");
    check(
      "sidebar rows are one line: dot + name (+ pin)",
      !!shape && shape.minHeight === 30 && shape.maxHeight === 30
        && shape.children.length <= 3 && shape.children[0] === "sdot" && shape.children[1] === "t1"
        && (shape.children.length === 2 || shape.children[2] === "pinbtn")
        && shape.nowrap && shape.titleHeight <= shape.titleLineHeight + 1,
      shape ? `${shape.rows} rows ${shape.minHeight}–${shape.maxHeight}px, children ${JSON.stringify(shape.children)}, title ${shape.titleHeight}px of line-height ${shape.titleLineHeight}, nowrap=${shape.nowrap}` : "no rows",
    );
    check("chats list carries the agent's sessions", sb.chats.length > 0, `${sb.chats.length} rows, ${sb.total} sessions with a turn`);
    if (sb.chats.length === 0) return;

    // Unread: forget the stamp and the dot fills; opening it empties the dot
    // and writes the stamp to disk.
    const id = sb.chats[0].id;
    const updatedAt = sb.chats[0].updatedAt;
    const unreadDot = await js<string>(`window.__forgetSeen(${JSON.stringify(id)})`);
    check("an unread chat draws a filled dot", unreadDot === "filled", `dot=${unreadDot} for ${id}`);

    await js<void>(`window.__openSession(${JSON.stringify(id)})`);
    await wait(1500);
    sb = await js<Sb>("window.__sidebar()");
    const opened = sb.chats.find((c) => c.id === id);
    const prefs = await js<{ ok: boolean; data: { pinned: string[]; seen: Record<string, number> } }>("window.__prefs()");
    check("opening a chat empties its dot", !!opened && opened.dot === "empty", `dot=${opened?.dot}`);
    check(
      "the read stamp is written to prefs.json",
      (prefs.data.seen[id] ?? 0) >= updatedAt && existsSync(PREFS_PATH()),
      `seen=${prefs.data.seen[id]} updatedAt=${updatedAt} file=${existsSync(PREFS_PATH())}`,
    );

    // Pinning sorts the row first and survives a round trip through the file.
    if (sb.chats.length >= 2) {
      const last = sb.chats[sb.chats.length - 1].id;
      const pinned = await js<string[]>(`window.__pin(${JSON.stringify(last)})`);
      sb = await js<Sb>("window.__sidebar()");
      const stored = await js<{ data: { pinned: string[] } }>("window.__prefs()");
      check(
        "a pinned chat sorts first and is stored",
        sb.chats[0].id === last && sb.chats[0].pinned && stored.data.pinned.includes(last),
        `first=${sb.chats[0].id} pinned=${JSON.stringify(pinned)} stored=${JSON.stringify(stored.data.pinned)}`,
      );
      await js<string[]>(`window.__unpin(${JSON.stringify(last)})`);
      sb = await js<Sb>("window.__sidebar()");
      const after = await js<{ data: { pinned: string[] } }>("window.__prefs()");
      check(
        "unpinning puts it back",
        sb.chats[0].id !== last && !after.data.pinned.includes(last),
        `first=${sb.chats[0].id} stored=${JSON.stringify(after.data.pinned)}`,
      );

      // Review fix: the two checks above go through act() and read PREFS, so
      // they would pass with no pin button rendered at all. This one clicks the
      // affordance the user actually has — the row's [data-pin] — through the
      // real document delegator, and proves the click does not also open the
      // chat (the delegator stops at the pin branch).
      type PinClick = { found: boolean; pinned?: boolean; opened?: boolean; titleBefore?: string; titleAfter?: string };
      const clicked = await js<PinClick>(`window.__clickPin(${JSON.stringify(last)})`);
      const unclicked = clicked.found ? await js<PinClick>(`window.__clickPin(${JSON.stringify(last)})`) : { found: false };
      const menuIpc = await js<string>("typeof window.atomic.sessionMenu");
      check(
        "the row's pin button pins without opening the chat",
        clicked.found === true &&
          clicked.pinned === true &&
          clicked.opened === false &&
          clicked.titleBefore === "Pin" &&
          clicked.titleAfter === "Unpin" &&
          unclicked.pinned === false &&
          unclicked.titleAfter === "Pin" &&
          menuIpc === "function",
        `pin ${JSON.stringify(clicked)} → unpin ${JSON.stringify(unclicked)}, sessionMenu ${menuIpc}`,
      );
    } else {
      check("a pinned chat sorts first and is stored", true, "skipped — fewer than two chats in this workspace");
    }

    // "Load more" appears only when the page actually hides rows.
    check(
      "load more appears only past the page",
      sb.loadMore === (sb.hiddenChats > 0) && sb.chats.length <= sb.page,
      `${sb.chats.length} of ${sb.total} shown, ${sb.hiddenChats} hidden, button=${sb.loadMore}`,
    );
    if (sb.hiddenChats > 0) {
      const grown = await js<number>("window.__loadMore()");
      check("load more grows the list", grown > sb.chats.length, `${sb.chats.length} → ${grown}`);
    }

    // Review fix: the lists are the scroll container and every render rebuilds
    // them, so paging used to scroll the rows it had just added off screen.
    const scrolled = await js<{ scrollable: boolean; kept: boolean; before?: number; after?: number; max: number; reason?: string }>(
      "window.__sidebarScroll()",
    );
    check(
      "the sidebar keeps its scroll position across a render",
      scrolled.kept,
      scrolled.scrollable ? `${scrolled.before} → ${scrolled.after} of ${scrolled.max}` : (scrolled.reason ?? "not scrollable"),
    );

    // The running dot is driven by the turn stream's own map, and it stays
    // distinguishable when the stylesheet turns the animation off.
    const runCls = await js<string>(`window.__running('smoke-turn', ${JSON.stringify(id)}, true)`);
    const style = await js<{ cls: string; animation: string; shadow: string } | null>(`window.__dotStyle(${JSON.stringify(id)})`);
    const stillCls = await js<string>(`window.__running('smoke-turn', ${JSON.stringify(id)}, false)`);
    check(
      "a running chat pulses, and still reads as running without animation",
      runCls.includes("running") && style?.animation === "sdot-pulse" && style.shadow !== "none" && !stillCls.includes("running"),
      `class ${JSON.stringify(runCls)}, animation ${style?.animation}, ring ${style?.shadow}, after ${JSON.stringify(stillCls)}`,
    );

    // A waiting approval fills the dot even for a chat that was just read.
    const waitingDot = await js<string>(`window.__pendingApproval(${JSON.stringify(id)}, true)`);
    const clearedDot = await js<string>(`window.__pendingApproval(${JSON.stringify(id)}, false)`);
    check(
      "a waiting approval fills the dot of a read chat",
      waitingDot === "filled" && clearedDot === "empty",
      `waiting=${waitingDot} cleared=${clearedDot}`,
    );

    // ... and it keeps filling it across a chat switch. The card leaves this
    // view with the old transcript, but the agent is still blocked on the gate,
    // so forgetting the request here made the waiting row read "empty" while
    // nothing had answered it.
    const kept = await js<{ pending: boolean; mapped: boolean; dot: string }>(`window.__approvalKeep(${JSON.stringify(id)})`);
    check(
      "a chat switch drops the approval card but keeps the row asking",
      !kept.pending && kept.mapped && kept.dot === "filled",
      `pending=${kept.pending} mapped=${kept.mapped} dot=${kept.dot}`,
    );

    // The turn's own terminal frame is what clears it: with the run over,
    // nothing is waiting for a verdict any more.
    const dropped = await js<{ mapped: boolean; running: boolean; dot: string }>(`window.__approvalDrop(${JSON.stringify(id)})`);
    check(
      "the turn's terminal frame clears the waiting approval",
      !dropped.mapped && !dropped.running && dropped.dot === "empty",
      `mapped=${dropped.mapped} running=${dropped.running} dot=${dropped.dot}`,
    );

    // A turn the user walks away from: its frames must not be spliced into the
    // transcript that is on screen now, and when it ends its own row must fill
    // because nobody read it. The prompt is the tool-using one, so the turn
    // really does emit tool_progress frames after the switch.
    const other = sb.chats.find((c) => c.id !== id)?.id ?? "";
    if (other) {
      // Settle on what that chat's transcript looks like with nothing running,
      // so anything extra afterwards can only have come from the other turn.
      const settled = async (): Promise<string[]> => {
        let shape = await js<string[]>("window.__transcript()");
        for (let i = 0; i < 16; i++) {
          await wait(500);
          const again = await js<string[]>("window.__transcript()");
          if (JSON.stringify(again) === JSON.stringify(shape)) return shape;
          shape = again;
        }
        return shape;
      };
      await js<void>(`window.__openSession(${JSON.stringify(other)})`);
      await wait(1000);
      const shapeBefore = await settled();
      await js<void>(`window.__openSession(${JSON.stringify(id)})`);
      await wait(1200);
      // The file-listing prompt the tool-card checks use: it needs no approval
      // here, and the nonce stops the model answering from memory.
      const walkNonce = Math.random().toString(36).slice(2, 8);
      await js<void>(`window.__ask(${JSON.stringify(`Run ${walkNonce}: call your file-listing tool on the current directory right now (do not answer from memory), then say done.`)})`);
      await wait(600);
      await js<void>(`window.__openSession(${JSON.stringify(other)})`);
      await wait(1500);
      const runDeadline = Date.now() + 150_000;
      let leftDot = "running";
      while (Date.now() < runDeadline) {
        sb = await js<Sb>("window.__sidebar()");
        leftDot = sb.chats.find((c) => c.id === id)?.dot ?? "";
        if (leftDot !== "running") break;
        await wait(1000);
      }
      await wait(2000);
      const shapeAfter = await js<string[]>("window.__transcript()");
      sb = await js<Sb>("window.__sidebar()");
      const finalDot = sb.chats.find((c) => c.id === id)?.dot ?? "";
      check(
        "a turn left behind stays out of the open chat and fills its own row",
        JSON.stringify(shapeAfter) === JSON.stringify(shapeBefore) && finalDot === "filled",
        `${shapeBefore.length} → ${shapeAfter.length} items in ${other} (added ${JSON.stringify(shapeAfter.slice(shapeBefore.length))}); ${id} dot=${finalDot}`,
      );
      // Read it again, so the run leaves the row as it found it.
      await js<void>(`window.__openSession(${JSON.stringify(id)})`);
      await wait(1500);
    } else {
      check("a turn left behind stays out of the open chat and fills its own row", true, "skipped — only one chat in this workspace");
    }

    // The Tasks list is every task, not the TUI rail's running/queued
    // projection — the user's dot rules are about tasks that have run. Both of
    // those rules need a task in a terminal state to say anything at all, and
    // a fresh state dir holds only pending and cancelled rows (both drawn
    // empty), so the fixture below runs one through the agent for real.
    fixture = await executedTaskFixture(check);
    await js<void>("window.__tasksRefresh()");
    await wait(300);
    const apiTasks = await js<Array<{ id: string; status: string; userMessage: string; updatedAt: number }>>(
      "(async () => { const r = await window.atomic.tasks(); return ((r.data && r.data.tasks) || []).map((t) => ({id:t.id, status:t.status, userMessage:t.userMessage || '', updatedAt:t.updatedAt || 0})); })()",
    );
    sb = await js<Sb>("window.__sidebar()");
    // A cancelled task never executed — the TUI rail would have dropped a
    // completed one, and that is the row this check is about.
    const executed = apiTasks.filter((t) => t.status === "completed" || t.status === "failed" || t.status === "blocked");
    // STATUS_RANK sorts completed last, so on a store carrying a page of
    // cancelled fixtures the executed row lives behind Load more. Press it the
    // way a user would until the row is on screen — which also proves the
    // Tasks list pages.
    let pages = 1;
    while (sb.hiddenTasks > 0 && !sb.tasks.some((t) => executed.some((e) => e.id === t.id)) && pages < 25) {
      const grew = await js<boolean>("(() => { const b = document.querySelector('[data-more=\"tasks\"]'); if (!b) return false; b.click(); return true; })()");
      if (!grew) break;
      pages += 1;
      await wait(100);
      sb = await js<Sb>("window.__sidebar()");
    }
    check(
      "the tasks list carries executed tasks too",
      executed.length > 0 && sb.tasks.some((t) => executed.some((e) => e.id === t.id)),
      `${apiTasks.length} tasks from the agent (${executed.length} executed, ${apiTasks.filter((t) => t.status === "cancelled").length} cancelled), ${sb.tasks.length} rows over ${pages} page(s)`,
    );
    check(
      "the tasks header counts running tasks",
      sb.counter === `${apiTasks.filter((t) => t.status === "running").length} running`,
      `counter ${JSON.stringify(sb.counter)}`,
    );
    if (apiTasks.length === 0) {
      check("an empty tasks list says so", sb.tasksEmpty === "(no tasks yet)", JSON.stringify(sb.tasksEmpty));
    } else {
      const first = sb.tasks[0];
      const src = apiTasks.find((t) => t.id === first.id);
      // Regression: the old code read `t.message`, a field the payload has
      // never carried, so every row was named by its id.
      check(
        "task rows are named by userMessage",
        !!src && first.name === (src.userMessage.trim().replace(/\s+/g, " ").slice(0, 72) || "(empty)"),
        `${JSON.stringify(first.name)} vs ${JSON.stringify(src?.userMessage.slice(0, 72))}`,
      );
    }
    // Whichever executed row is actually on screen — the dot checks read the
    // rendered page, and Load more above stops at the first one it finds.
    const doneTask = executed.find((t) => sb.tasks.some((r) => r.id === t.id)) ?? executed[0];
    if (doneTask) {
      await js<string>(`window.__forgetTaskSeen(${JSON.stringify(doneTask.id)})`);
      sb = await js<Sb>("window.__sidebar()");
      const before = sb.tasks.find((t) => t.id === doneTask.id);
      const stamp = await js<number>(`window.__openTask(${JSON.stringify(doneTask.id)})`);
      await wait(500);
      sb = await js<Sb>("window.__sidebar()");
      const afterOpen = sb.tasks.find((t) => t.id === doneTask.id);
      check(
        "an executed task fills until it is opened",
        before?.dot === "filled" && afterOpen?.dot === "empty" && stamp > 0,
        `${doneTask.id} (${doneTask.status}): ${before?.dot} → ${afterOpen?.dot}, stamp ${stamp}`,
      );
      await js<void>("window.__settingsClose && window.__settingsClose()");
    } else {
      check("an executed task fills until it is opened", false, "no task reached a terminal state — see the fixture check above");
    }

    // Deleting is a real DELETE now. The route is idempotent, so an id that
    // was never there answers 200 and the list is left alone.
    check("the renderer can delete a session", await js<boolean>("typeof window.atomic.deleteSession === 'function'"));
    const lenBefore = (await js<Sb>("window.__sidebar()")).total;
    await js<number>("window.__deleteSession('smoke-no-such-session')");
    await wait(1000);
    const lenAfter = (await js<Sb>("window.__sidebar()")).total;
    check("deleting an unknown session leaves the list alone", lenAfter === lenBefore, `${lenBefore} → ${lenAfter}`);

    // Skills left the sidebar, not the app.
    const skillsTab = await js<string>("window.__skillsReachable()");
    check("Skills is still reachable outside the sidebar", skillsTab === "Skills", `settings tab ${JSON.stringify(skillsTab)}`);
    await js<void>("window.__settingsClose && window.__settingsClose()");
  } finally {
    // The task record has to stay — 0.5.4 has no task delete, and a later run
    // reuses it instead of spending another turn — but the session it ran in
    // is this run's litter, and DELETE /api/sessions/{id} takes it back out.
    if (fixture && fixture.created && fixture.sessionId && agent) {
      await agent.deleteSession(fixture.sessionId).catch(() => undefined);
    }
    writePrefs(prefsBefore);
    await js<void>("window.__reloadPrefs && window.__reloadPrefs()");
  }
}

interface TaskFixture {
  id: string;
  status: string;
  sessionId: string | null;
  created: boolean;
}

/**
 * A task the agent has actually executed, so the two task-dot checks assert
 * something. A previous run's completed row is reused; otherwise one is
 * created through `atag task create --at` and run to a terminal state. The
 * CLI's one-shot path writes no `scheduled_for` and the claim query reads
 * NULL as "due now", so the scheduler normally takes it within a second; if
 * it has not, one attempt is forced through POST /api/tasks/{id}/run.
 */
async function executedTaskFixture(
  check: (name: string, ok: boolean, detail?: string) => void,
): Promise<TaskFixture | null> {
  const name = "the tasks list has a task the agent has run";
  if (!agent) {
    check(name, false, "no agent client");
    return null;
  }
  const terminal = (status: string) => status === "completed" || status === "failed" || status === "blocked";
  const record = async (id: string) =>
    (await agent!.task(id)) as { status?: unknown; sessionId?: unknown } | null;
  try {
    const listed = ((await agent.tasksList(500)) as { tasks?: Array<{ id?: unknown; status?: unknown; sessionId?: unknown }> }).tasks ?? [];
    const already = listed.find((t) => typeof t.id === "string" && typeof t.status === "string" && terminal(t.status));
    if (already) {
      check(name, true, `reused ${String(already.id)} (${String(already.status)})`);
      return { id: String(already.id), status: String(already.status), sessionId: null, created: false };
    }
    const created = await taskCreate(
      { message: "desktop smoke sidebar task: reply with exactly the word done, use no tools", kind: "at", expression: String(Date.now() + 1000) },
      agent.status.workingDir,
    );
    if (!created.ok || !created.id) {
      check(name, false, created.error ?? "task create failed");
      return null;
    }
    const id = created.id;
    const deadline = Date.now() + 150_000;
    let status = "pending";
    let forced = false;
    while (Date.now() < deadline) {
      const rec = await record(id);
      status = typeof rec?.status === "string" ? rec.status : "";
      if (terminal(status)) {
        const sid = typeof rec?.sessionId === "string" ? rec.sessionId : null;
        check(name, true, `${id} ran to ${status}${forced ? " (forced)" : ""}`);
        return { id, status, sessionId: sid, created: true };
      }
      if (status === "pending" && !forced) {
        forced = true;
        // Synchronous: one attempt, the agent's own turn. It throws when the
        // scheduler claimed the row first — the poll then sees the result.
        await agent.runTask(id).catch(() => undefined);
        continue;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    check(name, false, `fixture ${id} was still ${status || "unknown"} after 150 s`);
    await agent.cancelTask(id).catch(() => undefined);
    const rec = await record(id);
    return { id, status: typeof rec?.status === "string" ? rec.status : status, sessionId: typeof rec?.sessionId === "string" ? rec.sessionId : null, created: true };
  } catch (err) {
    check(name, false, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Item 7 (settings surface). Everything here reads the live agent or
 * writes and restores the lane's own config; the analytics round trip
 * and the task create/cancel round trip both clean up in `finally`.
 */
async function settingsTest(
  js: <T>(code: string) => Promise<T>,
  check: (name: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const GROUPS = ["Go", "Session", "Model", "Run", "Setup", "Help", "Danger zone"];
  const TABS = ["tasks", "skills", "memory", "mcp", "llm", "telegram", "import", "privacy"];
  const LABELS = ["Tasks", "Skills", "Memory", "MCP", "LLM", "Telegram", "Import", "Privacy"];

  const groups = await js<string[]>("window.__menuGroups()");
  check("settings: menu groups mirror the TUI", same(groups, GROUPS), JSON.stringify(groups));
  const tabs = await js<string[]>("window.__settingsTabs()");
  check("settings: tab ids mirror MANAGE_TABS", same(tabs, TABS), JSON.stringify(tabs));

  // Every node of the TUI menu tree, verbatim label and ctrl+g chord, in
  // registry order (src/tui/menu/menu-registry.ts:107-675).
  const NODES: Array<[string, string, string | null]> = [
    ["Go", "Run", "r"], ["Go", "Observe", null], ["Go", "Feed", "f"], ["Go", "World", "w"], ["Go", "Reasoning", "e"],
    ["Go", "Logs", "o"], ["Go", "LLM logs", "L"], ["Go", "Manage", null], ["Go", "Tasks", "t"], ["Go", "Skills", "s"],
    ["Go", "Memory", "m"], ["Go", "MCP", "c"], ["Go", "LLM", "l"], ["Go", "Telegram", "g"], ["Go", "Import", "i"],
    ["Go", "Privacy", "p"], ["Go", "Toggle debug pane", null],
    ["Session", "New session", "n"], ["Session", "Switch session…", "u"], ["Session", "Clear transcript", null],
    ["Session", "Context window", null], ["Session", "Show session id", null], ["Session", "New terminal window", null],
    ["Model", "Switch chat model…", "k"],
    ["Run", "Coding mode…", "M"], ["Run", "Abort turn", "a"], ["Run", "Queued messages", null],
    ["Run", "Steer the running turn", null], ["Run", "Expand all tool cards", null], ["Run", "Collapse all tool cards", null],
    ["Setup", "Theme…", "h"], ["Setup", "Mouse…", null], ["Setup", "Hide or show the sidebar", null], ["Setup", "Analytics", null],
    ["Setup", "Enable or disable a skill…", null], ["Setup", "Create, cancel or run a task…", null],
    ["Help", "Commands", null], ["Help", "List built-in tools", null], ["Help", "Write debug bundle", "d"], ["Help", "Quit", "q"],
    ["Danger zone", "Uninstall atomic-agent…", null],
  ];
  const nodes = await js<Array<{ group: string; label: string; chord: string | null; na: boolean; tab: string | null }>>("window.__menuNodes()");
  check("settings: every menu node has its TUI label and chord", same(nodes.map((n) => [n.group, n.label, n.chord]), NODES), JSON.stringify(nodes.map((n) => [n.group, n.label, n.chord])));
  const manageTabs = nodes.filter((n) => n.tab).map((n) => n.tab);
  check("settings: Manage children are the eight tabs", same(manageTabs, TABS), JSON.stringify(manageTabs));

  // The bottom-left entry lands on Go › Manage › Tasks.
  const foot = await js<{ present: boolean; text: string; pane: string }>(
    "(() => { const f = document.querySelector('#sidebar .sb-foot'); if (!f) return {present:false,text:'',pane:''};"
    + " f.click(); return {present:true, text:f.textContent, pane:window.__settingsPane()}; })()",
  );
  check("settings: bottom-left entry opens on Tasks", foot.present && /Settings/.test(foot.text) && foot.pane === "tasks", `pane=${foot.pane}`);
  await js<void>("window.__settingsClose()");
  const viaKey = await js<string>(
    "(() => { document.dispatchEvent(new KeyboardEvent('keydown', {key: ',', metaKey: true, bubbles: true, cancelable: true})); return window.__settingsPane(); })()",
  );
  check("settings: Cmd+, opens on Tasks", viaKey === "tasks", `pane=${viaKey}`);

  const labels = await js<string[]>("window.__settingsLabels()");
  check("settings: tab labels mirror the TUI", same(labels, LABELS), JSON.stringify(labels));

  // The menu column: chords render as `ctrl+g <key>`, nodes the desktop
  // cannot do keep their label with the note, and a verb dispatches its act.
  const menuDom = await js<{ chord: string; naCount: number; naText: string }>(
    "(() => { const t = document.querySelector('#settings [data-act=\"menu:go.manage.tasks\"] .ch');"
    + " const na = [...document.querySelectorAll('#settings .menurow.na')];"
    + " const win = na.find((r) => r.textContent.includes('New terminal window'));"
    + " return {chord: t ? t.textContent : '', naCount: na.length, naText: win ? win.textContent : ''}; })()",
  );
  const naExpected = nodes.filter((n) => n.na).length;
  check(
    "settings: menu column renders chords and the not-available note",
    menuDom.chord === "ctrl+g t" && menuDom.naCount === naExpected && menuDom.naText.includes("not available in the desktop"),
    `chord=${JSON.stringify(menuDom.chord)} na=${menuDom.naCount}/${naExpected}`,
  );
  const dispatched = await js<{ settings: boolean; inspector: boolean; inspTab: string }>("window.__menuActivate('go.observe.world')");
  check("settings: a menu verb dispatches its desktop act", !dispatched.settings && dispatched.inspector && dispatched.inspTab === "world", JSON.stringify(dispatched));
  const viaNode = await js<{ settings: boolean; pane: string | null }>(
    "(() => { window.__settingsOpen('tasks'); return window.__menuActivate('go.manage.privacy'); })()",
  );
  check("settings: a Manage node switches the panel", viaNode.settings && viaNode.pane === "privacy", JSON.stringify(viaNode));

  // Diagnostics line: the TUI's null forms for the process metrics, the
  // tools counter only for the open session, cwd/llama from /health.
  let diag = { line: "", session: null as string | null, toolsFor: null as string | null, health: null as unknown };
  for (let i = 0; i < 12; i++) {
    diag = await js<typeof diag>("window.__diag()");
    if (diag.health && (!diag.session || diag.toolsFor === diag.session)) break;
    await wait(500);
  }
  const toolsSeg = /\| tools \d+ok\/\d+err \|/.test(diag.line);
  const toolsOk = diag.session ? toolsSeg && diag.toolsFor === diag.session : !toolsSeg;
  // Review fix: the approval segment is compared with what GET /api/capabilities
  // actually carried — the old regex accepted any digit, so a payload without
  // agent.approvalLevel would have passed with the prototype's demo L3.
  const capsLevel = await js<number | null>(
    "window.atomic.capabilities().then((c) => (c && c.ok && c.data && c.data.agent && typeof c.data.agent.approvalLevel === 'number' ? c.data.agent.approvalLevel : null))",
  );
  const expectedLevel = capsLevel === null ? "—" : String(Math.max(1, Math.min(5, capsLevel)));
  // Item 6: which agent answered must be on the line in BOTH the supported
  // and the unsupported case. The head and the tail of the line are pinned
  // above and below this segment, so nothing else notices if it disappears
  // — assert the segment itself, and that it carries a value rather than
  // an empty slot. `[^|]+` covers both a path and the `—` null form.
  const agentSeg = / \| agent [^|]+ \| approval L/.test(diag.line);
  check(
    "settings: diagnostics line uses the TUI null forms and counts tools only for the open session",
    diag.line.startsWith("cwd ") && diag.line.includes(" | llama ") && diag.line.includes(" | llm — · step — | kv — |")
      && agentSeg
      && new RegExp(` \\| approval L${expectedLevel} \\| skills \\d+$`).test(diag.line) && !!diag.health && toolsOk,
    `${diag.line} (session=${diag.session ?? "none"}, capabilities says ${capsLevel === null ? "no approvalLevel" : capsLevel}`
      + `, agent segment ${agentSeg ? "present" : "MISSING"})`,
  );

  const errBefore = await js<number>("window.__errCount()");
  let allRender = true;
  const details: string[] = [];
  const PLACEHOLDER: string[] = []; // Item 7 part C: every Manage tab is real now (LLM / Telegram / Import are asserted in settingsTestPartC)
  for (const id of TABS) {
    const r = await js<{ pane: string; on: string; body: string }>(
      `(() => { const pane = window.__settingsOpen(${JSON.stringify(id)});`
      + " const on = (document.querySelector('#settings .settab.on') || {dataset:{}}).dataset.act || '';"
      + " return {pane, on, body: window.__settingsBody()}; })()",
    );
    // A placeholder tab must say so with its TUI label; the real tabs are asserted below.
    const bodyOk = PLACEHOLDER.includes(id)
      ? r.body.includes(LABELS[TABS.indexOf(id)]!) && r.body.includes("coming in the next step of this branch")
      : r.body.length > 0;
    const ok = r.pane === id && r.on === "settings:" + id && bodyOk;
    if (!ok) { allRender = false; details.push(`${id}: pane=${r.pane} on=${r.on} body=${r.body.slice(0, 60)}`); }
  }
  const errAfter = await js<number>("window.__errCount()");
  check("settings: every tab renders without errors", allRender && errAfter === errBefore, details.join("; ") || `errors ${errBefore}→${errAfter}`);

  // Tab cycling with the arrow keys, as the TUI's cycleSubTab does.
  const cycled = await js<string>(
    "(() => { window.__settingsOpen('privacy');"
    + " document.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true, cancelable: true}));"
    + " return window.__settingsPane(); })()",
  );
  check("settings: ArrowRight wraps from Privacy to Tasks", cycled === "tasks", `pane=${cycled}`);

  // The chord column is live: ctrl+g then `p` opens Go › Manage › Privacy
  // from a closed window, exactly the chord the column prints.
  const chord = await js<{ armed: boolean; pane: string | null; disarmed: boolean }>(
    "(() => { window.__settingsClose();"
    + " document.dispatchEvent(new KeyboardEvent('keydown', {key: 'g', ctrlKey: true, bubbles: true, cancelable: true}));"
    + " const armed = window.__chordPending();"
    + " document.dispatchEvent(new KeyboardEvent('keydown', {key: 'p', bubbles: true, cancelable: true}));"
    + " return {armed, pane: window.__settingsPane(), disarmed: !window.__chordPending()}; })()",
  );
  check("settings: ctrl+g p runs the Privacy chord", chord.armed && chord.pane === "privacy" && chord.disarmed, JSON.stringify(chord));

  // Switching tabs must not spawn `atag skill list` again or repaint for unchanged data.
  const spawns = await js<{ before: number; after: number }>(
    "(async () => { const before = window.__skillListCalls(); window.__settingsOpen('tasks'); window.__settingsOpen('privacy'); window.__settingsOpen('skills');"
    + " await new Promise((r) => setTimeout(r, 600)); return {before, after: window.__skillListCalls()}; })()",
  );
  check("settings: tab clicks do not re-run `atag skill list`", spawns.after === spawns.before, `${spawns.before} → ${spawns.after}`);

  // Skills count suffix: N = every installed skill incl. disabled, from `atag skill list`.
  let skillCount: number | null = null;
  for (let i = 0; i < 20 && skillCount === null; i++) { await wait(500); skillCount = await js<number | null>("window.__skillCount()"); }
  const skillsCli = await js<{ ok: boolean; rows?: unknown[]; error?: string }>("window.atomic.skillList()");
  const skillsLabel = await js<string>(
    "(() => { window.__settingsOpen('skills'); const b = document.querySelector('#settings .settab.on'); return b ? b.textContent.trim() : ''; })()",
  );
  check(
    "settings: Skills tab count is `atag skill list`",
    skillsCli.ok && skillCount === (skillsCli.rows ?? []).length && skillsLabel === (skillCount ? `Skills (${skillCount})` : "Skills"),
    `count=${String(skillCount)} cli=${skillsCli.ok ? (skillsCli.rows ?? []).length : skillsCli.error} label=${JSON.stringify(skillsLabel)}`,
  );
  // (After the count check, so `atag skill list` has answered.) Skills, this step: the installed list as skills-list.tsx draws it — the
  // header row and one row per `atag skill list` line — so the palette's
  // Skills rows and `/skills` land on a real list, not a placeholder.
  // Item 7 part B: the list is the TUI's 14-row window (skills-panel.tsx
  // maxRows) around the cursor, so the painted rows are min(loaded, 14)
  // with the `↓ N below` line; the loaded rows are every CLI row.
  const skl = await js<{ header: boolean; rows: number; loaded: number; cli: number | null; win: { painted: number; visible: number; max: number; above: string; below: string } }>(
    "(() => { window.__settingsOpen('skills'); const body = window.__settingsBody();"
    + " return {header: body.includes('state     source   version  name'), rows: document.querySelectorAll('#settings .setbody [data-skill-row]').length, loaded: window.__skillsRows(), cli: window.__skillCount(), win: window.__skillsWindow()}; })()",
  );
  const sklHidden = typeof skl.cli === "number" ? Math.max(0, skl.cli - skl.win.max) : 0;
  check(
    "settings: Skills tab lists every `atag skill list` row",
    skl.header && typeof skl.cli === "number" && skl.loaded === skl.cli && skl.rows === Math.min(skl.cli, skl.win.max)
      && skl.win.above === "" && (sklHidden === 0 ? skl.win.below === "" : skl.win.below === `↓ ${sklHidden} below`),
    JSON.stringify(skl),
  );

  // Tasks tab: what GET /api/tasks holds is what the tab shows.
  await js<void>("window.__settingsOpen('tasks')");
  await wait(1500);
  // The harness reads the store through the route's own cap (limit=500), so
  // the tab's count is checked against what the store holds up to the TUI's
  // 200-row list limit — not against the same 200-row call the tab makes.
  const storeCount = await agent!.tasksList(500).then((r) => ((r as { tasks?: unknown[] }).tasks ?? []).length).catch(() => -1);
  const taskState = await js<{ rows: number; body: string; win: { painted: number; visible: number; max: number; above: string; below: string } }>(
    "(() => ({rows: window.__tasksRows(), body: window.__settingsBody(), win: window.__tasksWindow()}))()",
  );
  const tasksCopy = taskState.rows === 0
    ? taskState.body.includes("no tasks match the current filter — press `n` to create one")
    : taskState.body.includes("status   schedule               next-run       session   message");
  // The route is called with limit=500 (agent-client tasks(); item 6 needs the
  // whole list so the sidebar's Load more pages over real rows); the TAB then
  // shows the TUI's first 200 of it, which is what this compares.
  check("tasks tab: rows and copy come from GET /api/tasks, cut to the TUI's 200-row list", tasksCopy && taskState.rows === Math.min(storeCount, 200), `${taskState.rows} rows, store holds ${storeCount}`);
  // tasks-list.tsx windows the list at 14 rows around the cursor and prints the hidden counts.
  const w = taskState.win;
  const hidden = Math.max(0, w.visible - w.max);
  const windowOk = w.painted === Math.min(w.visible, w.max) && w.above === "" && (hidden === 0 ? w.below === "" : w.below === `↓ ${hidden} below`);
  check("tasks tab: list is a 14-row window with the TUI's hidden-count lines", windowOk, `painted=${w.painted} visible=${w.visible} below=${JSON.stringify(w.below)}`);

  // The create form's preview (form path: tkPreview → app:taskPreview) is the agent's own cron-parser port.
  const preview = await js<{ cron: number; every: number; at: number; bad: string; shown: boolean }>(
    "(async () => { const cron = await window.__taskPreviewForm({kind:'cron', cronExpression:'0 * * * *', message:'x'});"
    + " const shown = window.__settingsBody().includes('next firings:');"
    + " const every = await window.__taskPreviewForm({kind:'interval', intervalSeconds:'300', message:'x'});"
    + " const at = await window.__taskPreviewForm({kind:'at', atIsoOrMs:'2030-01-01T09:00:00Z', message:'x'});"
    + " const bad = await window.__taskPreviewForm({kind:'cron', cronExpression:'not a cron', message:'x'});"
    + " return {cron: cron.nextFirings.length, every: every.nextFirings.length, at: at.nextFirings.length, bad: bad.error || '', shown}; })()",
  );
  check(
    "tasks tab: next-firings preview runs cron-parser",
    preview.cron === 5 && preview.every === 5 && preview.at === 1 && /invalid cron expression/.test(preview.bad) && preview.shown,
    `cron=${preview.cron} every=${preview.every} at=${preview.at} bad=${JSON.stringify(preview.bad)} shown=${preview.shown}`,
  );

  // Each `atag task create` allocates the task its own `s-<uuid>` session
  // (TaskRunner.create for the recurring path) and the agent has no task
  // delete, so without this every run left one more 0-turn "s-… session"
  // row in the lane's sidebar. DELETE /api/sessions/{id} (0.5.4, idempotent)
  // purges the fixture's session once the task is cancelled — only while
  // it has no turns, so a one-shot the scheduler claimed keeps its transcript.
  const purgeFixtureSession = async (taskId: string): Promise<string> => {
    if (!agent) return "no agent";
    try {
      // GET /api/tasks/{id} answers the bare record (recordToJson); only the run route wraps it as {task}.
      const t = (await agent.task(taskId)) as { sessionId?: unknown } | null;
      const sid = t && typeof t.sessionId === "string" ? t.sessionId : "";
      if (!sid) return "no session on the task";
      const list = (await agent.sessions()) as { sessions?: Array<{ id?: unknown; turnCount?: unknown }> } | null;
      const row = list?.sessions?.find((s) => s.id === sid);
      if (row && typeof row.turnCount === "number" && row.turnCount > 0) return `kept ${sid} (${row.turnCount} turns)`;
      await agent.deleteSession(sid);
      return `purged ${sid}`;
    } catch (err) {
      return `purge failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  // Create a one-shot task through `atag task create`, see it in the tab,
  // cancel it through the tab's `c cancel` (DELETE /api/tasks/{id}). The
  // fixed messages keep the rows recognisable; the agent has no task delete
  // (list/show/create/cancel/run/tick only), so each run leaves two cancelled
  // rows (this one and the recurring fixture below) in the store the harness
  // runs against.
  //
  // On 0.5.4 `atag task create --at` takes the CLI's one-shot path, which
  // writes through the bare TaskStore with no `scheduledFor` (only the
  // recurring path goes through TaskRunner.create, which resolves it), so
  // the row lands with `scheduled_for = NULL` — and the claim query takes
  // NULL as "due now". The scheduler can therefore pick this row up
  // milliseconds after creation — observed at +16 ms and +670 ms — whatever
  // `--at` says; POST /api/tasks takes no schedule, so there is no other
  // path. The cancel follows the create with no wait (the create already
  // awaits the tab's refresh), and the message asks for a bare reply so a
  // claimed run makes no tool calls. The TUI's own create goes through
  // TaskRunner.create and does not have this problem.
  let createdId = "";
  try {
    const created = await js<{ ok: boolean; id?: string; error?: string; line: string }>(
      "(async () => { const at = String(Date.now() + 5 * 365 * 24 * 3600 * 1000);"
      + " const r = await window.__taskCreate({kind:'at', atIsoOrMs: at, message:'desktop smoke task: reply with exactly the word done, use no tools'});"
      + " return Object.assign({}, r, {line: window.__tasksMsg()}); })()",
    );
    createdId = created.id ?? "";
    check("tasks tab: create goes through atag task create", created.ok && !!createdId && created.line === `task ${createdId} scheduled (at)`, created.error ?? created.line);
    // The one-shot caveat rides under the success line, not only in the form preview.
    const note = await js<string>("window.__tasksNote()");
    check("tasks tab: the `at` caveat follows the success line", note.includes("stores no next-run for a one-shot"), JSON.stringify(note));
    if (createdId) {
      // A one-shot with no scheduledFor sorts last, so it may sit outside the
      // 14-row window: find it the way the TUI does, through `/` search.
      const seen = await js<{ rows: number; has: boolean }>(
        "(() => { const ids = window.__tasksSearch('desktop smoke task'); const has = window.__settingsBody().includes('desktop smoke task'); window.__tasksSearch(''); return {rows: ids.length, has}; })()",
      );
      check("tasks tab: the new task appears in the list", seen.has && seen.rows >= 1, `${seen.rows} matching rows`);
    }
  } finally {
    if (createdId) {
      // `c cancel` on a one-shot row: the hint's own path (tasksAct → tkCancel →
      // DELETE /api/tasks/{id}), no modal, and the orchestrator's runtime line.
      const cancelled = await js<{ modal: unknown; line: string }>(
        `(async () => { const first = window.__tasksAct(${JSON.stringify("cancel:" + createdId)});`
        + ` const prefix = ${JSON.stringify(`task ${createdId} `)}; const deadline = Date.now() + 8000; let line = '';`
        + " while (Date.now() < deadline) { line = window.__tasksMsg(); if (line.startsWith(prefix) && /cancelled|cannot cancel|not found/.test(line)) break; await new Promise((r) => setTimeout(r, 200)); }"
        + " return {modal: first.cancel, line}; })()",
      );
      // A row the scheduler already finished reads `already completed (cannot
      // cancel)` — that is the TUI's line too, and it means the tick won the
      // race above, not that the cancel path is wrong.
      const oneShotOk = cancelled.modal === null
        && (cancelled.line === `task ${createdId} cancelled` || cancelled.line === `task ${createdId} already completed (cannot cancel)`);
      check("tasks tab: `c cancel` goes through DELETE /api/tasks/{id}", oneShotOk, `modal=${JSON.stringify(cancelled.modal)} line=${JSON.stringify(cancelled.line)}`);
      if (!oneShotOk) await js<void>(`window.atomic.cancelTask(${JSON.stringify(createdId)})`); // never leave the fixture pending
      const purged = await purgeFixtureSession(createdId);
      check("tasks tab: the one-shot fixture's empty session is purged", !purged.startsWith("purge failed"), purged);
      await js<void>("window.__tasksRefresh()");
    }
  }

  // A recurring fixture (cron `0 0 29 2 *`: next firing 29 Feb 2028, so it
  // never runs during the smoke) so `c cancel` shows the recurring-only
  // modal and `y` confirms it through the settings window's key handler.
  let recurringId = "";
  try {
    const rec = await js<{ ok: boolean; id?: string; error?: string; line: string }>(
      "(async () => { const r = await window.__taskCreate({kind:'cron', cronExpression:'0 0 29 2 *', message:'desktop smoke recurring task'});"
      + " return Object.assign({}, r, {line: window.__tasksMsg()}); })()",
    );
    recurringId = rec.id ?? "";
    check("tasks tab: recurring create goes through atag task create", rec.ok && !!recurringId && rec.line === `task ${recurringId} scheduled (cron)`, rec.error ?? rec.line);
  } finally {
    if (recurringId) {
      const modal = await js<{ cancel: { taskId: string; isRecurring: boolean } | null; msg: string }>(
        `(() => { window.__settingsOpen('tasks'); return window.__tasksAct(${JSON.stringify("cancel:" + recurringId)}); })()`,
      );
      const asked = !!modal.cancel && modal.cancel.taskId === recurringId && modal.cancel.isRecurring === true && modal.msg !== `task ${recurringId} cancelled`;
      const confirmed = await js<string>(
        "(async () => { document.dispatchEvent(new KeyboardEvent('keydown', {key: 'y', bubbles: true, cancelable: true}));"
        + ` const want = ${JSON.stringify(`task ${recurringId} cancelled`)}; const deadline = Date.now() + 8000; let line = '';`
        + " while (Date.now() < deadline) { line = window.__tasksMsg(); if (line === want) break; await new Promise((r) => setTimeout(r, 200)); }"
        + " return line; })()",
      );
      const recurringOk = asked && confirmed === `task ${recurringId} cancelled`;
      check("tasks tab: cancelling a recurring task asks first, `y` confirms", recurringOk, `asked=${asked} line=${JSON.stringify(confirmed)}`);
      if (!recurringOk) await js<void>(`window.atomic.cancelTask(${JSON.stringify(recurringId)})`); // never leave the fixture pending
      const purged = await purgeFixtureSession(recurringId);
      check("tasks tab: the recurring fixture's empty session is purged", purged.startsWith("purged"), purged);
      await js<void>("window.__tasksRefresh()");
    }
  }

  // Privacy: the TUI's post-#303 copy, and no ladder anywhere in it.
  await js<void>("window.__settingsOpen('privacy')");
  const priv = await js<string>("window.__settingsBody()");
  const privacyCopy = ["Analytics", "anonymous usage", "Product analytics + crash reports, fully anonymous.", "Session grants", "none active"]
    .every((s) => priv.includes(s));
  const noLadder = !/Approvals|approval level|1-5: set approval level/.test(priv);
  check("privacy tab: TUI copy, no approval ladder", privacyCopy && noLadder, privacyCopy ? (noLadder ? "" : "ladder text present") : "copy missing");
  // The TUI's tab strip is one line; with the count suffixes the eight
  // labels used to wrap onto a second row inside the 900px window.
  const stripRows = await js<number>("window.__settingsStripRows()");
  check("settings: the Manage tab strip stays on one row", stripRows === 1, `${stripRows} row(s)`);

  // Analytics round trip through `atag config set analytics.enabled`, restored in finally.
  // `before` is the user file (what the restore needs); the tab shows and
  // flips the EFFECTIVE value (the schema default when the key is unset),
  // read through `atag config get analytics.enabled` like the TUI's getConfig().
  const before = await js<boolean | undefined>(
    "(async () => { const r = await window.atomic.config(); const a = r.data && r.data.config && r.data.config.analytics; return a ? a.enabled : undefined; })()",
  );
  let effective: boolean | null = null;
  for (let i = 0; i < 16 && typeof effective !== "boolean"; i++) {
    effective = (await js<{ analyticsEnabled: boolean | null }>("window.__privacy()")).analyticsEnabled;
    if (typeof effective !== "boolean") await wait(500);
  }
  check("privacy tab: shows the effective analytics value", typeof effective === "boolean" && (typeof before !== "boolean" || before === effective), `file=${String(before)} effective=${String(effective)}`);
  const readEffective = async (): Promise<boolean | null> => (await js<{ analyticsEnabled: boolean | null }>("window.__privacy()")).analyticsEnabled;
  const readFile = () => js<boolean | undefined>(
    "(async () => { const r = await window.atomic.config(); const a = r.data && r.data.config && r.data.config.analytics; return a ? a.enabled : undefined; })()",
  );
  // Waits for the write queue to drain, not only for the value to match —
  // right after a slash the value may already read `want` while the write
  // is still in flight.
  const settle = async (want: boolean | null): Promise<boolean | null> => {
    const deadline = Date.now() + 10000;
    let now: boolean | null = null;
    while (Date.now() < deadline) {
      await wait(300);
      const idle = await js<boolean>("window.__privacyIdle()");
      now = await readEffective();
      if (idle && now === want) break;
    }
    return now;
  };
  try {
    // The slash verbs write the value the user typed (`/privacy analytics on`
    // = persistAnalyticsEnabled(true) in the TUI), never a toggle against the
    // user file: with the key unset the effective value is the schema
    // default, so asking for that same value must leave it in place …
    const verbSame = effective ? "on" : "off";
    await js<void>(`window.__runSlash(${JSON.stringify(`/privacy analytics ${verbSame}`)})`);
    const sameAfter = await settle(effective);
    const pane1 = await js<string | null>("window.__settingsPane()");
    check("privacy slash: `/privacy analytics " + verbSame + "` keeps the effective value", sameAfter === effective && pane1 === "privacy", `effective=${String(sameAfter)} pane=${String(pane1)}`);
    // … and asking for the other value flips it, through the same write as the `a` key.
    const verbOther = effective ? "off" : "on";
    await js<void>(`window.__runSlash(${JSON.stringify(`/analytics ${verbOther}`)})`);
    const otherAfter = await settle(!effective);
    const otherFile = await readFile();
    check("privacy slash: `/analytics " + verbOther + "` writes analytics.enabled", otherAfter === !effective && otherFile === !effective, `effective=${String(otherAfter)} file=${String(otherFile)}`);
    // Back to the starting value so the `a`-key round trip below starts where the tab did.
    await js<void>(`window.__runSlash(${JSON.stringify(`/analytics ${verbSame}`)})`);
    check("privacy slash: the slash and the `a` key agree", (await settle(effective)) === effective, "");
    await js<void>("window.__privacyToggle()");
    let flipped = false;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await wait(500);
      const now = await js<{ analyticsEnabled: boolean | null }>("window.__privacy()");
      if (now.analyticsEnabled === !effective) { flipped = true; break; }
    }
    const onDisk = await js<boolean | undefined>(
      "(async () => { const r = await window.atomic.config(); const a = r.data && r.data.config && r.data.config.analytics; return a ? a.enabled : undefined; })()",
    );
    check("privacy tab: analytics toggle writes config", flipped && onDisk === !effective, `${String(effective)} → ${String(onDisk)}`);
  } finally {
    // LIVE_CONFIG is the user file: an unset key reads as undefined and
    // must go back to unset, not to the string "undefined".
    if (typeof before === "boolean") await configSet("analytics.enabled", String(before));
    else await configUnset("analytics.enabled");
    await js<void>("window.__ctxRefreshCfg && window.__ctxRefreshCfg()");
  }
  await js<void>("window.__settingsClose()");
}

/**
 * Item 7 part B: the Skills, Memory and MCP tabs. Skills rows and the
 * detail body come from `atag skill list` / GET /api/skills/{name} /
 * `atag skill show`; the toggle round trip goes through `atag skill
 * disable` and is undone with `atag skill enable` in `finally`; the hub
 * browses ClawHub through `atag skill browse|search` (network); Memory is
 * compared against the tab's own named SQL run through app:memoryQuery;
 * MCP adds and removes a server through the whole-file `mcp.servers`
 * write and restores the list in `finally`.
 */
async function settingsTestPartB(
  js: <T>(code: string) => Promise<T>,
  check: (name: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  type SkillsState = {
    mode: string; busy: boolean; detailName: string | null; detailBody: string | null; detailSource: "route" | "skillShow" | null; msg: string; restart: boolean; lastError: string | null;
    hubRows: Array<{ identifier: string; source: string }>; hubLoading: boolean; hubError: string | null;
    hubCard: { identifier: string; name: string; bodyLines: number; bodyError: string | null; installId: string | null } | null; hubCardLoading: boolean;
  };
  const skills = () => js<SkillsState>("window.__skillsState()");
  const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> => {
    const deadline = Date.now() + ms;
    let v = await read();
    while (!ok(v) && Date.now() < deadline) { await wait(400); v = await read(); }
    return v;
  };

  // ---- Skills: rows, copy, detail ----
  await js<void>("window.__settingsOpen('skills')");
  const loaded = await until(() => js<number>("window.__skillsRows()"), (n) => n > 0, 15_000);
  const cli = await js<{ ok: boolean; rows?: Array<{ name: string; enabled: boolean; source: string }>; error?: string }>("window.atomic.skillList()");
  const cliRows = cli.rows ?? [];
  check("skills tab: loaded rows equal `atag skill list`", cli.ok && loaded === cliRows.length, `${loaded} vs ${cli.ok ? cliRows.length : cli.error}`);
  const body = await js<string>("window.__settingsBody()");
  const copy = ["filter: ", "built-in tools: ", "/tools", " shown · ", " enabled · ", " disabled", "j/k move", "Enter detail", "e toggle", "d remove", "r refresh", "a auto", "f filter", "Skills Hub", "browse & install skills from ClawHub"];
  const missing = copy.filter((s) => !body.includes(s));
  check("skills tab: filter bar, hints and the hub CTA carry the TUI copy", missing.length === 0, missing.length ? `missing ${JSON.stringify(missing)}` : "");

  // Enter on the first row: GET /api/skills/{name} body, skills-detail.tsx header + hints.
  const opened = await until(async () => { await js<void>("window.__skillsAct('detail')"); return skills(); }, (s) => s.mode === "detail", 2_000);
  const detail = await until(skills, (s) => s.detailBody !== null || s.mode !== "detail", 20_000);
  const detailBody = await js<string>("window.__settingsBody()");
  const detailOk = opened.mode === "detail" && typeof detail.detailBody === "string" && detail.detailBody.length > 0 && !!detail.detailName && detail.detailSource === "route"
    && detailBody.includes(detail.detailName) && detailBody.includes("Esc back") && detailBody.includes("e toggle") && detailBody.includes("r refresh");
  check("skills tab: Enter opens the detail from GET /api/skills/{name}", detailOk, `${detail.detailName ?? "?"} body=${detail.detailBody ? detail.detailBody.length : "null"} mode=${detail.mode} source=${detail.detailSource ?? "none"}`);
  await js<void>("window.__skillsAct('back')");

  // ---- Skills: e toggle → `atag skill disable`, detail via `atag skill show`, restored with `atag skill enable` ----
  // Any enabled skill: the toggle is a `skills.disabled` write, whatever the source (with the workspace at $HOME the
  // operator's ~/.atomic-agent/skills doubles as the project dir, so the CLI reports these rows as [project]).
  const target = cliRows.filter((r) => r.enabled).map((r) => r.name).sort()[0] ?? "";
  if (target) {
    try {
      const toggled = await until(async () => {
        if ((await skills()).busy) return skills();
        return js<SkillsState>(`window.__skillsAct(${JSON.stringify("toggle:" + target)})`);
      }, (s) => s.msg === `skill disabled: ${target}` || !!s.lastError, 30_000);
      const settled = await until(skills, (s) => !s.busy, 30_000);
      const listed = await js<{ ok: boolean; rows?: Array<{ name: string; enabled: boolean }> }>("window.atomic.skillList()");
      const row = (listed.rows ?? []).find((r) => r.name === target);
      check(
        "skills tab: e toggle goes through atag skill disable and offers the restart",
        toggled.msg === `skill disabled: ${target}` && toggled.restart && !!row && row.enabled === false && !settled.lastError,
        `msg=${JSON.stringify(toggled.msg)} listed=${row ? String(row.enabled) : "missing"} err=${settled.lastError ?? ""}`,
      );
      // A disabled skill is outside the registry's filtered view (404) — the body comes from `atag skill show`. On 0.5.4 the
      // route's view is boot-time, so a skill disabled now still answers 200 and the fallback cannot be provoked through
      // the route; two proofs instead. (1) Parity against the installed binary: skillShow() (header lines stripped,
      // frontmatter cut) equals the route body for the same skill. (2) The desktop's own branch: with the route answer
      // overridden to a 404-shaped failure, skpOpenDetail reads from cli:skillShow and records detailSource.
      const routeRes = await js<{ ok: boolean; data?: { body?: unknown }; error?: string }>(`window.atomic.skill(${JSON.stringify(target)})`);
      const routeText = routeRes.ok && routeRes.data && typeof routeRes.data.body === "string" ? routeRes.data.body : null;
      const shown = await js<{ ok: boolean; body?: string; error?: string }>(`window.atomic.skillShow(${JSON.stringify(target)})`);
      const shownText = shown.ok && typeof shown.body === "string" ? shown.body : null;
      check(
        "skills tab: atag skill show stripped of its two header lines equals the route body",
        shownText !== null && shownText.length > 0 && !shownText.startsWith("---") && routeText !== null && shownText === routeText,
        `${target}: skill show ${shownText === null ? "failed: " + (shown.error ?? "?") : shownText.length + " chars"}, route ${routeText === null ? "failed: " + (routeRes.error ?? "?") : routeText.length + " chars"}${shownText !== null && routeText !== null && shownText !== routeText ? ", bodies differ" : ""}`,
      );
      await js<void>("window.__skillsRouteOverride({ok:false, error:'404 not found (smoke: route answer overridden)'})");
      try {
        const viaShow = await until(async () => {
          const s = await skills();
          if (s.mode !== "detail") await js<void>(`window.__skillsAct(${JSON.stringify("detail:" + target)})`);
          return skills();
        }, (s) => s.mode === "detail" && s.detailBody !== null, 20_000);
        const shownBody = viaShow.detailBody ?? "";
        check(
          "skills tab: a disabled skill's detail falls back to atag skill show",
          viaShow.detailName === target && viaShow.detailSource === "skillShow" && shownBody.length > 0 && !shownBody.startsWith("---") && shownText !== null && shownBody === shownText,
          `${target}: source=${viaShow.detailSource ?? "none"} ${shownBody.length} chars${shownText !== null && shownBody === shownText ? ", same body as cli:skillShow" : ""}${viaShow.lastError ? " err=" + viaShow.lastError : ""}`,
        );
      } finally {
        await js<void>("window.__skillsRouteOverride(null)");
      }
    } finally {
      await skillSetDisabled(target, false);
      await js<void>("window.__skillsAct('back'); window.__skillsAct('refresh')");
      await until(() => js<{ ok: boolean; rows?: Array<{ name: string; enabled: boolean }> }>("window.atomic.skillList()"), (r) => !!(r.rows ?? []).find((x) => x.name === target && x.enabled), 15_000);
    }
  } else {
    check("skills tab: e toggle goes through atag skill disable and offers the restart", false, "no enabled skill to toggle");
  }

  // ---- Skills Hub: `atag skill browse` / `skill search`, the ClawHub card ----
  await js<void>("window.__skillsAct('hub')");
  const hub = await until(skills, (s) => s.mode === "hub" && !s.hubLoading, 120_000);
  const hubBody = await js<string>("window.__settingsBody()");
  check("skills hub: `atag skill browse` rows", hub.hubRows.length > 0 && hubBody.includes("hub search: (all)") && hubBody.includes("Enter open card"), `${hub.hubRows.length} rows${hub.hubError ? " hubError=" + hub.hubError : ""}`);
  // A `[gh]` row (skills.taps): the card carries the TUI's no-preview copy, no download count and installs by identifier.
  const ghIdx = hub.hubRows.findIndex((r) => r.source === "github");
  if (ghIdx >= 0) {
    await js<void>(`window.__skillsAct(${JSON.stringify("card:" + ghIdx)})`);
    const ghCard = await until(skills, (s) => !!s.hubCard && !s.hubCardLoading, 10_000);
    const ghBody = await js<string>("window.__settingsBody()");
    const gc = ghCard.hubCard;
    check(
      "skills hub: a GitHub-tap card says SKILL.md is pulled at install",
      !!gc && gc.identifier === hub.hubRows[ghIdx]!.identifier && gc.bodyLines === 0 && gc.bodyError === "preview unavailable for GitHub taps (SKILL.md is pulled at install)" && gc.installId === gc.identifier
        && ghBody.includes("[gh] ") && ghBody.includes("↓—") && ghBody.includes("preview unavailable for GitHub taps (SKILL.md is pulled at install)") && ghBody.includes("[i] install"),
      gc ? `${gc.identifier}: ${gc.bodyError ?? gc.bodyLines + " lines"}` : "no card",
    );
    await js<void>("window.__skillsAct('back')");
  } else {
    // Review fix: `atag skill browse` warns per tap and still returns the
    // ClawHub rows, so an unauthenticated GitHub rate limit (no GITHUB_TOKEN
    // on this machine, anonymous quota spent) looks exactly like a regression
    // here. The warning text is in hand — branch on it and skip with the
    // reason, as the fixture-less checks above do, instead of going red for
    // something this window did not do.
    const rateLimited = /rate limit|GITHUB_TOKEN|403|401/i.test(hub.hubError ?? "");
    check(
      "skills hub: a GitHub-tap card says SKILL.md is pulled at install",
      rateLimited,
      rateLimited
        ? `skipped — every GitHub tap warned: ${hub.hubError}`
        : `no [gh] row among ${hub.hubRows.length} browse rows (skills.taps empty or every tap warned)${hub.hubError ? " hubError=" + hub.hubError : ""}`,
    );
  }
  await js<void>("window.__skillsAct('search:pdf')");
  const found = await until(skills, (s) => !s.hubLoading, 120_000);
  const first = found.hubRows[0];
  check("skills hub: `/` search runs `atag skill search` and lists owner-qualified rows", found.hubRows.length > 0 && !!first && first.source === "clawhub" && first.identifier.startsWith("@"), `${found.hubRows.length} rows, first=${first ? first.identifier : "none"}${found.hubError ? " hubError=" + found.hubError : ""}`);
  if (first) {
    // ClawHub's search can list an owner its detail endpoint does not resolve (seen: search says @anthropics/pdf, the
    // detail answers 404) — the TUI then shows the client's own `not found: <url>`. Walk the first rows until one
    // resolves, so the detail path is proven, and require the client's own texts on the ones that do not.
    const clientTexts = (e: string | null) => !!e && (e.startsWith("not found: ") || e.startsWith("ambiguous skill slug") || e === "no SKILL.md published for this skill" || e.startsWith("ClawHub rate limit") || e.startsWith("network error fetching"));
    const outcomes: string[] = [];
    let resolved: SkillsState["hubCard"] = null;
    let chromeOk = true;
    for (let i = 0; i < Math.min(5, found.hubRows.length) && !resolved; i++) {
      await js<void>(`window.__skillsAct(${JSON.stringify("card:" + i)})`);
      const card = await until(skills, (s) => !!s.hubCard && !s.hubCardLoading, 40_000);
      const cardBody = await js<string>("window.__settingsBody()");
      const c = card.hubCard;
      chromeOk = chromeOk && !!c && c.identifier === found.hubRows[i]!.identifier && !!c.installId
        && cardBody.includes("[claw] ") && cardBody.includes("owner ") && cardBody.includes("[i] install") && cardBody.includes("[n] cancel");
      outcomes.push(c ? `${c.identifier}: ${c.bodyLines > 0 ? c.bodyLines + " lines" : c.bodyError ?? "no body"}` : "no card");
      if (c && c.bodyLines > 0) resolved = c;
      else if (!c || !clientTexts(c.bodyError)) chromeOk = false;
      await js<void>("window.__skillsAct('back')");
    }
    check("skills hub: the card body comes from ClawHub's detail endpoint", !!resolved && chromeOk, outcomes.join("; "));
  }
  const backToList = await until(async () => { await js<void>("window.__skillsAct('back')"); return skills(); }, (s) => s.mode === "list", 3_000);
  check("skills hub: Esc returns to the list", backToList.mode === "list", `mode=${backToList.mode}`);

  // ---- Memory: channels from config, rows from the tab's own SQL ----
  await js<void>("window.__settingsOpen('memory')");
  type MemState = {
    channel: string; channels: string[]; rows: number; mode: string; hint: string | null; error: string | null; refreshed: number | null;
    linksOn: boolean | null; expandRuns: number; expandQueries: number; stateDir: string | null;
    detail: { channel: string; id?: number; body: string; expanded: number[] | null; expandedAt: number | null; outgoing: number[] | null } | null;
  };
  // The link fixture for `g expand graph` is written with the sqlite3 CLI into the lane's own memory.sqlite (WAL, beside
  // the running serve) and deleted in finally; app:memoryQuery stays read-only.
  const sqliteExec = async (stateDir: string, sql: string): Promise<void> => {
    await promisify(execFile)("/usr/bin/sqlite3", [join(stateDir, "memory.sqlite"), sql], { timeout: 10_000 });
  };
  const memory = () => js<MemState>("window.__memory()");
  const mem = await until(memory, (m) => m.refreshed !== null || !!m.error, 20_000);
  const memCfg = await configGetKey("memory");
  const mc = (memCfg.ok && memCfg.value && typeof memCfg.value === "object" ? memCfg.value : {}) as Record<string, { enabled?: boolean }>;
  const expectedChannels = ["profile", "notes", ...(mc.lessons?.enabled ? ["lessons"] : []), ...(mc.procedures?.enabled ? ["procedures"] : []), ...(mc.links?.enabled ? ["links"] : []), ...(mc.voting?.enabled ? ["votes"] : [])];
  const memChannelsOk = await until(memory, (m) => same(m.channels, expectedChannels), 10_000);
  check("memory tab: channels follow memory.*.enabled as resolveAvailableChannels does", same(memChannelsOk.channels, expectedChannels), `${JSON.stringify(memChannelsOk.channels)} vs ${JSON.stringify(expectedChannels)}`);
  const profileSql = await js<{ ok: boolean; rows?: unknown[]; via?: string; error?: string }>("window.__memQuery('profile.list', [])");
  const memBody = await js<string>("window.__settingsBody()");
  check(
    "memory tab: profile rows equal the tab's own SQL over memory.sqlite",
    mem.channel === "profile" && profileSql.ok && mem.rows === (profileSql.rows ?? []).length && !mem.error && memBody.includes("[1:profile]") && (mem.rows === 0 || memBody.includes("primary                    secondary / meta")),
    `${mem.rows} rows vs sql ${profileSql.ok ? (profileSql.rows ?? []).length + " (" + profileSql.via + ")" : profileSql.error}${mem.error ? " err=" + mem.error : ""}`,
  );
  const notes = await js<MemState>("window.__memoryOpen('notes')");
  const notesSql = await js<{ ok: boolean; rows?: unknown[]; error?: string }>(`window.__memQuery('notes.listActive', [200])`);
  const notesBody = await js<string>("window.__settingsBody()");
  check("memory tab: notes rows equal notes.listActive and the bar says notes: active", notes.channel === "notes" && notesSql.ok && notes.rows === (notesSql.rows ?? []).length && notesBody.includes("[2:notes]") && notesBody.includes("notes: active"), `${notes.rows} vs ${notesSql.ok ? (notesSql.rows ?? []).length : notesSql.error}`);
  if (notes.rows > 0) {
    const d = await js<MemState>("window.__memoryDetail(0)");
    const dBody = await js<string>("window.__settingsBody()");
    check("memory tab: a note's detail is memory-detail-text.ts's body", d.mode === "detail" && !!d.detail && d.detail.channel === "notes" && d.detail.body.startsWith("#") && d.detail.body.includes("--- links ---") && dBody.includes(`note #${d.detail.id}`) && dBody.includes("g expand graph"), d.detail ? `note #${d.detail.id}` : `mode=${d.mode} err=${d.error ?? ""}`);
    // g expand graph: seed one link from the open note to another active note, so the walk (links.outgoing/incoming, depth 2)
    // has a neighbour to return; with memory.links.enabled false the walk is the TUI's no-op and must run no statement.
    const noteIds = ((notesSql.rows ?? []) as Array<{ id?: unknown }>).map((r) => (typeof r.id === "number" ? r.id : null)).filter((x): x is number => x !== null);
    const seedFrom = d.detail && typeof d.detail.id === "number" ? d.detail.id : null;
    const seedTo = noteIds.find((id) => id !== seedFrom) ?? null;
    const linksOn = d.linksOn === true;
    let seeded = false;
    try {
      if (linksOn && seedFrom !== null && seedTo !== null && d.stateDir) {
        await sqliteExec(d.stateDir, `INSERT OR IGNORE INTO memory_links(from_id, to_id, kind, weight, created_at) VALUES(${seedFrom}, ${seedTo}, 'desktop-smoke', 1.0, ${Date.now()})`);
        seeded = true;
      }
      const g = await js<MemState>("window.__memoryExpand()");
      const ex = g.detail?.expanded ?? null;
      const walked = !!g.detail && g.detail.expandedAt !== null && g.expandRuns === 1 && g.expandQueries >= 2 && Array.isArray(ex) && !g.error;
      const ok = linksOn
        ? walked && (!seeded || (ex!.includes(seedTo!) && (g.detail!.outgoing ?? []).includes(seedTo!) && g.detail!.body.includes(`expanded (g): #${seedTo}`)))
        : !!g.detail && g.expandRuns === 0 && g.expandQueries === 0 && !g.error;
      check(
        "memory tab: g expand graph runs the link-store walk",
        ok,
        linksOn
          ? `${seeded ? `link #${seedFrom}→#${seedTo} seeded, ` : "no second note to link, "}${g.expandRuns} run · ${g.expandQueries} link statements · expanded=${JSON.stringify(ex)}${g.error ? " err=" + g.error : ""}`
          : `memory.links.enabled=${String(g.linksOn)}: no-op as the TUI (${g.expandQueries} statements)${g.error ? " err=" + g.error : ""}`,
      );
    } finally {
      if (seeded && d.stateDir) await sqliteExec(d.stateDir, "DELETE FROM memory_links WHERE kind = 'desktop-smoke'");
    }
    await js<void>("window.__memoryAct('back')");
  }
  if (expectedChannels.includes("votes")) {
    const votes = await js<MemState>("window.__memoryOpen('votes')");
    const votesSql = await js<{ ok: boolean; rows?: unknown[]; error?: string }>("window.__memQuery('votes.listEvents', [100])");
    check("memory tab: vote events equal votes.listEvents", votes.channel === "votes" && votesSql.ok && votes.rows === (votesSql.rows ?? []).length, `${votes.rows} vs ${votesSql.ok ? (votesSql.rows ?? []).length : votesSql.error}`);
  }
  await js<void>("window.__memoryOpen('profile')");

  // ---- MCP: config rows, honest state cell, add/remove through the whole-file write ----
  type McpState = { mode: string; rows: number; servers: string[]; detailTab: string; addModal: { error: string | null } | null; removeConfirm: unknown; msg: string; lastError: string | null; refreshed: number | null };
  const mcp = () => js<McpState>("window.__mcp()");
  const beforeServers = ((await configGet()).config as { mcp?: { servers?: unknown[] } } | undefined)?.mcp?.servers;
  await js<void>("window.__settingsOpen('mcp')");
  const m0 = await until(mcp, (m) => m.refreshed !== null, 20_000);
  const mcpBody = await js<string>("window.__settingsBody()");
  const mcpEmpty = !Array.isArray(beforeServers) || beforeServers.length === 0;
  check(
    "mcp tab: rows come from mcp.servers, the empty copy is the TUI's",
    m0.rows === (Array.isArray(beforeServers) ? beforeServers.length : 0) && mcpBody.includes(`${m0.rows} servers`) && mcpBody.includes("n add") && mcpBody.includes("d remove")
      && (!mcpEmpty || (mcpBody.includes("no MCP servers configured — add entries under `mcp.servers[]` in config.json") && mcpBody.includes("(no servers)"))),
    `${m0.rows} rows, config holds ${Array.isArray(beforeServers) ? beforeServers.length : "unset"}`,
  );
  const parsed = await js<Array<{ ok: boolean; server?: { name: string; transport?: { kind: string; command?: string; url?: string } }; error?: string }>>(
    "[window.__mcpParse('{\"name\":\"a\",\"transport\":{\"kind\":\"sse\",\"url\":\"http://x/mcp\"}}'),"
    + " window.__mcpParse('{\"mcpServers\":{\"b\":{\"command\":\"npx\",\"args\":[\"-y\",\"pkg\"]}}}'),"
    + " window.__mcpParse('{\"name\":\"c\",\"url\":\"https://x/mcp\"}'),"
    + " window.__mcpParse('{\"mcpServers\":{\"d\":{},\"e\":{}}}')]",
  );
  const p = parsed;
  check(
    "mcp tab: the add modal accepts the three JSON shapes persist-mcp-server.ts accepts",
    p.length === 4 && p[0]!.ok && p[0]!.server?.transport?.kind === "sse" && p[1]!.ok && p[1]!.server?.name === "b" && p[1]!.server?.transport?.kind === "stdio" && p[1]!.server?.transport?.command === "npx"
      && p[2]!.ok && p[2]!.server?.transport?.kind === "streamable_http" && !p[3]!.ok && /exactly one server/.test(p[3]!.error ?? ""),
    JSON.stringify(p.map((x) => (x.ok ? x.server?.transport?.kind : x.error))),
  );
  const fixture = "desktop-smoke";
  try {
    const added = await js<{ ok: boolean; error?: string; state: McpState }>(
      `window.__mcpAddSubmit(${JSON.stringify(JSON.stringify({ mcpServers: { [fixture]: { command: "echo", args: ["hi"], description: "desktop smoke fixture" } } }))})`,
    );
    const onDisk = ((await configGet()).config as { mcp?: { servers?: Array<{ name: string }> } } | undefined)?.mcp?.servers ?? [];
    const addBody = await js<string>("window.__settingsBody()");
    check(
      "mcp tab: n add writes mcp.servers through the whole-file config set",
      added.ok && onDisk.some((s) => s.name === fixture) && added.state.rows === m0.rows + 1 && added.state.msg.includes(`added "${fixture}"`) && added.state.addModal === null
        && addBody.includes(fixture) && addBody.includes("[—]") && addBody.includes("state not exposed — no MCP status route in this agent") && addBody.includes("0 tools · — res · — prompts") && addBody.includes("desktop smoke fixture"),
      added.ok ? `rows=${added.state.rows} msg=${JSON.stringify(added.state.msg)}` : `error=${added.error ?? "?"}`,
    );
    const dup = await js<{ ok: boolean; error?: string }>(`window.__mcpAddSubmit(${JSON.stringify(JSON.stringify({ name: fixture, command: "echo" }))})`);
    check("mcp tab: a duplicate name is refused before the write", !dup.ok && /already exists in config.mcp.servers/.test(dup.error ?? ""), dup.error ?? "accepted");
    await js<void>("window.__mcpAct('addCancel')");
    const det = await js<McpState>(`window.__mcpAct(${JSON.stringify("detail:" + fixture)})`);
    const detBody = await js<string>("window.__settingsBody()");
    const res = await js<McpState>("window.__mcpAct('dtab:resources')");
    const resBody = await js<string>("window.__settingsBody()");
    check(
      "mcp tab: the detail shows the transport and says resources/prompts are not exposed",
      det.mode === "detail" && detBody.includes("stdio: echo hi") && detBody.includes("trust: approval_gated") && detBody.includes("[1:tools(0)]") && detBody.includes("2:resources(—)") && detBody.includes("3:prompts(—)") && detBody.includes("(empty)")
        && res.detailTab === "resources" && resBody.includes("[2:resources(—)]") && resBody.includes("not exposed by the agent's HTTP API"),
      `mode=${det.mode} tab=${res.detailTab}`,
    );
    const removed = await js<McpState>(`window.__mcpRemove(${JSON.stringify(fixture)})`);
    const afterDisk = ((await configGet()).config as { mcp?: { servers?: Array<{ name: string }> } } | undefined)?.mcp?.servers ?? [];
    check(
      "mcp tab: d remove rewrites mcp.servers without the server",
      !afterDisk.some((s) => s.name === fixture) && removed.rows === m0.rows && removed.mode === "list" && removed.removeConfirm === null && removed.msg.includes(`removed "${fixture}"`),
      `rows=${removed.rows} msg=${JSON.stringify(removed.msg)}${removed.lastError ? " err=" + removed.lastError : ""}`,
    );
  } finally {
    // The fixture must never outlive the smoke: put the list back exactly as it was (unset reads as [] — the schema default).
    await configSetPath("mcp.servers", Array.isArray(beforeServers) ? beforeServers : []);
    await js<void>("window.__mcpRefresh && window.__mcpRefresh()");
  }
  await js<void>("window.__settingsClose()");
}

/**
 * Item 7 part C: the LLM, Telegram and Import tabs. The LLM checks read
 * `atag models list` / `list-embeddings` / `status` and the user file
 * through the same wrappers the tab uses and assert that opening the tab
 * writes nothing; the fallback `l` toggle round trip restores the `llm`
 * block in `finally`; the Telegram token round trip (only with no token
 * anywhere) writes and removes TELEGRAM_BOT_TOKEN in the lane's .env and
 * restores telegram.enabled; the Import checks run `atag import` against
 * a directory that does not exist, so nothing can be imported.
 */
async function settingsTestPartC(
  js: <T>(code: string) => Promise<T>,
  check: (name: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> => {
    const deadline = Date.now() + ms;
    let v = await read();
    while (!ok(v) && Date.now() < deadline) { await wait(400); v = await read(); }
    return v;
  };
  type Provider = { id: string; kind: string; apiKey?: string; apiKeyEnvVar?: string; defaultChatModel?: string; model?: string };
  type Cfg = { llm?: { activeTextProvider?: string; activeEmbeddingProvider?: string; providers?: Provider[]; fallback?: { chain?: string[]; appendLocal?: boolean } }; localModels?: { url?: string; mode?: string; managed?: { modelId?: string } }; telegram?: { enabled?: boolean; ownerUserId?: number | null } };
  type LlmPane = {
    mode: string; rows: number; view: string; localRows: number; embRows: number; refreshed: number | null; localErr: string | null; statusErr: string | null;
    status: { mode: string; dataDir: string | null; activeModel: string | null; daemon: string; health: string | null } | null; daemonLabel: string; statusLine: string; msg: string; restart: boolean;
    keysKnown: boolean; modelsFor: string | null; models: number; modelsBusy: boolean; modelsErr: string | null; externalDraft: string | null; steerUrl: string | null;
    activeText: string; providers: Array<{ id: string; kind: string; hasKey: boolean; active: boolean }>;
    fallback: { links: Array<{ providerId: string; isActive: boolean; isAppendedLocal: boolean }>; addableProviderIds: string[]; appendLocal: boolean };
    section: { provider: string | null; status: string; models: number; filtered: number }; flatRows: string[];
  };
  const pane = () => js<LlmPane>("window.__llmPane()");
  const readCfg = async () => ((await configGet()).config ?? {}) as Cfg;

  // ---- LLM: Local pane, no config write on open ----
  const cfgBefore = JSON.stringify((await configGet()).config);
  await js<void>("window.__settingsOpen('llm')");
  const local = await until(pane, (p) => p.rows > 0 && p.refreshed !== null, 10_000);
  const localBody = await js<string>("window.__settingsBody()");
  const listCli = await modelsList();
  const embCli = await modelsListEmbeddings();
  const expectedLocal = (listCli.models ?? []).filter((m) => !/embed|bge|nomic|jina/i.test(m.id)).length + (embCli.models ?? []).length;
  check(
    "llm tab: Local pane rows come from atag models list + list-embeddings within 10 s",
    local.mode === "local" && local.rows > 0 && local.rows === expectedLocal && local.localRows + local.embRows === expectedLocal && !local.localErr,
    `${local.rows} rows painted, ${local.localRows}+${local.embRows} loaded, cli ${expectedLocal}${local.localErr ? " err=" + local.localErr : ""}`,
  );
  const localCopy = ["Active chat route", "current: ", "tools ", "provider embeddings: ", "local daemon: ", "Mode: Local | Cloud | External llama.cpp | Fallback", "Press ←/→ to switch mode",
    "Local text models", "Local embeddings", "j/k move", "Enter selected action", "a add from hugging face", "s start/stop", "r refresh", "[downloaded]", "[remote]", "Enter: download"];
  const localMissing = localCopy.filter((c) => !localBody.includes(c));
  check("llm tab: route card, mode strip and the Local pane carry the TUI copy", localMissing.length === 0, localMissing.length ? `missing ${JSON.stringify(localMissing)}` : `status line ${JSON.stringify(local.statusLine)}`);
  const cfgAfter = JSON.stringify((await configGet()).config);
  check("llm tab: opening the tab writes no config", cfgBefore === cfgAfter, cfgBefore === cfgAfter ? "" : "config.json changed");
  // The route card's daemon line and current model follow `atag models status` and the user file.
  const st = await modelsStatus();
  const cfg0 = await readCfg();
  const activeText = cfg0.llm?.activeTextProvider ?? "local-llama";
  const activeEntry = (cfg0.llm?.providers ?? []).find((p) => p.id === activeText);
  const localRoute = !activeEntry || activeEntry.kind === "llama-server";
  const expectedModel = localRoute ? (st.status?.activeModel ?? cfg0.localModels?.managed?.modelId ?? null) : (activeEntry?.defaultChatModel ?? activeEntry?.model ?? null);
  const expectedDaemon = st.ok && st.status ? (st.status.daemonRunning ? (String(st.status.health).toLowerCase() === "ok" ? "running pid " : "pid ") : "stopped") : null;
  const routeOk = !!expectedDaemon && local.daemonLabel.startsWith(expectedDaemon) && localBody.includes(`local daemon: ${local.daemonLabel} · mode ${cfg0.localModels?.mode ?? "external"}`)
    && localBody.includes(`current: ${activeText}${expectedModel ? " / " + expectedModel : ""}`) && localBody.includes(localRoute ? "tools grammar · cache local slot/cache_prompt" : "tools native_tools · cache cloud: no slot affinity");
  check("llm tab: route card follows the user file and atag models status", routeOk, `current ${activeText} / ${expectedModel ?? "—"} · daemon ${JSON.stringify(local.daemonLabel)} vs status ${st.ok ? st.status?.daemon : st.error}`);

  // ---- LLM: Cloud pane ----
  const cloud = await js<LlmPane>("window.__llmOpen('cloud')");
  const cloudBody = await js<string>("window.__settingsBody()");
  const cloudProviders = (cfg0.llm?.providers ?? []).filter((p) => p.kind !== "llama-server");
  const stateDir = (await js<{ data?: { paths?: { stateDir?: string } } }>("window.atomic.capabilities()")).data?.paths?.stateDir ?? "";
  const keyNames = (p: Provider): string[] => p.apiKeyEnvVar ? [p.apiKeyEnvVar] : p.kind === "openrouter" ? ["OPENROUTER_API_KEY"] : p.kind === "aimlapi" ? ["AIMLAPI_API_KEY"] : p.kind === "gemini" ? ["GEMINI_API_KEY"]
    : p.kind === "openai-compatible" || p.kind === "qwen-openai-compatible" ? ["OPENAI_COMPAT_API_KEY", "OPENAI_API_KEY", "ATOMIC_AGENT_OPENAI_API_KEY"] : [];
  const dotenv = stateDir ? dotenvKeys(stateDir).keys : [];
  const expectKey = (p: Provider) => p.kind === "subscription-cli" || !!(p.apiKey && p.apiKey.length) || keyNames(p).some((n) => envPresent([n]).length > 0 || dotenv.includes(n));
  const providersOk = cloud.providers.length === cloudProviders.length && cloudProviders.every((p) => {
    const row = cloud.providers.find((r) => r.id === p.id);
    const auth = p.kind === "subscription-cli" ? "cli auth" : expectKey(p) ? "key ok" : "missing key";
    return !!row && row.hasKey === expectKey(p) && cloudBody.includes(`${p.id} [${p.kind}] ${auth}`) && cloudBody.includes(p.id === activeText ? `Current provider: ${p.id}` : expectKey(p) ? `Enter: switch cloud route to ${p.id}` : `Enter: configure API key for ${p.id}`);
  });
  const cloudCopy = ["Cloud providers", "Cloud text models", "provider: ", "filter: ", "price: all", "p cycles free/paid/all", "Cloud embeddings", "n add provider", "c configure", "f filter"];
  const cloudMissing = cloudCopy.filter((c) => !cloudBody.includes(c));
  check(
    "llm tab: Cloud providers rows carry the key status from the env ∪ .env names",
    cloud.mode === "cloud" && providersOk && cloudMissing.length === 0 && (cloudProviders.length > 0 || cloudBody.includes("No cloud providers configured. Press n to add one.")),
    `${cloud.providers.map((p) => `${p.id}:${p.hasKey ? "key ok" : "missing key"}`).join(", ") || "no cloud providers"}${cloudMissing.length ? " missing " + JSON.stringify(cloudMissing) : ""}`,
  );
  const models = await until(pane, (p) => p.section.status !== "loading", 90_000);
  const modelsBody = await js<string>("window.__settingsBody()");
  const paintedModels = await js<number>("document.querySelectorAll('#settings [data-llm-row^=\"cloud-text:\"]').length");
  const counter = models.section.filtered === 0 ? "no match" : `1/${models.section.filtered}`;
  check(
    "llm tab: Cloud text models is the provider's atag models search list windowed to 12 rows",
    models.section.status === "ready" && paintedModels === Math.min(12, models.section.filtered) && modelsBody.includes(`↑/↓ move (${counter}`) && (cloudProviders.length === 0 || models.section.models > 0),
    `provider ${models.section.provider ?? "none"}: ${models.section.models} models, ${paintedModels} painted, status ${models.section.status}${models.modelsErr ? " err=" + models.modelsErr : ""}`,
  );

  // ---- LLM: External pane + the probe ----
  const ext = await js<LlmPane>("window.__llmOpen('external')");
  const extBody = await js<string>("window.__settingsBody()");
  const extUrl = cfg0.localModels?.url ?? "http://127.0.0.1:8080";
  const extActive = cfg0.localModels?.mode === "external" && activeText === "local-llama";
  check(
    "llm tab: External pane is the one base-URL row with the two hint lines",
    ext.rows === 1 && extBody.includes(`base URL ${extUrl} [`) && (extActive || extBody.includes("[not active]")) && extBody.includes("managed daemon: ") && extBody.includes("s start/stop")
      && extBody.includes("← Local pane: pick a managed model to switch back") && extBody.includes(extActive ? "Enter: edit the base URL" : "Enter: point the chat route at an external llama.cpp"),
    `${ext.rows} row(s), active=${extActive}`,
  );
  const cfgBeforeProbe = JSON.stringify((await configGet()).config);
  const probed = await js<LlmPane>("window.__llmExternalSave('127.0.0.1:1')");
  const cfgAfterProbe = JSON.stringify((await configGet()).config);
  check(
    "llm tab: an unreachable External URL is refused after the /health probe and writes nothing",
    probed.statusLine.startsWith("local-llm /health failed at http://127.0.0.1:1: ") && probed.externalDraft === null && cfgBeforeProbe === cfgAfterProbe,
    `${JSON.stringify(probed.statusLine)}${cfgBeforeProbe === cfgAfterProbe ? "" : " (config changed!)"}`,
  );
  // Review fix (item 5): a passing probe saves through ONE whole-file write
  // that moves localModels.mode/url AND llm.providers[local-llama].url
  // together — the two leaf writes it replaces left the provider url (and so
  // the runtime's actual endpoint) pointing at the old address. The probe
  // itself needs a live llama-server, so the write helper is driven directly
  // here and the renderer source is checked for the call it now makes.
  {
    const cfgBeforeExt = (await configGet()).config as Cfg | undefined;
    const rendererSrcExt = readFileSync(join(__dirname, "..", "renderer", "renderer.js"), "utf8");
    const callsHelper = /BR\.setExternalLlamaUrl\(/.test(rendererSrcExt) && !/configSet\(\s*['"]localModels\.(url|mode)['"]/.test(rendererSrcExt);
    if (!cfgBeforeExt) {
      check("llm tab: an External save moves mode, url and the provider url in one write", false, "could not read the config to restore it");
    } else {
      const savedExt = JSON.parse(JSON.stringify(cfgBeforeExt)) as Cfg;
      try {
        const probeUrl = "http://127.0.0.1:19199";
        const wrote = await setExternalLlamaUrl(probeUrl);
        const after = await readCfg();
        const entry = after.llm?.providers?.find((p) => p.id === "local-llama") as { url?: string } | undefined;
        const hadBlock = !!cfgBeforeExt.llm?.providers?.some((p) => p.id === "local-llama");
        check(
          "llm tab: an External save moves mode, url and the provider url in one write",
          wrote.ok && after.localModels?.mode === "external" && after.localModels?.url === probeUrl && (hadBlock ? entry?.url === probeUrl : !entry) && callsHelper,
          `mode=${String(after.localModels?.mode)} url=${String(after.localModels?.url)} provider=${hadBlock ? String(entry?.url) : "no local-llama entry in the file"} renderer=${callsHelper ? "BR.setExternalLlamaUrl" : "still leaf writes"}`,
        );
      } finally {
        await configSetWhole(savedExt);
      }
    }
  }

  // ---- LLM: Fallback pane (the resolver's effective chain) + the `l` round trip ----
  const fb = await js<LlmPane>("window.__llmOpen('fallback')");
  const fbBody = await js<string>("window.__settingsBody()");
  const llmBlock = cfg0.llm ?? { activeTextProvider: "local-llama", providers: [{ id: "local-llama", kind: "llama-server" }] };
  const providers = llmBlock.providers ?? [];
  const configured = new Set(providers.map((p) => p.id));
  const appendLocal = llmBlock.fallback?.appendLocal ?? true;
  const requested = llmBlock.fallback?.chain?.length ? llmBlock.fallback.chain : [activeText];
  const filtered = requested.filter((id) => configured.has(id));
  const withPrimary = filtered[0] === activeText ? filtered : [activeText, ...filtered.filter((id) => id !== activeText)];
  const localId = providers.find((p) => p.kind === "llama-server")?.id;
  const chain = [...withPrimary];
  if (appendLocal && localId && !chain.includes(localId)) chain.push(localId);
  const expectedChain = chain.filter((id, i) => configured.has(id) && chain.indexOf(id) === i);
  const fbLinks = fb.fallback.links.map((l) => l.providerId);
  check(
    "llm tab: Fallback pane shows the resolver's effective chain and the honest status line",
    same(fbLinks, expectedChain) && fb.fallback.links[0]?.isActive === true && fbBody.includes("status: fallover events are not exposed by the agent's HTTP API") && fbBody.includes("Fallback chain")
      && fbBody.includes(`1. ${expectedChain[0]}`) && fbBody.includes("active (primary)") && fbBody.includes(`append local as last resort: ${appendLocal ? "on" : "off"}`) && fbBody.includes("l to toggle") && fbBody.includes("< > reorder"),
    `${JSON.stringify(fbLinks)} vs ${JSON.stringify(expectedChain)} appendLocal=${appendLocal}`,
  );
  const llmBefore = cfg0.llm;
  if (llmBefore) {
    try {
      await js<void>("window.__llmAct('fb:local')");
      const toggled = await until(pane, (p) => p.fallback.appendLocal === !appendLocal && !!p.msg, 10_000);
      const onDisk = (await readCfg()).llm?.fallback?.appendLocal;
      check(
        "llm tab: l toggle writes llm.fallback.appendLocal through the whole-file config set and says restart",
        toggled.fallback.appendLocal === !appendLocal && onDisk === !appendLocal && toggled.restart && toggled.msg.includes("llm.fallback saved"),
        `pane=${toggled.fallback.appendLocal} disk=${String(onDisk)} msg=${JSON.stringify(toggled.msg)}`,
      );
    } finally {
      await configSetPath("llm", llmBefore);
      await js<void>("window.__llmRefresh()");
    }
  } else {
    check("llm tab: l toggle writes llm.fallback.appendLocal through the whole-file config set and says restart", false, "no llm block in the user file — the round trip needs one to restore");
  }

  // ---- Telegram ----
  await js<void>("window.__settingsOpen('telegram')");
  type TgState = { hasToken: boolean | null; enabled: boolean | null; owner: unknown; mode: string; message: string; restart: boolean; lastError: string | null; keysKnown: boolean; dotenvKeys: string[] };
  const tg = await until(() => js<TgState>("window.__telegram()"), (t) => t.keysKnown, 10_000);
  const tgBody = await js<string>("window.__settingsBody()");
  const tgLabel = await js<string>("(() => { const b = document.querySelector('#settings .settab.on'); return b ? b.textContent.trim() : ''; })()");
  const envHas = envPresent(["TELEGRAM_BOT_TOKEN"]).length > 0;
  const dotenvHas = stateDir ? dotenvKeys(stateDir).keys.includes("TELEGRAM_BOT_TOKEN") : false;
  if (!envHas && !dotenvHas) {
    check(
      "telegram tab: no token anywhere → the Connect Telegram card, plain tab label",
      tg.hasToken === false && tgBody.includes("Connect Telegram") && tgBody.includes("Create a bot with @BotFather, copy the token, and paste it here. The token is stored only on this machine.")
        && tgBody.includes("Press Enter to paste a bot token") && tgBody.includes("a — advanced") && tgLabel === "Telegram",
      `hasToken=${String(tg.hasToken)} label=${JSON.stringify(tgLabel)}`,
    );
  } else {
    check(
      "telegram tab: a token is present → the facts, channel state honestly unknown, plain tab label",
      tg.hasToken === true && tgBody.includes("token set") && tgBody.includes("state unknown") && tgBody.includes("Pairing needs the live channel") === (tg.owner === null) && tgLabel === "Telegram",
      `hasToken=${String(tg.hasToken)} owner=${String(tg.owner)} label=${JSON.stringify(tgLabel)}`,
    );
  }
  // Token round trip through the dotenv-writer port — only when no token exists anywhere, so a real one is never touched.
  if (!envHas && !dotenvHas && stateDir) {
    const envPath = join(stateDir, ".env");
    const keysBefore = dotenvKeys(stateDir).keys;
    const enabledBefore = cfg0.telegram?.enabled;
    try {
      const token = "desktop smoke:token #1"; // whitespace + `#` → the writer must quote it for the loader
      const saved = await js<{ ok: boolean; error?: string; state: TgState }>(`window.__telegramTokenSave(${JSON.stringify(token)})`);
      let envText = "";
      let mode = -1;
      try { envText = readFileSync(envPath, "utf8"); mode = statSync(envPath).mode & 0o777; } catch { /* missing */ }
      const afterBody = await js<string>("window.__settingsBody()");
      const enabledNow = (await readCfg()).telegram?.enabled;
      check(
        "telegram tab: the token lands in .env quoted, 0600, other keys kept, and the connect chain enables telegram",
        saved.ok && envText.includes(`TELEGRAM_BOT_TOKEN="${token}"`) && mode === 0o600 && keysBefore.every((k) => envText.includes(`${k}=`)) && saved.state.hasToken === true
          && enabledNow === true && afterBody.includes("One last step — confirm it's you") && afterBody.includes("Pairing needs the live channel — open the Telegram tab in `atag tui` to pair") && afterBody.includes("Restart Agent Runtime"),
        `${saved.ok ? "saved" : "error=" + (saved.error ?? "?")} mode=${mode.toString(8)} keys=${JSON.stringify(dotenvKeys(stateDir).keys)} enabled=${String(enabledNow)}`,
      );
      const cleared = await js<TgState>("window.__telegramClearToken()");
      let envAfter = "";
      try { envAfter = readFileSync(envPath, "utf8"); } catch { /* unlinked when empty */ }
      check(
        "telegram tab: T clear token removes the key and keeps the rest of .env",
        cleared.hasToken === false && !envAfter.includes("TELEGRAM_BOT_TOKEN") && keysBefore.every((k) => envAfter.includes(`${k}=`)) && cleared.message === "token cleared",
        `keys=${JSON.stringify(dotenvKeys(stateDir).keys)} msg=${JSON.stringify(cleared.message)}`,
      );
    } finally {
      dotenvSet(stateDir, "TELEGRAM_BOT_TOKEN", null);
      if (typeof enabledBefore === "boolean") await configSet("telegram.enabled", String(enabledBefore));
      else await configUnset("telegram.enabled");
      await js<void>("window.__telegramRefresh()");
    }
  }

  // ---- Import ----
  await js<void>("window.__settingsOpen('import')");
  type ImpState = { mode: string; form: { source: string; sourceDir: string; sessions: boolean; cron: boolean; secrets: boolean; overwrite: boolean; limit: string; focus: string }; runs: number; notice: string | null; state: string | null;
    report: { items: number; summary: { migrated: number; skipped: number; conflict: number; error: number }; first: { kind: string; status: string; reason: string | null } | null } | null; painted: number };
  const imp = await until(() => js<ImpState>("window.__import()"), (i) => !!i.form.sourceDir, 5_000);
  const impBody = await js<string>("window.__settingsBody()");
  const labels = ["source-of", "source", "sessions", "cron", "secrets", "overwrite", "limit"];
  const labelsOk = labels.every((l) => impBody.includes(`${l.padEnd(10)}: `));
  check(
    "import tab: the TUI form with its defaults, and no CLI run until Run preview",
    imp.runs === 0 && impBody.includes("Import · Hermes → atomic-agent") && labelsOk && impBody.includes("Run preview") && impBody.includes("↑↓ move · ←/→ switch source · space toggle · type to edit · Enter on Run = preview · Ctrl+Enter preview")
      && impBody.includes("OPENROUTER_API_KEY / AIMLAPI_API_KEY") && impBody.includes("replace differing destinations") && imp.form.source === "hermes" && imp.form.sessions && imp.form.cron && !imp.form.secrets && !imp.form.overwrite && imp.form.sourceDir.endsWith("/.hermes") && imp.mode === "configure",
    `runs=${imp.runs} dir=${imp.form.sourceDir}`,
  );
  const dir = "/nonexistent-desktop-smoke-dir";
  await js<void>(`window.__importAct(${JSON.stringify("field:sourceDir:" + dir)})`);
  const prev = await js<{ ok: boolean; state?: string; error?: string; state2: ImpState }>("window.__importRun(false)");
  const prevBody = await js<string>("window.__settingsBody()");
  check(
    "import tab: Run preview runs atag import --dry-run and parses the report into the TUI rows",
    prev.ok && prev.state === "preview" && prev.state2.mode === "preview" && prev.state2.runs === 1 && prev.state2.report?.items === 2 && prev.state2.report.summary.skipped === 2 && prev.state2.painted === 2
      && prevBody.includes("preview (dry-run) · 2 items") && prevBody.includes("skipped  [sessions]") && prevBody.includes(`(no state.db at ${dir}/state.db)`) && prevBody.includes("migrated=0 · skipped=2 · conflict=0 · error=0")
      && prevBody.includes("y / Enter apply") && prevBody.includes("e edit") && prevBody.includes("Esc cancel"),
    prev.ok ? `state=${prev.state} items=${prev.state2.report?.items} runs=${prev.state2.runs}` : `error=${prev.error ?? "?"}`,
  );
  const applied = await js<{ ok: boolean; state?: string; error?: string; state2: ImpState }>("window.__importRun(true)");
  const appliedBody = await js<string>("window.__settingsBody()");
  check(
    "import tab: apply passes --yes and reports the CLI's own Nothing to import",
    applied.ok && applied.state === "nothing" && applied.state2.mode === "done" && applied.state2.runs === 2 && appliedBody.includes("result · 2 items") && appliedBody.includes("Nothing to import.") && appliedBody.includes("Enter / Esc back to form"),
    applied.ok ? `state=${applied.state} mode=${applied.state2.mode}` : `error=${applied.error ?? "?"}`,
  );
  await js<void>("window.__importAct('reset'); window.__settingsClose()");
}

async function modelsTest(
  js: <T>(code: string) => Promise<T>,
  check: (name: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const cfg = async () => (await configGet()).config as {
    llm?: { activeTextProvider?: string; providers?: Array<{ id: string; defaultChatModel?: string }> };
  };
  // This test writes config for real — it adds a provider and picks a model.
  // Capture the whole file first and put it back in `finally`, the way every
  // other config-writing check in this suite does, so a `--models` run leaves
  // the operator's providers and chat model exactly as it found them.
  const configBefore = (await configGet()).config;
  try {
    // Local catalogue
    await js<void>("window.__pane('models','local')");
    await wait(6000);
    const localCount = await js<number>("window.__mp().local");
    check("local catalogue loaded", localCount > 0, `${localCount} models`);
    const hasDownload = await js<boolean>(
      "!!document.querySelector('[data-pull-local]')",
    );
    check("local models offer a download", hasDownload);

    // Add a provider
    const before = await cfg();
    const had = (before.llm?.providers ?? []).some((p) => p.id === "groq");
    await js<void>("window.__pane('models','cloud')");
    await js<void>("window.__addProvider('groq')");
    await wait(4000);
    const after = await cfg();
    const added = (after.llm?.providers ?? []).find((p) => p.id === "groq");
    check("provider added to config", !!added, had ? "(already present before)" : "groq written");

    // List that provider's models and select one
    const withKey = (after.llm?.providers ?? []).find((p) => p.id === "aimlapi") ? "aimlapi" : "groq";
    await js<void>(`window.__pickModels(${JSON.stringify(withKey)}, "claude")`);
    await wait(12_000);
    const found = await js<number>("window.__mp().picks");
    check("provider models listed", found > 0, `${found} models from ${withKey}`);

    if (found > 0) {
      const chosen = await js<string>("window.__mp().firstPick");
      await js<void>("window.__selectFirstModel()");
      await wait(5000);
      const now = await cfg();
      const entry = (now.llm?.providers ?? []).find((p) => p.id === withKey);
      check(
        "model written to the provider",
        entry?.defaultChatModel === chosen,
        `${entry?.defaultChatModel ?? "none"} === ${chosen}`,
      );
    }

  } finally {
    if (configBefore) {
      const restored = await configSetWhole(configBefore);
      const now = await cfg();
      check(
        "models: the run put the config back",
        restored.ok && JSON.stringify(now) === JSON.stringify(configBefore),
        restored.ok ? "config restored" : `restore failed: ${restored.error ?? "?"}`,
      );
    }
  }
}

/** Lane B — backend switch. */
async function backendSwitchTest(
  js: <T>(code: string) => Promise<T>,
  check: (name: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> => {
    const deadline = Date.now() + ms;
    let v = await read();
    while (!ok(v) && Date.now() < deadline) { await wait(400); v = await read(); }
    return v;
  };
  const cfgNow = async () => (await configGet()).config as UserConfigShape | undefined;
  const waitConnected = async () => {
    const deadline = Date.now() + 60_000;
    let st = "";
    while (Date.now() < deadline) {
      st = (await js<string>("window.__live && window.__live()")) ?? "";
      if (st === "connected") break;
      await wait(500);
    }
    await js<void>("window.__ctxRefreshCfg && window.__ctxRefreshCfg()");
    await wait(1500);
    return st;
  };
  const localEntry = (c: UserConfigShape | undefined) =>
    (c?.llm?.providers ?? []).find((p) => p.id === "local-llama");

  const beforeConfig = await cfgNow();
  const daemonWasRunning = await localDaemonRunning();
  const portBefore = agent?.status.port ?? null;
  try {
    // No dotted llm.* writes may remain in the renderer, and the guard must
    // answer before the CLI's "unknown key" ever could.
    const rendererSrc = readFileSync(join(__dirname, "..", "renderer", "renderer.js"), "utf8");
    const dotted = rendererSrc.match(/configSet\(\s*['"]llm\./g) ?? [];
    const guard = await configSet("llm.activeTextProvider", "x");
    check(
      "backend: no llm.* dotted writes remain",
      dotted.length === 0 && guard.ok === false && /no dotted spelling/.test(guard.error ?? ""),
      `${dotted.length} in renderer; guard: ${guard.error ?? "accepted"}`,
    );

    const snapshot = JSON.stringify(await cfgNow());
    const bad = await setActiveTextProvider("nope");
    check(
      "backend: unknown id refused without writing",
      bad.ok === false && bad.error === 'provider "nope" is not configured' && JSON.stringify(await cfgNow()) === snapshot,
      bad.error ?? "accepted",
    );

    // To local, through the same function the backend row's click runs —
    // from the route the file is actually on (cloud, on the lane's state
    // dir), so the write the user's click makes is the one asserted below.
    const wasCloud = (beforeConfig?.llm?.providers ?? []).find((p) => p.id === beforeConfig?.llm?.activeTextProvider)?.kind !== "llama-server";
    const toLocal = await js<SwitchResult>("window.__switchBackend('local')");
    // Read once before the harness refreshes anything: this is what the
    // renderer's own post-IPC refreshLiveConfig() produced.
    const rawLocal = await js<{ backend: string; mode: string }>(
      "({backend: window.__sel().backend, mode: document.querySelector('.modechip')?.textContent ?? ''})",
    );
    const stLocal = await waitConnected();
    const afterLocal = await cfgNow();
    const port = afterLocal?.localModels?.managed?.port ?? 19091;
    check(
      "backend: config round-trip to local",
      !!toLocal?.ok
        && wasCloud
        // The route moved in the file, so the switch itself says restart.
        && toLocal.restart === true
        && afterLocal?.llm?.activeTextProvider === "local-llama"
        && afterLocal?.localModels?.mode === "managed"
        && localEntry(afterLocal)?.url === `http://127.0.0.1:${port}`
        && afterLocal?.llm?.activeEmbeddingProvider === beforeConfig?.llm?.activeEmbeddingProvider
        && (afterLocal?.llm?.providers ?? []).length === (beforeConfig?.llm?.providers ?? []).length,
      toLocal?.ok
        ? `from=${beforeConfig?.llm?.activeTextProvider} active=${afterLocal?.llm?.activeTextProvider} mode=${afterLocal?.localModels?.mode} url=${localEntry(afterLocal)?.url} daemon=${toLocal.daemon} restart=${toLocal.restart}`
        : `error=${toLocal?.error}`,
    );
    const managedId = afterLocal?.localModels?.managed?.modelId ?? null;
    // The chip's precedence is the TUI's: `download model` whenever nothing
    // is on disk (selectComposerNeedsModelDownload ignores managed.modelId),
    // else the managed id.
    // The chip's own list: `models list` minus the CLI's embedding catalogue.
    const onDisk = ((await chatModelsList()).models ?? []).some((m) => m.downloaded);
    const localChips = await js<{ backend: string; mode: string; model: string }>(
      "({backend: window.__sel().backend, mode: document.querySelector('.modechip')?.textContent ?? '', model: document.querySelector('.modelchip')?.textContent ?? ''})",
    );
    check(
      "backend: renderer follows the file",
      rawLocal.backend === "local" && /local/.test(rawLocal.mode)
        && localChips.backend === "local" && /local/.test(localChips.mode)
        && (managedId && onDisk ? localChips.model.includes(managedId) : /download model/.test(localChips.model)),
      `own refresh: backend=${rawLocal.backend} chip=${JSON.stringify(rawLocal.mode)}; after harness refresh: backend=${localChips.backend} chip=${JSON.stringify(localChips.mode)} model=${JSON.stringify(localChips.model)} managed=${managedId} onDisk=${onDisk}`,
    );
    // Review fix: `custom` is a state the composer can be IN — the same
    // local-llama provider entry with localModels.mode external. It used to
    // read as `local`, which drew the managed row active and described a route
    // the operator was not on. Driven from the file (the pane has no editor
    // here; the External pane is the editor and the row deep-links to it).
    type BackRows = { backend: string; chip: string; modelChip: boolean; rows: Array<{ id: string; label: string; detail: string; active: boolean }> };
    const managedRows = await js<BackRows>("window.__backendRows()");
    const cfgForCustom = await cfgNow();
    if (cfgForCustom) {
      const restoreCustom = JSON.parse(JSON.stringify(cfgForCustom)) as UserConfigShape;
      try {
        await setExternalLlamaUrl("http://127.0.0.1:19199");
        await js<void>("window.__ctxRefreshCfg()");
        const customRows = await until(() => js<BackRows>("window.__backendRows()"), (r) => r.backend === "custom", 8000);
        const custom = customRows.rows.find((r) => r.id === "custom");
        const localRow = customRows.rows.find((r) => r.id === "local");
        check(
          "backend: an external route reads as custom, not as the managed local one",
          managedRows.backend === "local" && managedRows.rows.length === 3
            && customRows.backend === "custom" && /custom/.test(customRows.chip) && !customRows.modelChip
            && !!custom && custom.active && custom.detail.includes("http://127.0.0.1:19199") && custom.detail.includes("Settings › LLM › External")
            && !!localRow && !localRow.active,
          `managed: backend=${managedRows.backend} chip=${JSON.stringify(managedRows.chip)}; external: backend=${customRows.backend} chip=${JSON.stringify(customRows.chip)} custom.active=${custom?.active} local.active=${localRow?.active} detail=${JSON.stringify(custom?.detail)}`,
        );
        // Activating it writes nothing: it opens the pane that can probe a URL.
        const cfgBeforeRow = JSON.stringify(await cfgNow());
        const opened = await js<{ settings: boolean; pane: string; llmMode: string; selOpen: boolean }>("window.__backendActivate('custom')");
        check(
          "backend: the custom row opens the External pane and writes nothing",
          opened.settings && opened.pane === "llm" && opened.llmMode === "external" && !opened.selOpen && JSON.stringify(await cfgNow()) === cfgBeforeRow,
          `${JSON.stringify(opened)}${JSON.stringify(await cfgNow()) === cfgBeforeRow ? "" : " (config changed!)"}`,
        );
        await js<void>("window.__settingsClose()");
      } finally {
        await configSetWhole(restoreCustom);
        await js<void>("window.__ctxRefreshCfg()");
      }
    }
    // The chat route's model list is the catalogue minus the CLI's own
    // embedding catalogue — a fact, not a guess at the ids' names.
    const embCatalog = await modelsListEmbeddings();
    const chatOnly = await chatModelsList();
    const fullList = await modelsList();
    const embIds = new Set((embCatalog.models ?? []).map((m) => m.id));
    const expectedChat = (fullList.models ?? []).filter((m) => !embIds.has(m.id)).map((m) => m.id);
    check(
      "backend: the local switch subtracts the CLI's embedding catalogue, not a name guess",
      chatOnly.ok === true && chatOnly.byCatalog === true && embCatalog.ok === true
        && same((chatOnly.models ?? []).map((m) => m.id), expectedChat),
      `${(fullList.models ?? []).length} catalogue rows − ${embIds.size} embedding rows = ${(chatOnly.models ?? []).length} chat rows (byCatalog=${String(chatOnly.byCatalog)})`,
    );

    // The catalogue and key facts land seconds after the switch; their
    // repaint must not rebuild the composer under a typing user.
    const caret = await js<{ same: boolean; focused: boolean; start: number; end: number } | null>("window.__bswRepaintKeepsCaret()");
    check(
      "backend: late facts repaint keeps the caret",
      !!caret && caret.same && caret.focused && caret.start === 6 && caret.end === 6,
      caret ? `same textarea=${caret.same} focused=${caret.focused} caret=${caret.start}..${caret.end}` : "no composer",
    );
    check(
      "backend: agent restarted and alive",
      stLocal === "connected" && agent?.status.port !== portBefore,
      `state=${stLocal} port ${portBefore} → ${agent?.status.port}`,
    );
    const daemonUp = await localDaemonRunning();
    check(
      "backend: daemon side effect mirrors the TUI (local)",
      toLocal?.needsModel
        ? toLocal.daemon === "untouched"
        : (daemonUp && ["started", "restarted", "untouched"].includes(toLocal?.daemon ?? ""))
          || (toLocal?.daemon === "start-failed" && !!toLocal.error),
      `daemon=${toLocal?.daemon} running=${daemonUp}${toLocal?.error ? " error=" + toLocal.error : ""}`,
    );

    // The pre-turn gate: with no managed model selected the turn is refused
    // with the TUI's exact text, no turn is opened, and the message goes
    // back to the editor (the TUI's turn_gate_blocked + input_changed).
    if (afterLocal && afterLocal.localModels?.managed) {
      const noModel = JSON.parse(JSON.stringify(afterLocal)) as UserConfigShape;
      noModel.localModels!.managed!.modelId = null;
      const cardsBefore = await js<number>("window.__cards().length");
      const usersBefore = (await js<{ users: number }>("window.__draft()")).users;
      await configSetWhole(noModel);
      await js<void>("window.__ctxRefreshCfg()");
      await wait(1000);
      await js<void>("window.__ask('hi')");
      await wait(1500);
      const gate = await js<{ last: string; busy: boolean; cards: number; draft: string; entry: string | null; users: number }>(
        "({last: window.__lastSystem(), busy: window.__bsw().turnBusy, cards: window.__cards().length, ...window.__draft()})",
      );
      const blockLine = "no local model is selected — open Models (/local) to pick and download one (message returned to the editor)";
      check(
        "backend: local turn gate blocks with the TUI's text",
        gate.last === blockLine && !gate.busy && gate.cards === cardsBefore
          && gate.draft === "hi" && gate.entry === "hi" && gate.users === usersBefore,
        `last=${JSON.stringify(gate.last)} busy=${gate.busy} draft=${JSON.stringify(gate.draft)} entry=${JSON.stringify(gate.entry)} user lines ${usersBefore} → ${gate.users}`,
      );
      await js<void>("window.__ctxDraft('')");
      await configSetWhole(afterLocal);
      await js<void>("window.__ctxRefreshCfg()");
    }

    // Back to cloud: the TUI picks the active cloud provider, else the first
    // with a key, else the first configured.
    const cloud = (afterLocal?.llm?.providers ?? []).filter((p) => p.kind !== "llama-server");
    const expected = (cloud.find((p) => p.id === afterLocal?.llm?.activeTextProvider) ?? cloud.find((p) => providerHasKey(p)) ?? cloud[0])?.id;
    const toCloud = await js<SwitchResult>("window.__switchBackend('cloud')");
    const rawCloud = await js<{ backend: string; provider: string }>(
      "({backend: window.__sel().backend, provider: window.__activeProvider()})",
    );
    const stCloud = await waitConnected();
    const afterCloud = await cfgNow();
    const cloudChips = await js<{ backend: string; mode: string; provider: string }>(
      "({backend: window.__sel().backend, mode: document.querySelector('.modechip')?.textContent ?? '', provider: window.__activeProvider()})",
    );
    const activeEntry = (afterCloud?.llm?.providers ?? []).find((p) => p.id === afterCloud?.llm?.activeTextProvider);
    check(
      "backend: config round-trip back to cloud",
      !!toCloud?.ok && !!expected && toCloud.providerId === expected
        && afterCloud?.llm?.activeTextProvider === expected
        && !!activeEntry && activeEntry.kind !== "llama-server"
        && stCloud === "connected" && cloudChips.backend === "cloud" && /cloud/.test(cloudChips.mode) && cloudChips.provider === expected
        && rawCloud.backend === "cloud" && rawCloud.provider === expected,
      toCloud?.ok
        ? `provider=${toCloud.providerId} expected=${expected} own refresh: ${rawCloud.backend}/${rawCloud.provider} chip=${JSON.stringify(cloudChips.mode)} state=${stCloud}`
        : `error=${toCloud?.error} needsProvider=${toCloud?.needsProvider} needsKey=${toCloud?.needsKey}`,
    );
    const daemonAfterCloud = await localDaemonRunning();
    check(
      "backend: daemon side effect mirrors the TUI (cloud)",
      !daemonAfterCloud || toCloud?.daemon === "stop-failed",
      `daemon=${toCloud?.daemon} running=${daemonAfterCloud}`,
    );
    // Write 2 of activateProvider: a successful stop is followed by
    // memory.embeddings.enabled=false (the TUI's stopDaemon order).
    check(
      "backend: hybrid recall off after the daemon stop",
      toCloud?.daemon !== "stopped" || afterCloud?.memory?.embeddings?.enabled === false,
      `daemon=${toCloud?.daemon} memory.embeddings.enabled=${afterCloud?.memory?.embeddings?.enabled}`,
    );
    // The TUI's runtime_info lines, verbatim, in the transcript.
    const lines = (await js<string[]>("window.__systemLines()")) ?? [];
    const switchLine = `Switched active text provider to "${expected}". New messages use native_tools.`;
    const stopLine = "local-llm: daemons stopped — hybrid recall off (embedding switch unchanged)";
    check(
      "backend: TUI runtime_info copy in the transcript",
      lines.includes(switchLine) && (toCloud?.daemon !== "stopped" || lines.includes(stopLine)),
      `switch=${lines.includes(switchLine)} stop=${lines.includes(stopLine)} daemon=${toCloud?.daemon}`,
    );

    // Third leg: the file moves first, without a restart — what the TUI or
    // a hand edit does while this window is open. serve stays on the cloud
    // route it booted on; the switch finds nothing to write for the route
    // and must still restart it (main compares the boot route to the file).
    const portCloud = agent?.status.port ?? null;
    const preMoved = await setActiveTextProvider("local-llama");
    const behind = await js<SwitchResult>("window.__switchBackend('local')");
    const stBehind = await waitConnected();
    const afterBehind = await cfgNow();
    check(
      "backend: serve behind the file still restarts",
      preMoved.ok && preMoved.changed && !!behind?.ok && behind.restart === true
        && afterBehind?.llm?.activeTextProvider === "local-llama"
        && stBehind === "connected" && agent?.status.port !== portCloud,
      `file moved first: ${preMoved.changed}; switch ok=${behind?.ok} restart=${behind?.restart} error=${behind?.error ?? ""}; state=${stBehind} port ${portCloud} → ${agent?.status.port}`,
    );
  } finally {
    if (beforeConfig) await configSetWhole(beforeConfig);
    if (daemonWasRunning !== (await localDaemonRunning())) {
      if (daemonWasRunning) await modelsStart();
      else await modelsStop();
    }
    if (agent) {
      await agent.stop();
      await agent.start();
    }
    await waitConnected();
  }
}

void app.whenReady().then(async () => {
  const workspace = process.env.ATOMIC_AGENT_WORKSPACE ?? homedir();
  agent = new AgentClient(workspace);
  win = createWindow();
  buildMenu((command) => send("app:menu", command));
  wireIpc(agent);

  win.webContents.once("did-finish-load", () => {
    send("agent:status", agent?.status);
    if (FORCE_ONBOARDING) send("app:menu", "onboarding");
    void agent?.start();
    if (SMOKE) void smokeTest();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Never leave the agent running after the app is gone.
app.on("before-quit", (event) => {
  if (!agent) return;
  event.preventDefault();
  const client = agent;
  agent = null;
  void client.stop().finally(() => app.quit());
});
