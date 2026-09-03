import {
  chatModelsList,
  localDaemonRunning,
  modelsList,
  modelsStart,
  modelsStop,
  modelsUse,
  providerHasKey,
  readWholeConfig,
  setActiveTextProvider,
  setMemoryEmbeddingsEnabled,
  setProviderModel,
  useManagedMode,
  type ProviderEntry,
} from "./agent-cli.js";

/**
 * Lane B — backend switch.
 *
 * The TUI's decision logic for "where it runs", main-process side. Each
 * function is a port of one TUI path and returns a plain result the
 * renderer only renders:
 *
 *   activateProvider  ← llm-panel-primary-actions.ts triggerCloudProvider
 *                       → providers-orchestrator.ts setActiveText
 *                       → stopLocalDaemonsForCloudSelection
 *   switchBackend     ← composer-switch-activate.ts activateCloud / activateLocal
 *   selectCloudModel  ← triggerCloudChatModel → providers-orchestrator.ts selectChatModel
 *   selectLocalModel  ← triggerLocalChatModel → local-models-orchestrator.ts setActive
 *
 * One thing the TUI does not need: `restart`. The TUI hot-swaps the
 * provider in its own process; `atag serve` pins the active provider at
 * boot and 0.5.4 has no reload route, so main.ts restarts the child
 * whenever a result says `restart: true`. That is why every entry point
 * in the renderer refuses to run while a turn is in flight.
 */

export type DaemonEffect =
  | "untouched"
  | "stopped"
  | "stop-failed"
  | "started"
  | "restarted"
  | "start-failed";

export interface SwitchResult {
  ok: boolean;
  providerId?: string;
  /** The provider's configured chat model, or null (cloud). */
  model?: string | null;
  /** The managed local model (local). */
  modelId?: string;
  transport?: "grammar+llama-server" | "native_tools";
  daemon?: DaemonEffect;
  /** The TUI's runtime_info line for the daemon effect, when there is one. */
  daemonLine?: string;
  /** main.ts restarts `atag serve` when true. */
  restart?: boolean;
  /** activateCloud: no cloud provider configured — open the add wizard. */
  needsProvider?: boolean;
  /** The chosen provider has no key — open its configure step, as the TUI does. */
  needsKey?: boolean;
  /** activateLocal: nothing downloaded — the route moved, the model switch should open. */
  needsModel?: boolean;
  /** selectLocalModel on a model that is not on disk — pull it first. */
  needsDownload?: boolean;
  error?: string;
}

const LOCAL_ID = "local-llama";

function transportFor(id: string): "grammar+llama-server" | "native_tools" {
  return id === LOCAL_ID ? "grammar+llama-server" : "native_tools";
}

/**
 * `chat: started pid N, healthy on port P` → the TUI's ready line;
 * otherwise the CLI's own last stdout line, or nothing at all — never a
 * URL with a port this process guessed (`daemon: started` is already in
 * the result).
 */
function readyLine(stdout: string): string | undefined {
  const m = /chat: started pid (\d+), healthy on port (\d+)/.exec(stdout);
  if (m) return `local-llm: ready — pid ${m[1]} on http://127.0.0.1:${m[2]}`;
  const last = stdout.trim().split("\n").filter(Boolean).pop();
  return last ? `local-llm: ${last}` : undefined;
}

/**
 * triggerCloudProvider + setActiveText + stopLocalDaemonsForCloudSelection.
 * Write 1 is llm.activeTextProvider; the daemon stop comes after it, and
 * only a successful stop is followed by write 2 (memory.embeddings.enabled
 * = false), which is the order the TUI's stopDaemon does it.
 */
export async function activateProvider(id: string): Promise<SwitchResult> {
  const read = await readWholeConfig();
  if (!read.ok || !read.config) return { ok: false, error: read.error };
  const entry = (read.config.llm?.providers ?? []).find((p) => p.id === id);
  if (!entry) return { ok: false, error: `provider "${id}" is not configured` };
  const cloud = entry.kind !== "llama-server";
  if (cloud && !providerHasKey(entry)) {
    return { ok: false, needsKey: true, providerId: id, error: "no API key" };
  }
  const w = await setActiveTextProvider(id);
  if (!w.ok) return { ok: false, error: w.error };
  // `restart` says the file moved. main.ts also restarts when the file did
  // NOT move but `atag serve` booted on another route (the TUI or a hand
  // edit changed the file while this window was open) — see applySwitch.
  let restart = w.changed;
  let daemon: DaemonEffect = "untouched";
  let daemonLine: string | undefined;
  if (cloud && (await localDaemonRunning())) {
    const s = await modelsStop();
    if (s.ok) {
      daemon = "stopped";
      daemonLine = "local-llm: daemons stopped — hybrid recall off (embedding switch unchanged)";
      const m = await setMemoryEmbeddingsEnabled(false);
      if (m.changed) restart = true;
    } else {
      daemon = "stop-failed";
      daemonLine = `local-llm: stop failed — ${s.error ?? "unknown error"}`;
    }
  }
  return {
    ok: true,
    providerId: id,
    model: entry.defaultChatModel ?? entry.model ?? null,
    transport: transportFor(id),
    daemon,
    daemonLine,
    restart,
  };
}

/**
 * The local half of a switch once a downloaded model is known:
 * localModels.mode/managed.modelId via `models use` (with the url sync)
 * when they differ, the route to local-llama, then the daemon — started
 * when it is down, restarted only when the model changed, left alone
 * otherwise (triggerLocalChatModel + setActive).
 */
async function routeToLocal(modelId: string): Promise<SwitchResult> {
  const read = await readWholeConfig();
  if (!read.ok || !read.config) return { ok: false, error: read.error };
  const lm = read.config.localModels ?? {};
  const changed = lm.mode !== "managed" || (lm.managed?.modelId ?? null) !== modelId;
  let restart = false;
  if (changed) {
    const used = await modelsUse(modelId);
    if (!used.ok) return { ok: false, error: used.error };
    restart = true;
  }
  const w = await setActiveTextProvider(LOCAL_ID);
  if (!w.ok) return { ok: false, error: w.error };
  if (w.changed) restart = true;

  const running = await localDaemonRunning();
  let daemon: DaemonEffect = "untouched";
  let daemonLine: string | undefined;
  let error: string | undefined;
  if (running && changed) {
    daemonLine = `local-llm: restarting daemon for ${modelId}…`;
    const s = await modelsStop();
    if (!s.ok) {
      daemon = "stop-failed";
      daemonLine = `local-llm: stop failed — ${s.error ?? "unknown error"}`;
    } else {
      const st = await modelsStart();
      daemon = st.ok ? "restarted" : "start-failed";
      daemonLine = st.ok ? readyLine(st.stdout) : undefined;
      if (!st.ok) error = st.error;
    }
  } else if (!running) {
    const st = await modelsStart();
    daemon = st.ok ? "started" : "start-failed";
    daemonLine = st.ok ? readyLine(st.stdout) : undefined;
    if (!st.ok) error = st.error;
  }
  return {
    ok: true,
    providerId: LOCAL_ID,
    modelId,
    transport: transportFor(LOCAL_ID),
    daemon,
    daemonLine,
    restart,
    error,
  };
}

/** activateCloud / activateLocal from composer-switch-activate.ts. */
export async function switchBackend(kind: "cloud" | "local"): Promise<SwitchResult> {
  if (kind === "cloud") {
    const read = await readWholeConfig();
    if (!read.ok || !read.config) return { ok: false, error: read.error };
    const llm = read.config.llm ?? {};
    const cloud = (llm.providers ?? []).filter((p) => p.kind !== "llama-server");
    const provider: ProviderEntry | undefined =
      cloud.find((p) => p.id === llm.activeTextProvider) ??
      cloud.find((p) => providerHasKey(p)) ??
      cloud[0];
    if (!provider) return { ok: false, needsProvider: true, error: "add a provider first" };
    return activateProvider(provider.id);
  }

  // Embedding models are a separate daemon; the chat route never picks
  // them. chatModelsList subtracts the CLI's own embedding catalogue.
  const list = await chatModelsList();
  if (!list.ok || !list.models) return { ok: false, error: list.error };
  const rows = list.models;
  const ready = rows.find((m) => m.active && m.downloaded) ?? rows.find((m) => m.downloaded);
  if (!ready) {
    // Nothing on disk: point the route at local-llama and make the mode
    // managed so the control does not read `custom` on the next frame;
    // the renderer opens the model pane.
    const w = await setActiveTextProvider(LOCAL_ID);
    if (!w.ok) return { ok: false, error: w.error };
    const m = await useManagedMode();
    if (!m.ok) return { ok: false, error: m.error };
    return {
      ok: true,
      providerId: LOCAL_ID,
      transport: transportFor(LOCAL_ID),
      daemon: "untouched",
      needsModel: true,
      restart: w.changed || m.changed,
    };
  }
  return routeToLocal(ready.id);
}

/**
 * triggerCloudChatModel → selectChatModel: the key check comes first, as
 * the TUI's does, so a provider without one opens its configure step and
 * nothing is written; then the model, then the activation (which also
 * stops the local daemons).
 */
export async function selectCloudModel(providerId: string, modelId: string): Promise<SwitchResult> {
  if (!modelId.trim()) return { ok: false, error: "chat model id is empty" };
  const read = await readWholeConfig();
  if (!read.ok || !read.config) return { ok: false, error: read.error };
  const entry = (read.config.llm?.providers ?? []).find((p) => p.id === providerId);
  if (!entry) return { ok: false, error: `provider "${providerId}" is not configured` };
  if (entry.kind !== "llama-server" && !providerHasKey(entry)) {
    return { ok: false, needsKey: true, providerId, error: "no API key" };
  }
  const modelChanged = entry.defaultChatModel !== modelId.trim();
  const w = await setProviderModel(providerId, modelId.trim());
  if (!w.ok) return { ok: false, error: w.error };
  const res = await activateProvider(providerId);
  if (!res.ok) return res;
  return { ...res, model: modelId.trim(), restart: res.restart || modelChanged };
}

/** triggerLocalChatModel for a downloaded model; a pull is the renderer's job. */
export async function selectLocalModel(modelId: string): Promise<SwitchResult> {
  if (!/^[\w.-]{1,64}$/.test(modelId)) return { ok: false, error: `not a model id: ${modelId}` };
  const list = await modelsList();
  if (!list.ok || !list.models) return { ok: false, error: list.error };
  const row = list.models.find((m) => m.id === modelId);
  if (!row) return { ok: false, error: `unknown model id: ${modelId}` };
  if (!row.downloaded) {
    return { ok: false, needsDownload: true, modelId, error: `local model ${modelId} is not downloaded` };
  }
  return routeToLocal(modelId);
}
