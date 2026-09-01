import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

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
} from "./agent-cli.js";

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

function send(channel: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
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
  ipcMain.handle("app:hostRam", () => hostRamGb());
  ipcMain.handle("app:keyEnv", () => PROVIDER_KEY_ENV);

  ipcMain.handle("app:openExternal", (_event, url: unknown) => {
    if (typeof url === "string" && /^https?:\/\//.test(url)) void shell.openExternal(url);
  });

  client.on("status", (status) => send("agent:status", status));
  client.on("chat", (event) => send("agent:chat", event));
  client.on("approval", (event) => send("agent:approval", event));
  client.on("log", (event) => send("agent:log", event));
}

async function smokeTest(): Promise<void> {
  if (!win) return;
  const js = <T,>(code: string) => win!.webContents.executeJavaScript(code) as Promise<T>;
  const fail: string[] = [];
  const check = (name: string, ok: boolean, detail = "") => {
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}\n`);
    if (!ok) fail.push(name);
  };

  await new Promise((r) => setTimeout(r, 1500));
  check("renderer painted", (await js<number>("document.querySelectorAll('.navrow').length")) === 3);
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

  if (FORCE_ONBOARDING) {
    const title = await js<string>(
      "document.querySelector('#onboarding .ob-title')?.textContent ?? ''",
    );
    const options = await js<number>("document.querySelectorAll('#onboarding .ob-opt').length");
    check("wizard opens", title.length > 0 && options === 3, `${JSON.stringify(title)} options=${options}`);
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

    await js<void>("window.__selOpen('backend')");
    const back = await js<{ rows: number; backend: string }>("window.__sel()");
    check("selector: backend pane", back.rows === 2, `backend=${back.backend}`);

    await js<void>("window.__selTab('model')");
    await new Promise((r) => setTimeout(r, 9000));
    const models = await js<{ rows: number; err: string | null }>("window.__sel()");
    check("selector: model pane lists models", models.rows > 0, `${models.rows} rows${models.err ? " err=" + models.err : ""}`);

    const mode = await js<string>("window.__mode()");
    check("coding mode resolves", ["default", "auto", "bypass"].includes(mode), mode);
  }

  if (MODELS_TEST) await modelsTest(js, check);

  const image = await win.webContents.capturePage();
  const out = join(app.getPath("temp"), "atomic-desktop-smoke.png");
  writeFileSync(out, image.toPNG());
  process.stdout.write(`SMOKE screenshot=${out} failures=${fail.length}\n`);
  app.exit(fail.length === 0 ? 0 : 1);
}

async function modelsTest(
  js: <T>(code: string) => Promise<T>,
  check: (name: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const cfg = async () => (await configGet()).config as {
    llm?: { activeTextProvider?: string; providers?: Array<{ id: string; defaultChatModel?: string }> };
  };

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
