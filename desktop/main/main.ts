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
  configUnset,
  configGetKey,
  taskCreate,
  skillList,
} from "./agent-cli.js";
import { validateCreateForm, type TaskCreateFormInput } from "./task-schedule.js";

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
  ipcMain.handle("agent:session", (_event, id: unknown) =>
    typeof id === "string" ? client.session(id).then((data) => ({ ok: true, data })).catch((e) => ({ ok: false, error: String(e) })) : { ok: false, error: "id required" },
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

    const modeState = await js<{ supported: boolean | null; current: string }>("window.__modeState()");
    check(
      "coding mode is live or honestly unavailable",
      modeState.supported === false || ["default", "plan", "auto", "bypass"].includes(modeState.current),
      modeState.supported === false ? "agent lacks /api/coding-mode (reported, not faked)" : `current=${modeState.current}`,
    );

    // "claude haiku" must find claude/haiku, claude.haiku, claude-3-haiku…
    const hits = await js<number>("window.__search('claude haiku')");
    check("search tokenizes across separators", hits > 0, `${hits} hits`);
    await js<void>("window.__search('')");

    const wiz = await js<{ rows: number; selected: number }>("window.__wizOpen()");
    check("wizard lists kinds, none preselected", wiz.rows >= 4 && wiz.selected === 0, `${wiz.rows} kinds, ${wiz.selected} selected`);
    await js<void>("window.__closeAll && window.__closeAll()");

    // A tool-using turn: cards must carry the real args and a duration.
    // Harness fix (separate commit, revertable on its own): the turn used to
    // run inside a session that every smoke run grows by one more "List the
    // files… / done" pair — once the model has listed the directory several
    // times in its own context it answers a bare "done" with no tool call
    // (lane store: api-2931b30b63359b7d at 102 turns and api-aa0c6938cede73f2,
    // the id the agent derives from this very prompt, both 0 cards; 3 of 7
    // runs on unchanged code). __sessionNew mints a client-side session id,
    // which is the only way to get an empty session from /v1/chat/completions.
    await js<void>("window.__sessionNew()");
    await js<void>("window.__ask('List the files in the current directory, then say done.')");
    const toolDeadline = Date.now() + 150_000;
    let cards: Array<{ name: string; args: string; ms: number; ok: boolean | null; live: boolean }> = [];
    while (Date.now() < toolDeadline) {
      await new Promise((r) => setTimeout(r, 2000));
      cards = await js<typeof cards>("window.__cards()");
      const reply = await js<string>("window.__lastReply()");
      const born = cards.filter((c) => c.live);
      if (born.length && born.every((c) => c.ok !== null) && /done/i.test(reply)) break;
    }
    // Only cards born on this run's stream can be timed; ones rebuilt from the
    // store have no duration to show, because the store records none.
    const live = cards.filter((c) => c.live);
    const withArgs = live.filter((c) => /[{"]/.test(c.args) && c.args.length > 4);
    const timed = live.filter((c) => c.ms > 0);
    check("tool cards carry args", live.length > 0 && withArgs.length === live.length, `${withArgs.length}/${live.length} with real args`);
    check("tool cards carry durations", live.length > 0 && timed.length === live.length, `${timed.length}/${live.length} timed (observed)`);
    if (timed.length !== live.length) {
      // Say what the cards held and what the store held, so a failure here is diagnosable from the log alone.
      process.stdout.write(`DIAG cards=${JSON.stringify(cards)}\n`);
      process.stdout.write(`DIAG store=${await js<string>("window.__storeDiag ? window.__storeDiag() : 'no hook'")}\n`);
    }

    const chips = await js<number>("window.__pushAssistant('Saved the report to /Users/valerii/Desktop/report.pdf and the notes to ~/notes/summary.md.')");
    check("file paths render as chips", chips === 2, `${chips} chips`);

    // --- Item 7 (settings surface): the TUI menu tree, the Manage tabs, Privacy and Tasks ---
    await settingsTest(js, check);
  }

  if (MODELS_TEST) await modelsTest(js, check);

  const image = await win.webContents.capturePage();
  const out = join(app.getPath("temp"), "atomic-desktop-smoke.png");
  writeFileSync(out, image.toPNG());
  process.stdout.write(`SMOKE screenshot=${out} failures=${fail.length}\n`);
  app.exit(fail.length === 0 ? 0 : 1);
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
  check(
    "settings: diagnostics line uses the TUI null forms and counts tools only for the open session",
    diag.line.startsWith("cwd ") && diag.line.includes(" | llama ") && diag.line.includes(" | llm — · step — | kv — |")
      && / \| approval L\d \| skills \d+$/.test(diag.line) && !!diag.health && toolsOk,
    `${diag.line} (session=${diag.session ?? "none"})`,
  );

  const errBefore = await js<number>("window.__errCount()");
  let allRender = true;
  const details: string[] = [];
  const PLACEHOLDER = ["memory", "mcp", "llm", "telegram", "import"]; // skills shows the installed list from `atag skill list` already (read-only until the next step)
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
  const skl = await js<{ header: boolean; rows: number; cli: number | null }>(
    "(() => { window.__settingsOpen('skills'); const body = window.__settingsBody();"
    + " return {header: body.includes('state     source   version  name'), rows: document.querySelectorAll('#settings .setbody .tuirow').length, cli: window.__skillCount()}; })()",
  );
  check("settings: Skills tab lists every `atag skill list` row", skl.header && typeof skl.cli === "number" && skl.rows === skl.cli, JSON.stringify(skl));

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
  check("tasks tab: rows and copy come from GET /api/tasks?limit=200", tasksCopy && taskState.rows === Math.min(storeCount, 200), `${taskState.rows} rows, store holds ${storeCount}`);
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
