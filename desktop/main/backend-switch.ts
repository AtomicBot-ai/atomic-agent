import {
  abortStarts,
  chatModelsList,
  closeStarts,
  daemonFoundUp,
  daemonPidsIn,
  keyNamesAvailable,
  killDaemonLeftovers,
  localDaemonRunning,
  modelsList,
  modelsStart,
  modelsStop,
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
  START_REFUSED_MOVED_ON,
  START_REFUSED_QUITTING,
  useManagedMode,
  type CliResult,
  type ProviderEntry,
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
  if (cloud && !providerIsUsable(entry)) {
    return needsKeyFor(entry, id);
  }
  // U29: an entry with no chat model cannot be built by the agent, and as the
  // active provider it would stop `atag serve` from starting. Pick the model
  // first (selectCloudModel writes it and then activates).
  if (isIncompleteProvider(entry)) {
    return { ok: false, needsChatModel: true, providerId: id, error: "choose a model for this provider first" };
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
  // A stop never waits out a load (item 11): a bring-up on its way is ended, its start killed.
  if (cloud && !keepFusion) supersedeBringUp();
  // A stop decision: whatever is still there, answering or not (item 31), is stopped and said so.
  if (cloud && !keepFusion && (await localDaemonRunning({ reapWedged: false }))) {
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

  /* Another model: a background start for the old one is moot (item 11); the
     same one is waited for. The daemon's turn is bringUpLocalDaemon's, which
     this body was a copy of: started when down, restarted when the model moved. */
  const { daemon, daemonLine, error } = await bringUpLocalDaemon(changed);
  return {
    ok: true,
    providerId: LOCAL_ID,
    modelId,
    transport: transportFor(LOCAL_ID),
    daemon,
    daemonLine,
    // Backlog 18 (its second review): a superseded start restarts nothing (restartAfterSwitch).
    restart: restart && daemon !== "superseded",
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

export type BringUp = { daemon: DaemonEffect; daemonLine?: string; error?: string };

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
let daemonChain: Promise<void> = Promise.resolve();
let turnsClosed = false;
/* ATO-123: the turns asked for and not over yet. While one is on its way the
   server may be down on purpose (a model pick stopping the old one, Settings'
   Start replacing a wedged one, the llama.cpp update), so the supervisor
   (daemon-watch.ts) takes no look at it. */
let turnsOnTheirWay = 0;
function withDaemonLock<T>(run: () => Promise<T>, whenClosed: () => T): Promise<T> {
  turnsOnTheirWay += 1;
  const turn = () => (turnsClosed ? Promise.resolve(whenClosed()) : run());
  const next = daemonChain.then(turn, turn);
  const over = () => { turnsOnTheirWay -= 1; };
  daemonChain = next.then(over, over);
  return next;
}
/** ATO-123: how many daemon turns are on their way or running. */
export function daemonTurnsOnTheirWay(): number {
  return turnsOnTheirWay;
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
let startsMark = 0;

/** Start the managed daemon when it is down (restart it when the model moved), in its turn. A model pick's and a worker pin's. */
async function bringUpLocalDaemon(modelChanged: boolean): Promise<BringUp> {
  // Another model: a background start for the old one is moot.
  if (modelChanged) supersedeBringUp();
  const asked = startsMark;
  /* Backlog 18: whether a stop or a route change came since this was asked for.
     Asked as its turn begins, and (its second review) again at the spawn
     itself (modelsStart): the turn's `models status` and `models stop` take
     seconds, and one that comes in them would otherwise still be followed by a
     start nobody asks for any more. */
  const stillAsked = () => startsMark === asked;
  const start = async (effect: "started" | "restarted"): Promise<BringUp> => {
    const st = await modelsStart({ stillWanted: stillAsked });
    // It reached its spawn after a stop, a switch or the quit: nothing was started.
    if (st.notStarted) return SUPERSEDED;
    return st.ok ? { daemon: effect, daemonLine: readyLine(st.stdout) } : { daemon: "start-failed", error: st.error };
  };
  return withDaemonLock(async (): Promise<BringUp> => {
    if (!stillAsked()) return SUPERSEDED;
    const running = await localDaemonRunning();
    if (running && !modelChanged) {
      // ATO-123: found up when it was asked for, so it is the app's to bring back — unless a stop came meanwhile.
      if (stillAsked()) daemonFoundUp();
      return { daemon: "untouched" };
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
let background: Background | null = null;
let reportBringUp: BringUpReport = () => {};

/** main.ts: where a background bring-up says how it ended. Hands back the one it replaces. */
export function onBackgroundBringUp(report: BringUpReport): BringUpReport {
  const was = reportBringUp;
  reportBringUp = report;
  return was;
}
/** The background bring-up on its way, or null. */
export function bringUpInFlight(): Promise<BringUp> | null {
  return background ? background.done : null;
}
function startInBackground(task: (s: BringUpSteps) => Promise<BringUp>): { done: Promise<BringUp>; adopted: boolean } {
  if (background) return { done: background.done, adopted: true };
  const b = { superseded: false, starting: false, abort: new AbortController() } as Background;
  const steps: BringUpSteps = { signal: b.abort.signal, superseded: () => b.superseded, starting: () => { b.starting = true; } };
  b.done = withDaemonLock(() => (b.superseded ? Promise.resolve(SUPERSEDED) : task(steps)), () => SUPERSEDED)
    .catch((err): BringUp => ({ daemon: "start-failed", error: err instanceof Error ? err.message : String(err) }))
    .then((r) => (b.superseded ? SUPERSEDED : r))
    .finally(() => { if (background === b) background = null; });
  background = b;
  return { done: b.done, adopted: false };
}
/**
 * End the background bring-up, if one is on its way: its `models start` is
 * killed, and it reports nothing and does nothing more. Answers whether it had
 * got as far as starting — what it spawned is then the caller's to stop.
 * Backlog 18: a start still waiting for its turn is ended too (startsMark).
 */
export function supersedeBringUp(): boolean {
  startsMark++;
  const b = background;
  if (!b) return false;
  background = null;
  b.superseded = true;
  b.abort.abort();
  return b.starting;
}
/** status → start, checking after each step whether a stop has ended it. */
async function startIfDown(s: BringUpSteps): Promise<BringUp> {
  if (await localDaemonRunning()) {
    // ATO-123: found up when it was asked for (a ⇄, the launch, the supervisor's own restart) — the app's from here on.
    if (!s.superseded()) daemonFoundUp();
    return { daemon: "untouched" };
  }
  if (s.superseded()) return SUPERSEDED;
  s.starting();
  const st = await modelsStart({ signal: s.signal });
  // The quit had begun (closeStarts): nothing was started.
  if (st.notStarted) return SUPERSEDED;
  return st.ok ? { daemon: "started", daemonLine: readyLine(st.stdout) } : { daemon: "start-failed", error: st.error };
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
  return startsMark;
}
/** Settings › Models › Start: in its turn, and no second `models start` for a daemon that is already up. */
export function startDaemonNow(): Promise<CliResult & { alreadyRunning?: boolean }> {
  const asked = startsMark;
  const stillAsked = () => startsMark === asked;
  return withDaemonLock(async () => {
    // Backlog 18: a stop or a route change came while this waited for its turn.
    if (!stillAsked()) return { ok: false, stdout: "", stderr: "", error: START_REFUSED_MOVED_ON };
    if (await localDaemonRunning()) {
      // ATO-123: Settings' Start found it up: the app's to bring back from here on, unless a stop came meanwhile.
      if (stillAsked()) daemonFoundUp();
      return { ok: true, stdout: "", stderr: "", alreadyRunning: true };
    }
    // Its second review: asked again at the spawn — one may have come, or the quit begun, during that status read.
    return modelsStart({ stillWanted: stillAsked });
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
}): Promise<SwitchResult> {
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
  const plan = runModeDaemonPlan(now, lm, v);
  if (plan === "wait") up = (await onDisk(modelId)) ? await bringUpLocalDaemon(false) : { daemon: "skipped" };
  else if (plan === "background") bringUpBehindSwap(modelId);
  // The seats no longer need it (a seat moved to the cloud): a start on its way is moot, and what it spawned goes.
  else if (supersedeBringUp()) await modelsStop();
  return {
    ok: true,
    providerId: leg,
    model: entry ? (entry.defaultChatModel ?? entry.model ?? null) : null,
    transport: transportFor(leg),
    ...up,
    // Backlog 18 (its second review): a superseded start restarts nothing (restartAfterSwitch).
    restart: res.changed && up.daemon !== "superseded",
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
    // Backlog 18 (its second review): a superseded start restarts nothing (restartAfterSwitch).
    restart: (!!settled.restart || changed) && up.daemon !== "superseded",
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
