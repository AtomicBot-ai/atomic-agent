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
  traceTools,
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
    // [data-group] click. The opened session usually carries one; when it does
    // not, say so instead of fabricating cards.
    const grp = await js<{ members: boolean; headBefore: number; headAfter: number; scrollBefore: number; scrollAfter: number } | null>("window.__unfoldGroup()");
    check(
      "unfolding a run keeps its head in place",
      grp === null || (grp.members && Math.abs(grp.headAfter - grp.headBefore) <= 1 && grp.scrollAfter === grp.scrollBefore),
      grp ? JSON.stringify(grp) : "no folded run in this transcript (nothing to assert)",
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
