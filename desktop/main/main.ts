import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";   // item 5: the attachment strip stats what a turn wrote, nothing else
import { execFile, spawn } from "node:child_process";   // item 2 (voice input): the smoke spawns the speech helper with --probe
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
  // Item 7A — add a model from Hugging Face
  addCustomModelEntry,
} from "./agent-cli.js";
// Item 7A — the vendored port of the agent's huggingface-* modules; the
// renderer's CSP forbids it from reaching huggingface.co itself.
import {
  buildCustomModelDef,
  downloadProjector,
  huggingFaceToken,
  isSafeModelFilename,
  resolveHuggingFaceGgufChoices,
  type HuggingFaceRepoChoices,
} from "./huggingface.js";
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
  // Item 7A — the HF_TOKEN asymmetry note on a gated listing (names only)
  stateDirPath,
  type ImportRunInput,
} from "./agent-cli.js";
import { validateCreateForm, type TaskCreateFormInput } from "./task-schedule.js";
// Item 2 (voice input): the on-device speech helper's supervisor.
import { VoiceSession, helperPath as speechHelperPath } from "./speech.js";
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
/* Item 2 (voice input): at most one live speech helper, for the whole app.
   Created here rather than inside wireIpc because createWindow's permission
   handlers read `voice.armed`, and both quit paths have to be able to kill
   it — a helper outliving the window holds the microphone indicator on. */
const voice = new VoiceSession();

/* Item 2 (voice input): the chosen dictation languages. This is a viewer
   preference, not agent state — the agent has no voice surface at all — so
   it lives beside prefs.json in Electron's userData and never touches
   ~/.atomic-agent/config.json. Its own file, so the sidebar's whole-object
   prefs write cannot drop it. */
type VoicePrefs = { locales: string[] };
const VOICE_PREFS_PATH = () => join(app.getPath("userData"), "voice.json");

function readVoicePrefs(): VoicePrefs {
  try {
    const raw = JSON.parse(readFileSync(VOICE_PREFS_PATH(), "utf8")) as { locales?: unknown };
    const locales = Array.isArray(raw.locales)
      ? raw.locales.filter((l): l is string => typeof l === "string" && !!l).slice(0, 2)
      : [];
    return { locales };
  } catch {
    return { locales: [] };
  }
}

function writeVoicePrefs(locales: string[]): { ok: boolean; error?: string } {
  try {
    writeFileSync(VOICE_PREFS_PATH(), JSON.stringify({ locales: locales.slice(0, 2) }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
/* Item 7A — the Hugging Face lookup in flight, so a second reference
   aborts the first (the TUI's `hfLookup` controller, verbatim). */
let hfLookup: AbortController | null = null;
/* Item 7A — the projector download in flight. It shares the `cli:pull`
   stream with `cli:modelsPull` so the renderer needs one subscriber, so
   it needs its own slot and both must refuse while the other runs. */
let hfProjector: { controller: AbortController; id: string } | null = null;

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

  /* Item 2 (voice input): until this feature there was no permission handler
     at all, and Electron's default grants everything — the renderer could
     open the microphone, or the camera, without anyone asking. Both handlers
     go in and both deny by default; the exceptions are an audio-only media
     request while a voice session the user started is armed, and the
     clipboard write the composer already relied on (see the predicate).

     The two callbacks have deliberately different shapes and neither is a
     copy of the other: setPermissionRequestHandler is
     (webContents, permission, callback, details) and answers through the
     callback; setPermissionCheckHandler is
     (webContents, permission, requestingOrigin, details) and RETURNS a
     boolean — returning nothing from it denies everything, the armed
     session included. */
  window.webContents.session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(voicePermissionVerdict(permission, details as { mediaTypes?: string[] } | undefined));
  });
  window.webContents.session.setPermissionCheckHandler((_wc, permission, _origin, details) =>
    voicePermissionVerdict(permission, details as unknown as { mediaTypes?: string[] } | undefined),
  );

  void window.loadFile(join(__dirname, "..", "renderer", "index.html"));
  return window;
}

/** The ONE predicate both handlers above run, and the one the smoke asserts.
 *  It lives at module scope on purpose: while it was a closure inside
 *  createWindow the check had to assert a textually parallel copy of it, and
 *  the two bodies could drift apart without anything going red.
 *
 *  BOTH clipboard permissions are allowed, and the second one is not
 *  cosmetic. The composer's "copy session id" (act('copy:session')) is a
 *  plain `navigator.clipboard.writeText` whose rejection is swallowed, so a
 *  denial breaks the copy silently while the toast still says it worked.
 *  Which permission Chromium asks for depends on transient user activation,
 *  measured here with a standalone Electron probe rather than reasoned about:
 *    with a user gesture    → req:clipboard-sanitized-write
 *    without a user gesture → req:clipboard-read   ← and this one was denied
 *  A click or a keystroke carries activation; a copy driven from an IPC
 *  message or a timer does not. Before this feature Electron's default
 *  granted every permission, so allowing both is a restoration of what the
 *  renderer already had, not a widening — the gate exists for the microphone
 *  and the camera, and those are still refused unless a session is armed. */
function voicePermissionVerdict(
  permission: string,
  details: { mediaTypes?: string[] } | undefined,
): boolean {
  if (permission === "clipboard-sanitized-write" || permission === "clipboard-read") return true;
  if (permission !== "media" || !voice.armed) return false;
  const types = details?.mediaTypes ?? [];
  return types.length > 0 && types.every((t) => t === "audio");
}

/**
 * Item 7A — the def the renderer picked, rebuilt in main from the repo it
 * was handed. The renderer never assembles a `LocalModelDef` itself: the
 * id slug, the RAM estimates and the projector attachment are the agent's
 * arithmetic (`buildCustomModelDef`), and a second implementation of them
 * in the renderer is exactly the drift this port already risks once.
 */
function hfBuildDef(
  payload: unknown,
): { ok: true; def: ReturnType<typeof buildCustomModelDef> } | { ok: false; error: string } {
  const { repo, index } = (payload ?? {}) as { repo?: unknown; index?: unknown };
  const r = repo as HuggingFaceRepoChoices | undefined;
  if (!r || typeof r.repoId !== "string" || !Array.isArray(r.choices)) {
    return { ok: false, error: "no resolved repo to add from" };
  }
  const at = typeof index === "number" && Number.isInteger(index) ? index : 0;
  const choice = r.choices[at];
  if (!choice) return { ok: false, error: "that file is not in the list any more" };
  try {
    return {
      ok: true,
      def: buildCustomModelDef({
        repoId: r.repoId,
        revision: typeof r.revision === "string" && r.revision ? r.revision : "main",
        file: { path: choice.path, sizeBytes: choice.sizeBytes },
        mmproj: r.mmproj ?? null,
      }),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The one honest thing this window can add to a gated-repo refusal.
 *
 * `atag models pull` reads HF_TOKEN out of <stateDir>/.env — load-config
 * applies the NAMES into process.env on every CLI run — while this
 * process sees only its own environment, so a gated repo can fail to LIST
 * here and download fine. Names only: the value is never read.
 *
 * Extracted from the cli:hfResolve handler so the sentence can be
 * asserted without a gated repo and a token on disk (review fix: it was
 * the one string in this feature the desktop authored on top of the port,
 * and nothing checked it).
 */
function hfGatedTokenHint(message: string, dir: string): string {
  if (!/Hugging Face returned 40[13]/.test(message)) return message;
  const names = dotenvKeys(dir).keys.filter((k) => k === "HF_TOKEN" || k === "HUGGING_FACE_HUB_TOKEN");
  if (names.length === 0 || envPresent(names).length > 0) return message;
  return message
    + ` (${names.join(" / ")} is named in ${dir}/.env, which \`atag models pull\` reads and this window does not`
    + " — start the app with it exported and the listing will see it too.)";
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

  /* Item 7C — mid-turn steering. The 409/429 bodies come back as
     `error.message` through `request`; the renderer decides what to say,
     it never prints the agent's API-client advice. */
  ipcMain.handle("agent:steer", async (_event, payload: unknown) => {
    const { sessionId, text } = (payload ?? {}) as { sessionId?: unknown; text?: unknown };
    if (typeof sessionId !== "string" || !sessionId) return { ok: false, error: "session id required" };
    if (typeof text !== "string" || !text.trim()) return { ok: false, error: "text required" };
    try {
      const res = await client.steer(sessionId, text);
      return { ok: true, steered: res.steered === true, sessionId: res.sessionId };
    } catch (err) {
      return { ok: false, steered: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("agent:undeliveredSteers", async (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId) return { ok: false, error: "session id required" };
    try {
      return { ok: true, data: await client.undeliveredSteers(sessionId) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("agent:ackSteers", async (_event, payload: unknown) => {
    const { sessionId, through, discarded } = (payload ?? {}) as {
      sessionId?: unknown; through?: unknown; discarded?: unknown;
    };
    if (typeof sessionId !== "string" || !sessionId) return { ok: false, error: "session id required" };
    const t = typeof through === "number" && Number.isFinite(through) ? Math.trunc(through) : 0;
    const d = typeof discarded === "number" && Number.isFinite(discarded) ? Math.trunc(discarded) : 0;
    try {
      return { ok: true, data: await client.ackSteers(sessionId, t, d) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

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
    if (pull || hfProjector) return { ok: false, error: "a download is already running" };
    const started = modelsPull(id, (line) => send("cli:pull", { id, line }));
    pull = started;
    void started.done.then((res) => {
      pull = null;
      send("cli:pull", { id, done: true, ok: res.ok, error: res.error ?? null });
    });
    return { ok: true, started: true };
  });
  ipcMain.handle("cli:cancelPull", () => {
    // Item 7A: the one Cancel button covers both downloads, because the
    // banner it lives under covers both phases.
    if (hfProjector) {
      hfProjector.controller.abort();
      return true;
    }
    if (!pull) return false;
    pull.cancel();
    return true;
  });

  /* ---- Item 7A: add a model from Hugging Face ------------------------
     The desktop owns exactly two steps the agent exposes nowhere —
     parsing the reference and listing the repo. Everything after that is
     the agent's own: the entry goes into `localModels.customModels` with
     the whole-file `atag config set`, and the download is the existing
     `models pull` → `cli:pull` plumbing, unchanged.

     Every error message is passed through UNTOUCHED. They are written for
     the screen (huggingface-ref.ts says so in as many words) and the
     smoke asserts four of them verbatim. */
  ipcMain.handle("cli:hfResolve", async (_event, ref: unknown) => {
    if (typeof ref !== "string" || ref.trim().length === 0) {
      return { ok: false, error: "Type a repo id or a huggingface.co URL." };
    }
    if (ref.length > 512) return { ok: false, error: "that reference is too long to be a repo id or a URL" };
    const controller = new AbortController();
    hfLookup?.abort();
    hfLookup = controller;
    try {
      const repo = await resolveHuggingFaceGgufChoices(ref, { signal: controller.signal });
      if (hfLookup !== controller) return { ok: false, cancelled: true, error: "cancelled" };
      hfLookup = null;
      return { ok: true, repo };
    } catch (err) {
      if (hfLookup !== controller) return { ok: false, cancelled: true, error: "cancelled" };
      hfLookup = null;
      if (controller.signal.aborted) return { ok: false, cancelled: true, error: "cancelled" };
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: hfGatedTokenHint(message, stateDirPath()) };
    }
  });
  ipcMain.handle("cli:hfCancel", () => {
    // Escape mid-lookup: drop the socket, keep what was typed.
    if (!hfLookup) return false;
    hfLookup.abort();
    hfLookup = null;
    return true;
  });
  /** Build the def WITHOUT writing anything — what makes the add testable. */
  ipcMain.handle("cli:hfDef", (_event, payload: unknown) => {
    const built = hfBuildDef(payload);
    return built.ok ? { ok: true, def: built.def } : built;
  });
  ipcMain.handle("cli:hfAdd", async (_event, payload: unknown) => {
    const built = hfBuildDef(payload);
    if (!built.ok) return built;
    const res = await addCustomModelEntry(built.def as unknown as Record<string, unknown>);
    if (!res.ok) return { ok: false, error: res.error ?? "could not write the config" };
    return { ok: true, id: built.def.id, def: built.def };
  });
  /**
   * `atag models pull` fetches weights only, so the projector is fetched
   * here — reported on the SAME `cli:pull` stream the weights used, with
   * the TUI's own phase label, because a download nobody can see is the
   * failure this step exists to prevent.
   *
   * Progress LINES only, never a `done` frame: this call resolves to the
   * caller, and a second `done` would re-enter the renderer's pull
   * subscriber and run the post-download activation twice.
   */
  ipcMain.handle("cli:hfProjector", async (_event, payload: unknown) => {
    const { id, mmprojUrl, mmprojFilename, name } = (payload ?? {}) as {
      id?: unknown; mmprojUrl?: unknown; mmprojFilename?: unknown; name?: unknown;
    };
    if (typeof id !== "string" || !/^custom-[a-z0-9._-]{1,88}$/.test(id)) {
      return { ok: false, error: "custom model id required" };
    }
    if (typeof mmprojUrl !== "string" || !mmprojUrl.startsWith("https://huggingface.co/")) {
      return { ok: false, error: "the projector URL must be on huggingface.co" };
    }
    // The schema's own filename rule: this lands in a path join under
    // <dataDir>/models/<id>/, and the name comes from a repo.
    if (typeof mmprojFilename !== "string" || !isSafeModelFilename(mmprojFilename)) {
      return { ok: false, error: "unsafe projector filename" };
    }
    if (pull || hfProjector) return { ok: false, error: "a download is already running" };
    const st = await modelsStatus();
    const dataDir = st.ok && st.status ? st.status.dataDir : null;
    if (!dataDir) return { ok: false, error: `could not read the model data dir: ${st.error ?? "no data dir in \`atag models status\`"}` };
    const dir = join(dataDir, "models", id);
    const dest = join(dir, mmprojFilename);
    const label = `${typeof name === "string" && name ? name : id} (mmproj)`;
    // Matches downloadMmproj's own early return: the installer skips when
    // the destination exists.
    if (existsSync(dest)) {
      send("cli:pull", { id, line: `${label} already on disk` });
      return { ok: true, alreadyPresent: true };
    }
    const controller = new AbortController();
    hfProjector = { controller, id };
    send("cli:pull", { id, line: `${label} 0%` });
    try {
      mkdirSync(dir, { recursive: true });
      await downloadProjector(mmprojUrl, dest, {
        signal: controller.signal,
        onProgress: (percent, transferred, total) =>
          send("cli:pull", {
            id,
            line: total > 0
              ? `${label} ${percent}% (${(transferred / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB)`
              : `${label} ${(transferred / 1e6).toFixed(1)} MB`,
          }),
      });
      send("cli:pull", { id, line: `${label} done` });
      return { ok: true, path: dest };
    } catch (err) {
      const aborted = controller.signal.aborted;
      const message = aborted
        ? "the projector download was cancelled — a retry starts it from the beginning"
        : err instanceof Error ? err.message : String(err);
      send("cli:pull", { id, line: `${label} failed: ${message}` });
      return { ok: false, error: message };
    } finally {
      hfProjector = null;
    }
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

  /* ---- Item 2 (voice input) --------------------------------------------
     Nothing here touches the agent: 0.5.5 has no audio route, no
     transcription tool and no config key, so no HTTP call is made, nothing
     is written to config.json and no `atag serve` restart is involved. */
  ipcMain.handle("voice:probe", async () => {
    const probe = await voice.probe();
    return { ok: true, data: { ...probe, chosen: readVoicePrefs().locales } };
  });
  ipcMain.handle("voice:start", (_event, locales: unknown) => {
    const wanted = Array.isArray(locales) ? locales.filter((l): l is string => typeof l === "string") : [];
    return voice.start(wanted, (payload) => send("app:voice", payload));
  });
  // `on`, not `handle`: this fires ten times a second and no answer is wanted.
  ipcMain.on("voice:audio", (_event, chunk: unknown) => voice.audio(chunk));
  ipcMain.handle("voice:stop", () => voice.stop());
  ipcMain.handle("voice:cancel", () => voice.cancel());
  ipcMain.handle("voice:install", (_event, locale: unknown) =>
    typeof locale === "string" && locale
      ? voice.install(locale, (payload) => send("app:voice", payload))
      : Promise.resolve({ ok: false, error: "locale required" }),
  );
  ipcMain.handle("voice:setLocales", (_event, locales: unknown) =>
    writeVoicePrefs(Array.isArray(locales) ? locales.filter((l): l is string => typeof l === "string") : []),
  );

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
      // Item 7C: `measured` is the session row's own contextUsage, which
      // v0.5.5 persists and which now leads the ladder.
      ctx.tokens > 0 && ["measured", "provider", "estimate", "built"].includes(ctx.source ?? ""),
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

    // --- Item 2: voice input (no microphone is opened anywhere in it) ---
    await voiceTest(js, check);

    // --- Item 7A + 7C: Hugging Face, steering, the stored gauge, the model stamp ---
    await hfAndDeltaTest(js, check, sidFirst);

    // --- Item 6: the sidebar's two lists ---
    await sidebarTest(js, check);

    // --- r4-ui: the dot, the bubbles, the header pluses, Escape ---
    await uiTest(js, check);

    // --- r4 integration: the seams between the four lanes ---
    await r4SeamTest(js, check);

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
 * Item 2 (voice input). Every check here runs WITHOUT a microphone: the
 * renderer's state machine is driven through `window.__voice*` hooks with
 * synthetic helper events, and the one live browser call asserts that the
 * camera is DENIED — never that audio is granted, which would open the
 * operator's real device.
 *
 * Nothing in this suite touches the agent: the feature owns no route, no
 * config key and no restart. The renderer's chosen languages are captured
 * and written back in `finally`.
 */
async function voiceTest(
  js: <T>(code: string) => Promise<T>,
  check: (name: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  type V = {
    available: boolean | null; reason: string; code: string; state: string; locales: string[];
    winner: string | null; final: string; partial: string; menu: boolean;
    supported: number; installed: number; offMachine: boolean;
  };
  type Strip = {
    present: boolean; hidden: boolean; empty: boolean; text: string; partial: string;
    note: string; chip: string; menuRows: number; menuFoot: string;
  } | null;
  type Mic = { present: boolean; disabled: boolean; title: string; order: string };

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const before = await js<V>("window.__voice()");
  const draftBefore = await js<string>("window.__draft ? window.__draft().draft : ''");
  // The menu checks below click real rows, and a real click writes
  // userData/voice.json. Captured byte-for-byte and put back in `finally`,
  // including the case where the operator has never chosen a language and
  // the file does not exist at all.
  const voiceJson = VOICE_PREFS_PATH();
  const voiceJsonBefore = existsSync(voiceJson) ? readFileSync(voiceJson, "utf8") : null;
  // The acceptance line "nothing was written to the agent": this feature owns
  // no route, no config leaf and no restart, and the snapshot below proves it
  // rather than asserting it in prose. Compared at the end of the sub-suite.
  const agentCfgBefore = JSON.stringify((await configGet()).config);
  try {
    // --- the button ------------------------------------------------------
    const mic = await js<Mic>("window.__voiceMic()");
    const order = mic.order.split("|");
    const iMic = order.findIndex((c) => c.split(" ").includes("micbtn"));
    const iSend = order.findIndex((c) => c.split(" ").includes("sendbtn"));
    check(
      "mic button sits next to send",
      mic.present && iMic >= 0 && iSend === iMic + 1,
      `field children ${JSON.stringify(mic.order)}`,
    );

    // --- honesty ---------------------------------------------------------
    const reasons = await js<Record<string, string>>("window.__voiceReasons()");
    const v0 = await js<V>("window.__voice()");
    const named = Object.keys(reasons).filter((k) => k !== "ondevice");
    const sentences = named.map((k) => reasons[k]);
    check(
      "every disabled case has a sentence",
      named.length === 8 && sentences.every((s) => typeof s === "string" && s.length > 12)
        && reasons["voice-os-too-old"] === "Voice input needs macOS 26 or later"
        && reasons["voice-helper-missing"] === "Voice input needs the speech helper, which this build was packaged without"
        && reasons["voice-not-macos"] === "Voice input works only on macOS",
      `${named.length} named cases`,
    );
    check(
      "voice reports itself honestly",
      v0.available !== null
        && (v0.available
          ? v0.reason === "" && !mic.disabled && mic.title.includes("click again to insert")
          : sentences.includes(v0.reason) && mic.disabled && mic.title === v0.reason),
      `available=${v0.available} code=${v0.code} reason=${JSON.stringify(v0.reason)} disabled=${mic.disabled}`,
    );
    // Each disabled case must actually render its own sentence on the button.
    let allRendered = true;
    const rendered: string[] = [];
    for (const code of ["voice-os-too-old", "voice-helper-missing", "voice-not-macos"]) {
      await js<V>(`window.__voiceProbeSet({available:false, reason:'${code}'})`);
      const m = await js<Mic>("window.__voiceMic()");
      rendered.push(`${code}→${m.disabled ? "off" : "ON"}`);
      if (!m.disabled || m.title !== reasons[code]) allRendered = false;
    }
    check("a disabled button carries the true reason", allRendered, rendered.join(", "));
    await js<V>("window.__voiceReprobe()");

    // --- the strip is only ever a placeholder when idle -------------------
    const idle = await js<Strip>("window.__voiceStrip()");
    check(
      "an idle strip is a hidden placeholder, not a missing node",
      !!idle && idle.present && idle.hidden && idle.empty,
      idle ? `hidden=${idle.hidden} empty=${idle.empty}` : "no strip",
    );

    // --- interim text never touches the draft ----------------------------
    await js<unknown>("window.__ctxDraft('fix ')");
    await js<V>("window.__voiceArm()");
    await js<V>("window.__voiceEvent({type:'ready', locales:['en-US']})");
    await js<V>("window.__voiceEvent({type:'partial', text:'refactor the login'})");
    const s1 = await js<Strip>("window.__voiceStrip()");
    const d1 = await js<{ draft: string; entry: string }>("window.__draft()");
    check(
      "interim renders without touching the draft",
      !!s1 && !s1.hidden && s1.text.includes("refactor the login") && d1.draft === "fix " && d1.entry === "fix ",
      `strip ${JSON.stringify(s1 && s1.text)}, draft ${JSON.stringify(d1.draft)}, entry ${JSON.stringify(d1.entry)}`,
    );
    check(
      "the on-device sentence is the one that ships",
      !!s1 && s1.note.startsWith("On-device — the audio never leaves this Mac") && !before.offMachine,
      `note ${JSON.stringify(s1 && s1.note)}, offMachine ${before.offMachine}`,
    );

    // --- segments accumulate ---------------------------------------------
    await js<V>("window.__voiceEvent({type:'final', text:'Open the settings pane.'})");
    await js<V>("window.__voiceEvent({type:'final', text:' Then switch the backend.'})");
    const s2 = await js<V>("window.__voiceEvent({type:'partial', text:' Finally'})");
    check(
      "segments accumulate",
      s2.final + s2.partial === "Open the settings pane. Then switch the backend. Finally",
      JSON.stringify(s2.final + s2.partial),
    );

    // --- the ordering a naive implementation gets wrong -------------------
    // Real speech ends every segment partial-then-final with the same words,
    // and a stop always lands on a final. Without clearing `partial` when a
    // final arrives, the closing sentence is inserted twice.
    await js<V>("window.__voiceCancel()");
    await js<unknown>("window.__ctxDraft('')");
    await js<V>("window.__voiceArm()");
    await js<V>("window.__voiceEvent({type:'final', text:'a.'})");
    await js<V>("window.__voiceEvent({type:'partial', text:' b'})");
    const s3 = await js<V>("window.__voiceEvent({type:'final', text:' b.'})");
    check(
      "a take that ends on a final is not doubled",
      s3.final + s3.partial === "a. b." && s3.partial === "",
      `strip text ${JSON.stringify(s3.final + s3.partial)}, partial ${JSON.stringify(s3.partial)}`,
    );
    const ins0 = await js<{ draft: string; users: number }>("window.__voiceStop()");
    check(
      "and the doubled sentence is not inserted either",
      ins0.draft === "a. b.",
      JSON.stringify(ins0.draft),
    );

    // --- insertion at the caret ------------------------------------------
    // The transcript already holds the turns the suite ran above, so the
    // assertion is that dictation added NO user message, not that there are
    // none at all.
    const usersBefore = await js<number>("window.__draft().users");
    await js<unknown>("window.__ctxDraft('fix ')");
    await js<V>("window.__voiceArm()");
    await js<V>("window.__voiceEvent({type:'final', text:'Open the settings pane.'})");
    await js<V>("window.__voiceEvent({type:'final', text:' Then switch the backend.'})");
    await js<V>("window.__voiceEvent({type:'partial', text:' Finally'})");
    const ins = await js<{ voice: V; draft: string; entry: string; users: number }>("window.__voiceStop()");
    check(
      "final text is inserted at the caret and nothing is sent",
      ins.draft === "fix Open the settings pane. Then switch the backend. Finally"
        && ins.entry === ins.draft && ins.voice.state === "idle" && ins.users === usersBefore,
      `draft ${JSON.stringify(ins.draft)}, user messages ${usersBefore}→${ins.users}, state ${ins.voice.state}`,
    );

    // --- a cancelled take inserts nothing ---------------------------------
    await js<unknown>("window.__ctxDraft('fix ')");
    await js<V>("window.__voiceArm()");
    await js<V>("window.__voiceEvent({type:'partial', text:'discard me'})");
    const cancelled = await js<V>("window.__voiceCancel()");
    const dc = await js<{ draft: string }>("window.__draft()");
    const sc = await js<Strip>("window.__voiceStrip()");
    check(
      "a cancelled recording inserts nothing",
      dc.draft === "fix " && cancelled.state === "idle" && !!sc && sc.hidden && sc.empty,
      `draft ${JSON.stringify(dc.draft)}, state ${cancelled.state}, strip hidden=${sc && sc.hidden} empty=${sc && sc.empty}`,
    );

    // --- Escape, from the states that would otherwise swallow it ----------
    const esc = async (setup: string, label: string) => {
      if (label === "slash") {
        // The real path: an input event, so S.slash is set and the popover
        // is actually on screen — that branch returns before the general
        // Escape case and would swallow the cancel.
        await js<boolean>(
          "(() => { const e = document.getElementById('entry'); e.focus(); e.value = '/he';"
          + " e.dispatchEvent(new Event('input', {bubbles:true})); return !!document.querySelector('.slash'); })()",
        );
      } else {
        await js<unknown>('window.__ctxDraft("fix ")');
      }
      await js<V>("window.__voiceArm()");
      await js<V>("window.__voiceEvent({type:'partial', text:'discard me'})");
      if (setup) await js<unknown>(setup);
      const slashWasOpen = await js<boolean>("!!document.querySelector('.slash')");
      const pendingWasSet = await js<boolean>("window.__voicePending()");
      const scrollBefore = await js<number>(
        "(() => { const s = document.getElementById('scroller'); if (!s) return -1; s.scrollTop = 0; return s.scrollTop; })()",
      );
      // The slash branch is gated on `e.target.id === 'entry'`, so an Escape
      // dispatched on `document` would sail past it and prove nothing about
      // ordering. The slash case therefore strikes the key where the user
      // strikes it — in the textarea. The approval branch is the opposite:
      // it needs `!inText`, so its twin keeps dispatching on `document`.
      await js<unknown>(
        (label === "slash"
          ? "document.getElementById('entry')"
          : "document")
        + ".dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}))",
      );
      const after = await js<V>("window.__voice()");
      const d = await js<{ draft: string }>("window.__draft()");
      const scrollAfter = await js<number>(
        "(() => { const s = document.getElementById('scroller'); return s ? s.scrollTop : -1; })()",
      );
      return { after, draft: d.draft, scrollBefore, scrollAfter, slashWasOpen, pendingWasSet };
    };
    const e1 = await esc("", "clean");
    check(
      "Escape cancels a recording before every other Escape branch",
      e1.after.state === "idle" && e1.draft === "fix " && e1.scrollAfter === e1.scrollBefore,
      `state ${e1.after.state}, draft ${JSON.stringify(e1.draft)}, scrollTop ${e1.scrollBefore}→${e1.scrollAfter}`,
    );
    const slashOpen = await js<boolean>("!!document.querySelector('.slash')");
    const e2 = await esc("", "slash");
    check(
      "Escape still cancels with the slash popover open",
      slashOpen === false && e2.slashWasOpen === true && e2.after.state === "idle" && e2.draft === "/he",
      `popover open before Esc=${e2.slashWasOpen}, state ${e2.after.state}, draft ${JSON.stringify(e2.draft)}`,
    );
    await js<unknown>('window.__ctxDraft("")');
    const e3 = await esc("window.__voicePending(true)", "clean");
    await js<unknown>("window.__voicePending(false)");
    check(
      "Escape still cancels with an approval pending",
      e3.pendingWasSet === true && e3.after.state === "idle" && e3.draft === "fix ",
      `pending before Esc=${e3.pendingWasSet}, state ${e3.after.state}, draft ${JSON.stringify(e3.draft)}`,
    );
    await js<unknown>('window.__ctxDraft("")');

    // --- an error strip does not go on eating Escape ----------------------
    // Nothing else clears the error state, so if Escape cancelled from it the
    // next Escape struck anywhere — over a palette, a settings window, a
    // pending approval — would be swallowed for the rest of the session.
    await js<V>("window.__voiceSetError('the speech helper did not answer')");
    await js<unknown>(
      "document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}))",
    );
    const afterEsc = await js<V>("window.__voice()");
    const dismissed = await js<{ clicked: boolean; voice: V }>("window.__voiceDismiss()");
    const stripGone = await js<Strip>("window.__voiceStrip()");
    check(
      "an error strip keeps Escape and is dismissed by its own control",
      afterEsc.state === "error" && dismissed.clicked && dismissed.voice.state === "idle"
        && !!stripGone && stripGone.hidden && stripGone.empty,
      `after Escape ${afterEsc.state}, × present=${dismissed.clicked}, then ${dismissed.voice.state}`,
    );

    // --- the recording indicator is not re-created ten times a second -----
    // .micbtn.rec and .vsdot.live carry a CSS pulse, and a replaced element
    // restarts its animation at frame one — so the two nodes surviving a run
    // of transcript events IS the animation working.
    await js<V>("window.__voiceArm()");
    const marked = await js<{ dot: boolean; mic: boolean }>("window.__voiceMark()");
    for (const t of ["refactor", "refactor the login", "refactor the login handler"]) {
      await js<V>(`window.__voiceEvent({type:'partial', text:'${t}'})`);
    }
    const survived = await js<{ dot: boolean; mic: boolean; dotPresent: boolean; micPresent: boolean }>(
      "window.__voiceMarked()",
    );
    const stripLive = await js<Strip>("window.__voiceStrip()");
    await js<V>("window.__voiceCancel()");
    const afterShapeChange = await js<{ dot: boolean; micPresent: boolean }>("window.__voiceMarked()");
    check(
      "the recording pulse survives the transcript repaints, and the strip still leaves on cancel",
      marked.dot && marked.mic && survived.dot && survived.mic
        && !!stripLive && stripLive.text === "refactor the login handler"
        && afterShapeChange.dot === false && afterShapeChange.micPresent === true,
      `dot kept=${survived.dot} mic kept=${survived.mic}, text ${JSON.stringify(stripLive && stripLive.text)},`
      + ` dot after cancel=${afterShapeChange.dot}`,
    );
    await js<unknown>('window.__ctxDraft("")');

    // --- two languages at once -------------------------------------------
    // The helper's `replace`: both models heard the same audio and the
    // second scored higher, so its whole transcript wins the take.
    await js<V>("window.__voiceProbeSet({available:true, supported:['en-US','ru-RU'], installed:['en-US','ru-RU'], speech:['en-US'], dictation:['ru-RU'], locales:['en-US','ru-RU']})");
    await js<V>("window.__voiceArm()");
    await js<V>("window.__voiceEvent({type:'final', text:'at croy panel nastroyek'})");
    const rep = await js<V>("window.__voiceEvent({type:'replace', text:'Открой панель настроек', locale:'ru-RU', confidence:0.88})");
    const stripRep = await js<Strip>("window.__voiceStrip()");
    check(
      "a second language can win the take",
      rep.final === "Открой панель настроек" && rep.partial === "" && rep.winner === "ru-RU"
        && !!stripRep && stripRep.chip.includes("matched"),
      `final ${JSON.stringify(rep.final)}, winner ${rep.winner}, chip ${JSON.stringify(stripRep && stripRep.chip)}`,
    );
    const insRep = await js<{ draft: string }>("window.__voiceStop()");
    check(
      "and the winning language is what gets inserted",
      insRep.draft === "Открой панель настроек",
      JSON.stringify(insRep.draft),
    );
    await js<unknown>("window.__ctxDraft('')");

    // ...including the case the whole two-language feature exists for. On
    // Russian speech the en-US leg emits NOTHING — no partial, no final, no
    // score — so a take can arrive as a bare `replace` with no primary text
    // before it. Measured with the fixed helper on the review's fixture:
    //   $ cat rev-ru.raw | out/native/atomic-speech en-US ru-RU
    //   {"type":"replace","text":"Открой панель настроек …","locale":"ru-RU",
    //    "runnerUp":"en-US","runnerUpHeard":false,"confidence":0.826}
    // Before the fix that take reached the composer as an empty string.
    await js<V>("window.__voiceArm()");
    const bare = await js<V>(
      "window.__voiceEvent({type:'replace', text:'Открой панель настроек и переключи бэкенд на облако',"
      + " locale:'ru-RU', confidence:0.826, runnerUp:'en-US', runnerUpHeard:false})",
    );
    const stripBare = await js<Strip>("window.__voiceStrip()");
    const insBare = await js<{ draft: string }>("window.__voiceStop()");
    check(
      "a second language wins even when the first one heard nothing",
      bare.final === "Открой панель настроек и переключи бэкенд на облако" && bare.winner === "ru-RU"
        && !!stripBare && stripBare.text === bare.final
        && insBare.draft === "Открой панель настроек и переключи бэкенд на облако",
      `strip ${JSON.stringify(stripBare && stripBare.text)}, inserted ${JSON.stringify(insBare.draft)}`,
    );
    await js<unknown>("window.__ctxDraft('')");

    // --- the language menu says what is true ------------------------------
    // Opened the way an idle user opens it: the button's tooltip promises a
    // right-click, so the right-click is what the check performs.
    await js<unknown>(
      "document.querySelector('.composer .field .micbtn')"
      + ".dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true}))",
    );
    const menu = await js<Strip>("window.__voiceStrip()");
    check(
      "the language menu lists the on-device models and says one is active",
      !!menu && !menu.hidden && menu.menuRows === 2
        && menu.menuFoot.includes("One language is active at a time")
        && menu.menuFoot.includes("Russian"),
      menu ? `${menu.menuRows} rows, foot ${JSON.stringify(menu.menuFoot.slice(0, 60))}` : "no menu",
    );
    await js<V>("window.__voiceCancel()");
    await js<V>("window.__voiceReprobe()");

    // --- the + control, which is the only user route to a second language --
    // Everything above drives the state directly; these clicks go through the
    // menu the user actually sees, so voicePick() and the voice:setLocales
    // write are exercised rather than assumed.
    await js<V>(
      "window.__voiceProbeSet({available:true, supported:['en-US','ru-RU','de-DE','fr-FR'],"
      + " installed:['en-US','ru-RU','de-DE'], speech:['en-US','de-DE','fr-FR'], dictation:['ru-RU'],"
      + " locales:['en-US']})",
    );
    const menuOpened = await js<{ menu: boolean; rows: number }>("window.__voiceMenu(true)");
    type Pick = { clicked: boolean; locales: string[]; installing: string | null };
    const added = await js<Pick>("window.__voiceMenuClick('voice:add:ru-RU')");
    await wait(200);
    const storedPair = readVoicePrefs().locales;
    check(
      "the + control adds a second language and the choice is remembered",
      menuOpened.menu && menuOpened.rows === 4 && added.clicked
        && JSON.stringify(added.locales) === '["en-US","ru-RU"]'
        && JSON.stringify(storedPair) === '["en-US","ru-RU"]',
      `${menuOpened.rows} rows, after + ${JSON.stringify(added.locales)}, voice.json ${JSON.stringify(storedPair)}`,
    );
    const swapped = await js<Pick>("window.__voiceMenuClick('voice:pick:de-DE')");
    await wait(200);
    const storedSwap = readVoicePrefs().locales;
    check(
      "choosing a new first language keeps the second one",
      swapped.clicked && JSON.stringify(swapped.locales) === '["de-DE","ru-RU"]'
        && JSON.stringify(storedSwap) === '["de-DE","ru-RU"]',
      `after picking de-DE ${JSON.stringify(swapped.locales)}, voice.json ${JSON.stringify(storedSwap)}`,
    );
    // A language with no model on this Mac must route to the download, not
    // to the selection. The call site is spied on rather than called: a real
    // --install spends minutes downloading an Apple model onto the
    // operator's machine, which a smoke run has no business doing.
    await js<string[]>("window.__voiceInstallSpy(true)");
    const uninstalled = await js<Pick>("window.__voiceMenuClick('voice:pick:fr-FR')");
    const asked = await js<string[]>("window.__voiceInstallSpy(false)");
    const afterInstall = await js<V>("window.__voice()");
    check(
      "an uninstalled language goes to the download, not to the selection",
      uninstalled.clicked && JSON.stringify(asked) === '["fr-FR"]'
        && JSON.stringify(afterInstall.locales) === '["de-DE","ru-RU"]',
      `install asked for ${JSON.stringify(asked)}, languages still ${JSON.stringify(afterInstall.locales)}`,
    );
    await js<V>("window.__voiceMenu(false)");
    await js<V>("window.__voiceReprobe()");

    // --- the permission gate ----------------------------------------------
    // Live, in the renderer: video must be refused outright. The audio twin
    // is asserted main-side below instead, because a granted audio request
    // would open the operator's real microphone.
    const cam = await js<string>(
      "navigator.mediaDevices.getUserMedia({video:true}).then(() => 'GRANTED', (e) => e.name)",
    );
    check("the renderer cannot take the camera", cam === "NotAllowedError", `getUserMedia({video:true}) → ${cam}`);
    // The very function both handlers call — not a copy of it.
    check(
      "and cannot take the microphone outside a session the user started",
      voicePermissionVerdict("media", { mediaTypes: ["audio"] }) === false
        && voicePermissionVerdict("media", { mediaTypes: ["audio", "video"] }) === false
        && voicePermissionVerdict("geolocation", undefined) === false,
      `armed=${voice.armed}; audio→${voicePermissionVerdict("media", { mediaTypes: ["audio"] })}`,
    );
    // ...and the gate did not take the clipboard down with it. Electron sees a
    // writeText as `clipboard-sanitized-write`; a deny-all handler turns the
    // permission state to "denied" and the composer's silent "copy session id"
    // stops copying. The operator's own clipboard is restored below.
    const { clipboard } = require("electron") as typeof import("electron");
    // Focus first. Chromium refuses a writeText from an unfocused document
    // before it ever consults the permission layer ("Document is not
    // focused"), and on a machine running several of these windows at once
    // that made this check pass without testing anything — which is how a
    // real denial survived two green runs.
    BrowserWindow.getAllWindows()[0]?.focus();
    win?.webContents.focus();
    await wait(300);
    // Electron 44's clipboard module really is promise-based — see
    // node_modules/electron/electron.d.ts:6996, `readText(): Promise<string>`,
    // "modeled after the W3C navigator.clipboard.readText API", and
    // writeText(): Promise<void> beside it. Dropping the awaits does not
    // compile.
    //
    // The operator's pasteboard is theirs. This check writes to it, and the
    // only content it can put back afterwards is plain text — so when the
    // clipboard is holding anything else (a screenshot, a file, a bookmark)
    // the live half is skipped entirely rather than destroying it. The
    // verdict half below still runs and is the part that cannot go vacuous.
    const clipBefore = await clipboard.readText();
    const clipItems = await clipboard.read().catch(() => [] as Electron.ClipboardItem[]);
    const clipTypes = clipItems.flatMap((i) => i.types);
    // A plain-text copy on macOS reports `text/plain` plus a handful of
    // `electron application/osclipboard;format="…"` mirrors of the same
    // bytes (NSStringPboardType, the source URL, the find buffer) — those are
    // metadata, not a second payload, so they must not count as "something I
    // cannot put back" or this half of the check never runs at all. An
    // image, a file, or a rich-text copy does carry a payload that writeText
    // cannot restore, and for those the live write is skipped.
    const clipUnrestorable = (t: string): boolean =>
      /^image\//i.test(t) || t === "text/html" || t === "text/rtf" || t === "text/uri-list"
      || /bookmark/i.test(t)
      || /public\.(png|tiff|jpeg|file-url)|NSFilenamesPboardType/i.test(t);
    const clipRestorable = clipTypes.length === 0
      || (clipTypes.includes("text/plain") && !clipTypes.some(clipUnrestorable));
    const clip = await js<{ perm: string; write: string }>(
      "(async () => { let perm = 'n/a';"
      + " try { perm = (await navigator.permissions.query({name:'clipboard-write'})).state; }"
      + " catch (e) { perm = 'query-threw:' + e.name; }"
      + " let write = " + (clipRestorable ? "'OK'" : "'skipped (the operator has non-text on the clipboard)'") + ";"
      + (clipRestorable
        ? " try { await navigator.clipboard.writeText('atomic-desktop-smoke'); }"
          + " catch (e) { write = e.name + ': ' + e.message; }"
        : "")
      + " return {perm, write}; })()",
    );
    // Restore only what we actually disturbed. The write has to have
    // succeeded for there to be anything to put back; an empty pasteboard is
    // returned to empty rather than left holding the probe string.
    if (clip.write === "OK" && clipRestorable) {
      if (clipBefore) await clipboard.writeText(clipBefore);
      else clipboard.clear();
    }
    // The live write can still be blocked by focus on a busy machine, so the
    // verdict itself is asserted directly as well — that half cannot go
    // vacuous. `clipboard-read` is in it because that is the permission a
    // writeText asks for with no user gesture behind it (see the predicate).
    const clipVerdicts = voicePermissionVerdict("clipboard-sanitized-write", undefined)
      && voicePermissionVerdict("clipboard-read", undefined);
    check(
      "the voice permission gate leaves the clipboard alone",
      clipVerdicts && clip.perm === "granted" && !/permission denied/i.test(clip.write),
      `verdicts sanitized-write+read=${clipVerdicts}; permissions.query(clipboard-write) → ${clip.perm};`
      + ` writeText → ${clip.write}${/not focused/i.test(clip.write) ? " (the live write did not reach the gate)" : ""}`
      + `; pasteboard held ${clipTypes.length ? clipTypes.join("+") : "nothing"}`,
    );

    // --- what actually ships ----------------------------------------------
    check(
      "the worklet ships next to the renderer",
      existsSync(join(__dirname, "..", "renderer", "voice-worklet.js")),
      join(__dirname, "..", "renderer", "voice-worklet.js"),
    );
    const helper = speechHelperPath();
    if (!existsSync(helper)) {
      process.stdout.write(`SKIP speech helper not built — ${helper}\n`);
    } else {
      const probe = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(helper, ["--probe"], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: null, out }); }, 8000);
        child.stdout.on("data", (b: Buffer) => { out += b.toString("utf8"); });
        child.on("error", () => { clearTimeout(timer); resolve({ code: null, out }); });
        child.on("close", (code: number | null) => { clearTimeout(timer); resolve({ code, out }); });
      });
      let supported: string[] = [];
      let installed: string[] = [];
      try {
        const obj = JSON.parse(probe.out.split("\n").find((l) => l.trim().startsWith("{")) ?? "") as {
          supported?: string[]; installed?: string[];
        };
        supported = obj.supported ?? [];
        installed = obj.installed ?? [];
      } catch { /* asserted below */ }
      check(
        "the speech helper answers",
        probe.code === 0 && supported.includes("en-US") && installed.every((l) => supported.includes(l)),
        `exit ${probe.code}, ${supported.length} supported, ${installed.length} installed`,
      );
    }

    // --- nothing was written to the agent ---------------------------------
    const agentCfgAfter = JSON.stringify((await configGet()).config);
    check(
      "nothing was written to the agent",
      agentCfgBefore === agentCfgAfter,
      agentCfgBefore === agentCfgAfter
        ? `config.json byte-identical across ${agentCfgAfter.length} bytes`
        : "the agent's config.json changed during the voice suite",
    );
  } finally {
    await js<unknown>("window.__voiceInstallSpy(false)").catch(() => undefined);
    await js<unknown>("window.__voiceMenu(false)").catch(() => undefined);
    await js<unknown>("window.__voiceCancel()").catch(() => undefined);
    await js<unknown>("window.__ctxDraft(" + JSON.stringify(draftBefore ?? "") + ")").catch(() => undefined);
    try {
      if (voiceJsonBefore === null) rmSync(voiceJson, { force: true });
      else writeFileSync(voiceJson, voiceJsonBefore);
    } catch { /* the language choice is a preference; a failed restore is not worth failing the suite */ }
    // Put the renderer's languages back exactly as they were, including the
    // case where the probe had not answered yet when this suite started.
    const restore = before && Array.isArray(before.locales) && before.locales.length
      ? before.locales
      : ["en-US"];
    await js<unknown>(
      `window.__voiceProbeSet({locales:${JSON.stringify(restore)}})`,
    ).catch(() => undefined);
    await js<unknown>("window.__voiceReprobe()").catch(() => undefined);
  }
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
  // r4-ui item 5: the user asked for Go and Observe to leave the menu, so the
  // eight Manage children are a top-level group now and the TUI's `Go` group is
  // gone. This is a deliberate divergence recorded at MENU_GROUPS in renderer.js,
  // not a relaxed assertion — the rest of the tree is still the registry's.
  const GROUPS = ["Manage", "Session", "Model", "Run", "Setup", "Help", "Danger zone"];
  const TABS = ["tasks", "skills", "memory", "mcp", "llm", "telegram", "import", "privacy"];
  const LABELS = ["Tasks", "Skills", "Memory", "MCP", "LLM", "Telegram", "Import", "Privacy"];

  const groups = await js<string[]>("window.__menuGroups()");
  check("settings: menu groups are the TUI's minus Go and Observe", same(groups, GROUPS), JSON.stringify(groups));
  const tabs = await js<string[]>("window.__settingsTabs()");
  check("settings: tab ids mirror MANAGE_TABS", same(tabs, TABS), JSON.stringify(tabs));

  // Every node of the menu tree, verbatim label and ctrl+g chord, in registry
  // order (src/tui/menu/menu-registry.ts:107-675) — except that Go, Observe and
  // the debug pane are gone and Manage's eight children are their own group,
  // with their labels and chords unchanged.
  const NODES: Array<[string, string, string | null]> = [
    ["Manage", "Tasks", "t"], ["Manage", "Skills", "s"], ["Manage", "Memory", "m"], ["Manage", "MCP", "c"],
    ["Manage", "LLM", "l"], ["Manage", "Telegram", "g"], ["Manage", "Import", "i"], ["Manage", "Privacy", "p"],
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
  // `go.observe.world` used to prove this; that node is gone. `help.tools` is
  // the surviving verb with the same observable result (the inspector on its
  // World tab) and, unlike `session.context`, it leaves no overlay open across
  // the checks that follow.
  const dispatched = await js<{ settings: boolean; inspector: boolean; inspTab: string; overlay: string | null }>("window.__menuActivate('help.tools')");
  check(
    "settings: a menu verb dispatches its desktop act",
    !dispatched.settings && dispatched.inspector && dispatched.inspTab === "world" && !dispatched.overlay,
    JSON.stringify(dispatched),
  );
  const gone = await js<{ ids: string[]; subs: number; rows: number }>(
    "(() => { window.__settingsOpen('tasks');"
    + " return {ids: window.__menuNodes().filter((n) => /^go[.](run|observe|debug)/.test(n.id) || n.parent).map((n) => n.id),"
    + " subs: window.__menuSubRows(), rows: document.querySelectorAll('#settings .setmenu .menurow').length}; })()",
  );
  check(
    "settings: Go, Observe and the debug pane left the tree",
    gone.ids.length === 0 && gone.subs === 0 && gone.rows === 32,
    JSON.stringify(gone),
  );
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
 * Item 7A (add a model from Hugging Face) and item 7C (mid-turn steering,
 * the persisted context gauge, the session's model stamp).
 *
 * STATE DIR. Two checks here write config — the add and its re-add — and
 * both undo themselves through the product's own path (`atag models
 * remove <custom-id>` deletes the files AND drops the config entry for a
 * custom row), in a `finally`, against a snapshot taken first. Run the
 * suite with ATOMIC_AGENT_STATE_DIR pointed somewhere disposable: without
 * it, `agent-cli.ts` resolves `~/.atomic-agent` and these write the
 * operator's real file.
 *
 * NOTHING HERE DOWNLOADS A MODEL. The heaviest network call is one
 * ~2 KB repo listing; the add is asserted at the config, and the pull is
 * never started.
 */
async function hfAndDeltaTest(
  js: <T>(code: string) => Promise<T>,
  check: (name: string, ok: boolean, detail?: string) => void,
  sessionWithTurns: string,
): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  type Hf = {
    open: boolean; step: string; reference: string; busy: boolean; error: string | null;
    repoId: string | null; revision: string | null; choices: number; first: string | null; filenames: string[];
    mmproj: string | null; hidden: string | null; cursor: number; ram: number; pendingMmproj: string | null;
    rows: number; pulling: { id: string; phase?: string } | null; daemonPhase: string | null; confirm: string | null;
  };
  const networkDown = (e: string | null) => !!e && e.startsWith("Could not reach huggingface.co");

  // ---- the row and the key are live ----
  await js<Hf>("window.__llmOpen('local')");
  const localBody0 = await js<string>("window.__settingsBody()");
  const rowLive = await js<boolean>(
    "[...document.querySelectorAll('#settings button')].some((b) => b.textContent === 'a add from hugging face' && !b.disabled)",
  );
  check(
    "llm tab: the Hugging Face row is live and the Local pane signposts Ollama",
    rowLive && localBody0.includes("a add from hugging face")
      && localBody0.includes("Ollama is not a download source on this agent")
      && localBody0.includes("Ollama (local)") && localBody0.includes("http://localhost:11434"),
    `row enabled=${rowLive}`,
  );
  /* Review fix: the check above only proved the signpost's own text
     exists. The path it points at is a different object — the Cloud
     wizard's preset array — so it is asserted separately, off the array
     the wizard renders from. Renaming or deleting the preset now fails
     here, which the copy check alone could never notice. */
  const ollamaPreset = await js<{ id: string; label: string; baseUrl: string; kind: string; local: boolean } | null>(
    "window.__preset('ollama')",
  );
  check(
    "llm tab: the Ollama signpost points at a preset that is really there",
    !!ollamaPreset && ollamaPreset.label === "Ollama (local)"
      && ollamaPreset.baseUrl === "http://localhost:11434"
      && ollamaPreset.kind === "openai-compatible" && ollamaPreset.local === true
      && localBody0.includes(ollamaPreset.label) && localBody0.includes(ollamaPreset.baseUrl),
    JSON.stringify(ollamaPreset),
  );
  /* And the other half of the promise: this window never reads Ollama's
     own model store. Asserted over the BUILT bundle, anchored to a PATH
     SEGMENT rather than the bare substring — `result.ollama` in
     agent-cli.js is a property name, not a directory.

     The needle is assembled at runtime on purpose: written as a literal
     it would appear in this very file and the scan would flag itself. */
  const outDir = join(__dirname, "..");
  const storeSegment = new RegExp('["\'`/\\\\]\\.' + "ollama\\b", "g");
  const bundleHits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!/\.(js|html|css|json)$/.test(entry.name)) continue;
      const m = readFileSync(p, "utf8").match(storeSegment);
      if (m) bundleHits.push(`${entry.name}: ${m.length}`);
    }
  };
  try { walk(outDir); } catch (err) { bundleHits.push(`could not read ${outDir}: ${String(err)}`); }
  check(
    "llm tab: the built bundle builds no path into Ollama's own store - it is a provider here, never a store",
    bundleHits.length === 0,
    bundleHits.length ? bundleHits.join("; ") : `scanned ${outDir}`,
  );
  const opened = await js<Hf>("window.__llmHfOpen()");
  const refBody = await js<string>("window.__settingsBody()");
  const refCopy = [
    "Which model?", "(it has to be a GGUF build)",
    "unsloth/Qwen3.5-4B-GGUF · https://huggingface.co/owner/repo · a link to one .gguf",
    "enter look it up", "ctrl+l clear", "esc back to the list",
  ];
  const refMissing = refCopy.filter((c) => !refBody.includes(c));
  const hasInput = await js<boolean>("!!document.getElementById('llm-hf-ref')");
  check(
    "hf: `a` opens the reference editor with the TUI's copy",
    opened.open && opened.step === "ref" && refMissing.length === 0 && hasInput,
    refMissing.length ? `missing ${JSON.stringify(refMissing)}` : `ram=${opened.ram} input=${hasInput}`,
  );

  // ---- a bad reference is refused with the agent's own sentence ----
  const bad = await js<Hf>("window.__llmHfResolve('not a ref at all')");
  const badBody = await js<string>("window.__settingsBody()");
  const badWanted = 'Not a Hugging Face URL or an owner/name id: "not a ref at all"';
  const ds = await js<Hf>("window.__llmHfResolve('hf://datasets/foo/bar')");
  check(
    "hf: a bad reference shows the parser's own sentence, not 'invalid input'",
    bad.error === badWanted && bad.repoId === null && badBody.includes(badWanted)
      && ds.error === "hf://datasets/… points at a dataset, not a model repo",
    `${JSON.stringify(bad.error)} / ${JSON.stringify(ds.error)}`,
  );

  /* Review fix: the desktop's own added sentence on that 401 — the only
     string this feature authored on top of the port, and the only place
     `dotenvKeys`/`envPresent` are consulted from the HF path. Driven over
     a throwaway directory so it needs neither a gated repo nor a token in
     the operator's own .env — and so "names only, never values" is
     demonstrable: the file below holds a value the message must not show. */
  const hintDir = join(app.getPath("temp"), `atag-hf-hint-${process.pid}`);
  const base401 = "Hugging Face returned 401: either no such repo, or it is gated.";
  const base403 = "Hugging Face returned 403: either no such repo, or it is gated.";
  const base404 = "Hugging Face returned 404: no repo or revision by that name.";
  let hintWith = "";
  let hintWithout = "";
  let hintOther = "";
  try {
    mkdirSync(hintDir, { recursive: true });
    writeFileSync(join(hintDir, ".env"), "HF_TOKEN=hf_not-a-real-token\n");
    hintWith = hfGatedTokenHint(base401, hintDir);
    hintOther = hfGatedTokenHint(base404, hintDir);
    rmSync(join(hintDir, ".env"), { force: true });
    hintWithout = hfGatedTokenHint(base403, hintDir);
  } finally {
    rmSync(hintDir, { recursive: true, force: true });
  }
  // Exported in this process, the hint would be a lie — `models pull` and
  // this window would both already see it — so it is correctly withheld.
  const tokenExported = envPresent(["HF_TOKEN"]).length > 0;
  const hintWanted = tokenExported
    ? base401
    : base401 + ` (HF_TOKEN is named in ${hintDir}/.env, which \`atag models pull\` reads and this window does not`
      + " — start the app with it exported and the listing will see it too.)";
  check(
    "hf: a 401 with a token named in <stateDir>/.env says where `models pull` reads it, and never its value",
    hintWith === hintWanted && !hintWith.includes("hf_not-a-real-token")
      && hintWithout === base403 && hintOther === base404,
    `${JSON.stringify(hintWith)}${tokenExported ? " (HF_TOKEN is exported here, so the hint is withheld)" : ""}`,
  );

  // ---- every paste form parses (network-gated) ----
  const forms = [
    "unsloth/Qwen3-4B-GGUF",
    "https://huggingface.co/unsloth/Qwen3-4B-GGUF",
    "https://huggingface.co/unsloth/Qwen3-4B-GGUF/tree/main",
    "hf.co/unsloth/Qwen3-4B-GGUF",
    "hf://unsloth/Qwen3-4B-GGUF",
    "hf download unsloth/Qwen3-4B-GGUF Qwen3-4B-Q4_K_M.gguf --local-dir .",
  ];
  const parsed: string[] = [];
  let offline = false;
  for (const f of forms) {
    const r = await js<Hf>(`window.__llmHfResolve(${JSON.stringify(f)})`);
    if (networkDown(r.error)) { offline = true; break; }
    parsed.push(`${f} -> ${r.repoId ?? "ERR " + r.error}`);
  }
  check(
    "hf: every paste form the TUI accepts resolves to the same repo",
    offline || parsed.every((p) => p.endsWith("-> unsloth/Qwen3-4B-GGUF")),
    offline ? "skipped - huggingface.co is unreachable from this run" : JSON.stringify(parsed),
  );

  if (!offline) {
    // ---- ranking, the hidden tally, the projector line, the 6-row window ----
    const qwen = await js<Hf>("window.__llmHfResolve('unsloth/Qwen3-4B-GGUF')");
    const qwenBody = await js<string>("window.__settingsBody()");
    const painted = await js<number>("document.querySelectorAll('#settings [data-llm-row^=\"hf:\"]').length");
    // Anchored to the code's own predicates rather than a looser regex: a
    // quant whose name merely contains "f16" without a delimiter is
    // correctly offered by isFullPrecisionGguf.
    const rejects = /(^|[-_.])(?:f16|f32|bf16|fp16|fp32)(?=[-_.]|\.gguf$)|-\d{5}-of-\d{5}\.gguf$|(^|\/)mmproj[^/]*\.gguf$/i;
    check(
      "hf: choices are quant-ranked, windowed to 6, and hide what cannot be served",
      qwen.step === "pick" && !!qwen.first && qwen.first.includes("Q4_K_XL")
        && painted === Math.min(6, qwen.choices) && qwen.choices > 6
        && qwenBody.includes("↓ " + (qwen.choices - 6) + " more")
        && qwen.hidden === "1 more file hidden: 1 full-precision"
        && qwen.filenames.every((f) => !rejects.test(f)),
      `${qwen.choices} choices led by ${JSON.stringify(qwen.first)}, ${painted} painted, hidden ${JSON.stringify(qwen.hidden)}`,
    );

    // Escape steps back to the reference and keeps the repo; a second one leaves.
    const backOnce = await js<Hf>("window.__llmHfKey('Escape')");
    const closeOnce = await js<Hf>("window.__llmHfKey('Escape')");
    check(
      "hf: Escape steps back to the reference with the repo intact, then leaves the branch",
      backOnce.step === "ref" && backOnce.open && backOnce.repoId === "unsloth/Qwen3-4B-GGUF" && !closeOnce.open,
      `${backOnce.step}/${backOnce.repoId} then open=${closeOnce.open}`,
    );

    // A repo that is not a GGUF conversion refuses with the real sentence.
    await js<Hf>("window.__llmHfOpen()");
    const none = await js<Hf>("window.__llmHfResolve('meta-llama/Llama-3.1-8B-Instruct')");
    check(
      "hf: a repo that is not a GGUF conversion says exactly why",
      none.error === "No .gguf files in meta-llama/Llama-3.1-8B-Instruct — that is the original model, not a GGUF conversion of it. Look for a \"-GGUF\" repo of the same name.",
      JSON.stringify(none.error),
    );

    /* Review fix: the gated-repo arm — one of the four messages the
       spec's drift mitigation names, and the only one that was
       unasserted. huggingface.co answers 401 for a repo that is private
       OR absent (it will not say which), so a repo id nobody owns drives
       the real listing call into the real 401 branch without needing a
       gated repo or a token. The sentence is the PORT's, byte for byte. */
    const gated = await js<Hf>("window.__llmHfResolve('atag-smoke-no-such-owner-9f3a/does-not-exist')");
    const gatedWanted = "Hugging Face returned 401: either no such repo, or it is gated. "
      + (huggingFaceToken()
        ? "Your HF_TOKEN does not grant access — accept the licence on huggingface.co."
        : "If it is gated, accept its licence on huggingface.co and export HF_TOKEN.");
    const gatedBody = await js<string>("window.__settingsBody()");
    check(
      "hf: a gated or absent repo shows the port's own 401 sentence",
      networkDown(gated.error)
        || (gated.error === gatedWanted && gated.repoId === null && gatedBody.includes(gatedWanted)),
      networkDown(gated.error) ? "skipped - huggingface.co is unreachable from this run" : JSON.stringify(gated.error),
    );

    // The vision repo: one servable quant, a projector, the hidden tally.
    const vis = await js<Hf>("window.__llmHfResolve('ggml-org/SmolVLM-256M-Instruct-GGUF')");
    const visBody = await js<string>("window.__settingsBody()");
    check(
      "hf: a vision repo offers its one servable quant and says the projector comes with it",
      vis.choices === 1 && vis.mmproj === "mmproj-SmolVLM-256M-Instruct-Q8_0.gguf"
        && vis.hidden === "3 more files hidden: 1 full-precision, 2 vision projector"
        && visBody.includes("vision projector in this repo — it is pulled alongside")
        && visBody.includes(vis.hidden),
      `${vis.choices} choice(s), mmproj ${vis.mmproj}, hidden ${JSON.stringify(vis.hidden)}`,
    );

    // The fit verdict warns in one direction and disables nothing.
    const ram = await js<number>("window.atomic.hostRam()");
    const huge = {
      repoId: "smoke/huge-GGUF", revision: "main", mmproj: null, hidden: null,
      choices: [{ path: "huge-Q4_K_M.gguf", filename: "huge-Q4_K_M.gguf", sizeBytes: 0, fileSizeGb: ram + 8, sizeLabel: `${ram + 8}.0 GB` }],
    };
    const warned = await js<Hf>(`window.__llmHfFakeRepo(${JSON.stringify(huge)})`);
    const warnBody = await js<string>("window.__settingsBody()");
    const wantWarn = `⚠ ${(ram + 8).toFixed(1)} GB model, ${ram} GB of RAM — it will run from disk, slowly.`;
    const small = { ...huge, choices: [{ ...huge.choices[0]!, fileSizeGb: 0.2, sizeLabel: "200 MB" }] };
    await js<Hf>(`window.__llmHfFakeRepo(${JSON.stringify(small)})`);
    const smallBody = await js<string>("window.__settingsBody()");
    check(
      "hf: the RAM line warns above host memory, says nothing below it, and disables nothing",
      warnBody.includes(wantWarn) && !smallBody.includes("GB of RAM — it will run from disk")
        && warned.step === "pick" && warned.choices === 1,
      `warn present=${warnBody.includes(wantWarn)} (${JSON.stringify(wantWarn)}); small pane warns=${smallBody.includes("GB of RAM — it will run from disk")}`,
    );

    // ---- the def is the agent's builder's, and asking for it writes nothing ----
    await js<Hf>("window.__llmHfResolve('ggml-org/SmolVLM-256M-Instruct-GGUF')");
    const cfgBeforeDef = JSON.stringify((await configGet()).config);
    type Def = { ok: boolean; def?: Record<string, unknown>; error?: string };
    const built = await js<Def>("window.__llmHfDef(0)");
    const cfgAfterDef = JSON.stringify((await configGet()).config);
    const d = built.def ?? {};
    const id = String(d.id ?? "");
    check(
      "hf: the def is buildCustomModelDef's, and asking for it writes no config",
      built.ok && cfgBeforeDef === cfgAfterDef
        && id === "custom-ggml-org-smolvlm-256m-instruct-gguf-smolvlm-256m-instruct-q8_0"
        && id.length <= 87 && /^custom-[a-z0-9._-]{1,80}$/.test(id)
        && d.family === "custom" && d.filename === "SmolVLM-256M-Instruct-Q8_0.gguf"
        && d.huggingFaceUrl === "https://huggingface.co/ggml-org/SmolVLM-256M-Instruct-GGUF/resolve/main/SmolVLM-256M-Instruct-Q8_0.gguf"
        && d.maxContextLength === 0 && d.contextLabel === "auto" && d.supportsVision === true
        && d.mmprojFilename === "mmproj-SmolVLM-256M-Instruct-Q8_0.gguf",
      `${id} (${id.length} chars)${cfgBeforeDef === cfgAfterDef ? "" : " - CONFIG CHANGED"}`,
    );

    // ---- the add: one array element, nothing else, and no download ----
    type Cfg = { localModels?: { customModels?: Array<{ id?: string }>; managed?: Record<string, unknown> } };
    const snapshot = ((await configGet()).config ?? {}) as Cfg;
    const beforeCustom = JSON.stringify(snapshot.localModels?.customModels ?? []);
    const beforeManaged = JSON.stringify(snapshot.localModels?.managed ?? {});
    try {
      const added = await js<Hf & { started: { id: string } | null }>("window.__llmHfAddNoDownload(0)");
      const cfg1 = ((await configGet()).config ?? {}) as Cfg;
      const list1 = await modelsList();
      const row = (list1.models ?? []).find((m) => m.id === id);
      check(
        "hf: the add writes one customModels entry, leaves managed alone and hands off to `models pull`",
        (cfg1.localModels?.customModels ?? []).length === (JSON.parse(beforeCustom) as unknown[]).length + 1
          && JSON.stringify(cfg1.localModels?.managed ?? {}) === beforeManaged
          && !!row && row.family === "custom" && row.downloaded === false
          && !added.open && !!added.started && added.started.id === id && added.pulling === null,
        `row=${JSON.stringify(row)}; customModels ${(JSON.parse(beforeCustom) as unknown[]).length} -> ${(cfg1.localModels?.customModels ?? []).length}; handed off to ${JSON.stringify(added.started)}`,
      );
      // Re-adding the same repo+file is a refresh: the schema rejects
      // duplicate ids, so a second successful write proves it too.
      const readd = await addCustomModelEntry(built.def as Record<string, unknown>);
      const cfg2 = ((await configGet()).config ?? {}) as Cfg;
      const sameId = (cfg2.localModels?.customModels ?? []).filter((m) => m.id === id);
      check(
        "hf: re-adding the same repo+file refreshes the entry instead of duplicating it",
        readd.ok && sameId.length === 1,
        `${sameId.length} entries for ${id}${readd.ok ? "" : " - " + String(readd.error)}`,
      );
    } finally {
      // The product's own undo: `models remove` deletes the files AND drops
      // the config entry for a custom row, which is why no bespoke remove
      // path exists in this window.
      const removed = await modelsRemove(id);
      const cfg3 = ((await configGet()).config ?? {}) as Cfg;
      check(
        "hf: `atag models remove` is the whole undo - customModels comes back byte-identical",
        removed.ok && JSON.stringify(cfg3.localModels?.customModels ?? []) === beforeCustom,
        `${removed.ok ? "removed" : String(removed.error)}; customModels=${JSON.stringify(cfg3.localModels?.customModels ?? [])}`,
      );
      await js<Hf>("window.__llmHfClose()");
    }
  }

  // ---- the id guard the add needs, network or no network ----
  const longId = "custom-" + "a".repeat(80); // 87 chars, buildCustomModelId's ceiling
  const guards = [await modelsUse(longId), await modelsRemove(longId), await modelsPullGuard(longId)];
  check(
    "hf: an 87-character custom id reaches the CLI instead of this window's own regex",
    guards.every((g) => !String(g.error ?? "").startsWith("not a model id")) && guards.every((g) => !g.ok),
    guards.map((g) => JSON.stringify(String(g.error ?? "").slice(0, 40))).join(" | "),
  );

  // ---- the branch swallows every key it does not name ----
  await js<Hf>("window.__llmHfOpen()");
  const swallowed: Hf[] = [];
  for (const k of ["s", "d", "B", "G"]) swallowed.push(await js<Hf>(`window.__llmHfKey(${JSON.stringify(k)})`));
  const afterKeys = swallowed[swallowed.length - 1]!;
  check(
    "hf: a stray letter under the open editor starts no daemon and opens no confirm",
    swallowed.every((x) => x.open) && afterKeys.daemonPhase === null
      && afterKeys.confirm === null && afterKeys.pulling === null,
    `daemonPhase=${afterKeys.daemonPhase} confirm=${afterKeys.confirm} pulling=${afterKeys.pulling ? afterKeys.pulling.id : null}`,
  );
  await js<Hf>("window.__llmHfClose()");

  /* ---- a projector that did not land holds activation back ----
     Review fix: llmAfterPull used to run llmPrimary() unconditionally, so
     a failed or cancelled mmproj download still went pull -> use ->
     start. `models start` appends --mmproj only when the file is on disk
     (models-handlers.ts isMmprojDownloaded), so the operator got a
     running daemon serving a vision model text-only, with nothing saying
     why. The real cli:hfProjector call is driven into its own filename
     guard, which refuses before any network or filesystem access - the
     same {ok:false} the download-error and cancel arms produce. */
  type AfterPull = { projector: string; activated: boolean; skipped: boolean; msg: string | null; body: string; pulling: unknown };
  const mmFailed = await js<AfterPull>("window.__llmAfterPullProbe('bad/name.gguf')");
  check(
    "hf: a projector that did not land blocks auto-activation and says so on the pane",
    mmFailed.projector === "failed" && mmFailed.activated === false && mmFailed.skipped === true
      && mmFailed.pulling === null
      && typeof mmFailed.msg === "string"
      && mmFailed.msg.includes("unsafe projector filename")
      && mmFailed.msg.includes("the model was not started: it would serve text only")
      && mmFailed.body.includes("the model was not started: it would serve text only"),
    `${JSON.stringify(mmFailed.msg)} activated=${mmFailed.activated} skipped=${mmFailed.skipped} painted=${mmFailed.body.includes("it would serve text only")}`,
  );
  await js<void>("window.__settingsClose()");

  /* ---- the first-run row into the same branch ----
     Review fix: obAction('hf') assigned S.settings/S.settingsPane by hand
     and so skipped llmTabEntered(), which is what starts the 5 s `models
     status` poll and issues the first llmRefresh(). Escaping out of the
     branch then landed on a Local pane reading "no models listed" on a
     machine that has them, with nothing to refresh it. */
  const obLabel = await js<string>("window.__obHfRowLabel()");
  type ObHf = {
    pane: string; settings: boolean; branch: boolean; mode: string; polling: boolean;
    refreshed: boolean; rows: number; body: string;
  };
  const obHf = await js<ObHf>("window.__obHfProbe()");
  check(
    "hf: the first-run row enters the LLM tab properly - the Local pane behind it is loaded, not empty",
    obLabel === "Add a model from Hugging Face…"
      && obHf.settings && obHf.pane === "llm" && obHf.mode === "local" && obHf.branch
      && obHf.polling && obHf.refreshed && obHf.rows >= 0
      && obHf.body.includes("a add from hugging face"),
    `label=${JSON.stringify(obLabel)} pane=${obHf.pane} polling=${obHf.polling} refreshed=${obHf.refreshed} rows=${obHf.rows}`,
  );
  await js<void>("window.__settingsClose()");

  /* ------------------------------------------------------------------
     Item 7C - mid-turn steering.
     ------------------------------------------------------------------ */
  const menu = await js<Array<{ id: string; na: boolean }>>("window.__menuNodes()");
  const steerRow = menu.find((n) => n.id === "run.steer");
  check(
    "steer: the menu row is no longer marked unavailable",
    !!steerRow && steerRow.na === false,
    JSON.stringify(steerRow),
  );

  /* ---- the GET leg, and its wiring on openSession ----
     Review fix: the route was plumbed end to end (agent-client ->
     agent:undeliveredSteers -> atomic.undeliveredSteers) and never
     called, so the only recovery for a steer the route already accepted
     was the `steer_undelivered` SSE frame - which a window that missed
     the turn never sees, leaving those messages parked forever. */
  await js<void>(`window.__openSession(${JSON.stringify(sessionWithTurns)})`);
  await wait(1500);
  type Undel = { ok?: boolean; error?: string; data?: { sessionId?: string; undelivered?: unknown[]; discarded?: number } };
  const undel = await js<Undel>(`window.__undelivered(${JSON.stringify(sessionWithTurns)})`);
  const wiredRecovery = await js<{ id: string; parked: number; discarded: number } | null>("window.__steerRecovery()");
  const queuedBefore = await js<string[]>("window.__queued()");
  const recovered = await js<{ queued: string[]; ahead: number; lines: string[]; recovery: { parked: number } | null }>(
    `window.__recoverSteers(${JSON.stringify(sessionWithTurns)})`,
  );
  check(
    "steer: the GET leg answers and openSession runs it, so an accepted steer is never stranded",
    undel.ok === true && !!undel.data && Array.isArray(undel.data.undelivered)
      && !!wiredRecovery && wiredRecovery.id === sessionWithTurns
      && !!recovered.recovery
      && recovered.recovery.parked === (undel.data.undelivered as unknown[]).length
      && (recovered.recovery.parked === 0
        ? JSON.stringify(recovered.queued) === JSON.stringify(queuedBefore)
        : recovered.queued.length === queuedBefore.length + recovered.recovery.parked),
    `route=${JSON.stringify(undel.ok === true ? undel.data : undel.error)}; openSession recovery=${JSON.stringify(wiredRecovery)}`,
  );

  /* Review fix: the check above passes with an empty store, where its own
     ternary degrades to "nothing happened" — so the recovery BODY (the
     unshift to the front, the STEER.ahead watermark, the sentence and the
     mandatory DELETE) was executed by nothing in the suite. This drives
     the real recoverParkedSteers over a fixed answer, the same technique
     the `steer_undelivered` frame is asserted with. */
  type Park = {
    queued: string[]; ahead: number; added: string[];
    acks: Array<{ id: string; seq: number; discarded: number }>;
    recovery: { id: string; parked: number; discarded: number } | null;
  };
  await js<number>("window.__clearQueue()");
  await js<number>("window.__seedQueue(2)");
  const parked = await js<Park>(
    "window.__steerParkProbe([{seq:4, text:'the first parked one', parked_at:1}, {seq:7, text:'and the second', parked_at:2}], 3)",
  );
  const parkedNone = await js<Park>("window.__steerParkProbe([], 0)");
  await js<number>("window.__clearQueue()");
  check(
    "steer: parked messages go to the FRONT of the queue, are announced once, and are acked at the high seq",
    JSON.stringify(parked.queued) === JSON.stringify(["the first parked one", "and the second", "seed 0", "seed 1"])
      && parked.ahead === 2
      && JSON.stringify(parked.added) === JSON.stringify(["2 messages arrived too late for the last turn here — sending them next"])
      && JSON.stringify(parked.acks) === JSON.stringify([{ id: "probe-parked-session", seq: 7, discarded: 3 }])
      && !!parked.recovery && parked.recovery.parked === 2 && parked.recovery.discarded === 3
      && parkedNone.added.length === 0 && parkedNone.acks.length === 0
      && JSON.stringify(parkedNone.queued) === JSON.stringify(["seed 0", "seed 1"]),
    `queued=${JSON.stringify(parked.queued)} ahead=${parked.ahead} acks=${JSON.stringify(parked.acks)} said=${JSON.stringify(parked.added)}`,
  );

  /* Review fix (major): the steer POST is a round trip, and clicking
     another chat inside it used to land chat A's user bubble and its
     system line at the bottom of chat B, and hand A's text back into a
     draft the user had since typed in B. Both arms of the answer are
     driven, plus the control arm where nothing switches. */
  type Switch = { a: string[]; b: string[]; draft: string; value: string | null; queued: string[]; ahead: number };
  await js<number>("window.__clearQueue()");
  const swSteered = await js<Switch>("window.__steerSwitchProbe({ok:true, steered:true})");
  await js<number>("window.__clearQueue()");
  const swQueued = await js<Switch>("window.__steerSwitchProbe({ok:true, steered:false})");
  await js<number>("window.__clearQueue()");
  const stayed = await js<Switch>("window.__steerSwitchProbe({ok:true, steered:true}, true)");
  await js<number>("window.__clearQueue()");
  const typed = "a draft typed in chat B";
  const untouched = (r: Switch) =>
    JSON.stringify(r.a) === JSON.stringify(["system:chat A"])
    && JSON.stringify(r.b) === JSON.stringify(["system:chat B"])
    && r.draft === typed && r.value === typed;
  check(
    "steer: a result that arrives after a chat switch writes into neither transcript and leaves the new draft alone",
    untouched(swSteered) && untouched(swQueued)
      // The park itself still happens - the queue tray is window-global.
      && JSON.stringify(swQueued.queued) === JSON.stringify(["a message typed while chat A was running"])
      && swQueued.ahead === 1
      && JSON.stringify(swSteered.queued) === JSON.stringify([])
      // Control: with no switch, the transcript is written exactly as before.
      && JSON.stringify(stayed.a) === JSON.stringify([
        "system:chat A",
        "user:a message typed while chat A was running",
        "system:steering the running turn — the agent reads it at the next step",
      ])
      && JSON.stringify(stayed.b) === JSON.stringify(["system:chat B"]),
    `steered a=${JSON.stringify(swSteered.a)} b=${JSON.stringify(swSteered.b)} draft=${JSON.stringify(swSteered.draft)}`
      + ` | refused queued=${JSON.stringify(swQueued.queued)} b=${JSON.stringify(swQueued.b)}`
      + ` | control a=${JSON.stringify(stayed.a)}`,
  );

  // A message typed during a turn is offered to the running turn. The
  // ROUTE's answer is what is asserted - not the model's obedience.
  await wait(800);
  await js<void>("window.__ask('List the files in the current directory, then say done.')");
  type SteerAnswer = { ok?: boolean; steered?: boolean; error?: string };
  let steered: SteerAnswer | null = null;
  const steerDeadline = Date.now() + 90_000;
  while (Date.now() < steerDeadline) {
    const busy = await js<boolean>("window.__busy()");
    if (busy) {
      steered = await js<SteerAnswer>("window.__steer('Also mention the word BANANA once.')");
      if (steered && steered.steered) break;
    } else if (steered) break;
    await wait(500);
  }
  check(
    "steer: POST /api/sessions/{id}/steer folds a message into the running turn",
    !!steered && steered.ok === true && steered.steered === true,
    JSON.stringify(steered),
  );
  // Let the turn finish before anything else drives the composer.
  const endDeadline = Date.now() + 150_000;
  while (Date.now() < endDeadline && (await js<boolean>("window.__busy()"))) await wait(1000);

  // A refusal parks the text ahead of ordinary backlog, in the TUI's words.
  await js<number>("window.__clearQueue()");
  const turnA = await js<string>("window.__fakeTurn()");
  const refused = await js<{ queued: string[]; ahead: number; draft: string }>("window.__steerOrQueue('later, please')");
  const refusedLines = await js<string[]>("window.__systemLines()");
  check(
    "steer: a refused steer is parked as the next turn, never dropped and never the agent's 409 text",
    refused.queued.length === 1 && refused.queued[0] === "later, please" && refused.ahead === 1
      && refusedLines.includes("steering the running turn — it cannot take this one, so it runs as the next turn")
      && !refusedLines.some((l) => l.includes("POST /v1/chat/completions instead")),
    JSON.stringify(refused),
  );
  // A full queue hands the text back to the editor rather than eating it.
  await js<number>("window.__seedQueue(20)");
  const full = await js<{ queued: string[]; ahead: number; draft: string }>("window.__steerOrQueue('overflow')");
  const fullLines = await js<string[]>("window.__systemLines()");
  check(
    "steer: a full queue returns the text to the editor and says so",
    full.queued.length === 20 && full.draft === "overflow"
      && fullLines.includes("queue: full at 20 — the steer could not be parked (returned to the editor)"),
    `${full.queued.length} queued, draft=${JSON.stringify(full.draft)}`,
  );
  await js<number>("window.__clearQueue()");
  await js<void>("window.__ctxDraft('')");

  // The undelivered leg: accepted, never read, re-queued at the front.
  const late = await js<{ busy: boolean; lines: string[] }>(
    `window.__chatEvent({turnId:${JSON.stringify(turnA)}, kind:'steer_undelivered', payload:{undelivered:[{seq:1, text:'too late', parked_at:1}]}})`,
  );
  const lateQueue = await js<string[]>("window.__queued()");
  check(
    "steer: a message accepted too late is re-queued at the front and announced",
    lateQueue[0] === "too late" && late.lines.includes("1 message arrived too late for that turn — sending it next"),
    JSON.stringify(lateQueue),
  );
  await js<number>("window.__clearQueue()");
  // A steer applied from anywhere else still lands in this transcript.
  await js<unknown>(`window.__chatEvent({turnId:${JSON.stringify(turnA)}, kind:'steer_applied', text:'from another client', stepIndex:1})`);
  const entries = await js<string[]>("window.__steerEntries()");
  check(
    "steer: a steer_applied frame puts the message in the transcript",
    entries.includes("from another client"),
    JSON.stringify(entries),
  );
  // The while-busy affordance only appears with something in the editor;
  // an empty one is the Stop button, which is right and unchanged.
  await js<number>("window.__ctxDraft('something to steer with')");
  const sendBtn = await js<{ act: string; title: string } | null>("window.__sendButton()");
  await js<number>("window.__ctxDraft('')");
  check(
    "steer: the while-busy send button no longer promises a queue",
    !!sendBtn && sendBtn.title === "Steer this turn" && sendBtn.act === "send",
    JSON.stringify(sendBtn),
  );

  /* ---- DRIFT: the SSE error frame carries its message ---- */
  const errored = await js<{ busy: boolean; lines: string[] }>(
    `window.__chatEvent({turnId:${JSON.stringify(turnA)}, kind:'error', error:'boom', category:'transport'})`,
  );
  const turnB = await js<string>("window.__fakeTurn()");
  const empty = await js<{ lines: string[] }>(
    `window.__chatEvent({turnId:${JSON.stringify(turnB)}, kind:'error', error:''})`,
  );
  check(
    "drift: a failed turn prints its message and its category, never a bare `turn failed: `",
    errored.lines.includes("turn failed [transport]: boom")
      && empty.lines.includes("turn failed: the agent gave no message")
      && !empty.lines.some((l) => l === "turn failed: "),
    JSON.stringify([...errored.lines, ...empty.lines].filter((l) => l.startsWith("turn failed"))),
  );

  /* ------------------------------------------------------------------
     Item 7C - the persisted context gauge.
     ------------------------------------------------------------------ */
  await js<void>(`window.__openSession(${JSON.stringify(sessionWithTurns)})`);
  await wait(2500);
  await js<void>("window.__ctxRefresh()");
  await wait(1500);
  type Ctx = { tokens: number; source: string | null; window: number | null; windowLabel: string; stablePrefix: number };
  const gauge = await js<Ctx>("window.__ctx()");
  type Stored = {
    tokens: number; contextWindow: number; sections: string[]; conversationBoundBy: string | null;
    conversationPairs: number; conversationPairsCap: number;
  } | null;
  const stored = await js<Stored>("window.__ctxStored()");
  const row = await js<{ ok?: boolean; data?: { contextUsage?: { tokens?: number } } }>(
    `window.atomic.session(${JSON.stringify(sessionWithTurns)})`,
  );
  const agentTokens = row && row.data && row.data.contextUsage ? row.data.contextUsage.tokens ?? null : null;
  check(
    "gauge: the breakdown is the session's own, read straight off GET /api/sessions/{id}",
    agentTokens === null
      ? gauge.tokens > 0 && gauge.source !== null && stored === null
      : !!stored && gauge.source === "measured" && gauge.tokens === agentTokens && stored.tokens === agentTokens
        && stored.sections.includes("prompt scaffold") && stored.sections.includes("conversation"),
    agentTokens === null
      ? `this agent persists no contextUsage on ${sessionWithTurns} - the ladder fell through to ${gauge.source} (${gauge.tokens})`
      : `${gauge.tokens} tokens (${gauge.source}) vs the agent's ${agentTokens}; sections ${JSON.stringify(stored ? stored.sections : null)}`,
  );
  if (agentTokens !== null && stored) {
    await js<boolean>("window.__ctxOpen()");
    const panel = await js<string>("((document.querySelector('.popover') || {}).textContent || '')");
    const basis = await js<string>("window.__ctxBasis()");
    const bound = await js<string>("window.__ctxBound()");
    await js<void>("window.__ctxClose()");
    // Review fix: the full sentence, not a shared prefix. `startsWith`
    // on "older turns are being dropped — " matched all three arms, so
    // even when it fired it could not tell the configured-cap sentence
    // from the window-is-the-limit one.
    const wantBound = !stored.conversationBoundBy
      ? ""
      : stored.conversationBoundBy === "pairs"
        ? `older turns are being dropped — ${stored.conversationPairs} of ${stored.conversationPairsCap} turns kept`
        : null;   // a token verdict: pinned by __ctxBoundProbe below, which can drive both of its arms
    check(
      "gauge: the panel draws the agent's own sections, its window and its binding verdict",
      stored.sections.every((l) => panel.includes(l))
        && basis === "measured on this session’s last turn"
        && (stored.contextWindow > 0 ? gauge.window === stored.contextWindow && gauge.windowLabel === "prompt window" : true)
        && (wantBound === null ? bound.startsWith("older turns are being dropped — ") : bound === wantBound),
      `window=${gauge.window} (${gauge.windowLabel}) boundBy=${stored.conversationBoundBy} line=${JSON.stringify(bound)} basis=${JSON.stringify(basis)}`,
    );
  }
  /* Review fix: every arm of the binding line, driven off a synthetic
     session row. On a live agent `conversationBoundBy` is usually null,
     so the three sentences never rendered and the assertion above
     collapsed to "" === "". The probe restores the real snapshot. */
  type Bound = { html: string; text: string };
  const storedBeforeProbe = await js<Stored>("window.__ctxStored()");
  const boundArms = {
    none: await js<Bound>("window.__ctxBoundProbe({tokens:1, conversationBoundBy:null})"),
    pairs: await js<Bound>(
      "window.__ctxBoundProbe({tokens:1, conversationBoundBy:'pairs', conversationPairs:12, conversationPairsCap:20, droppedPairs:0})",
    ),
    cap: await js<Bound>(
      "window.__ctxBoundProbe({tokens:1, conversationBoundBy:'tokens', conversationCapAuto:false, conversationCap:48000, conversationCapConfigured:48000, droppedPairs:3})",
    ),
    window: await js<Bound>(
      "window.__ctxBoundProbe({tokens:1, conversationBoundBy:'tokens', conversationCapAuto:true, conversationCap:31000, conversationCapConfigured:48000, droppedPairs:0})",
    ),
  };
  const boundWant = {
    none: "",
    pairs: "older turns are being dropped — 12 of 20 turns kept",
    cap: "older turns are being dropped — the 48k-token transcript cap (agent.conversationMaxTokens) is the limit · 3 dropped so far",
    window: "older turns are being dropped — the window is the limit, not a configured cap",
  };
  const boundBad = (Object.keys(boundWant) as Array<keyof typeof boundWant>)
    .filter((k) => boundArms[k].text !== boundWant[k]);
  const storedAfterProbe = await js<Stored>("window.__ctxStored()");
  check(
    "gauge: each binding verdict renders its own full sentence, and the probe leaves the row alone",
    boundBad.length === 0 && JSON.stringify(storedAfterProbe) === JSON.stringify(storedBeforeProbe),
    boundBad.length
      ? boundBad.map((k) => `${k}: ${JSON.stringify(boundArms[k].text)}`).join(" | ")
      : `all four arms exact; snapshot ${JSON.stringify(storedAfterProbe) === JSON.stringify(storedBeforeProbe) ? "intact" : "CLOBBERED"}`,
  );
  /* Review fix (D2): the basis line's `provider` arm — "(Nk of it reused
     from its cache)", reworded because 0.5.5's promptTokens is evaluated
     + cached rather than the KV-cache miss count. That arm cannot arise
     on this state dir's route, so the reword shipped unguarded; the probe
     plants the three fields the sentence reads and restores them. The
     `after` wording is a regression the check names explicitly. */
  type Basis = { text: string; live: { source: string | null; tokens: number; cacheHitTokens: number | null }; restored: boolean };
  const basisArms = {
    cached: await js<Basis>("window.__ctxBasisProbe({source:'provider', modelId:'glm-5.2', cacheHitTokens:12800})"),
    fresh: await js<Basis>("window.__ctxBasisProbe({source:'provider', modelId:'glm-5.2', cacheHitTokens:0})"),
    unnamed: await js<Basis>("window.__ctxBasisProbe({source:'provider', modelId:null, cacheHitTokens:null})"),
  };
  const basisWant = {
    cached: "counted by glm-5.2 (12.8k of it reused from its cache)",
    fresh: "counted by glm-5.2",
    unnamed: "counted by the model",
  };
  const basisBad = (Object.keys(basisWant) as Array<keyof typeof basisWant>)
    .filter((k) => basisArms[k].text !== basisWant[k]);
  // The parenthetical describes the figure's composition, so the cache hit
  // is PART of the counted total, never additional to it.
  const liveBasis = basisArms.cached.live;
  const cacheWithin = liveBasis.source !== "provider" || liveBasis.cacheHitTokens === null
    || liveBasis.cacheHitTokens <= liveBasis.tokens;
  check(
    "gauge: the counted figure names the model and says the cache hit is part of it, not before it",
    basisBad.length === 0 && !basisArms.cached.text.includes("after") && basisArms.cached.restored && cacheWithin,
    basisBad.length
      ? basisBad.map((k) => `${k}: ${JSON.stringify(basisArms[k].text)}`).join(" | ")
      : `all three arms exact; live ${liveBasis.source ?? "-"} ${liveBasis.tokens}/${liveBasis.cacheHitTokens ?? "-"}`,
  );
  /* Review fix: the 0.5.5 snapshot used to be written before the
     staleness guard, so a refresh for the session the user just left
     could draw its trimming verdict over the session they are on. */
  const stale = await js<{ survived: boolean }>("window.__ctxStaleProbe()");
  check(
    "gauge: an overtaken refresh writes no session snapshot over the session that overtook it",
    stale.survived,
    stale.survived ? "the newer session's snapshot survived" : "a stale refresh clobbered CTX055.stored",
  );
  const release = await js<{ released: boolean; window: number | null; label: string; releasedAgain: boolean; windowAgain: number | null }>(
    "window.__ctxReleaseProbe()",
  );
  check(
    "drift: a prompt-derived window is released when the route changes, and only then",
    release.released && release.window === null && release.label === ""
      && !release.releasedAgain && release.windowAgain === 999999,
    JSON.stringify(release),
  );
  await js<void>("window.__ctxRefresh()");

  /* ------------------------------------------------------------------
     Item 7C - the session's model stamp: reported, never applied.
     ------------------------------------------------------------------ */
  const liveProvider = await js<string>("window.__activeProvider()");
  type Probe = { stamp: { providerId: string; chatModel: string | null } | null; added: string[]; provider: string; model: string };
  const gone = await js<Probe>("window.__sessStampProbe({llm:{providerId:'no-such-provider', chatModel:'ghost-model'}})");
  const goneLine = 'this session last ran on "no-such-provider/ghost-model", which is no longer configured — keeping the current model';
  check(
    "stamp: a provider that is gone says so verbatim and offers nothing",
    gone.stamp === null && gone.added.map(decodeEntities).some((t) => t === goneLine),
    JSON.stringify(gone.added.map(decodeEntities)),
  );
  const offered = await js<Probe>("window.__sessStampProbe({llm:{providerId:'openrouter', chatModel:'a/model-this-session-ran-on'}})");
  const cfgNow = ((await configGet()).config ?? {}) as { llm?: { providers?: Array<{ id: string }> } };
  const hasOpenrouter = (cfgNow.llm?.providers ?? []).some((p) => p.id === "openrouter");
  const providerAfter = await js<string>("window.__activeProvider()");
  check(
    "stamp: a configured provider is reported with an offer, and reporting it switches nothing",
    hasOpenrouter
      ? !!offered.stamp && offered.stamp.providerId === "openrouter"
        && offered.added.some((t) => t.includes("this session ran on openrouter/a/model-this-session-ran-on") && t.includes("Switch to it"))
        && providerAfter === liveProvider
      : offered.stamp === null && providerAfter === liveProvider,
    hasOpenrouter ? JSON.stringify(offered.stamp) : "no `openrouter` provider in this config - the gone-provider arm covers the copy",
  );
  /* Review fix: the stamp used to compare model BASENAMES, so on a
     provider with vendor-prefixed ids a session stamped `openai/gpt-4.1`
     opened while the provider is on `azure/gpt-4.1` read as "same model"
     and no offer appeared. 0.5.5's planModelRestore compares the full id
     against `provider.defaultChatModel ?? provider.model`, and so does
     this window now. Both directions are pinned: the same id is silent,
     an id sharing only its basename is not. */
  const liveProviderModel = await js<string>("window.__activeProviderModel()");
  if (liveProvider && liveProviderModel) {
    const same = await js<Probe>(
      `window.__sessStampProbe({llm:{providerId:${JSON.stringify(liveProvider)}, chatModel:${JSON.stringify(liveProviderModel)}}})`,
    );
    // Same basename, different vendor prefix - a different model to the agent.
    const base = liveProviderModel.split("/").pop() ?? liveProviderModel;
    const twin = `smoke-vendor/${base}`;
    const differs = await js<Probe>(
      `window.__sessStampProbe({llm:{providerId:${JSON.stringify(liveProvider)}, chatModel:${JSON.stringify(twin)}}})`,
    );
    check(
      "stamp: the model comparison is the agent's full id, not a basename",
      same.stamp === null && same.added.length === 0
        && (twin === liveProviderModel
          ? true
          : !!differs.stamp && differs.stamp.chatModel === twin
            && differs.added.some((t) => t.includes(twin) && t.includes("Switch to it"))),
      `live ${liveProvider}/${liveProviderModel}; same-id silent=${same.stamp === null}; ${JSON.stringify(twin)} offered=${!!differs.stamp}`,
    );
  } else {
    check(
      "stamp: the model comparison is the agent's full id, not a basename",
      true,
      `skipped - the active provider (${JSON.stringify(liveProvider)}) carries no defaultChatModel/model to compare against`,
    );
  }

  // The offer is refused while anything is running: applying costs a config
  // write plus a serve restart, and a restart aborts turns in other chats.
  const turnC = await js<string>("window.__fakeTurn()");
  const refusedSwitch = await js<{ stamp: unknown; provider: string }>("window.__sessStampApply()");
  await js<unknown>(`window.__chatEvent({turnId:${JSON.stringify(turnC)}, kind:'aborted'})`);
  const providerEnd = await js<string>("window.__activeProvider()");
  check(
    "stamp: the offered switch is refused while a turn is running",
    refusedSwitch.provider === liveProvider && providerEnd === liveProvider,
    `provider ${refusedSwitch.provider} (live ${liveProvider})`,
  );
  await js<number>("window.__clearQueue()");
}

/** The log escapes its text; the smoke compares the sentence, not the markup. */
function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** `modelsPull` streams, so its id guard is probed without leaving a download running. */
async function modelsPullGuard(id: string): Promise<{ ok: boolean; error?: string }> {
  const started = modelsPull(id, () => {});
  started.cancel();
  return (await started.done) as { ok: boolean; error?: string };
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
      // r4 integration: the detail used to print only four of the nine
      // conjuncts, so a failure said "saved mode=600 keys=[…] enabled=true"
      // — every field it printed green — and named nothing that went wrong.
      // The assertion is unchanged; each conjunct now reports itself.
      const tgParts: Record<string, boolean> = {
        ok: saved.ok,
        quoted: envText.includes(`TELEGRAM_BOT_TOKEN="${token}"`),
        mode600: mode === 0o600,
        keysKept: keysBefore.every((k) => envText.includes(`${k}=`)),
        hasToken: saved.state.hasToken === true,
        enabled: enabledNow === true,
        confirmCard: afterBody.includes("One last step — confirm it's you"),
        pairingLine: afterBody.includes("Pairing needs the live channel — open the Telegram tab in `atag tui` to pair"),
        restartButton: afterBody.includes("Restart Agent Runtime"),
      };
      check(
        "telegram tab: the token lands in .env quoted, 0600, other keys kept, and the connect chain enables telegram",
        Object.values(tgParts).every(Boolean),
        `${saved.ok ? "saved" : "error=" + (saved.error ?? "?")} mode=${mode.toString(8)} keys=${JSON.stringify(dotenvKeys(stateDir).keys)} enabled=${String(enabledNow)}`
          + ` failed=[${Object.entries(tgParts).filter(([, v]) => !v).map(([k]) => k).join(", ")}]`,
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

/**
 * r4-ui — the four things the user asked for, checked through the renderer's
 * own hooks: the sidebar dot's size and seat (item 1), user bubbles and the
 * one end-of-turn mark (item 3), a plus on each list header and none on the
 * head row (item 4), and Escape opening the settings menu column without
 * losing any dismissal it already had (item 5).
 */
async function uiTest(
  js: <T>(code: string) => Promise<T>,
  check: (name: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  // --- item 1: the circles ---------------------------------------------------
  const probe = await js<{
    dots: Array<{ cls: string; w: number; h: number; border: number; bg: string; animation: string; shadow: string }>;
    seat: { dotMid: number; capMid: number; xMid: number } | null;
  } | null>("window.__dotProbe()");
  const dots = probe ? probe.dots : [];
  check(
    "item 1: every sidebar dot is a 6px ring, not a paragraph",
    dots.length === 3 && dots.every((d) => d.w === 6 && d.h === 6 && d.border === 1),
    JSON.stringify(dots.map((d) => [d.cls, d.w, d.h, d.border])),
  );
  const empty = dots[0], filled = dots[1], running = dots[2];
  check(
    "item 1: read, waiting and running stay apart at 6px",
    !!empty && !!filled && !!running
      && /rgba\(0, 0, 0, 0\)|transparent/.test(empty.bg) && empty.animation === "none" && empty.shadow === "none"
      && filled.animation === "none" && filled.shadow === "none" && !/rgba\(0, 0, 0, 0\)/.test(filled.bg)
      && running.animation === "sdot-pulse" && running.shadow !== "none",
    JSON.stringify(dots.map((d) => [d.cls, d.bg, d.animation, d.shadow])),
  );
  const seat = probe ? probe.seat : null;
  check(
    "item 1: the dot sits on the label's optical centre",
    !!seat && seat.dotMid >= seat.capMid - 0.5 && seat.dotMid <= seat.xMid + 0.5,
    seat ? `dot ${seat.dotMid.toFixed(2)}, cap-mid ${seat.capMid.toFixed(2)}, x-mid ${seat.xMid.toFixed(2)}` : "no probe row",
  );
  const ec = await js<{ found: boolean; display: string; strays: number }>("window.__emptyChatProbe()");
  check(
    "item 1: the empty-transcript screen kept its centring under .emptychat",
    ec.found && ec.display === "flex" && ec.strays === 0,
    JSON.stringify(ec),
  );
  // The fourth state: `prefers-reduced-motion: reduce` kills the pulse through
  // the blanket `*{animation:none!important}`, so the halo is the only thing
  // left telling a running dot from a filled one — and at 6px the wash is too
  // faint for that, which is what the reduced-motion rule swaps out. The media
  // feature is really emulated through the devtools protocol rather than read
  // back out of the stylesheet, so what is measured is what the operator gets.
  type Probe = { dots: Array<{ cls: string; w: number; h: number; border: number; bg: string; animation: string; shadow: string }> };
  const dbg = win ? win.webContents.debugger : null;
  let reduced: Probe | null = null;
  let reducedErr = "";
  try {
    if (!dbg) throw new Error("no webContents to attach to");
    if (!dbg.isAttached()) dbg.attach("1.3");
    await dbg.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    reduced = await js<Probe | null>("window.__dotProbe()");
  } catch (e) {
    reducedErr = e instanceof Error ? e.message : String(e);
  } finally {
    try { if (dbg && dbg.isAttached()) await dbg.sendCommand("Emulation.setEmulatedMedia", { features: [] }); } catch { /* the assertion below reports it */ }
    try { if (dbg && dbg.isAttached()) dbg.detach(); } catch { /* ditto */ }
  }
  const rmRun = reduced ? reduced.dots[2] : null;
  const rmFilled = reduced ? reduced.dots[1] : null;
  check(
    "item 1: reduced motion still tells running from waiting at 6px",
    !!rmRun && !!rmFilled && rmRun.w === 6 && rmRun.h === 6
      // the emulation really took: the blanket rule killed the pulse
      && rmRun.animation === "none"
      // and what is left is a ring the filled dot does not have, and a heavier
      // one than the animated state carries
      && rmRun.shadow !== "none" && rmFilled.shadow === "none" && !!running && rmRun.shadow !== running.shadow,
    reducedErr || JSON.stringify([rmRun, rmFilled, running ? running.shadow : null]),
  );

  // --- item 3: bubbles, empty gutters, one mark per finished turn -------------
  // The end mark is withheld while a turn streams or an approval waits, and the
  // sidebar checks above leave a turn running in another chat — so stop that
  // first, or the mark's absence would prove nothing.
  const quiet = await js<{ busy: boolean; pending: boolean; items: number }>("window.__quiesce()");
  check("item 3: the window is at rest before the transcript checks", !quiet.busy && !quiet.pending, JSON.stringify(quiet));
  await js<number>("window.__pushUser('a short one')");
  await js<number>("window.__pushTool('read_file', {path:'a.txt'}, 'ok', false)");
  await js<number>("window.__pushAssistant('done')");
  type Shape = { k: string; glyphs: number; gutter: number | null; end: boolean; endLast: boolean; strip: boolean; left: number };
  const shape = await js<Shape[]>("window.__turnShape()");
  const tail = shape.slice(-3);
  check(
    // Two things, both positive: no row carries a `.avatar` or a `.gutter` (the
    // user's `›` and the assistant's per-message mark), and every row that still
    // uses the grid has an empty first cell. The user rows are only proof of the
    // first half if there IS one on screen, so that is asserted too.
    "item 3: no glyph in any transcript row",
    shape.length > 0 && shape.every((t) => t.glyphs === 0 && (t.gutter === null || t.gutter === 0))
      && shape.some((t) => t.k === "user") && shape.some((t) => t.gutter === 0),
    JSON.stringify(shape.filter((t) => t.glyphs !== 0 || (t.gutter !== null && t.gutter !== 0))
      .concat(shape.some((t) => t.k === "user") ? [] : [{ k: "no user row on screen" } as unknown as Shape])),
  );
  check(
    "item 3: the agent's content column did not move",
    tail.length === 3 && tail[1].k === "tool" && tail[2].k === "assistant" && tail[1].left === tail[2].left,
    JSON.stringify(tail),
  );
  check(
    "item 3: one mark, on the item that closes the finished turn",
    tail.length === 3 && tail[0].k === "user" && !tail[0].end && !tail[1].end && tail[2].end && tail[2].endLast
      && shape.every((t) => !t.end || (t.k === "assistant" && t.endLast)),
    JSON.stringify(shape.map((t) => [t.k, t.end])),
  );
  const busyMarks = await js<{ during: { total: number; last: boolean }; after: { total: number; last: boolean } }>("window.__marksWhileBusy()");
  check(
    "item 3: a running turn carries no end mark",
    !busyMarks.during.last && busyMarks.after.last && busyMarks.during.total === busyMarks.after.total - 1,
    JSON.stringify(busyMarks),
  );
  // The turn that never produced a word: startLiveTurn pushes an empty assistant
  // item before the first delta, and an abort or a failed BR.chat leaves it in
  // S.log at rest. No poked flag here — the rows are the ones that path pushes.
  const emptyTurn = await js<{ before: number; after: number; lastHasMark: boolean }>("window.__emptyTurnMark()");
  check(
    "item 3: a turn that produced no text gets no mark",
    emptyTurn.after === emptyTurn.before && !emptyTurn.lastHasMark,
    JSON.stringify(emptyTurn),
  );
  // The mark is appended AFTER attachStrip(m), and the only case that can catch
  // a wrong order is a reply that really wrote a file. Same recipe as the
  // attachment-strip checks earlier in the run: a real file, the real collector.
  const endmarkFile = join(app.getPath("temp"), "atomic-desktop-endmark.txt");
  writeFileSync(endmarkFile, "smoke\n");
  await js<unknown>(
    "window.__pushAssistantFiles('Saved it.', ["
    + `{tool:'os.fs.write', args:{path:${JSON.stringify(endmarkFile)}, content:'smoke\\n'}, out:'wrote 6 bytes to ${endmarkFile} (replace)'}])`,
  );
  const stripShape = await js<Shape[]>("window.__turnShape()");
  const stripTail = stripShape[stripShape.length - 1];
  check(
    "item 3: the mark closes the column below the attachment strip",
    !!stripTail && stripTail.k === "assistant" && stripTail.strip && stripTail.end && stripTail.endLast
      && stripShape.filter((t) => t.end).length === shape.filter((t) => t.end).length + 1,
    JSON.stringify(stripShape.slice(-2)),
  );
  const bub = await js<{
    right: number; width: number; colRight: number; colWidth: number;
    marginLeft: string; rowDisplay: string; markW: number;
  } | null>("window.__bubbleBox()");
  check(
    // `margin-left:auto` resolves to a used pixel value in getComputedStyle, so
    // what is asserted is what it buys: a positive left margin, a box narrower
    // than the column, and a right edge flush with the column's content box.
    "item 3: the user's bubble is right-aligned and sized to its text",
    !!bub && parseFloat(bub.marginLeft) > 0 && bub.rowDisplay === "block"
      && Math.abs(bub.right - bub.colRight) <= 1 && bub.width < bub.colWidth / 2,
    JSON.stringify(bub),
  );
  check("item 3: the end mark is 12px", !!bub && bub.markW === 12, bub ? String(bub.markW) : "no bubble");
  // An unbroken 400-character message must not widen the column either.
  await js<number>("window.__pushUser('x'.repeat(400))");
  type Ov = { sw: number; cw: number; colRight: number; colWidth: number; track: number; maxRight: number };
  const ov = await js<Ov>("window.__overflow()");
  check(
    // `track` is the grid's SECOND column, as the existing overflow checks read
    // it; the guard is that it is still a number at all — a user row is
    // display:block now and would report "none" → NaN if the selector took one.
    "item 3: a long user message keeps inside the panel, and the grid still reads",
    ov.sw === ov.cw && ov.maxRight <= ov.colRight + 1 && ov.track > 0 && ov.track <= ov.colWidth,
    `scrollWidth ${ov.sw} vs clientWidth ${ov.cw}, max right ${ov.maxRight} vs column ${ov.colRight}, track ${ov.track} of ${ov.colWidth}`,
  );

  // --- item 4: the pluses ----------------------------------------------------
  type Heads = {
    headPlus: boolean; railWidth: number; rail: boolean;
    heads: Array<{ list: string; act: string | null; right: number; centre: number; visible: boolean;
                   counter: string | null; counterVisible: boolean; labelVisible: boolean; counterLeftOfPlus: boolean }>;
  };
  const heads = await js<Heads>("window.__sbHeads()");
  check("item 4: no plus on the head row", heads.headPlus === false, JSON.stringify(heads.headPlus));
  check(
    "item 4: one plus per list header, and they line up",
    heads.heads[0].act === "tasks:new" && heads.heads[1].act === "session:new" && heads.heads[0].right === heads.heads[1].right,
    JSON.stringify(heads.heads.map((h) => [h.list, h.act, h.right])),
  );
  check(
    "item 4: \"N running\" sits to the left of the Tasks plus",
    /^\d+ running$/.test(heads.heads[0].counter ?? "") && heads.heads[0].counterLeftOfPlus,
    JSON.stringify([heads.heads[0].counter, heads.heads[0].counterLeftOfPlus]),
  );
  const rail = await js<Heads>("window.__rail()");
  check(
    "item 4: the collapsed rail keeps both pluses and nothing else",
    rail.rail && rail.heads.every((h) => h.visible && !h.labelVisible && Math.abs(h.centre - rail.railWidth / 2) <= 2)
      && !rail.heads[0].counterVisible,
    JSON.stringify([rail.railWidth, rail.heads.map((h) => [h.list, h.visible, h.labelVisible, h.centre])]),
  );
  await js<Heads>("window.__rail()"); // back to the full sidebar
  const viaTasks = await js<{ pane: string | null; mode: string } | null>("window.__clickHead('tasks')");
  check(
    "item 4: the Tasks plus opens the create form",
    !!viaTasks && viaTasks.pane === "tasks" && viaTasks.mode === "create",
    JSON.stringify(viaTasks),
  );
  await js<void>("window.__tasksAct('back'); window.__settingsClose();");
  const viaChats = await js<{ logLen: number; session: string | null; onRows: number } | null>("window.__clickHead('chats')");
  check(
    "item 4: the Chats plus starts a new chat",
    !!viaChats && viaChats.logLen === 0 && viaChats.session === null && viaChats.onRows === 0,
    JSON.stringify(viaChats),
  );

  // --- item 5: Escape --------------------------------------------------------
  type Esc = {
    pane: string | null; focusRow: boolean; focusAct: string; overlay: string | null;
    sel: boolean; toasts: number; firstRowLabel: string;
  };
  // Nothing may be left over from the earlier tabs: a stale Tasks search or an
  // open form would eat the Escape before the menu branch is reached.
  // The window reopens on the pane it was last left on, and the earlier tabs
  // left it elsewhere — so put it back on Tasks first, and clear the Tasks
  // tab's own state, or a stale search or open form would eat the Escape
  // before the menu branch is reached.
  await js<number>("window.__settingsOpen('tasks'); window.__tasksAct('back'); window.__tasksAct('clearSearch'); window.__settingsClose(); window.__clearToasts()");
  const opened = await js<Esc>("window.__esc()");
  check(
    "item 5: Escape with nothing open opens the menu on its first row",
    opened.pane === "tasks" && opened.focusRow && opened.focusAct === "menu:go.manage.tasks" && opened.firstRowLabel === "Tasks",
    JSON.stringify(opened),
  );
  // The focus ring is re-applied on every render while the window is open, so
  // it has to let go the moment the operator clicks anywhere else — and a click
  // on dead space is a blur to <body>, not to another element inside #settings.
  // Without this the next full render (the tasks poll alone fires one every 5 s
  // in exactly this state) drags focus back onto Tasks under their hands.
  const blur = await js<{ focusedBefore: boolean; blurred: boolean; stolen: boolean; active: string } | null>("window.__menuFocusBlur()");
  check(
    "item 5: the menu stops grabbing focus once the operator clicks away",
    !!blur && blur.focusedBefore && blur.blurred && !blur.stolen,
    JSON.stringify(blur),
  );
  const closed = await js<Esc>("window.__esc()");
  check("item 5: Escape closes the menu again, it does not reopen it", closed.pane === null, JSON.stringify(closed));
  await js<string>("window.__clearToasts(); window.__openPalette()");
  const pal = await js<Esc>("window.__esc()");
  check("item 5: Escape still closes the palette", pal.overlay === null && pal.pane === null, JSON.stringify(pal));
  await js<void>("window.__selOpen('model')");
  await js<number>("window.__clearToasts()");
  const sel = await js<Esc>("window.__esc()");
  check(
    "item 5: Escape still dismisses the model selector instead of stacking the menu on it",
    sel.sel === false && sel.pane === null,
    JSON.stringify(sel),
  );
  await js<number>("window.__settingsClose(); window.__clearToasts()");

  // --- item 5: nothing became unreachable ------------------------------------
  // Deleting a whole menu group and six chords is only defensible if every
  // destination keeps a route. Asserted, not claimed in a comment: each of the
  // eight hoisted Manage nodes still opens its pane both from the node and from
  // its ctrl+g chord, and the three verbs that went with `Go`/`Observe`/the
  // debug pane still run from their acts and still have a palette row.
  const MANAGE: Array<[string, string]> = [
    ["tasks", "t"], ["skills", "s"], ["memory", "m"], ["mcp", "c"],
    ["llm", "l"], ["telegram", "g"], ["import", "i"], ["privacy", "p"],
  ];
  const nodeMisses: string[] = [];
  const chordMisses: string[] = [];
  for (const [tab, chord] of MANAGE) {
    const viaNode = await js<{ settings: boolean; pane: string | null }>(
      `(() => { window.__settingsClose(); return window.__menuActivate('go.manage.${tab}'); })()`,
    );
    if (!viaNode.settings || viaNode.pane !== tab) nodeMisses.push(`${tab}:${JSON.stringify(viaNode)}`);
    const viaChord = await js<{ armed: boolean; pane: string | null; disarmed: boolean }>(
      "(() => { window.__settingsClose();"
      + " document.dispatchEvent(new KeyboardEvent('keydown', {key: 'g', ctrlKey: true, bubbles: true, cancelable: true}));"
      + " const armed = window.__chordPending();"
      + ` document.dispatchEvent(new KeyboardEvent('keydown', {key: ${JSON.stringify(chord)}, bubbles: true, cancelable: true}));`
      + " return {armed, pane: window.__settingsPane(), disarmed: !window.__chordPending()}; })()",
    );
    if (!viaChord.armed || viaChord.pane !== tab || !viaChord.disarmed) chordMisses.push(`ctrl+g ${chord}:${JSON.stringify(viaChord)}`);
  }
  check("item 5: every Manage tab still opens from its node", nodeMisses.length === 0, nodeMisses.join("; "));
  check("item 5: every Manage chord still reaches its tab", chordMisses.length === 0, chordMisses.join("; "));
  await js<number>("window.__settingsClose(); window.__clearToasts()");

  type Route = { room: string; inspector: boolean; inspTab: string; consoleOpen: boolean; consoleTab: string; settings: boolean };
  type Panes = { room: string; inspector: boolean; inspTab: string; consoleOpen: boolean; consoleTab: string };
  // Snapshotted first: these acts really open the inspector and the console,
  // the inspector starts OPEN, and the backend-switch lane runs after this one.
  const panesBefore = await js<Panes>("window.__panes()");
  const routes = await js<{ chat: Route; world: Route; llm: Route }>(
    "(() => { const chat = window.__route('room:chat');"
    + " const world = window.__route('insp:world');"
    + " const llm = window.__route('console:llm');"
    + " return {chat, world, llm}; })()",
  );
  check(
    "item 5: the deleted Go/Observe destinations still run from their acts",
    routes.chat.room === "chat" && !routes.chat.settings
      && routes.world.inspector && routes.world.inspTab === "world"
      && routes.llm.consoleOpen && routes.llm.consoleTab === "llm",
    JSON.stringify(routes),
  );
  const panesAfter = await js<Panes>(`window.__restorePanes(${JSON.stringify(panesBefore)})`);
  check(
    "item 5: the route probe leaves the panes where it found them",
    JSON.stringify(panesAfter) === JSON.stringify(panesBefore),
    JSON.stringify({ before: panesBefore, after: panesAfter }),
  );
  const palRows = await js<Array<[string, string]>>("window.__palRows()");
  const WANT: Array<[string, string]> = [
    ["Chat", "room:chat"], ["Feed", "insp:steps"], ["World", "insp:world"],
    ["Reasoning", "insp:reasoning"], ["Logs", "console:agent"],
  ];
  const palMisses = WANT.filter(([t, a]) => !palRows.some((r) => r[0] === t && r[1] === a));
  check(
    "item 5: the palette still lists every destination that left the menu",
    palMisses.length === 0,
    JSON.stringify({ missing: palMisses, rows: palRows.length }),
  );
  await js<number>("window.__clearToasts()");
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
  // Item 2 (voice input): the third teardown path — this window going away
  // while the app stays alive on macOS.
  win.on("closed", () => voice.kill());
  buildMenu((command) => send("app:menu", command));
  wireIpc(agent);

  win.webContents.once("did-finish-load", () => {
    send("agent:status", agent?.status);
    if (FORCE_ONBOARDING) send("app:menu", "onboarding");
    void agent?.start();
    if (SMOKE) void smokeTest();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      win = createWindow();
      win.on("closed", () => voice.kill());
    }
  });
});

app.on("window-all-closed", () => {
  // Item 2 (voice input): a helper that outlives its window keeps the
  // system microphone indicator lit, which is worse for trust than any bug
  // in the transcript.
  voice.kill();
  if (process.platform !== "darwin") app.quit();
});

// Never leave the agent running after the app is gone.
app.on("before-quit", (event) => {
  // Item 2 (voice input): BEFORE the guard below. `if (!agent) return` skips
  // everything after it whenever the agent is not running, which is exactly
  // the degraded state in which someone is most likely to be poking at the
  // microphone button.
  voice.kill();
  if (!agent) return;
  event.preventDefault();
  const client = agent;
  agent = null;
  void client.stop().finally(() => app.quit());
});

/**
 * r4 integration — the seams between the four lanes, asserted where each
 * lane's own suite could not: every one of these checks needs code from two
 * branches in the same window.
 *
 * (c) the transcript. r4-feat writes the session's model-stamp notice into
 *     S.log; r4-ui turned user rows into bubbles and moved the agent's mark
 *     to the end of a finished turn. The notice must be a system row —
 *     no bubble, no end mark, and not a turn boundary.
 * (b) the composer. r4-voice put the microphone and the interim strip in it;
 *     r4-feat rewired submit() so Enter steers a running turn. Both controls
 *     have to be on screen at once, and the voice guard has to sit ABOVE the
 *     steer branch or Enter mid-dictation would post the pre-dictation draft.
 * (d) the menu. r4-ui rewrote the group list; un-greying `run.steer` is
 *     r4-feat's. The group list is asserted in settingsTestPartA and the
 *     steer row in hfAndDeltaTest; what is asserted here is that the verb
 *     r4-feat made live belongs to the group r4-ui rewrote.
 */
async function r4SeamTest(
  js: <T>(code: string) => Promise<T>,
  check: (name: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  type Shape = {
    added: number; kinds: string[]; classes: string[];
    bubbles: number; endmarks: number; offers: number;
    markedBefore: number; markedAfter: number;
  };
  // A provider that is not configured takes the "no longer configured" arm,
  // which is the one notice this window can raise without a real session
  // history behind it. Its shape in the DOM is what is under test, not its
  // wording — hfAndDeltaTest already pins the sentence verbatim.
  const gone = await js<Shape>(
    "window.__stampRowShape({llm:{providerId:'no-such-provider-seam', chatModel:'ghost-model'}})",
  );
  check(
    "seam: the session model-stamp notice is a system row, not a user bubble",
    gone.added === 1 && gone.kinds[0] === "system"
      && gone.classes.every((c) => /(^|\s)sysrow(\s|$)/.test(c))
      && gone.bubbles === 0 && gone.endmarks === 0
      && gone.markedAfter === gone.markedBefore,
    `added=${gone.added} kinds=${JSON.stringify(gone.kinds)} classes=${JSON.stringify(gone.classes)}`
      + ` bubbles=${gone.bubbles} endmarks=${gone.endmarks} marks ${gone.markedBefore}→${gone.markedAfter}`,
  );

  // The composer carries the microphone, the interim strip and the send
  // button together, and the mic is not swallowed by the steer rewiring.
  const composer = await js<{ mic: boolean; strip: boolean; send: boolean; entry: boolean }>(
    "(() => ({mic: !!document.querySelector('#composer .field .micbtn[data-mic]'),"
    + " strip: !!document.querySelector('.composerwrap .voicestrip'),"
    + " send: !!document.querySelector('#composer .field .sendbtn'),"
    + " entry: !!document.querySelector('#composer #entry')}))()",
  );
  check(
    "seam: the composer carries the microphone, the voice strip and send at once",
    composer.mic && composer.strip && composer.send && composer.entry,
    JSON.stringify(composer),
  );

  // Enter while the microphone is open must stop the take and insert, never
  // send and never steer: r4-voice's guard at the top of submit() has to sit
  // above r4-feat's `if (S.busy || S.pending) { steerOrQueue(text); return; }`.
  // S.busy is raised for the probe so the steer branch is genuinely the one
  // that would run next — with it clear the check would pass vacuously — and
  // dropped again in the finally below, along with the take and the draft.
  const busyBefore = await js<boolean>("window.__busy()");
  const draftBefore = await js<{ draft: string; entry: string | null }>("window.__draft()");
  try {
    const armed = await js<{ state: string; users: number; queued: number; draft: string }>(
      "(async () => { window.__modeBusy(true); window.__voiceArm();"
      // A take that really heard something, so the insertion is visible in the
      // draft rather than the take ending on the "Nothing was heard" branch.
      + " window.__voiceEvent({type:'final', text:'spoken into a running turn', locale:'en-US'});"
      + " const before = window.__draft().users, q = window.__queued().length;"
      + " const e = document.querySelector('#entry');"
      + " e.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}));"
      + " await new Promise((r) => setTimeout(r, 300));"
      + " return {state: window.__voice().state, users: window.__draft().users - before,"
      + " queued: window.__queued().length - q, draft: window.__draft().draft}; })()",
    );
    check(
      "seam: Enter while the microphone is open inserts the take and neither sends nor steers",
      armed.users === 0 && armed.queued === 0
        && armed.state !== "recording" && armed.state !== "starting"
        && armed.draft.includes("spoken into a running turn"),
      JSON.stringify(armed),
    );
  } finally {
    await js<unknown>("window.__voiceCancel()");
    await js<unknown>(`window.__modeBusy(${busyBefore === true})`);
    // __ctxDraft is the existing set-the-draft hook: it writes S.draft, re-costs
    // the projection and renders, and afterChat() copies S.draft back into the
    // textarea — so the composer ends exactly as this check found it.
    await js<unknown>(`window.__ctxDraft(${JSON.stringify(draftBefore.draft ?? "")})`);
  }

  // The verb r4-feat un-greyed lives in the group list r4-ui rewrote.
  const steerNode = await js<{ group: string; label: string; na: boolean } | null>(
    "(() => { const n = window.__menuNodes().find((x) => x.id === 'run.steer'); return n ? {group:n.group, label:n.label, na:n.na} : null; })()",
  );
  check(
    "seam: the live Steer verb sits in r4-ui's rewritten Run group",
    !!steerNode && steerNode.group === "Run" && steerNode.na === false
      && steerNode.label === "Steer the running turn",
    JSON.stringify(steerNode),
  );
}
