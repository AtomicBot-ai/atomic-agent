import { contextBridge, ipcRenderer } from "electron";

/**
 * The whole surface the renderer gets. No `ipcRenderer`, no `require`,
 * no Node globals — every call is a named method with a fixed channel,
 * and every subscription hands back an unsubscribe.
 */
type Unsubscribe = () => void;

function on(channel: string, cb: (payload: unknown) => void): Unsubscribe {
  const listener = (_event: unknown, payload: unknown) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/* Backlog 03 — what the window put on screen at boot, for `--first-run-probe`
   (main.ts firstRunProbe) and only for it: main adds the argument to that
   launch alone, so a normal one runs no frame loop.

   A fresh install showed the chat window for half a second before the
   wizard, then a title card that waited for a click. Both are facts about
   FRAMES, which no read of the DOM taken afterwards can see. So every
   animation frame from the first is classified by what it shows, and each
   change of view is kept with its wall-clock time and frame number. It lives
   here rather than in renderer.js so that it is watching before the page's
   own script has run, and reads only the DOM, never the renderer's state. */
type BootView = { view: "blank" | "chat" | "intro" | "wizard"; at: number; frame: number };
const BOOT_PAINT: { views: BootView[]; frames: number; input: { type: string; at: number } | null; done: boolean } =
  { views: [], frames: 0, input: null, done: false };

function bootView(): BootView["view"] {
  const ob = document.getElementById("onboarding");
  if (ob) return ob.classList.contains("ob-intro-layer") ? "intro" : "wizard";
  const drawn = (id: string) => (document.getElementById(id)?.childElementCount ?? 0) > 0;
  return drawn("content") || drawn("sidebar") ? "chat" : "blank";
}

if (process.argv.includes("--atomic-boot-probe")) {
  const frame = () => {
    BOOT_PAINT.frames += 1;
    const view = bootView();
    const last = BOOT_PAINT.views[BOOT_PAINT.views.length - 1];
    if (!last || last.view !== view) BOOT_PAINT.views.push({ view, at: Date.now(), frame: BOOT_PAINT.frames });
    // Done once the wizard is past its title card, or after 15 s of frames.
    if (view === "wizard" || Date.now() - BOOT_PAINT.views[0]!.at > 15_000) { BOOT_PAINT.done = true; return; }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // The probe presses nothing; an input here would mean the card did not leave by itself.
  for (const type of ["keydown", "mousedown", "wheel", "paste"]) {
    document.addEventListener(type, () => { BOOT_PAINT.input ??= { type, at: Date.now() }; }, true);
  }
}

/* The platform as a class on <body> (`platform-darwin`, `platform-win32`,
   `platform-linux`), so the stylesheet can give the window chrome of each
   its room: macOS insets traffic lights at the left of the toolbar, Windows
   overlays its controls at the right, Linux draws a normal frame. Set before
   the first paint the renderer makes. */
window.addEventListener("DOMContentLoaded", () => {
  document.body.classList.add(`platform-${process.platform}`);
});

/** Main's answer (platform.ts voiceSupported); macOS-only if it cannot say. */
function voiceSupportedNow(): boolean {
  try {
    return ipcRenderer.sendSync("app:voiceSupported") === true;
  } catch {
    return process.platform === "darwin";
  }
}

contextBridge.exposeInMainWorld("atomic", {
  /** Process supervision. */
  status: () => ipcRenderer.invoke("agent:status"),
  start: () => ipcRenderer.invoke("agent:start"),
  restart: () => ipcRenderer.invoke("agent:restart"),
  onStatus: (cb: (payload: unknown) => void) => on("agent:status", cb),
  onLog: (cb: (payload: unknown) => void) => on("agent:log", cb),

  /** Read-only resources, each `{ok, data}` or `{ok:false, error}`. */
  capabilities: () => ipcRenderer.invoke("agent:capabilities"),
  config: () => ipcRenderer.invoke("agent:config"),
  skills: () => ipcRenderer.invoke("agent:skills"),
  tasks: () => ipcRenderer.invoke("agent:tasks"),
  sessions: () => ipcRenderer.invoke("agent:sessions"),
  models: () => ipcRenderer.invoke("agent:models"),
  session: (id: string) => ipcRenderer.invoke("agent:session", id),
  // item 6: DELETE /api/sessions/{id} — the sidebar's delete is a real one
  deleteSession: (id: string) => ipcRenderer.invoke("agent:deleteSession", id),
  codingMode: (mode?: string) => ipcRenderer.invoke("agent:codingMode", mode),

  /** One turn of the agent loop, streamed back over `onChat`. */
  chat: (messages: Array<{ role: string; content: string }>, sessionId?: string) =>
    ipcRenderer.invoke("agent:chat", { messages, sessionId }),
  cancel: (turnId: string) => ipcRenderer.invoke("agent:cancel", turnId),
  onChat: (cb: (payload: unknown) => void) => on("agent:chat", cb),

  /** Approvals raised by gated tools. */
  onApproval: (cb: (payload: unknown) => void) => on("agent:approval", cb),
  approve: (approvalId: string, decision: "allow-once" | "deny", reason?: string) =>
    ipcRenderer.invoke("agent:approve", { approvalId, decision, reason }),
  /** B01 QA, ATO-198: the turns main streams, for a page that loads while they run. */
  liveTurns: () => ipcRenderer.invoke("agent:liveTurns"),
  /** B01 review: the agent replays the approvals still pending (asked once the page has taken the turns over). */
  replayApprovals: () => ipcRenderer.invoke("agent:replayApprovals"),

  /** Setup wizard: real config writes and the real model catalogue. */
  configGet: () => ipcRenderer.invoke("cli:configGet"),
  /** `via` (settings | slash) only matters for analytics.enabled: it is what `analytics_disabled` says. */
  configSet: (key: string, value: string, via?: string) =>
    ipcRenderer.invoke("cli:configSet", via === undefined ? { key, value } : { key, value, via }),
  modelsList: () => ipcRenderer.invoke("cli:modelsList"),
  chatModelsList: () => ipcRenderer.invoke("cli:chatModelsList"),
  modelsUse: (id: string) => ipcRenderer.invoke("cli:modelsUse", id),
  /** `opts.trigger` (onboarding | settings | selector) only labels the download for analytics. */
  modelsPull: (id: string, opts?: { trigger?: string }) =>
    opts === undefined ? ipcRenderer.invoke("cli:modelsPull", id) : ipcRenderer.invoke("cli:modelsPull", id, opts),
  cancelPull: () => ipcRenderer.invoke("cli:cancelPull"),
  onPull: (cb: (payload: unknown) => void) => on("cli:pull", cb),
  modelsSearch: (query: string, provider?: string, limit?: number) =>
    ipcRenderer.invoke("cli:modelsSearch", { query, provider, limit }),
  upsertProvider: (entry: Record<string, unknown>) => ipcRenderer.invoke("cli:upsertProvider", entry),
  setProviderModel: (id: string, model: string) =>
    ipcRenderer.invoke("cli:setProviderModel", { id, model }),
  providerModels: (id: string, kind: string) => ipcRenderer.invoke("cli:providerModels", { id, kind }),
  // r6 cloud item 2: a real one-token completion, the only check that can fail.
  verifyProviderKey: (entry: Record<string, unknown>, model: string) =>
    ipcRenderer.invoke("cli:verifyProviderKey", { entry, model }),
  // ATO-161: an empty key field — a saved key or a variable behind it? Yes or no.
  providerKeyPresent: (entry: { id?: string; kind: string; apiKeyEnvVar?: string; baseUrl?: string }) =>
    ipcRenderer.invoke("cli:providerKeyPresent", entry),
  removeProvider: (id: string) => ipcRenderer.invoke("cli:removeProvider", id),
  modelsStart: () => ipcRenderer.invoke("cli:modelsStart"),
  traceUsage: (stateDir: string, sessionId: string) =>
    ipcRenderer.invoke("cli:traceUsage", { stateDir, sessionId }),
  // item 4: per-call tool durations from the trace
  traceTools: (stateDir: string, sessionId: string) =>
    ipcRenderer.invoke("cli:traceTools", { stateDir, sessionId }),
  hostRam: () => ipcRenderer.invoke("app:hostRam"),
  keyEnv: () => ipcRenderer.invoke("app:keyEnv"),

  /** Shell affordances. */
  chooseWorkspace: () => ipcRenderer.invoke("app:chooseWorkspace"),
  openPath: (path: string) => ipcRenderer.invoke("app:openPath", path),
  // Chat review Д23: `fromReply` for a chip from a reply's text, which main checks again.
  fileMenu: (path: string, fromReply?: boolean) => ipcRenderer.invoke("app:fileMenu", path, fromReply === true),
  // item 5: existence check for the files a turn wrote (fs.stat only)
  statPaths: (paths: string[]) => ipcRenderer.invoke("app:statPaths", paths),
  // Chat review Д23: which paths a reply names are files in the home folder, and opening one
  replyPaths: (paths: string[]) => ipcRenderer.invoke("app:replyPaths", paths),
  openReplyPath: (path: string) => ipcRenderer.invoke("app:openReplyPath", path),
  micStatus: () => ipcRenderer.invoke("app:micStatus"),
  micRequest: () => ipcRenderer.invoke("app:micRequest"),
  resetMicPermission: () => ipcRenderer.invoke("app:resetMicPermission"),
  openMicSettings: () => ipcRenderer.invoke("app:openMicSettings"),
  openExternal: (url: string) => ipcRenderer.invoke("app:openExternal", url),
  /** 13: the page's ground colour (#rrggbb), for the window's own background. */
  windowGround: (color: string) => ipcRenderer.invoke("app:windowGround", color),
  // item 6: the sidebar's own pin/read state (Electron userData/prefs.json) and the row menu
  prefsGet: () => ipcRenderer.invoke("app:prefsGet"),
  prefsSet: (prefs: { pinned: string[]; seen: Record<string, number> }) =>
    ipcRenderer.invoke("app:prefsSet", prefs),
  // r5 item 3: `unread` is the row's current state — main uses it to disable
  // "Mark as Unread" on a row that already reads unread.
  sessionMenu: (id: string, pinned: boolean, unread?: boolean) =>
    ipcRenderer.invoke("app:sessionMenu", { id, pinned, unread }),
  onMenu: (cb: (command: unknown) => void) => on("app:menu", cb),

  /** Item 7 (settings surface): tasks, health, schedule preview. */
  task: (id: string) => ipcRenderer.invoke("agent:task", id),
  cancelTask: (id: string) => ipcRenderer.invoke("agent:cancelTask", id),
  runTask: (id: string) => ipcRenderer.invoke("agent:runTask", id),
  health: () => ipcRenderer.invoke("agent:health"),
  /** Agent 0.6.6 live routes (main/agent-live.ts): a deep-merge config patch and per-server MCP control. */
  configPatch: (patch: Record<string, unknown>) => ipcRenderer.invoke("agent:configPatch", patch),
  mcpServer: (name: string, op: "restart" | "enable" | "disable") => ipcRenderer.invoke("agent:mcpServer", { name, op }),
  taskCreate: (input: { message: string; kind: string; expression: string; tz?: string }) =>
    ipcRenderer.invoke("cli:taskCreate", input),
  taskPreview: (form: Record<string, string>, now?: number) =>
    ipcRenderer.invoke("app:taskPreview", { form, now }),
  quit: () => ipcRenderer.invoke("app:quit"),
  skillList: () => ipcRenderer.invoke("cli:skillList"),
  configGetKey: (key: string) => ipcRenderer.invoke("cli:configGetKey", key),

  /** Item 7 part B: the Skills, Memory and MCP tabs. */
  skill: (name: string) => ipcRenderer.invoke("agent:skill", name),
  uninstallSkill: (name: string, source?: string) => ipcRenderer.invoke("agent:uninstallSkill", { name, source }),
  configSetPath: (key: string, value: unknown) => ipcRenderer.invoke("cli:configSetPath", { key, value }),
  skillShow: (name: string) => ipcRenderer.invoke("cli:skillShow", name),
  skillSetDisabled: (name: string, disabled: boolean) => ipcRenderer.invoke("cli:skillSetDisabled", { name, disabled }),
  skillBrowse: (query?: string) => ipcRenderer.invoke("cli:skillBrowse", query ?? ""),
  /** Д45: the hub's last answer for the query, kept by main; `{ok:false}` when there is none. */
  skillBrowseCached: (query?: string) => ipcRenderer.invoke("cli:skillBrowseCached", query ?? ""),
  skillInstall: (identifier: string, acknowledgeRisk?: boolean) =>
    ipcRenderer.invoke("cli:skillInstall", { identifier, acknowledgeRisk: !!acknowledgeRisk }),
  clawhubSkillDetail: (apiBase: string, slug: string, owner?: string | null) =>
    ipcRenderer.invoke("app:clawhubSkillDetail", { apiBase, slug, owner: owner ?? null }),
  memoryQuery: (stateDir: string, name: string, params?: unknown[]) =>
    ipcRenderer.invoke("app:memoryQuery", { stateDir, name, params: params ?? [] }),

  /** Item 7 part C: the LLM, Telegram and Import tabs. */
  modelsStatus: () => ipcRenderer.invoke("cli:modelsStatus"),
  modelsListEmbeddings: () => ipcRenderer.invoke("cli:modelsListEmbeddings"),
  modelsStop: () => ipcRenderer.invoke("cli:modelsStop"),
  // ATO-119: `stop` lets main stop a server that has the model loaded before it deletes.
  modelsRemove: (id: string, opts?: { stop?: boolean }) => ipcRenderer.invoke("cli:modelsRemove", id, opts ?? {}),
  // An embedding model's files (no `atag models` verb removes one).
  modelsRemoveEmbedding: (id: string, opts?: { stop?: boolean }) => ipcRenderer.invoke("cli:modelsRemoveEmbedding", id, opts ?? {}),
  // ATO-125: what the managed servers really run, asked on their ports.
  modelsServed: () => ipcRenderer.invoke("cli:modelsServed"),
  modelsPullEmbedding: (id: string) => ipcRenderer.invoke("cli:modelsPullEmbedding", id),
  modelsUseEmbedding: (idOrDisable: string) => ipcRenderer.invoke("cli:modelsUseEmbedding", idOrDisable),
  modelsUpdate: () => ipcRenderer.invoke("cli:modelsUpdate"),
  modelsDevices: () => ipcRenderer.invoke("cli:modelsDevices"),
  modelsUseDevice: (id: string) => ipcRenderer.invoke("cli:modelsUseDevice", id),
  configUnset: (key: string) => ipcRenderer.invoke("cli:configUnset", key),
  importRun: (input: Record<string, unknown>) => ipcRenderer.invoke("cli:importRun", input),
  importDefaults: () => ipcRenderer.invoke("app:importDefaults"),
  llamaLogTail: (dataDir: string | null) => ipcRenderer.invoke("app:llamaLogTail", dataDir),
  llamaProbe: (url: string) => ipcRenderer.invoke("app:llamaProbe", url),
  dotenvKeys: (stateDir: string) => ipcRenderer.invoke("app:dotenvKeys", stateDir),
  envPresent: (names: string[]) => ipcRenderer.invoke("app:envPresent", names),
  dotenvSet: (stateDir: string, key: string, value: string | null) =>
    ipcRenderer.invoke("app:dotenvSet", { stateDir, key, value }),

  platform: process.platform,
  /** Windows: repaint the overlaid window controls for the page's theme. */
  setChromeTheme: (dark: boolean) => ipcRenderer.invoke("app:chromeTheme", dark),
  build: () => ipcRenderer.invoke("app:build"),
  /** `kind` (dump | report) only labels the bundle for analytics. */
  debugBundle: (kind?: "dump" | "report") =>
    kind === undefined ? ipcRenderer.invoke("app:debugBundle") : ipcRenderer.invoke("app:debugBundle", kind),
  unverified: () => ipcRenderer.invoke("app:unverified"),
  unverifiedSet: (id: string, on: boolean) => ipcRenderer.invoke("app:unverifiedSet", { id, on }),

  /** Item 2 (voice input): on-device dictation.
   *  `voiceAudio` is the only `ipcRenderer.send` on this bridge and the only
   *  binary payload — it fires ten times a second while recording and there
   *  is nothing to answer. The chunk crosses as a Uint8Array (main checks
   *  for exactly that; it is NOT a Buffer on the other side). */
  /** False where there is no speech helper (Windows, Linux): the composer
   *  then draws no microphone at all rather than a disabled one. */
  voiceSupported: voiceSupportedNow(),
  voiceProbe: () => ipcRenderer.invoke("voice:probe"),
  voiceStart: (locales: string[]) => ipcRenderer.invoke("voice:start", locales),
  voiceAudio: (chunk: Uint8Array) => ipcRenderer.send("voice:audio", chunk),
  voiceStop: () => ipcRenderer.invoke("voice:stop"),
  voiceCancel: () => ipcRenderer.invoke("voice:cancel"),
  voiceInstall: (locale: string) => ipcRenderer.invoke("voice:install", locale),
  voiceSetLocales: (locales: string[]) => ipcRenderer.invoke("voice:setLocales", locales),
  onVoice: (cb: (payload: unknown) => void) => on("app:voice", cb),

  /** Lane B — backend switch: whole-file config writes + agent restart, main-process side. */
  switchBackend: (kind: "cloud" | "local") => ipcRenderer.invoke("cli:switchBackend", kind),
  activateProvider: (id: string) => ipcRenderer.invoke("cli:activateProvider", id),
  selectCloudModel: (id: string, model: string) => ipcRenderer.invoke("cli:selectCloudModel", { id, model }),
  selectLocalModel: (id: string) => ipcRenderer.invoke("cli:selectLocalModel", id),
  /** Run mode — Fusion: RunModeOrchestrator's writes (enter / swap / workers / worker model), each a whole-file write + agent restart. */
  enterFusion: (pins?: { orchestratorProvider?: string; workerProvider?: string }) =>
    ipcRenderer.invoke("cli:enterFusion", pins ?? {}),
  swapFusionLegs: () => ipcRenderer.invoke("cli:swapFusionLegs"),
  /** How a daemon a swap started in the background, without waiting, came up (item 11). */
  onDaemon: (cb: (payload: unknown) => void) => on("cli:daemon", cb),
  /** ATO-123: the local model server brought back after it stopped — each notice (restarting, back, failed, gave up), and the state now. */
  onDaemonWatch: (cb: (payload: unknown) => void) => on("app:daemonWatch", cb),
  daemonWatch: () => ipcRenderer.invoke("app:daemonWatch"),
  fusionWorkers: (workers: number) => ipcRenderer.invoke("cli:fusionWorkers", workers),
  fusionWorkerModel: (id: string) => ipcRenderer.invoke("cli:fusionWorkerModel", id),
  useManagedMode: () => ipcRenderer.invoke("cli:useManagedMode"),
  setExternalLlamaUrl: (url: string) => ipcRenderer.invoke("cli:setExternalLlamaUrl", url),
  providersReady: () => ipcRenderer.invoke("cli:providersReady"),

  /** Lane B — context before the first message (item 3): the projection's sources. */
  traceBaseline: (stateDir: string, model: string | null, workingDir: string | null) =>
    ipcRenderer.invoke("cli:traceBaseline", { stateDir, model, workingDir }),
  modelWindow: (providerId: string, kind: string, model: string) =>
    ipcRenderer.invoke("cli:modelWindow", { providerId, kind, model }),
  llamaProps: (url: string, apiKey?: string) => ipcRenderer.invoke("agent:llamaProps", { url, apiKey }),
  contextPreview: (sessionId: string | null, message: string) =>
    ipcRenderer.invoke("agent:contextPreview", { sessionId, message }),

  /** Item 7A — add a model from Hugging Face (the port lives in main/huggingface.ts). */
  hfResolve: (ref: string) => ipcRenderer.invoke("cli:hfResolve", ref),
  hfCancel: () => ipcRenderer.invoke("cli:hfCancel"),
  hfDef: (repo: unknown, index: number) => ipcRenderer.invoke("cli:hfDef", { repo, index }),
  hfAdd: (repo: unknown, index: number) => ipcRenderer.invoke("cli:hfAdd", { repo, index }),
  hfProjector: (id: string, mmprojUrl: string, mmprojFilename: string, name?: string) =>
    ipcRenderer.invoke("cli:hfProjector", { id, mmprojUrl, mmprojFilename, name }),

  /** r5 item 9 — the desktop's own state directory, and the TUI import offer.
   *  `tuiSetupPresent` reports env var NAMES only; `importFromTui` copies only
   *  the flags that are ticked and never touches the source. */
  firstRun: () => ipcRenderer.invoke("app:firstRun"),
  /** Backlog 03 — `firstRun().fresh`, handed over with the window rather than
   *  asked for, so the renderer can open the wizard before its first paint. */
  freshAtBoot: process.argv.includes("--atomic-fresh-state"),
  /** Backlog 03 — the boot frames above; empty unless main armed the probe. */
  bootPaint: () => BOOT_PAINT,
  tuiSetupPresent: () => ipcRenderer.invoke("app:tuiSetupPresent"),
  importFromTui: (opts: Record<string, boolean>) => ipcRenderer.invoke("app:importFromTui", opts),
  /** r5 item 7 — setup wizard: the streamed runtime phase, the custom-endpoint
   *  whole-file write, and the first-run import scan. */
  modelsUpdateStream: () => ipcRenderer.invoke("cli:modelsUpdateStream"),
  setExternalLlamaUrls: (chatUrl: string, embeddingUrl?: string) =>
    ipcRenderer.invoke("cli:setExternalLlamaUrls", { chatUrl, embeddingUrl: embeddingUrl ?? "" }),
  detectImportAgents: () => ipcRenderer.invoke("app:detectImportAgents"),

  /** Item 7C — mid-turn steering (POST/GET/DELETE /api/sessions/{id}/steer). */
  steer: (sessionId: string, text: string) => ipcRenderer.invoke("agent:steer", { sessionId, text }),
  undeliveredSteers: (sessionId: string) => ipcRenderer.invoke("agent:undeliveredSteers", sessionId),
  ackSteers: (sessionId: string, through: number, discarded: number) =>
    ipcRenderer.invoke("agent:ackSteers", { sessionId, through, discarded }),

  /** ATO-229 — app updates (main/updater.ts). Nothing downloads or installs
   *  except through updateDownload / updateInstall, each a click. Every call
   *  answers the updater's state; `onUpdateState` gets every change. */
  updateState: () => ipcRenderer.invoke("updates:get"),
  updateCheck: () => ipcRenderer.invoke("updates:check"),
  updateDownload: () => ipcRenderer.invoke("updates:download"),
  updateCancel: () => ipcRenderer.invoke("updates:cancel"),
  updateInstall: () => ipcRenderer.invoke("updates:install"),
  updateLater: () => ipcRenderer.invoke("updates:later"),
  updateDismiss: () => ipcRenderer.invoke("updates:dismiss"),
  updateSkip: () => ipcRenderer.invoke("updates:skip"),
  updateSetAuto: (on: boolean) => ipcRenderer.invoke("updates:setAuto", on === true),
  onUpdateState: (cb: (payload: unknown) => void) => on("updates:state", cb),

  /** Analytics (desktop/ANALYTICS.md): fire and forget. Main re-validates
   *  every event against its allowlist and drops anything it does not know;
   *  nothing is sent while analytics is off. */
  track: (event: string, props?: Record<string, unknown>) => {
    if (typeof event !== "string") return;
    try {
      ipcRenderer.send("analytics:track", { event, props: props && typeof props === "object" ? props : {} });
    } catch {
      /* a value that cannot cross the bridge is dropped, never thrown at the caller */
    }
  },
  /** A renderer error for the crash report. Main scrubs it (no message, basenames only). */
  reportError: (payload: { kind: "error" | "unhandledrejection"; name: string; message: string; stack: string }) => {
    if (!payload || typeof payload !== "object") return;
    try {
      ipcRenderer.send("errors:report", {
        kind: payload.kind,
        name: String(payload.name ?? ""),
        message: String(payload.message ?? ""),
        stack: typeof payload.stack === "string" ? payload.stack.slice(0, 20_000) : "",
      });
    } catch {
      /* never thrown at the caller */
    }
  },
});
