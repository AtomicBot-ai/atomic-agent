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

  /** Setup wizard: real config writes and the real model catalogue. */
  configGet: () => ipcRenderer.invoke("cli:configGet"),
  configSet: (key: string, value: string) => ipcRenderer.invoke("cli:configSet", { key, value }),
  modelsList: () => ipcRenderer.invoke("cli:modelsList"),
  chatModelsList: () => ipcRenderer.invoke("cli:chatModelsList"),
  modelsUse: (id: string) => ipcRenderer.invoke("cli:modelsUse", id),
  modelsPull: (id: string) => ipcRenderer.invoke("cli:modelsPull", id),
  cancelPull: () => ipcRenderer.invoke("cli:cancelPull"),
  onPull: (cb: (payload: unknown) => void) => on("cli:pull", cb),
  modelsSearch: (query: string, provider?: string, limit?: number) =>
    ipcRenderer.invoke("cli:modelsSearch", { query, provider, limit }),
  upsertProvider: (entry: Record<string, unknown>) => ipcRenderer.invoke("cli:upsertProvider", entry),
  setProviderModel: (id: string, model: string) =>
    ipcRenderer.invoke("cli:setProviderModel", { id, model }),
  providerModels: (id: string, kind: string) => ipcRenderer.invoke("cli:providerModels", { id, kind }),
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
  fileMenu: (path: string) => ipcRenderer.invoke("app:fileMenu", path),
  // item 5: existence check for the files a turn wrote (fs.stat only)
  statPaths: (paths: string[]) => ipcRenderer.invoke("app:statPaths", paths),
  openExternal: (url: string) => ipcRenderer.invoke("app:openExternal", url),
  // item 6: the sidebar's own pin/read state (Electron userData/prefs.json) and the row menu
  prefsGet: () => ipcRenderer.invoke("app:prefsGet"),
  prefsSet: (prefs: { pinned: string[]; seen: Record<string, number> }) =>
    ipcRenderer.invoke("app:prefsSet", prefs),
  sessionMenu: (id: string, pinned: boolean) => ipcRenderer.invoke("app:sessionMenu", { id, pinned }),
  onMenu: (cb: (command: unknown) => void) => on("app:menu", cb),

  /** Item 7 (settings surface): tasks, health, schedule preview. */
  task: (id: string) => ipcRenderer.invoke("agent:task", id),
  cancelTask: (id: string) => ipcRenderer.invoke("agent:cancelTask", id),
  runTask: (id: string) => ipcRenderer.invoke("agent:runTask", id),
  health: () => ipcRenderer.invoke("agent:health"),
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
  modelsRemove: (id: string) => ipcRenderer.invoke("cli:modelsRemove", id),
  modelsPullEmbedding: (id: string) => ipcRenderer.invoke("cli:modelsPullEmbedding", id),
  modelsUseEmbedding: (idOrDisable: string) => ipcRenderer.invoke("cli:modelsUseEmbedding", idOrDisable),
  modelsUpdate: () => ipcRenderer.invoke("cli:modelsUpdate"),
  modelsDevices: () => ipcRenderer.invoke("cli:modelsDevices"),
  modelsUseDevice: (id: string) => ipcRenderer.invoke("cli:modelsUseDevice", id),
  configUnset: (key: string) => ipcRenderer.invoke("cli:configUnset", key),
  importRun: (input: Record<string, unknown>) => ipcRenderer.invoke("cli:importRun", input),
  importDefaults: () => ipcRenderer.invoke("app:importDefaults"),
  llamaLogTail: (dataDir: string) => ipcRenderer.invoke("app:llamaLogTail", dataDir),
  llamaProbe: (url: string) => ipcRenderer.invoke("app:llamaProbe", url),
  dotenvKeys: (stateDir: string) => ipcRenderer.invoke("app:dotenvKeys", stateDir),
  envPresent: (names: string[]) => ipcRenderer.invoke("app:envPresent", names),
  dotenvSet: (stateDir: string, key: string, value: string | null) =>
    ipcRenderer.invoke("app:dotenvSet", { stateDir, key, value }),

  platform: process.platform,

  /** Item 2 (voice input): on-device dictation.
   *  `voiceAudio` is the only `ipcRenderer.send` on this bridge and the only
   *  binary payload — it fires ten times a second while recording and there
   *  is nothing to answer. The chunk crosses as a Uint8Array (main checks
   *  for exactly that; it is NOT a Buffer on the other side). */
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
});
