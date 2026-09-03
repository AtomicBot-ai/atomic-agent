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
  hostRam: () => ipcRenderer.invoke("app:hostRam"),
  keyEnv: () => ipcRenderer.invoke("app:keyEnv"),

  /** Shell affordances. */
  chooseWorkspace: () => ipcRenderer.invoke("app:chooseWorkspace"),
  openPath: (path: string) => ipcRenderer.invoke("app:openPath", path),
  fileMenu: (path: string) => ipcRenderer.invoke("app:fileMenu", path),
  openExternal: (url: string) => ipcRenderer.invoke("app:openExternal", url),
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

  platform: process.platform,
});
