import {
  chatModelsList,
  keyNamesAvailable,
  localDaemonRunning,
  modelsList,
  modelsStart,
  modelsStop,
  modelsUse,
  providerHasKey,
  readWholeConfig,
  rewriteWholeConfig,
  setActiveTextProvider,
  setMemoryEmbeddingsEnabled,
  setProviderModel,
  useManagedMode,
  type ProviderEntry,
} from "./agent-cli.js";
import {
  describeRunMode,
  planEnterFusion,
  planFusionWorkers,
  planSwapLegs,
  resolveRunMode,
  type RunModeProvider,
  type RunModeVerdict,
} from "./run-mode.js";

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
  /** Run-mode switches: the one sentence a refused change is told in (nothing was written). */
  refusal?: string;
  /** Run-mode switches: the effective mode either side of the write, and the TUI's `run mode: …` line. */
  runMode?: { before: string; after: string; line: string; enteredFusion: boolean };
  /** setFusionWorkers: the TUI's `fusion: N workers …` line. */
  notice?: string;
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
export async function activateProvider(id: string, opts: { leaveFusion?: boolean } = {}): Promise<SwitchResult> {
  const read = await readWholeConfig();
  if (!read.ok || !read.config) return { ok: false, error: read.error };
  const entry = (read.config.llm?.providers ?? []).find((p) => p.id === id);
  if (!entry) return { ok: false, error: `provider "${id}" is not configured` };
  const cloud = entry.kind !== "llama-server";
  if (cloud && !providerHasKey(entry)) {
    return { ok: false, needsKey: true, providerId: id, error: "no API key" };
  }
  /* Under effective Fusion the orchestrator IS the active provider, and its
     own model chip re-activates it: that keeps the mode (the TUI's
     selectChatModel on the active provider), and it must not stop the local
     daemon the workers run on. Every other activation — another provider,
     or the backend row's `cloud` — leaves Fusion in the same write. */
  const rm = resolveRunMode(read.config);
  const keepFusion = !opts.leaveFusion && rm.effective === "fusion" && rm.orchestratorProviderId === id;
  const w = await setActiveTextProvider(id, { leaveFusion: !keepFusion });
  if (!w.ok) return { ok: false, error: w.error };
  // `restart` says the file moved. main.ts also restarts when the file did
  // NOT move but `atag serve` booted on another route (the TUI or a hand
  // edit changed the file while this window was open) — see applySwitch.
  let restart = w.changed;
  let daemon: DaemonEffect = "untouched";
  let daemonLine: string | undefined;
  if (cloud && !keepFusion && (await localDaemonRunning())) {
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
  const w = await setActiveTextProvider(LOCAL_ID, { leaveFusion: true });
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
    // Under Fusion the active provider is the orchestrator, so "cloud" picks
    // it — and without leaveFusion the stored mode would keep it in Fusion.
    return activateProvider(provider.id, { leaveFusion: true });
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
    const w = await setActiveTextProvider(LOCAL_ID, { leaveFusion: true });
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

/* ---------------------------------------------------------------
   Run mode — Fusion. RunModeOrchestrator's writes, main-process side.

   Each one is ONE whole-file write under one hold of the config lock
   (rewriteWholeConfig + a planner from run-mode.ts), then the same
   `restart` the other switches return: `atag serve` reads its config once
   (getConfig is cached in-process), so neither the active provider nor the
   run mode reaches a running agent any other way.
   --------------------------------------------------------------- */

function keyed(): (p: RunModeProvider) => boolean {
  const names = keyNamesAvailable();
  return (p) => providerHasKey(p as ProviderEntry, names);
}

/** Start the managed daemon when it is down (restart it when the model moved). */
async function bringUpLocalDaemon(modelChanged: boolean): Promise<{ daemon: DaemonEffect; daemonLine?: string; error?: string }> {
  const running = await localDaemonRunning();
  if (running && !modelChanged) return { daemon: "untouched" };
  if (running) {
    const s = await modelsStop();
    if (!s.ok) return { daemon: "stop-failed", daemonLine: `local-llm: stop failed — ${s.error ?? "unknown error"}` };
    const st = await modelsStart();
    return st.ok ? { daemon: "restarted", daemonLine: readyLine(st.stdout) } : { daemon: "start-failed", error: st.error };
  }
  const st = await modelsStart();
  return st.ok ? { daemon: "started", daemonLine: readyLine(st.stdout) } : { daemon: "start-failed", error: st.error };
}

async function afterRunModeWrite(res: {
  ok: boolean;
  changed: boolean;
  error?: string;
  verdict?: RunModeVerdict;
}): Promise<SwitchResult> {
  if (!res.ok) return { ok: false, error: res.error };
  const v = res.verdict;
  if (v?.refusal) return { ok: false, refusal: v.refusal, error: v.refusal };
  const read = await readWholeConfig();
  if (!read.ok || !read.config) return { ok: false, error: read.error };
  const now = resolveRunMode(read.config);
  const leg = v?.leg ?? now.primaryProviderId;
  const entry = (read.config.llm?.providers ?? []).find((p) => p.id === leg);
  /* The worker daemon. autoStartIfReady keys on local-llama being the ACTIVE
     provider, and under Fusion the active provider is the orchestrator — so
     nothing else would bring a local leg up. Only for a model that is on
     disk: a start for a file that is not there is a failure line about
     nothing the operator chose. */
  let up: { daemon: DaemonEffect; daemonLine?: string; error?: string } = { daemon: "untouched" };
  const lm = read.config.localModels ?? {};
  const localLeg = now.effective === "fusion" && (now.workerProviderId === LOCAL_ID || now.orchestratorProviderId === LOCAL_ID);
  if (localLeg && lm.mode === "managed" && lm.managed?.modelId) {
    const list = await chatModelsList();
    if (list.ok && (list.models ?? []).some((m) => m.id === lm.managed?.modelId && m.downloaded)) {
      up = await bringUpLocalDaemon(false);
    }
  }
  return {
    ok: true,
    providerId: leg,
    model: entry ? (entry.defaultChatModel ?? entry.model ?? null) : null,
    transport: transportFor(leg),
    ...up,
    restart: res.changed,
    runMode: {
      before: v?.before.effective ?? now.effective,
      after: now.effective,
      line: `run mode: ${describeRunMode(now)}`,
      enteredFusion: now.effective === "fusion" && (v?.before.effective ?? now.effective) !== "fusion",
    },
  };
}

/**
 * setMode("fusion", {fusion: pins}) — the backend row's `fusion`, the
 * provider control under Fusion (orchestrator pin) and a cloud row in the
 * workers control (worker pin).
 */
export async function enterFusion(pins: { orchestratorProvider?: string; workerProvider?: string } = {}): Promise<SwitchResult> {
  const isKeyed = keyed();
  return afterRunModeWrite(await rewriteWholeConfig((cfg) => planEnterFusion(cfg, pins, isKeyed)));
}

/** swapLegs — the composer's ⇄ and `/runmode swap`. */
export async function swapFusionLegs(): Promise<SwitchResult> {
  const isKeyed = keyed();
  return afterRunModeWrite(await rewriteWholeConfig((cfg) => planSwapLegs(cfg, isKeyed)));
}

/**
 * setWorkers — `fusion.workers` and `managed.parallel` together. The agent
 * took the count at boot, so it restarts only while Fusion is what runs;
 * off Fusion the count is remembered for the next time it is picked.
 */
export async function setFusionWorkers(workers: number): Promise<SwitchResult> {
  const res = await rewriteWholeConfig((cfg) => planFusionWorkers(cfg, workers));
  if (!res.ok) return { ok: false, error: res.error };
  const v = res.verdict;
  if (v?.refusal) return { ok: false, refusal: v.refusal, error: v.refusal };
  return { ok: true, notice: v?.notice, restart: res.changed && v?.after?.effective === "fusion" };
}

/**
 * The workers control's model rows: activateComposerSwitchRow
 * `fusionWorkerModel`. Picking a model for the worker slot claims the slot
 * for the local provider, then the managed daemon moves to it through
 * `models use` — which writes localModels.* only, never activeTextProvider,
 * so Fusion survives the pick (the TUI deliberately avoids
 * triggerLlmPrimary here for the same reason).
 */
export async function selectFusionWorkerModel(modelId: string): Promise<SwitchResult> {
  if (!/^[\w.-]{1,96}$/.test(modelId)) return { ok: false, error: `not a model id: ${modelId}` };
  const list = await chatModelsList();
  if (!list.ok || !list.models) return { ok: false, error: list.error };
  const row = list.models.find((m) => m.id === modelId);
  if (!row) return { ok: false, error: `unknown model id: ${modelId}` };
  if (!row.downloaded) {
    return { ok: false, needsDownload: true, modelId, error: `local model ${modelId} is not downloaded` };
  }
  const isKeyed = keyed();
  const pin = await rewriteWholeConfig((cfg): RunModeVerdict => {
    const rm = resolveRunMode(cfg);
    if (rm.effective === "fusion" && rm.workerProviderId === LOCAL_ID) return { write: false, before: rm };
    return planEnterFusion(cfg, { workerProvider: LOCAL_ID }, isKeyed);
  });
  const settled = await afterRunModeWrite(pin);
  if (!settled.ok) return settled;
  const read = await readWholeConfig();
  if (!read.ok || !read.config) return { ok: false, error: read.error };
  const lm = read.config.localModels ?? {};
  const changed = lm.mode !== "managed" || (lm.managed?.modelId ?? null) !== modelId;
  if (changed) {
    const used = await modelsUse(modelId);
    if (!used.ok) return { ok: false, error: used.error };
  }
  const up = await bringUpLocalDaemon(changed);
  return {
    ...settled,
    ...up,
    modelId,
    restart: !!settled.restart || changed,
  };
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
