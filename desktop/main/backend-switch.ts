import { AsyncLocalStorage } from "node:async_hooks";

import {
  abortStarts,
  applyActiveTextProvider,
  applyManagedMode,
  chatModelsList,
  closeStarts,
  configFileHint,
  configLockTurns,
  daemonFoundUp,
  daemonPidsIn,
  embeddingPidAlive,
  embeddingsWanted,
  keyNamesAvailable,
  killDaemonLeftovers,
  localDaemonRunning,
  managedDaemonPidAlive,
  modelsList,
  modelsEngine,
  modelsStart,
  modelsStartEmbedding,
  modelsStop,
  stopEmbeddingServer,
  modelsUse,
  providerHasKey,
  providerIsUsable,
  providerKeyInvalid,
  STORED_KEY_INVALID,
  parseChatStartSpeed,
  readWholeConfig,
  rewriteWholeConfig,
  setActiveTextProvider,
  setMemoryEmbeddingsEnabled,
  setProviderModel,
  startsInFlight,
  stopsAsked,
  START_REFUSED_MOVED_ON,
  START_REFUSED_QUITTING,
  withCliStandIn,
  type CliResult,
  type CliStandIn,
  type CliStandInHooks,
  type ProviderEntry,
  type UserConfigShape,
} from "./agent-cli.js";
import {
  describeRunMode,
  planEnterFusion,
  planFusionWorkers,
  planSwapLegs,
  resolveRunMode,
  type ResolvedRunMode,
  type RunModeProvider,
  type RunModeVerdict,
} from "./run-mode.js";
import { isIncompleteProvider } from "./provider-hygiene.js";

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
 * in the renderer refuses to run while a turn is in flight — and why main
 * holds the restart back itself while one is (restartAfterSwitch).
 */

export type DaemonEffect =
  | "untouched"
  | "stopped"
  | "stop-failed"
  | "started"
  | "restarted"
  | "start-failed"
  /** A bring-up that started nothing because the model is not on disk (or the list could not be read) — not "already running". */
  | "skipped"
  /** A background bring-up that a stop or a route change ended (item 11), or any start whose turn came after the quit closed the turns (backlog 18): it reports nothing and does nothing more. */
  | "superseded";

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
  /** main.ts restarts `atag serve` when true (restartAfterSwitch says when it does not). */
  restart?: boolean;
  /** Set by main.ts's applySwitch: the switch landed, but `atag serve` was not restarted under the turns still running — it restarts once the last one ends. */
  restartHeld?: boolean;
  /** activateCloud: no cloud provider configured — open the add wizard. */
  needsProvider?: boolean;
  /** The chosen provider has no key — open its configure step, as the TUI does. */
  needsKey?: boolean;
  /** Backlog 32: with needsKey — it has a saved key, but one the agent will not send. */
  keyInvalid?: boolean;
  /** activateLocal: nothing downloaded — the route moved, the model switch should open. */
  needsModel?: boolean;
  /** activateProvider: the entry has no chat model yet (U29) — open its model list. */
  needsChatModel?: boolean;
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

/** A provider that cannot be routed to for want of a key: none at all, or (backlog 32) a saved one the agent will not send. */
function needsKeyFor(entry: ProviderEntry, providerId: string): SwitchResult {
  return providerKeyInvalid(entry)
    ? { ok: false, needsKey: true, keyInvalid: true, providerId, error: STORED_KEY_INVALID }
    : { ok: false, needsKey: true, providerId, error: "no API key" };
}

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
  const speed = parseChatStartSpeed(stdout);
  if (m) return `local-llm: ready — pid ${m[1]} on http://127.0.0.1:${m[2]}${speed ? ` · ~${speed.tokensPerSecond} tok/s` : ""}`;
  const last = stdout.trim().split("\n").filter(Boolean).pop();
  return last ? `local-llm: ${last}` : undefined;
}

/* ATO-157 — what a switch costs. Every `atag` call below is a process of its
   own (~0.6 s on a quiet Mac, more on one deep in swap), and they ran one
   after another: the cloud switch read the whole config four times (the
   provider pick, the activation, the route write, the embeddings flag) around
   its two writes, a `models status` and a `models stop` — eight processes
   before the agent's restart. Now the pick, the checks and the route are one
   read and one write under one hold of the config lock (rewriteWholeConfig),
   the Cloud switch asks the daemon's status beside them when a stop looks
   needed and no start can be on its way (earlyDaemonLook), and the
   embeddings flag is written only when the file still has it on.

   Left as it was, said out loud: the agent's own `models` commands (a pull,
   an update, `models use`) and the TUI write the file outside this process's
   lock, so a write of theirs between the read and the write here is lost, as
   it was before (the "migration race" of the review). */

/** What one activation decided, read and planned under the config lock. */
interface ActivationPlan {
  write: boolean;
  /** Nothing was written: the switch's answer (no provider, no key, no chat model). */
  refuse?: SwitchResult;
  id?: string;
  entry?: ProviderEntry;
  cloud?: boolean;
  keepFusion?: boolean;
  /** memory.embeddings.enabled is already false in the file as written. */
  embeddingsOff?: boolean;
}

/**
 * Whether the Cloud switch will stop a local model server — asked of the
 * config file and the pid files on disk, no process spawned. Only a hint:
 * false whenever it cannot tell, and the switch then asks `models status`
 * after its write, as it always did.
 */
function cloudSwitchLikelyStops(): boolean {
  const cfg = configFileHint();
  if (!cfg) return false;
  const id = pickCloudProvider(cfg);
  if (typeof id !== "string") return false;   // refused: no provider
  const entry = (cfg.llm?.providers ?? []).find((p) => p.id === id);
  if (!entry || !providerIsUsable(entry) || isIncompleteProvider(entry)) return false;   // refused: no key, no chat model
  return managedDaemonPidAlive(cfg);
}

/**
 * The Cloud switch's `models status`, asked at once, beside the config's read
 * and write, instead of after them. Only when no start can be on its way — no
 * daemon turn, no background bring-up, no `models start` — because the look
 * is taken before supersedeBringUp ends such a start, and a server that start
 * spawned would not be in it (item 11).
 *
 * `still()`, asked after the write and the switch's own supersedeBringUp,
 * says whether the look still holds: no turn begun, nothing in flight, no
 * stop asked for (Settings › Stop, the route leaving the managed daemon, a
 * stop of any kind) and no mark moved but by the switch's own one bump. When
 * it does not hold, the status is asked again.
 */
function earlyDaemonLook(): { running: Promise<boolean>; still: () => boolean } | null {
  const d = book();
  const quiet = () => d.background === null && d.onTheirWay === 0 && startsInFlight() === 0;
  if (!quiet()) return null;
  const begun = d.begun;
  const mark = d.mark;
  const stops = stopsAsked();
  return {
    running: localDaemonRunning({ reapWedged: false }),
    still: () => quiet() && d.begun === begun && d.mark === mark + 1 && stopsAsked() === stops,
  };
}

/**
 * triggerCloudProvider + setActiveText + stopLocalDaemonsForCloudSelection.
 * Write 1 is llm.activeTextProvider; the daemon stop comes after it, and
 * only a successful stop is followed by write 2 (memory.embeddings.enabled
 * = false), which is the order the TUI's stopDaemon does it.
 */
export function activateProvider(id: string, opts: { leaveFusion?: boolean } = {}): Promise<SwitchResult> {
  return activate(() => id, opts);
}

/** activateProvider for the provider `pick` names in the file as read, or `pick`'s refusal. */
async function activate(
  pick: (cfg: UserConfigShape) => string | SwitchResult,
  opts: { leaveFusion?: boolean; earlyLook?: boolean },
): Promise<SwitchResult> {
  /* The status beside the write: the Cloud switch's only (switchBackend), and
     only when a stop looks needed — a refused switch, the wizard's local-llama
     or a Fusion orchestrator's own chip spawn nothing they will not use. */
  const early = opts.earlyLook && cloudSwitchLikelyStops() ? earlyDaemonLook() : null;
  const pending = rewriteWholeConfig((cfg): ActivationPlan => {
    const id = pick(cfg);
    if (typeof id !== "string") return { write: false, refuse: id };
    const entry = (cfg.llm?.providers ?? []).find((p) => p.id === id);
    if (!entry) return { write: false, refuse: { ok: false, error: `provider "${id}" is not configured` } };
    const cloud = entry.kind !== "llama-server";
    if (cloud && !providerIsUsable(entry)) return { write: false, refuse: needsKeyFor(entry, id) };
    // U29: an entry with no chat model cannot be built by the agent, and as the
    // active provider it would stop `atag serve` from starting. Pick the model
    // first (selectCloudModel writes it and then activates).
    if (isIncompleteProvider(entry)) {
      return { write: false, refuse: { ok: false, needsChatModel: true, providerId: id, error: "choose a model for this provider first" } };
    }
    /* Under effective Fusion the orchestrator IS the active provider, and its
       own model chip re-activates it: that keeps the mode (the TUI's
       selectChatModel on the active provider), and it must not stop the local
       daemon the workers run on. Every other activation — another provider,
       or the backend row's `cloud` — leaves Fusion in the same write. */
    const rm = resolveRunMode(cfg);
    const keepFusion = !opts.leaveFusion && rm.effective === "fusion" && rm.orchestratorProviderId === id;
    const a = applyActiveTextProvider(cfg, id, { leaveFusion: !keepFusion });
    if (!a.ok) return { write: false, refuse: { ok: false, error: a.error } };
    return { write: a.changed, id, entry, cloud, keepFusion, embeddingsOff: cfg.memory?.embeddings?.enabled === false };
  });
  // This activation's own hold of the config lock: asked for synchronously just above.
  const ownTurn = configLockTurns();
  const w = await pending;
  if (!w.ok || !w.verdict) return { ok: false, error: w.error };
  const v = w.verdict;
  if (v.refuse) return v.refuse;
  const { id, entry, cloud, keepFusion } = v as Required<Pick<ActivationPlan, "id" | "entry" | "cloud" | "keepFusion">>;
  // `restart` says the file moved. main.ts also restarts when the file did
  // NOT move but `atag serve` booted on another route (the TUI or a hand
  // edit changed the file while this window was open) — see applySwitch.
  let restart = w.changed;
  let daemon: DaemonEffect = "untouched";
  let daemonLine: string | undefined;
  if (cloud && !keepFusion) {
    // A stop never waits out a load (item 11): a bring-up on its way is ended, its start killed.
    supersedeBringUp();
    // A stop decision: whatever is still there, answering or not (item 31), is stopped and said so.
    const up = early && early.still() ? await early.running : await localDaemonRunning({ reapWedged: false });
    if (up) {
      const s = await modelsStop();
      if (s.ok) {
        daemon = "stopped";
        daemonLine = "local-llm: daemons stopped — hybrid recall off (embedding switch unchanged)";
        /* The file as this activation wrote it has the flag off already, and no
           other write of this process has queued since: nothing to read or
           write. Any other write since, and the file is read again. */
        if (!(v.embeddingsOff && configLockTurns() === ownTurn)) {
          const m = await setMemoryEmbeddingsEnabled(false);
          if (m.changed) restart = true;
        }
      } else {
        daemon = "stop-failed";
        daemonLine = `local-llm: stop failed — ${s.error ?? "unknown error"}`;
      }
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
  /* ATO-157: the model check and the route are one read and (when the route
     moves) one write. Another model goes the long way: `models use` writes
     the file itself, so the route is written after it, on a fresh read. */
  const w = await rewriteWholeConfig((cfg): { write: boolean; changed: boolean; error?: string } => {
    const lm = cfg.localModels ?? {};
    const changed = lm.mode !== "managed" || (lm.managed?.modelId ?? null) !== modelId;
    if (changed) return { write: false, changed };
    const a = applyActiveTextProvider(cfg, LOCAL_ID, { leaveFusion: true });
    return { write: a.ok && a.changed, changed, error: a.ok ? undefined : a.error };
  });
  if (!w.ok || !w.verdict) return { ok: false, error: w.error };
  if (w.verdict.error) return { ok: false, error: w.verdict.error };
  const changed = w.verdict.changed;
  let restart = w.changed;
  if (changed) {
    const used = await modelsUse(modelId);
    if (!used.ok) return { ok: false, error: used.error };
    restart = true;
    const r = await setActiveTextProvider(LOCAL_ID, { leaveFusion: true });
    if (!r.ok) return { ok: false, error: r.error };
  }

  /* Another model: a background start for the old one is moot (item 11); the
     same one is waited for. The daemon's turn is bringUpLocalDaemon's, which
     this body was a copy of: started when down, restarted when the model moved. */
  const { daemon, daemonLine, error, paired } = await bringUpLocalDaemon(changed);
  return {
    ok: true,
    providerId: LOCAL_ID,
    modelId,
    transport: transportFor(LOCAL_ID),
    daemon,
    daemonLine,
    // Backlog 18 (its second review): a superseded start restarts nothing (restartAfterSwitch).
    // ATO-126: an embedding server paired just now is wired by the restart.
    restart: (restart || !!paired) && daemon !== "superseded",
    error,
  };
}

/** The cloud provider "cloud" picks: the active one, else the first with a key, else the first. */
function pickCloudProvider(cfg: UserConfigShape): string | SwitchResult {
  const llm = cfg.llm ?? {};
  const cloud = (llm.providers ?? []).filter((p) => p.kind !== "llama-server");
  const provider: ProviderEntry | undefined =
    cloud.find((p) => p.id === llm.activeTextProvider) ??
    cloud.find((p) => providerHasKey(p)) ??
    cloud[0];
  return provider ? provider.id : { ok: false, needsProvider: true, error: "add a provider first" };
}

/** activateCloud / activateLocal from composer-switch-activate.ts. */
export async function switchBackend(kind: "cloud" | "local"): Promise<SwitchResult> {
  if (kind === "cloud") {
    // Under Fusion the active provider is the orchestrator, so "cloud" picks
    // it — and without leaveFusion the stored mode would keep it in Fusion.
    return activate(pickCloudProvider, { leaveFusion: true, earlyLook: true });
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
    // the renderer opens the model pane. One read and one write (ATO-157).
    const w = await rewriteWholeConfig((cfg): { write: boolean; error?: string } => {
      const a = applyActiveTextProvider(cfg, LOCAL_ID, { leaveFusion: true });
      if (!a.ok) return { write: false, error: a.error };
      const managed = applyManagedMode(cfg);
      return { write: a.changed || managed };
    });
    if (!w.ok || !w.verdict) return { ok: false, error: w.error };
    if (w.verdict.error) return { ok: false, error: w.verdict.error };
    return {
      ok: true,
      providerId: LOCAL_ID,
      transport: transportFor(LOCAL_ID),
      daemon: "untouched",
      needsModel: true,
      restart: w.changed,
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
  if (entry.kind !== "llama-server" && !providerIsUsable(entry)) {
    return needsKeyFor(entry, providerId);
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

export type BringUp = {
  daemon: DaemonEffect;
  daemonLine?: string;
  error?: string;
  /** ATO-126: the embedding server was started, or hybrid recall switched back on, for it: `atag serve` wires it only as it boots. */
  paired?: boolean;
};
type Paired = { paired: boolean; line?: string };

/**
 * ATO-126 — the embedding server beside the chat one.
 *
 * Semantic search (hybrid recall over memory and files) needs a second
 * llama-server for `/embedding`, and only `atag models start` brought it up:
 * chat first, then embedding, both or neither. Every bring-up here skips that
 * start when the chat server is already up (a model found up at launch, a pick
 * of the model already serving, a ⇄, Settings' Start), and `models start`
 * itself refuses as a whole once the chat server runs. So with a local chat
 * model running the embedding server never started — an embedding model
 * enabled or downloaded later, one that had stopped, all stayed off. The TUI
 * pairs them in-process (ensureEmbeddingPaired); the CLI now can too (`models
 * start-embedding`, agent side). A Cloud switch also writes
 * `memory.embeddings.enabled = false` as it stops both servers (the TUI's
 * stopDaemon order), and nothing here put it back on the way back to local,
 * where the TUI latches it on once its server runs. `atag serve` reads both
 * only as it boots.
 *
 * Asked in the daemon's turn, once the chat server is up (and at launch before
 * it, daemon-watch pairEmbeddingsBeforeServe): when the file wants embeddings
 * and their server is not up, it is started alone; once it is up, hybrid
 * recall is switched back on. `startOut` is the `models start` that
 * just ran, which already tried the embedding side: its failure is not tried
 * again. No guard of memory stands in its way here — the agent's own start
 * fits the chat context to the memory free as it starts, and the embedding
 * server (2048 context) is small. `paired`: something `atag serve` has not
 * seen, which the switch's restart then picks up.
 */
export async function pairEmbeddingServer(opts: {
  /** The `models start` that just ran. */
  startOut?: string;
  /** False once a stop, a switch or the quit came: what this started then goes again, and nothing is written. */
  stillWanted: () => boolean;
  /** Whether the agent restarts after this (a switch): only then is semantic search on at once. */
  restarts?: boolean;
}): Promise<Paired> {
  const cfg = configFileHint();
  if (!embeddingsWanted(cfg)) return { paired: false };
  let started = false;
  let up = embeddingPidAlive(cfg);
  let line: string | undefined;
  if (opts.startOut !== undefined) {
    started = /^embedding: started pid/m.test(opts.startOut);
    up = up || started;
  } else if (!up) {
    const r = await modelsStartEmbedding({ stillWanted: opts.stillWanted });
    if (r.notStarted) return { paired: false };
    started = r.started;
    up = r.up;
    // Exit 0 without a server: the model is not on disk (or not chosen), which Settings › Models says itself.
    if (!r.ok) {
      const why = (r.stderr.match(/^embedding: failed to start \((.*)\)\s*$/m)?.[1] ?? r.error ?? "").trim();
      line = `local-llm: the embedding server did not start${why ? ` — ${why}` : ""}; semantic search is off, keyword search still works`;
    }
  }
  if (!up) return { paired: false, line };
  /* A stop or a switch away while it started (they do not wait for the
     daemon's turn): the server it brought up is nobody's any more, and the
     Cloud switch's own write of the flag is the last word. */
  if (!opts.stillWanted()) {
    if (started) await stopEmbeddingServer().catch(() => undefined);
    return { paired: false };
  }
  if (started) {
    line = opts.restarts
      ? "local-llm: embedding server up — semantic search on"
      : "local-llm: embedding server up — semantic search comes on with the agent's next start";
  }
  const m = await setMemoryEmbeddingsEnabled(true);
  return { paired: started || m.changed, line };
}

/* ---- the managed daemon: starts one at a time, stops at once (item 11) ----
   Every sequence that checks the daemon and then starts (or restarts) it holds
   this lock, first come first served. Two `models start` never run side by
   side — a second one beside a starting daemon is the agent-side duplicate
   localDaemonRunning describes — and when a long one ends, the sequences
   queued behind it go one by one, not all at once. A stop never takes it: a
   stop must not wait out a load of up to 90 s (supersedeBringUp).
   Backlog 18: the llama.cpp update takes a turn as well (inDaemonTurn, from
   main.ts). It stops the daemon and replaces its binary, and `models start`
   fetches a newer binary itself (managed.autoUpdate), so a start beside it
   came up on a binary being replaced, or downloaded a second one into the
   same data dir. Quitting closes the turns (closeDaemonTurns): one that has
   not begun by then gets `whenClosed` instead — a start that waited out an
   update the quit stopped does not bring a model server up as the app goes. */
/**
 * The daemon's bookkeeping, in one place.
 *
 * `chain`: the turns, one after another. `onTheirWay` (ATO-123): the turns
 * asked for and not over yet. While one is on its way the server may be down
 * on purpose (a model pick stopping the old one, Settings' Start replacing a
 * wedged one, the llama.cpp update), so the supervisor (daemon-watch.ts)
 * takes no look at it. `begun` (ATO-157): every turn ever begun — the early
 * status look is trusted only when none began while it was out. `mark`: see
 * startsMark below. `background`: the bring-up nobody waits on.
 *
 * ATO-157: a smoke check runs a switch on a bookkeeping of its own
 * (withSwitchStandIn), so it never ends, waits for or counts as the app's.
 */
interface DaemonBook { chain: Promise<void>; onTheirWay: number; begun: number; mark: number; background: Background | null }
const appBook: DaemonBook = { chain: Promise.resolve(), onTheirWay: 0, begun: 0, mark: 0, background: null };
const standInBooks = new AsyncLocalStorage<DaemonBook>();
function book(): DaemonBook {
  return standInBooks.getStore() ?? appBook;
}
/** What a smoke check may set on its own bookkeeping, and read back. */
export type StandInBook = Pick<DaemonBook, "onTheirWay" | "begun" | "mark">;
/**
 * Smoke only (ATO-157): run `body` — a switch — with every `atag` call it
 * makes answered by `standIn` (agent-cli withCliStandIn) and on a daemon
 * bookkeeping of its own, starting from `start`. `hooks` stand in for the
 * lifecycle listener and the hints read from disk. Nothing of the app's is
 * read, written, stopped, started, ended or waited for.
 */
export function withSwitchStandIn<T>(
  standIn: CliStandIn,
  body: (book: StandInBook) => Promise<T>,
  hooks: CliStandInHooks = {},
  start: Partial<StandInBook> = {},
): Promise<T> {
  const own: DaemonBook = { chain: Promise.resolve(), onTheirWay: 0, begun: 0, mark: 0, background: null, ...start };
  return withCliStandIn(standIn, () => standInBooks.run(own, () => body(own)), hooks);
}

let turnsClosed = false;
function withDaemonLock<T>(run: () => Promise<T>, whenClosed: () => T): Promise<T> {
  const d = book();
  d.onTheirWay += 1;
  d.begun += 1;
  const turn = () => (turnsClosed ? Promise.resolve(whenClosed()) : run());
  const next = d.chain.then(turn, turn);
  const over = () => { d.onTheirWay -= 1; };
  d.chain = next.then(over, over);
  return next;
}
/** ATO-123: how many daemon turns are on their way or running. */
export function daemonTurnsOnTheirWay(): number {
  return book().onTheirWay;
}
/** Backlog 18: `run` in the daemon's turn, as a start takes it — the llama.cpp update's. `whenClosed` is its answer if the app quits first. */
export function inDaemonTurn<T>(run: () => Promise<T>, whenClosed: () => T): Promise<T> {
  return withDaemonLock(run, whenClosed);
}
/**
 * Quitting (main.ts stopForQuit): no turn begins after this, no `models start`
 * spawns — not even one whose turn began before (agent-cli closeStarts) — and
 * no switch restarts the agent (restartAfterSwitch). The undo is for a smoke
 * check, which carries on after it.
 */
export function closeDaemonTurns(): () => void {
  turnsClosed = true;
  const reopenStarts = closeStarts();
  return () => {
    turnsClosed = false;
    reopenStarts();
  };
}
/* Backlog 18 (its review): a start waiting for its turn can wait out a whole
   llama.cpp update, minutes, and the window lets go of its switch after 45 s —
   the operator may pick the cloud, another model or Settings › Stop by the
   time the turn comes. Every stop and route change that ends a background
   bring-up (supersedeBringUp) moves this mark too, and a start asked for
   before it moved starts nothing in its turn: a server nobody asks for any
   more would hold the model's memory, on a route that has moved on. */
/* startsMark: book().mark. */

/** Start the managed daemon when it is down (restart it when the model moved), in its turn. A model pick's and a worker pin's. */
async function bringUpLocalDaemon(modelChanged: boolean): Promise<BringUp> {
  // Another model: a background start for the old one is moot.
  if (modelChanged) supersedeBringUp();
  const d = book();
  const asked = d.mark;
  /* Backlog 18: whether a stop or a route change came since this was asked for.
     Asked as its turn begins, and (its second review) again at the spawn
     itself (modelsStart): the turn's `models status` and `models stop` take
     seconds, and one that comes in them would otherwise still be followed by a
     start nobody asks for any more. */
  const stillAsked = () => d.mark === asked;
  const start = async (effect: "started" | "restarted"): Promise<BringUp> => {
    const st = await modelsStart({ stillWanted: stillAsked });
    // It reached its spawn after a stop, a switch or the quit: nothing was started.
    if (st.notStarted) return SUPERSEDED;
    if (!st.ok) return { daemon: "start-failed", error: st.error };
    // ATO-126: hybrid recall back on when `models start` brought its server up too.
    const pair = await pairEmbeddingServer({ startOut: st.stdout, stillWanted: stillAsked, restarts: true });
    return { daemon: effect, daemonLine: readyLine(st.stdout), ...(pair.paired ? { paired: true } : {}) };
  };
  return withDaemonLock(async (): Promise<BringUp> => {
    if (!stillAsked()) return SUPERSEDED;
    const running = await localDaemonRunning();
    if (running && !modelChanged) {
      // ATO-123: found up when it was asked for, so it is the app's to bring back — unless a stop came meanwhile.
      if (stillAsked()) daemonFoundUp();
      // ATO-126: the chat server stays as it is; the embedding one is started beside it when it is not up.
      const pair: Paired = stillAsked() ? await pairEmbeddingServer({ stillWanted: stillAsked, restarts: true }) : { paired: false };
      return { daemon: "untouched", ...(pair.line ? { daemonLine: pair.line } : {}), ...(pair.paired ? { paired: true } : {}) };
    }
    if (running) {
      const s = await modelsStop();
      if (!s.ok) return { daemon: "stop-failed", daemonLine: `local-llm: stop failed — ${s.error ?? "unknown error"}` };
      return start("restarted");
    }
    return start("started");
  }, () => SUPERSEDED);
}
/** Only a model that is on disk is started: a start for a file that is not there is a failure about nothing the operator chose. */
async function onDisk(modelId: string): Promise<boolean> {
  const list = await chatModelsList();
  return list.ok && (list.models ?? []).some((m) => m.id === modelId && m.downloaded);
}

/* ---- the bring-up nobody waits on (item 11) ----
   A ⇄ moves no model, so it never waits on the daemon: that wait — a `models
   status`, and with the daemon down a whole `models start` — is the swap the
   operator saw stick. But a daemon that is down (stopped in Settings ›
   Models, crashed) would leave the local seat with nothing serving it, so
   the swap starts it in the background, as the TUI's setMode does (`void
   localModels.startDaemon()`); the launch start is one too. One at a time, in
   the lock's turn. A stop, or a route change that makes it moot, supersedes
   it: its `models start` is killed, and it reports nothing and starts
   nothing after. */
export interface BringUpSteps { signal: AbortSignal; superseded(): boolean; starting(): void }
interface Background { superseded: boolean; starting: boolean; abort: AbortController; done: Promise<BringUp> }
/** `update` (ATO-123): the server the llama.cpp update stopped, started again after it. */
export type BringUpReport = (r: BringUp & { modelId: string; via: "swap" | "launch" | "update" }) => void;
const SUPERSEDED: BringUp = { daemon: "superseded" };
let reportBringUp: BringUpReport = () => {};

/** main.ts: where a background bring-up says how it ended. Hands back the one it replaces. */
export function onBackgroundBringUp(report: BringUpReport): BringUpReport {
  const was = reportBringUp;
  reportBringUp = report;
  return was;
}
/** The background bring-up on its way, or null. */
export function bringUpInFlight(): Promise<BringUp> | null {
  const b = book().background;
  return b ? b.done : null;
}
function startInBackground(task: (s: BringUpSteps) => Promise<BringUp>): { done: Promise<BringUp>; adopted: boolean } {
  const d = book();
  if (d.background) return { done: d.background.done, adopted: true };
  const b = { superseded: false, starting: false, abort: new AbortController() } as Background;
  const steps: BringUpSteps = { signal: b.abort.signal, superseded: () => b.superseded, starting: () => { b.starting = true; } };
  b.done = withDaemonLock(() => (b.superseded ? Promise.resolve(SUPERSEDED) : task(steps)), () => SUPERSEDED)
    .catch((err): BringUp => ({ daemon: "start-failed", error: err instanceof Error ? err.message : String(err) }))
    .then((r) => (b.superseded ? SUPERSEDED : r))
    .finally(() => { if (d.background === b) d.background = null; });
  d.background = b;
  return { done: b.done, adopted: false };
}
/**
 * End the background bring-up, if one is on its way: its `models start` is
 * killed, and it reports nothing and does nothing more. Answers whether it had
 * got as far as starting — what it spawned is then the caller's to stop.
 * Backlog 18: a start still waiting for its turn is ended too (startsMark).
 */
export function supersedeBringUp(): boolean {
  const d = book();
  d.mark++;
  const b = d.background;
  if (!b) return false;
  d.background = null;
  b.superseded = true;
  b.abort.abort();
  return b.starting;
}
/** status → start, checking after each step whether a stop has ended it. */
async function startIfDown(s: BringUpSteps): Promise<BringUp> {
  if (await localDaemonRunning()) {
    // ATO-123: found up when it was asked for (a ⇄, the launch, the supervisor's own restart) — the app's from here on.
    if (!s.superseded()) daemonFoundUp();
    // ATO-126: and the embedding server beside it. Nothing restarts the agent from here: the next restart wires it.
    if (!s.superseded()) await pairEmbeddingServer({ stillWanted: () => !s.superseded() });
    return { daemon: "untouched" };
  }
  if (s.superseded()) return SUPERSEDED;
  s.starting();
  const st = await modelsStart({ signal: s.signal });
  // The quit had begun (closeStarts): nothing was started.
  if (st.notStarted) return SUPERSEDED;
  if (!st.ok) return { daemon: "start-failed", error: st.error };
  if (!s.superseded()) await pairEmbeddingServer({ startOut: st.stdout, stillWanted: () => !s.superseded() });
  return { daemon: "started", daemonLine: readyLine(st.stdout) };
}
function report(r: BringUp, modelId: string, via: "swap" | "launch" | "update"): void {
  if (r.daemon !== "started" && r.daemon !== "start-failed") return;   // nothing started, or it was superseded
  try { reportBringUp({ ...r, modelId, via }); } catch { /* a report never fails the bring-up */ }
}
/** A ⇄'s: the local seat's daemon, for a model on disk, not waited for. */
function bringUpBehindSwap(modelId: string): void {
  const { done, adopted } = startInBackground(async (s) => {
    if (!(await onDisk(modelId))) return { daemon: "skipped" };
    if (s.superseded()) return SUPERSEDED;
    return startIfDown(s);
  });
  // One already on its way serves the same model, and says how it went itself.
  if (!adopted) void done.then((r) => report(r, modelId, "swap"));
}
/**
 * The launch start (main.ts startLocalDaemonAtBoot, once it has found the
 * model on disk), as the background bring-up. One already on its way — a ⇄'s
 * — is adopted, and says how it went itself: the start is logged once.
 */
export function bringUpAtLaunch(modelId: string, via: "launch" | "update" = "launch"): Promise<BringUp> {
  const { done, adopted } = startInBackground(startIfDown);
  if (!adopted) void done.then((r) => report(r, modelId, via));
  return done;
}
/** ATO-123: the mark every stop, switch, model change and the quit move (supersedeBringUp) — whether one came since a moment. */
export function stopsMark(): number {
  return book().mark;
}
/** Settings › Models › Start: in its turn, and no second `models start` for a daemon that is already up. */
export function startDaemonNow(): Promise<CliResult & { alreadyRunning?: boolean }> {
  const d = book();
  const asked = d.mark;
  const stillAsked = () => d.mark === asked;
  return withDaemonLock(async () => {
    // Backlog 18: a stop or a route change came while this waited for its turn.
    if (!stillAsked()) return { ok: false, stdout: "", stderr: "", error: START_REFUSED_MOVED_ON };
    if (await localDaemonRunning()) {
      // ATO-123: Settings' Start found it up: the app's to bring back from here on, unless a stop came meanwhile.
      if (stillAsked()) daemonFoundUp();
      // ATO-126: the embedding server beside it, when the file wants one and it is not up.
      const pair: Paired = stillAsked() ? await pairEmbeddingServer({ stillWanted: stillAsked }) : { paired: false };
      return { ok: true, stdout: pair.line ? `${pair.line}\n` : "", stderr: "", alreadyRunning: true };
    }
    // Its second review: asked again at the spawn — one may have come, or the quit begun, during that status read.
    const st = await modelsStart({ stillWanted: stillAsked });
    if (st.ok && !st.notStarted && stillAsked()) await pairEmbeddingServer({ startOut: st.stdout, stillWanted: stillAsked });
    return st;
  }, () => ({ ok: false, stdout: "", stderr: "", error: START_REFUSED_QUITTING }));
}
/** Settings › Models › Stop, and quitting: at once — a bring-up on its way is ended, not waited for. */
export function stopDaemonNow(): Promise<CliResult> {
  supersedeBringUp();
  return modelsStop();
}

/**
 * Quitting (item 30): every start on its way is killed first — the launch's,
 * a switch's, Settings' — so none brings a server up after the stop; then the
 * stop, bounded; then whatever the daemons' pid files still name is killed by
 * this process outright: a llama-server that ignored SIGTERM, or a stop that did
 * not finish in time. Answers the pids that last step had to kill.
 * Backlog 18 (its second review): and no start spawns after this, though its
 * turn began before (closeDaemonTurns; stopForQuit has closed them already).
 */
export async function stopDaemonForQuit(dataDir: string): Promise<number[]> {
  closeDaemonTurns();
  supersedeBringUp();
  await abortStarts(1_500);
  const named = daemonPidsIn(dataDir);
  await Promise.race([modelsStop(), new Promise((r) => setTimeout(r, 5_000))]);
  return killDaemonLeftovers([...named, ...daemonPidsIn(dataDir)]);
}

/* ---- the agent's restart after a switch (backlog 18, its second review) ----
   `atag serve` takes its route at boot, so a switch that moved the file ends in
   main restarting it (main.ts applySwitch), and the restart aborts every turn
   the window streams. The renderer refuses a switch while any chat has a turn
   running (item 28), but a switch can land long after the window let go of
   it: a model pick, or the deferred activation of a finished download, waits
   for its daemon turn behind the llama.cpp update — minutes — while the window
   gives up on it at 45 s and unlocks send. The person starts a turn, the
   update ends, and the pick's restart aborted that turn. So main decides here,
   whatever the window believed:

   - A superseded result restarts nothing when a later switch came while it
     waited for its turn: that switch restarts the agent for its own route,
     and this one's would be a second restart, for nothing. Settings › Stop
     moves no route, though, so (backlog 35) when no newer switch is on its
     way and the file names another route than serve booted on, main restarts
     the agent onto the file's route (`drifted`): an agent left on the cloud
     under a "Local models" label would send the person's messages somewhere
     the window says they do not go. With the model server just stopped, the
     restarted agent says so honestly instead.
   - While a turn runs, the restart is held back and the answer says so
     (`restartHeld`). The config is already written, and the window's chips
     read the file, so an agent left on its old route would answer the next
     message on a route the window does not show — less expected than a
     restart. The held restart therefore runs as soon as the last turn ends
     (lastTurnEnded, the AgentClient's `idle`), which is when the switch would
     have restarted had it landed then; a turn asked for while it runs (a
     message queued behind the one that ended goes out at that very moment)
     waits for it in main and runs on the agent it brings up, once main has
     put the window's coding mode back on it (main.ts). A switch that
     comes first restarts it instead, and so does anything else that starts
     `atag serve` (agentStarting): a new agent reads the file as it is.
   - Nothing restarts once the app quits (closeDaemonTurns).
   One restart at a time: a switch or a turn that comes while one runs waits
   for it to end. */

/** What a switch restarts: main.ts hands in its AgentClient (restartsAgent). */
export interface SwitchAgent {
  /** The turns the window streams from `atag serve` right now. */
  turnsInFlight(): number;
  /** Stop `atag serve` and start it again, on the config as the file has it then. */
  restart(): Promise<void>;
}
let switchAgent: SwitchAgent | null = null;
let restartOwed = false;
let restarting: Promise<void> | null = null;

/** main.ts: the agent a switch restarts. Hands back the one it replaces — a smoke check stands in, and puts it back. */
export function restartsAgent(agent: SwitchAgent | null): SwitchAgent | null {
  const was = switchAgent;
  switchAgent = agent;
  return was;
}

function restartNow(agent: SwitchAgent): Promise<void> {
  restartOwed = false;
  const run: Promise<void> = agent.restart()
    .catch(() => undefined)   // the agent's own status says how its start went
    .finally(() => { if (restarting === run) restarting = null; });
  restarting = run;
  return run;
}

/** The switch restart on its way, or null. One can follow another, so it is waited out in a loop with nothing awaited after the last look (main.ts agent:chat). */
export function switchRestartOnItsWay(): Promise<void> | null {
  return restarting;
}

/** Wait out a switch's restart on its way, and any that follows it. main.ts: applySwitch, before it reads the route serve booted on. */
export async function waitForSwitchRestart(): Promise<void> {
  while (restarting) await restarting;
}

/**
 * applySwitch's restart. `wanted`: the result moved the file or serve is behind
 * it, and the app is not quitting (main.ts). Answers whether the agent was
 * restarted, and `restartHeld` when this switch's restart waits for the turns
 * in flight. A restart owed to an earlier switch is paid by this one.
 */
export async function restartAfterSwitch(
  res: SwitchResult,
  wanted: boolean,
  /** Backlog 35: superseded by a stop, with the file on another route than serve booted on and no newer switch on its way (main.ts). */
  drifted = false,
): Promise<{ restart: boolean; restartHeld?: true }> {
  // One at a time: from the last look at `restarting` to restartNow setting it, nothing is awaited.
  while (restarting) await restarting;
  const agent = switchAgent;
  const mine = wanted && res.ok && (res.daemon !== "superseded" || drifted);
  if (!agent || turnsClosed || !res.ok || !(mine || restartOwed)) return { restart: false };
  if (agent.turnsInFlight() > 0) {
    restartOwed = true;
    return mine ? { restart: false, restartHeld: true } : { restart: false };
  }
  await restartNow(agent);
  return { restart: true };
}

/** main.ts, as the last turn the window streams ends on its own (AgentClient `idle`): a restart held back for the turns runs now. */
export function lastTurnEnded(): void {
  const agent = switchAgent;
  if (!restartOwed || restarting || turnsClosed || !agent || agent.turnsInFlight() > 0) return;
  void restartNow(agent);
}

/** main.ts, as `atag serve` starts, whoever starts it: the new agent reads the file as it is, so no restart is owed. */
export function agentStarting(): void {
  restartOwed = false;
}

/** Whether the seats need the managed daemon: Fusion in force with a local seat on a managed model. */
export function runModeWantsDaemon(now: ResolvedRunMode, lm: { mode?: string; managed?: { modelId?: string | null } }): boolean {
  const localLeg = now.effective === "fusion" && (now.workerProviderId === LOCAL_ID || now.orchestratorProviderId === LOCAL_ID);
  return localLeg && lm.mode === "managed" && !!lm.managed?.modelId;
}
/**
 * What a run-mode write does about the daemon its seats need: `wait` for it
 * (entering Fusion, a worker pin), start it in the `background` (a
 * seats-only ⇄, RunModeVerdict.seatsOnly), or nothing (`none`).
 */
export function runModeDaemonPlan(
  now: ResolvedRunMode,
  lm: { mode?: string; managed?: { modelId?: string | null } },
  v?: RunModeVerdict,
): "wait" | "background" | "none" {
  if (!runModeWantsDaemon(now, lm)) return "none";
  return v?.seatsOnly ? "background" : "wait";
}

async function afterRunModeWrite(res: {
  ok: boolean;
  changed: boolean;
  error?: string;
  verdict?: RunModeVerdict;
}, opts: { daemonByCaller?: boolean; stillWanted?: () => boolean } = {}): Promise<SwitchResult> {
  if (opts.stillWanted && !opts.stillWanted()) return { ok: true, daemon: "superseded", restart: false };
  if (!res.ok) return { ok: false, error: res.error };
  const v = res.verdict;
  if (v?.refusal) return { ok: false, refusal: v.refusal, error: v.refusal };
  const read = await readWholeConfig();
  if (!read.ok || !read.config) return { ok: false, error: read.error };
  const now = resolveRunMode(read.config);
  const leg = v?.leg ?? now.primaryProviderId;
  const entry = (read.config.llm?.providers ?? []).find((p) => p.id === leg);
  /* The local seat's daemon. autoStartIfReady keys on local-llama being the
     ACTIVE provider, and under Fusion the active provider is the orchestrator
     — so nothing else would bring a local leg up. Entering Fusion or pinning
     a seat waits for it (started when down, only for a model on disk); a
     seats-only ⇄ starts it in the background and does not wait (see
     bringUpBehindSwap). */
  let up: BringUp = { daemon: "untouched" };
  const lm = read.config.localModels ?? {};
  const modelId = lm.managed?.modelId ?? "";
  /* ATO-127: a worker model pick brings up the model it picked itself, after
     `models use` (selectFusionWorkerModel). Waiting here started the model
     the file still named — the one the workers were leaving — for tens of
     seconds and its memory, only to stop it for the new one. */
  const plan = opts.daemonByCaller ? "none" : runModeDaemonPlan(now, lm, v);
  if (opts.stillWanted && !opts.stillWanted()) return { ok: true, daemon: "superseded", restart: false };
  if (plan === "wait") {
    const ready = await onDisk(modelId);
    if (opts.stillWanted && !opts.stillWanted()) return { ok: true, daemon: "superseded", restart: false };
    up = ready ? await bringUpLocalDaemon(false) : { daemon: "skipped" };
  }
  else if (plan === "background") bringUpBehindSwap(modelId);
  // The seats no longer need it (a seat moved to the cloud): a start on its way is moot, and what it spawned goes.
  else if (!opts.daemonByCaller && supersedeBringUp()) await modelsStop();
  return {
    ok: true,
    providerId: leg,
    model: entry ? (entry.defaultChatModel ?? entry.model ?? null) : null,
    transport: transportFor(leg),
    ...up,
    // Backlog 18 (its second review): a superseded start restarts nothing (restartAfterSwitch).
    restart: (res.changed || !!up.paired) && up.daemon !== "superseded",
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
export async function enterFusion(pins: { orchestratorProvider?: string; workerProvider?: string } = {}, stillWanted?: () => boolean): Promise<SwitchResult> {
  const isKeyed = keyed();
  return afterRunModeWrite(await rewriteWholeConfig((cfg) => {
    if (stillWanted && !stillWanted()) return { write: false, before: resolveRunMode(cfg) };
    return planEnterFusion(cfg, pins, isKeyed);
  }), { stillWanted });
}

/**
 * swapLegs — the composer's ⇄ and `/runmode swap`. On a Fusion in force it
 * is one write and the agent restart: planSwapLegs marks the verdict
 * seats-only, so a swap costs what a provider switch costs, and a daemon the
 * local seat needs is brought up in the background if it is down.
 */
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
  // The workers move to another model: a background start for the one they leave is moot (item 11).
  if (!row.active) supersedeBringUp();
  const isKeyed = keyed();
  const pin = await rewriteWholeConfig((cfg): RunModeVerdict => {
    const rm = resolveRunMode(cfg);
    if (rm.effective === "fusion" && rm.workerProviderId === LOCAL_ID) return { write: false, before: rm };
    return planEnterFusion(cfg, { workerProvider: LOCAL_ID }, isKeyed);
  });
  // ATO-127: the daemon is this pick's to bring up, below, on the model picked.
  const settled = await afterRunModeWrite(pin, { daemonByCaller: true });
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
    // Backlog 18 (its second review): a superseded start restarts nothing (restartAfterSwitch).
    restart: (!!settled.restart || changed || !!up.paired) && up.daemon !== "superseded",
  };
}

/** triggerLocalChatModel for a downloaded model; a pull is the renderer's job. */
export async function selectLocalModel(modelId: string): Promise<SwitchResult> {
  // 96, as agent-cli's MODEL_ID_RE: a model added from Hugging Face is `custom-` + up to 80 characters (Settings' Use comes here too now, ATO-125).
  if (!/^[\w.-]{1,96}$/.test(modelId)) return { ok: false, error: `not a model id: ${modelId}` };
  const list = await modelsList();
  if (!list.ok || !list.models) return { ok: false, error: list.error };
  const row = list.models.find((m) => m.id === modelId);
  if (!row) return { ok: false, error: `unknown model id: ${modelId}` };
  if (!row.downloaded) {
    return { ok: false, needsDownload: true, modelId, error: `local model ${modelId} is not downloaded` };
  }
  return routeToLocal(modelId);
}

/** Composer engine selection shares the daemon queue with starts and stops. */
export async function selectComposerEngine(engine: "atomic-core" | "llama-server", leg?: "orchestrator" | "worker"): Promise<SwitchResult> {
  const requestedAt = stopsMark();
  const stopsAt = stopsAsked();
  const stillWanted = () => !turnsClosed && stopsMark() === requestedAt && stopsAsked() === stopsAt;
  const superseded: SwitchResult = { ok: true, daemon: "superseded", restart: false };
  const selected = await inDaemonTurn(async (): Promise<SwitchResult> => {
    const read = await readWholeConfig();
    if (!read.ok || !read.config) return { ok: false, error: read.error };
    if (!stillWanted()) return superseded;
    if (leg) {
      const rm = resolveRunMode(read.config);
      if (rm.effective !== "fusion") return { ok: false, error: "Select Fusion first." };
      const other = leg === "worker" ? rm.orchestratorProviderId : rm.workerProviderId;
      if (other === LOCAL_ID) return { ok: false, error: "The other role uses the local engine. Swap the roles to move it." };
    }
    const current = read.config.localModels?.managed?.engine ?? "llama-server";
    if (current === engine) return { ok: true };
    const changed = await modelsEngine(engine);
    return { ok: changed.ok, error: changed.ok ? undefined : changed.error || changed.stderr, restart: changed.ok };
  }, () => ({ ok: false, error: "The app is closing" }));
  if (!stillWanted()) return superseded;
  if (!selected.ok || !leg) return selected;
  const entered = await enterFusion(leg === "worker" ? { workerProvider: LOCAL_ID } : { orchestratorProvider: LOCAL_ID }, stillWanted);
  if (entered.daemon === "superseded") return entered;
  return { ...entered, restart: selected.restart || entered.restart };
}

/** Pin a model on its own Fusion role without activating the worker as primary. */
export async function selectFusionModel(leg: "orchestrator" | "worker", modelId: string): Promise<SwitchResult> {
  const requestedAt = stopsMark();
  const stopsAt = stopsAsked();
  const stillWanted = () => !turnsClosed && stopsMark() === requestedAt && stopsAsked() === stopsAt;
  const superseded: SwitchResult = { ok: true, daemon: "superseded", restart: false };
  if (!modelId.trim() || modelId.length > 512) return { ok: false, error: "A model is required." };
  const read = await readWholeConfig();
  if (!read.ok || !read.config) return { ok: false, error: read.error };
  const rm = resolveRunMode(read.config);
  if (rm.effective !== "fusion") return { ok: false, error: "Select Fusion first." };
  const providerId = leg === "worker" ? rm.workerProviderId : rm.orchestratorProviderId;
  const provider = read.config.llm?.providers?.find(p => p.id === providerId);
  if (!provider) return { ok: false, error: "Choose an inference engine first." };
  const local = provider.kind === "llama-server";
  if (!local && !providerIsUsable(provider)) return needsKeyFor(provider, provider.id);
  if (!stillWanted()) return superseded;
  const localChanged = local && (read.config.localModels?.mode !== "managed" || read.config.localModels?.managed?.modelId !== modelId);
  if (local) {
    const list = await chatModelsList();
    if (!list.ok || !list.models?.some(m => m.id === modelId && m.downloaded)) return { ok: false, error: "Download this local model first." };
    if (!stillWanted()) return superseded;
    if (localChanged) {
      const used = await modelsUse(modelId);
      if (!used.ok) return { ok: false, error: used.error };
    }
  }
  if (!stillWanted()) return superseded;
  const changed = await rewriteWholeConfig((cfg): RunModeVerdict => {
    const now = resolveRunMode(cfg);
    if (!stillWanted()) return { write: false, before: now };
    const current = leg === "worker" ? now.workerProviderId : now.orchestratorProviderId;
    if (now.effective !== "fusion" || current !== providerId) return { write: false, before: now, refusal: "The inference engine changed. Choose the model again." };
    const fusion = cfg.llm!.runMode!.fusion!;
    if (leg === "worker") fusion.workerModel = modelId;
    else fusion.orchestratorModel = modelId;
    return { write: true, before: now, after: resolveRunMode(cfg), leg: now.orchestratorProviderId ?? undefined };
  });
  if (!stillWanted()) return superseded;
  const settled = await afterRunModeWrite(changed, { daemonByCaller: local, stillWanted });
  if (!stillWanted()) return superseded;
  if (!settled.ok || !local) return settled;
  return { ...settled, ...await bringUpLocalDaemon(localChanged), modelId, restart: !!settled.restart || localChanged };
}
