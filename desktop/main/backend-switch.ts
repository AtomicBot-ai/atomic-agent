import {
  abortStarts,
  chatModelsList,
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
 * in the renderer refuses to run while a turn is in flight.
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
  /** main.ts restarts `atag serve` when true. */
  restart?: boolean;
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

  // Another model: a background start for the old one is moot (item 11); the same one is waited for.
  if (changed) supersedeBringUp();
  const asked = startsMark;
  const { daemon, daemonLine, error } = await withDaemonLock(async (): Promise<BringUp> => {
    // Backlog 18: a stop or a route change came while this waited for its turn.
    if (startsMark !== asked) return SUPERSEDED;
    const running = await localDaemonRunning();
    if (running && changed) {
      const s = await modelsStop();
      if (!s.ok) return { daemon: "stop-failed", daemonLine: `local-llm: stop failed — ${s.error ?? "unknown error"}` };
      const st = await modelsStart();
      return st.ok ? { daemon: "restarted", daemonLine: readyLine(st.stdout) } : { daemon: "start-failed", error: st.error };
    }
    if (running) return { daemon: "untouched" };
    const st = await modelsStart();
    return st.ok ? { daemon: "started", daemonLine: readyLine(st.stdout) } : { daemon: "start-failed", error: st.error };
  }, () => SUPERSEDED);
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
function withDaemonLock<T>(run: () => Promise<T>, whenClosed: () => T): Promise<T> {
  const turn = () => (turnsClosed ? Promise.resolve(whenClosed()) : run());
  const next = daemonChain.then(turn, turn);
  daemonChain = next.then(() => undefined, () => undefined);
  return next;
}
/** Backlog 18: `run` in the daemon's turn, as a start takes it — the llama.cpp update's. `whenClosed` is its answer if the app quits first. */
export function inDaemonTurn<T>(run: () => Promise<T>, whenClosed: () => T): Promise<T> {
  return withDaemonLock(run, whenClosed);
}
/** Quitting (main.ts stopForQuit): no turn begins after this. The undo is for a smoke check, which carries on after it. */
export function closeDaemonTurns(): () => void {
  turnsClosed = true;
  return () => { turnsClosed = false; };
}
/* Backlog 18 (its review): a start waiting for its turn can wait out a whole
   llama.cpp update, minutes, and the window lets go of its switch after 45 s —
   the operator may pick the cloud, another model or Settings › Stop by the
   time the turn comes. Every stop and route change that ends a background
   bring-up (supersedeBringUp) moves this mark too, and a start asked for
   before it moved starts nothing in its turn: a server nobody asks for any
   more would hold the model's memory, on a route that has moved on. */
let startsMark = 0;

/** Start the managed daemon when it is down (restart it when the model moved), in its turn. */
async function bringUpLocalDaemon(modelChanged: boolean): Promise<BringUp> {
  // Another model: a background start for the old one is moot.
  if (modelChanged) supersedeBringUp();
  const asked = startsMark;
  return withDaemonLock(async (): Promise<BringUp> => {
    // Backlog 18: a stop or a route change came while this waited for its turn.
    if (startsMark !== asked) return SUPERSEDED;
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
export type BringUpReport = (r: BringUp & { modelId: string; via: "swap" | "launch" }) => void;
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
  if (await localDaemonRunning()) return { daemon: "untouched" };
  if (s.superseded()) return SUPERSEDED;
  s.starting();
  const st = await modelsStart({ signal: s.signal });
  return st.ok ? { daemon: "started", daemonLine: readyLine(st.stdout) } : { daemon: "start-failed", error: st.error };
}
function report(r: BringUp, modelId: string, via: "swap" | "launch"): void {
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
export function bringUpAtLaunch(modelId: string): Promise<BringUp> {
  const { done, adopted } = startInBackground(startIfDown);
  if (!adopted) void done.then((r) => report(r, modelId, "launch"));
  return done;
}
/** Settings › Models › Start: in its turn, and no second `models start` for a daemon that is already up. */
export function startDaemonNow(): Promise<CliResult & { alreadyRunning?: boolean }> {
  const asked = startsMark;
  return withDaemonLock(async () => {
    // Backlog 18: a stop or a route change came while this waited for its turn.
    if (startsMark !== asked) return { ok: false, stdout: "", stderr: "", error: "a stop or a switch came first — the model server was not started" };
    if (await localDaemonRunning()) return { ok: true, stdout: "", stderr: "", alreadyRunning: true };
    return modelsStart();
  }, () => ({ ok: false, stdout: "", stderr: "", error: "the app is quitting — the model server was not started" }));
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
 */
export async function stopDaemonForQuit(dataDir: string): Promise<number[]> {
  supersedeBringUp();
  await abortStarts(1_500);
  const named = daemonPidsIn(dataDir);
  await Promise.race([modelsStop(), new Promise((r) => setTimeout(r, 5_000))]);
  return killDaemonLeftovers([...named, ...daemonPidsIn(dataDir)]);
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
