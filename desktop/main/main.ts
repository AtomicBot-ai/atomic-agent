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
  // Lane B — backend switch
  configSetWhole,
  localDaemonRunning,
  modelsStop,
  providerHasKey,
  providersReady,
  setActiveTextProvider,
  useManagedMode,
  type UserConfigShape,
  // Lane B — context before the first message (item 3)
  modelWindow,
  traceBaseline,
} from "./agent-cli.js";
import { readFileSync } from "node:fs";
import {
  activateProvider,
  selectCloudModel,
  selectLocalModel,
  switchBackend,
  type SwitchResult,
} from "./backend-switch.js";
// Lane B — context before the first message (item 3): the no-trace smoke dir.
import { mkdirSync, rmSync } from "node:fs";

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

  // Lane B — backend switch: snapshot the route serve booted with, as soon
  // as it is healthy; a stopped or dead child has none.
  client.on("status", (status: { state?: string }) => {
    if (status.state === "connected") bootRoute = snapshotBootRoute(client);
    else if (status.state === "stopped" || status.state === "error") bootRoute = Promise.resolve(null);
  });
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
    // A new thread flips back to the projection, with the same baseline.
    const fresh = await js<PreCtx>("window.__ctxNew()");
    check(
      "session:new flips back to the projection",
      pre?.source !== "projected"
        ? fresh.source === pre?.source
        : fresh.source === "projected" && fresh.baseline?.sessionId === pre.baseline?.sessionId && fresh.tokens === fresh.stablePrefix,
      `source=${fresh.source} tokens=${fresh.tokens} scaffold=${fresh.stablePrefix} baseline=${fresh.baseline?.sessionId}`,
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
    // Lane B — item 3: ask on a fresh thread. The sidebar check above
    // opened the most-turned stored session, whose transcript by now holds
    // dozens of near-identical smoke turns; a model answering "done" from
    // that history without calling a tool is a harness artefact, not a
    // desktop defect (seen once: turn 49 of api-2931b30b63359b7d).
    // Lane B — backend switch: session:new alone is not enough — without a
    // session_id the server keys the session on the first user message
    // (src/http/openai-chat-completions.ts firstUserMessage), so the same
    // prompt lands in the same stored session run after run and by its third
    // turn the model answered "done" from history without a tool call. A
    // per-run nonce in the prompt makes the derived session genuinely fresh.
    await js<void>("window.__ctxNew()");
    const toolNonce = Date.now().toString(36);
    await js<void>(`window.__ask('List the files in the current directory, then say done. (run ${toolNonce})')`);
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

    // --- Lane B — backend switch ---
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

/** Lane B — backend switch. */
async function backendSwitchTest(
  js: <T>(code: string) => Promise<T>,
  check: (name: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

    // The file moves first, without a restart — what the TUI or a hand
    // edit does while this window is open. serve stays on its boot route,
    // and the switch below, which finds nothing to write for the route,
    // must still restart it.
    const preMoved = await setActiveTextProvider("local-llama");

    // To local, through the same function the backend row's click runs.
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
        && afterLocal?.llm?.activeTextProvider === "local-llama"
        && afterLocal?.localModels?.mode === "managed"
        && localEntry(afterLocal)?.url === `http://127.0.0.1:${port}`
        && afterLocal?.llm?.activeEmbeddingProvider === beforeConfig?.llm?.activeEmbeddingProvider
        && (afterLocal?.llm?.providers ?? []).length === (beforeConfig?.llm?.providers ?? []).length,
      toLocal?.ok
        ? `active=${afterLocal?.llm?.activeTextProvider} mode=${afterLocal?.localModels?.mode} url=${localEntry(afterLocal)?.url} daemon=${toLocal.daemon}`
        : `error=${toLocal?.error}`,
    );
    const managedId = afterLocal?.localModels?.managed?.modelId ?? null;
    const localChips = await js<{ backend: string; mode: string; model: string }>(
      "({backend: window.__sel().backend, mode: document.querySelector('.modechip')?.textContent ?? '', model: document.querySelector('.modelchip')?.textContent ?? ''})",
    );
    check(
      "backend: renderer follows the file",
      rawLocal.backend === "local" && /local/.test(rawLocal.mode)
        && localChips.backend === "local" && /local/.test(localChips.mode)
        // With a managed model the chip names it; with none, it reads the
        // TUI's DOWNLOAD_MODEL_LABEL once the catalogue snapshot has landed.
        && (managedId ? localChips.model.includes(managedId) : /download model/.test(localChips.model)),
      `own refresh: backend=${rawLocal.backend} chip=${JSON.stringify(rawLocal.mode)}; after harness refresh: backend=${localChips.backend} chip=${JSON.stringify(localChips.mode)} model=${JSON.stringify(localChips.model)}`,
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
    check(
      "backend: serve behind the file still restarts",
      preMoved.ok && preMoved.changed && toLocal?.restart === true && agent?.status.port !== portBefore,
      `file moved first: ${preMoved.changed}; restart=${toLocal?.restart}; port ${portBefore} → ${agent?.status.port}`,
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
    // with the TUI's exact text and no turn is opened.
    if (afterLocal && afterLocal.localModels?.managed) {
      const noModel = JSON.parse(JSON.stringify(afterLocal)) as UserConfigShape;
      noModel.localModels!.managed!.modelId = null;
      const cardsBefore = await js<number>("window.__cards().length");
      await configSetWhole(noModel);
      await js<void>("window.__ctxRefreshCfg()");
      await wait(1000);
      await js<void>("window.__ask('hi')");
      await wait(1500);
      const gate = await js<{ last: string; busy: boolean; cards: number }>(
        "({last: window.__lastSystem(), busy: window.__bsw().turnBusy, cards: window.__cards().length})",
      );
      check(
        "backend: local turn gate blocks with the TUI's text",
        gate.last === "no local model is selected — open Models (/local) to pick and download one" && !gate.busy && gate.cards === cardsBefore,
        `last=${JSON.stringify(gate.last)} busy=${gate.busy}`,
      );
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
