/**
 * Release-fix checks for backlog item 11 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=11`.
 *
 * 11 — Fusion's ⇄ while the local model loads. A press during another switch
 * hit the one-switch-at-a-time guard and a toast that faded, and a swap that
 * did get through stuck: it waited on `models status` and, with the daemon
 * down, a whole `models start`. Now the press queues the swap and the seats
 * repaint traded on every press; the queued swap runs once when the switch
 * ahead has landed and nothing else holds the agent, and goes with that
 * switch's failure or its watchdog; and a swap of a Fusion in force does not
 * wait on the daemon — it brings a daemon that is down up in the background.
 * Starts take turns (never two `models start` at once); a stop — a cloud
 * switch, Settings › Stop — never waits out a load: it ends it at once.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserWindow } from "electron";

import { configGet, configSetWhole, type UserConfigShape } from "../agent-cli.js";
import { resolveBinary } from "../agent-client.js";
import {
  activateProvider,
  bringUpAtLaunch,
  bringUpInFlight,
  enterFusion,
  onBackgroundBringUp,
  runModeDaemonPlan,
  runModeWantsDaemon,
  supersedeBringUp,
  swapFusionLegs,
} from "../backend-switch.js";
import { planEnterFusion, planSwapLegs, resolveRunMode, type RunModeConfig } from "../run-mode.js";

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const threw = (err: unknown) => `threw: ${err instanceof Error ? err.message : String(err)}`;

/* The composer the report is about: Fusion · AI/ML API · grok ⇄ the local model. */
const PROVIDERS = [
  { id: "local-llama", kind: "llama-server" },
  { id: "aimlapi", kind: "aimlapi", defaultChatModel: "x-ai/grok-4-6" },
];
const PLANS = { provider: "aimlapi", model: "x-ai/grok-4-6" };
const LOCAL = { provider: "local-llama", model: "qwen-3.5-4b" };
function fusion(active = "aimlapi"): RunModeConfig {
  return {
    llm: {
      activeTextProvider: active,
      providers: clone(PROVIDERS),
      runMode: { mode: "fusion", fusion: { orchestratorProvider: "aimlapi", workerProvider: "local-llama" } },
    },
    localModels: { mode: "managed", managed: { modelId: "qwen-3.5-4b" } },
  };
}

interface Seats { provider: string | null; model: string | null; workers: string | null; queued: boolean; cls: string; tip: string }
const traded = (s: Seats | undefined) => !!s && s.provider === LOCAL.provider && s.model === LOCAL.model && s.workers === PLANS.model;
const asIs = (s: Seats | undefined) => !!s && s.provider === PLANS.provider && s.model === PLANS.model && s.workers === LOCAL.model;

/**
 * One renderer scenario on the staged Fusion composer. `startAhead(want,
 * viaRow)` starts the switch the swap waits behind — the workers control
 * starting the local model — and hands back `{p, land}`: `land(result)` is
 * main's answer, and `viaRow` runs it through the row's own fzAfter as the
 * real control does. `press()` is a real click on ⇄ (or `/runmode swap`),
 * `seats()` reads the three chips off the DOM, and every swap that reaches the
 * SWXBR funnel is recorded in `calls` instead of going to main — answered at
 * once, or held until `release(result)` when the body sets `hold = true`.
 * Everything it touches is put back.
 */
const scenario = (body: string) => `(async () => {
  const tick = (ms) => new Promise((res) => setTimeout(res, ms));
  const keep = {cfg: LIVE_CONFIG, queued: FZ.swapQueued, swap: SWXBR.swapFusionLegs, busy: S.busy, err: SWX.err,
    times: Object.assign({}, SWX.times), lastMs: SWX.lastMs, pending: S.pending, msgs: S.queued.slice(),
    running: Array.from(RUNNING.entries()), log: S.log, logLen: S.log.length};
  const calls = [];
  let hold = false, release = null;
  const seats = () => {
    const id = (k) => { const b = document.querySelector('#composer .cfoot [data-sel-open="' + k + '"]'); return b ? (b.dataset.id || '') : null; };
    const sw = document.querySelector('#composer .cfoot .fzswap');
    return {provider: id('provider'), model: id('model'), workers: id('workers'), queued: FZ.swapQueued === true,
      cls: sw ? sw.className : '', tip: sw ? sw.title : ''};
  };
  const press = (how) => {
    if (how === 'slash') window.__runSlash('/runmode swap');
    else { const b = document.querySelector('#composer .cfoot .fzswap'); if (b) b.click(); }
    return seats();
  };
  const lands = [];
  const startAhead = (want, viaRow) => {
    let landIt = null;
    const run = () => new Promise((res) => { landIt = res; });
    const label = 'starting qwen-3.5-4b…';
    const p = viaRow ? (async () => fzAfter(await swxRun(label, want, run), 'fusion'))() : swxRun(label, want, run);
    const land = (r) => { if (landIt) landIt(r); };
    lands.push(land);
    return {p, land};
  };
  try {
    LIVE_CONFIG = ${JSON.stringify(fusion())}; FZ.swapQueued = false; S.busy = false; SWX.err = null;
    S.pending = null; S.queued.length = 0; RUNNING.clear();
    SWXBR.swapFusionLegs = () => {
      calls.push({want: SWX.want ? JSON.parse(JSON.stringify(SWX.want)) : null, seats: seats()});
      SWX.route = 'swapFusionLegs';
      return hold ? new Promise((res) => { release = res; }) : Promise.resolve({ok: true});
    };
    render();
    const idle = seats();
    ${body}
  } finally {
    FZ.swapQueued = false;
    lands.forEach((land) => land({ok: true}));
    if (release) release({ok: true});
    await tick(80);
    SWXBR.swapFusionLegs = keep.swap; LIVE_CONFIG = keep.cfg; FZ.swapQueued = keep.queued; S.busy = keep.busy; SWX.err = keep.err;
    SWX.times = keep.times; SWX.lastMs = keep.lastMs; S.pending = keep.pending;
    S.queued.length = 0; S.queued.push.apply(S.queued, keep.msgs);
    RUNNING.clear(); keep.running.forEach(([k, v]) => RUNNING.set(k, v));
    if (S.log === keep.log) S.log.length = keep.logLen;
    render();
  }
})()`;

async function connected(js: Js): Promise<boolean> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if ((await js<string>("window.__live && window.__live()")) === "connected") return true;
    await wait(500);
  }
  return false;
}

export async function checks11(js: Js, check: Check): Promise<void> {
  // The model chip names the orchestrator's model only on a connected agent; another check may have restarted it.
  if (!(await connected(js))) {
    check("T11: the agent is connected for the composer checks", false, "not connected after 60 s");
    return;
  }

  /* ---- the renderer: ⇄ while the local model loads ---- */
  try {
    const a = await js<{
      idle: Seats; presses: Seats[]; pending: number; toasts: string[]; callsBefore: number;
      calls: Array<{ want: Record<string, unknown> | null; seats: Seats }>;
      after: { queued: boolean; pending: number; want: unknown }; settled: Seats;
    }>(scenario(`
      const {p, land} = startAhead({backend: 'fusion'});
      await tick(30);
      const pending = SWX.pending;
      const t0 = S.toasts.length;
      const presses = [press('click'), press('click'), press('slash')];
      const toasts = S.toasts.slice(t0).map((t) => t.t + (t.s ? ' / ' + t.s : ''));
      const callsBefore = calls.length;
      land({ok: true});
      await p;
      await tick(400);
      return {idle, presses, pending, toasts, callsBefore, calls,
        after: {queued: FZ.swapQueued, pending: SWX.pending, want: SWX.want}, settled: seats()};
    `));
    const [p1, p2, p3] = a.presses;
    check(
      "T11: ⇄ while the model loads queues the swap — each press repaints the seats at once, the next press puts them back, no refusal toast",
      asIs(a.idle) && a.pending === 1
        && traded(p1) && p1!.queued && /is-queued/.test(p1!.cls) && /once qwen-3\.5-4b is up/.test(p1!.tip)
        && asIs(p2) && !p2!.queued && !/is-queued/.test(p2!.cls)
        && traded(p3) && p3!.queued
        && !a.toasts.some((t) => /one switch at a time|has not finished/i.test(t)) && a.callsBefore === 0,
      JSON.stringify({ idle: a.idle, presses: a.presses, toasts: a.toasts, callsBefore: a.callsBefore }),
    );
    check(
      "T11: a typed /runmode swap that queues says so (the ⇄ shows it on itself)",
      a.toasts.length === 1 && /^Swap queued \/ It takes effect once qwen-3\.5-4b is up$/.test(a.toasts[0] ?? ""),
      JSON.stringify(a.toasts),
    );
    const sw = a.calls[0]?.want?.swap as { orchestrator?: string; worker?: string } | undefined;
    check(
      "T11: when the load lands, the queued swap runs exactly once, through swxRun, with the seats painted traded",
      a.calls.length === 1 && a.calls[0]!.want?.backend === "fusion"
        && sw?.orchestrator === PLANS.provider && sw?.worker === LOCAL.provider
        && traded(a.calls[0]!.seats) && !a.calls[0]!.seats.queued
        && a.after.queued === false && a.after.pending === 0 && a.after.want === null
        // the stub wrote nothing, so the live seats come back
        && asIs(a.settled),
      JSON.stringify({ calls: a.calls, after: a.after, settled: a.settled }),
    );
  } catch (err) {
    check("T11: ⇄ while the model loads queues the swap", false, threw(err));
  }

  try {
    const b = await js<{ queued: Seats; calls: number; after: Seats; err: string | null }>(scenario(`
      const {p, land} = startAhead({backend: 'fusion'});
      await tick(30);
      const queued = press('click');
      land({ok: false, error: 'smoke t11: the model did not load'});
      await p;
      await tick(400);
      return {queued, calls: calls.length, after: seats(), err: SWX.err};
    `));
    check(
      "T11: a load that fails takes the queued swap with it — the seats roll back and its failure line stays",
      traded(b.queued) && b.calls === 0 && asIs(b.after) && !b.after.queued && /smoke t11: the model did not load/.test(b.err ?? ""),
      JSON.stringify(b),
    );
  } catch (err) {
    check("T11: a load that fails takes the queued swap with it", false, threw(err));
  }

  // selectFusionWorkerModel answers ok:true with daemon:'start-failed' when the write landed and the model did not start.
  try {
    const b2 = await js<{ queued: Seats; calls: number; after: Seats; lines: string[] }>(scenario(`
      const {p, land} = startAhead({backend: 'fusion', worker: {provider: 'local-llama', label: 'qwen-3.5-4b'}}, true);
      await tick(30);
      const queued = press('click');
      const n0 = S.log.length;
      land({ok: true, daemon: 'start-failed', error: 'smoke t11: the model did not start'});
      await p;
      await tick(400);
      return {queued, calls: calls.length, after: seats(), lines: S.log.slice(n0).filter((m) => m.k === 'system').map((m) => m.text)};
    `));
    check(
      "T11: a worker model that did not start takes the queued swap with it too — the seats roll back, its failure line stays",
      traded(b2.queued) && b2.calls === 0 && asIs(b2.after) && !b2.after.queued
        && b2.lines.some((l) => /did not start: smoke t11: the model did not start/.test(l)),
      JSON.stringify(b2),
    );
  } catch (err) {
    check("T11: a worker model that did not start takes the queued swap with it", false, threw(err));
  }

  try {
    const sf = await js<{ queued: Seats; calls: number; after: Seats }>(scenario(`
      const {p, land} = startAhead({backend: 'fusion'});
      await tick(30);
      const queued = press('click');
      land({ok: true, daemon: 'stop-failed', daemonLine: 'local-llm: stop failed — smoke t11'});
      await p;
      await tick(400);
      return {queued, calls: calls.length, after: seats()};
    `));
    check(
      "T11: a switch whose daemon stop failed takes the queued swap with it as well",
      traded(sf.queued) && sf.calls === 0 && asIs(sf.after) && !sf.after.queued,
      JSON.stringify(sf),
    );
  } catch (err) {
    check("T11: a switch whose daemon stop failed takes the queued swap with it as well", false, threw(err));
  }

  try {
    const ap = await js<{ pressed: Seats; held: { queued: boolean; calls: number }; ran: { queued: boolean; calls: number } }>(scenario(`
      S.pending = {id: 't11', k: 'approval', approvalId: 't11'};   // a turn waits on the gate; no switch is landing
      render();
      const pressed = press('click');
      await tick(250);
      const held = {queued: FZ.swapQueued, calls: calls.length};
      S.pending = null; render();   // answered, and that turn is over
      await tick(400);
      return {pressed, held, ran: {queued: FZ.swapQueued, calls: calls.length}};
    `));
    check(
      "T11: ⇄ pressed under an open approval queues the swap instead of restarting the agent under the gate",
      traded(ap.pressed) && ap.pressed.queued && /approval is answered/.test(ap.pressed.tip)
        && ap.held.queued && ap.held.calls === 0 && !ap.ran.queued && ap.ran.calls === 1,
      JSON.stringify(ap),
    );
  } catch (err) {
    check("T11: ⇄ pressed under an open approval queues the swap", false, threw(err));
  }

  // A ⇄'s background start can end 90 s later, in whatever chat is open: a toast and the app line, never a row there.
  try {
    const keep = await js<{ log: number; toasts: number }>("({log: S.log.length, toasts: S.toasts.length})");
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send("cli:daemon", { daemon: "start-failed", error: "smoke t11: the model did not start", modelId: "qwen-3.5-4b", via: "swap" });
    }
    await wait(300);
    const seen = await js<{ log: number; toast: { t: string; s: string } | null }>("({log: S.log.length, toast: window.__lastToast()})");
    check(
      "T11: a background start that failed is a toast, not a row in the chat that happens to be open",
      seen.log === keep.log && seen.toast?.t === "The local model did not start" && /smoke t11/.test(seen.toast?.s ?? ""),
      JSON.stringify({ keep, seen }),
    );
  } catch (err) {
    check("T11: a background start that failed is a toast, not a row in the chat", false, threw(err));
  }

  try {
    const w = await js<{ queued: Seats; fired: Seats & { pending: number; err: string | null }; calls: number; after: Seats }>(scenario(`
      const {p, land} = startAhead({backend: 'fusion'});
      await tick(30);
      const queued = press('click');
      clearTimeout(SWX.timer); swxWatchdog('starting qwen-3.5-4b…');   // what the 45 s timer calls
      const fired = Object.assign(seats(), {pending: SWX.pending, err: SWX.err});
      land({ok: true});   // the IPC comes back late
      await p;
      await tick(400);
      return {queued, fired, calls: calls.length, after: seats()};
    `));
    check(
      "T11: when the 45 s watchdog gives up on the load, the queued swap goes with it and the seats read as the config has them",
      traded(w.queued) && w.queued.queued && asIs(w.fired) && !w.fired.queued && w.fired.pending === 0
        && /has not finished/.test(w.fired.err ?? "") && w.calls === 0 && asIs(w.after),
      JSON.stringify(w),
    );
  } catch (err) {
    check("T11: when the 45 s watchdog gives up on the load, the queued swap goes with it", false, threw(err));
  }

  try {
    const c = await js<Record<string, { queued: boolean; calls: number; tip?: string }>>(scenario(`
      const {p, land} = startAhead({backend: 'fusion'});
      await tick(30);
      press('click');
      const at = (extra) => Object.assign({queued: FZ.swapQueued, calls: calls.length}, extra || {});
      // An approval arrives before the load lands: never under an open gate.
      S.pending = {id: 't11', k: 'approval', approvalId: 't11'};
      land({ok: true});
      await p;
      await tick(250);
      const approval = at({tip: seats().tip});
      // Answered, but a message waits to start the next turn: the restart would kill it.
      S.pending = null; S.queued.push('t11 queued message'); render();
      await tick(250);
      const queuedMessage = at();
      // The queue drained; a turn still runs in another chat.
      S.queued.length = 0; RUNNING.set('t11-turn', 't11-other-chat'); render();
      await tick(250);
      const otherChat = at({tip: seats().tip});
      // That turn ends (its frame clears RUNNING and paints): the swap runs, once.
      RUNNING.delete('t11-turn'); render();
      await tick(400);
      const ran = at();
      return {approval, queuedMessage, otherChat, ran};
    `));
    check(
      "T11: a queued swap waits out an open approval, a queued message and a turn in another chat, then runs once",
      c.approval!.queued && c.approval!.calls === 0 && /approval is answered/.test(c.approval!.tip ?? "")
        && c.queuedMessage!.queued && c.queuedMessage!.calls === 0
        && c.otherChat!.queued && c.otherChat!.calls === 0 && /running turn ends/.test(c.otherChat!.tip ?? "")
        && !c.ran!.queued && c.ran!.calls === 1,
      JSON.stringify(c),
    );
  } catch (err) {
    check("T11: a queued swap waits out an open approval, a queued message and a turn in another chat", false, threw(err));
  }

  try {
    const n = await js<{ held: { queued: boolean; calls: number }; flushed: { queued: boolean; calls: number; busy: boolean } }>(scenario(`
      const {p, land} = startAhead({backend: 'fusion'});
      await tick(30);
      press('click');
      S.busy = true;   // a turn on screen took the composer while the load was landing
      land({ok: true});
      await p;
      await tick(250);
      const held = {queued: FZ.swapQueued, calls: calls.length};
      window.__newSession();   // clears S.busy with no done frame — no flush call of its own
      await tick(400);
      return {held, flushed: {queued: FZ.swapQueued, calls: calls.length, busy: S.busy}};
    `));
    check(
      "T11: a queued swap held by a turn runs once whatever path lets the composer go (a new chat here, no done frame)",
      n.held.queued && n.held.calls === 0 && !n.flushed.queued && n.flushed.calls === 1 && !n.flushed.busy,
      JSON.stringify(n),
    );
  } catch (err) {
    check("T11: a queued swap held by a turn runs once whatever path lets the composer go", false, threw(err));
  }

  /* swxSettle re-reads the config BEFORE swxRun's `finally` drops the want,
     and then waits up to 3 s for the coding mode: the swap's paint has to
     hold over a file that already has the traded seats, not trade it back. */
  const landedFile = fusion();
  planSwapLegs(landedFile, () => true);
  try {
    const e = await js<{ pressed: Seats; inFlight: Seats; reRead: Seats; done: Seats; calls: number; pending: number }>(scenario(`
      hold = true;
      const pressed = press('click');   // nothing landing: the swap goes at once
      await tick(30);
      const inFlight = seats();
      LIVE_CONFIG = ${JSON.stringify(landedFile)}; render();
      const reRead = seats();
      const pending = SWX.pending;
      release({ok: true});
      await tick(300);
      return {pressed, inFlight, reRead, done: seats(), calls: calls.length, pending};
    `));
    check(
      "T11: a swap in flight paints the traded seats on the press, and keeps them when the config is re-read under it",
      traded(e.pressed) && !e.pressed.queued && traded(e.inFlight) && traded(e.reRead) && traded(e.done)
        && e.pending === 1 && e.calls === 1,
      JSON.stringify(e),
    );
  } catch (err) {
    check("T11: a swap in flight paints the traded seats", false, threw(err));
  }

  try {
    const f = await js<{ moving: Seats; queued: Seats; calls: number }>(scenario(`
      const {p, land} = startAhead({backend: 'fusion', worker: {provider: 'local-llama', label: 'qwen-3.5-9b'}});
      await tick(30);
      const moving = seats();
      const queued = press('click');
      land({ok: true});
      await p;
      await tick(400);
      return {moving, queued, calls: calls.length};
    `));
    check(
      "T11: while the workers move to another model the chip names it, and a swap queued behind that names it as the orchestrator",
      f.moving.provider === PLANS.provider && f.moving.model === PLANS.model && f.moving.workers === "qwen-3.5-9b"
        && f.queued.provider === LOCAL.provider && f.queued.model === "qwen-3.5-9b" && f.queued.workers === PLANS.model
        && f.calls === 1,
      JSON.stringify(f),
    );
  } catch (err) {
    check("T11: while the workers move to another model the chip names it", false, threw(err));
  }

  /* ---- main: what a swap does about the daemon ---- */
  const swapped = fusion();
  const v = planSwapLegs(swapped, () => true);
  const after = resolveRunMode(swapped);
  const entering: RunModeConfig = { llm: { activeTextProvider: "aimlapi", providers: clone(PROVIDERS) }, localModels: fusion().localModels };
  const ve = planEnterFusion(entering, {}, () => true);
  const handSwitched = fusion("local-llama");   // stored fusion, the orchestrator not the active provider
  const vh = planSwapLegs(handSwitched, () => true);
  const d = {
    seatsOnly: v.seatsOnly,
    swap: runModeDaemonPlan(after, swapped.localModels ?? {}, v),
    seatsNeedIt: runModeWantsDaemon(after, swapped.localModels ?? {}),
    enter: runModeDaemonPlan(resolveRunMode(entering), entering.localModels ?? {}, ve),
    handSwitched: { seatsOnly: vh.seatsOnly, plan: runModeDaemonPlan(resolveRunMode(handSwitched), handSwitched.localModels ?? {}, vh) },
  };
  check(
    "T11: a swap of a Fusion in force is seats-only and brings the daemon up in the background; entering Fusion waits for it",
    v.write && d.seatsOnly === true && d.swap === "background" && d.seatsNeedIt === true
      && after.orchestratorProviderId === "local-llama" && after.workerProviderId === "aimlapi"
      && d.enter === "wait" && d.handSwitched.seatsOnly === false && d.handSwitched.plan === "wait",
    JSON.stringify(d),
  );

  /* The real daemon paths, against this state dir with the local model on
     disk, through a guard in front of the agent binary. The guard writes
     every verb down and never lets `models start`, `models stop` or `models
     status` reach the agent: the start is a sleep of `slow` seconds that
     marks the daemon up as it begins (the pid file is written at the spawn)
     and again when it ends; the stop clears the mark; the status reads it. So
     no llama-server can come up here whatever the code does — and a start
     that was killed never writes its end. */
  const live = (await configGet()).config as UserConfigShape | undefined;
  const bin = resolveBinary();
  if (!live || !bin) {
    check("T11: the daemon paths ran against a guarded agent", false, !live ? "config not read" : "no agent binary");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "aa-t11-"));
  const log = join(dir, "verbs.log");
  const up = join(dir, "daemon-up");
  const slow = join(dir, "slow");
  const guard = join(dir, "atag-guard.sh");
  const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
  writeFileSync(guard, [
    "#!/bin/sh",
    `case "$1 $2" in`,
    `  "models start") echo "models start begin" >> ${q(log)}; : > ${q(up)}`,
    `    sleep "$(cat ${q(slow)} 2>/dev/null || echo 2)"`,
    `    echo "models start end" >> ${q(log)}; : > ${q(up)}; exit 0;;`,
    `  "models stop") echo "models stop" >> ${q(log)}; rm -f ${q(up)}; exit 0;;`,
    `  "models status") echo "models status" >> ${q(log)}`,
    `    if [ -f ${q(up)} ]; then printf 'mode:           managed\\ndaemon:         running (pid 1)\\nhealth:         ok\\n'`,
    `    else printf 'mode:           managed\\ndaemon:         stopped\\nhealth:         down\\n'; fi; exit 0;;`,
    `  *) printf '%s %s\\n' "$1" "$2" >> ${q(log)};;`,
    "esac",
    `exec ${q(bin)} "$@"`,
    "",
  ].join("\n"));
  chmodSync(guard, 0o755);
  const verbs = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  const count = (x: string) => verbs().filter((v) => v === x).length;
  const reset = (seconds: number, daemonUp = false) => {
    writeFileSync(log, "");
    writeFileSync(slow, String(seconds));
    if (daemonUp) writeFileSync(up, ""); else rmSync(up, { force: true });
  };
  const until = async (pred: () => boolean, ms: number) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await wait(50); return pred(); };
  const settle = async () => {
    const bg = bringUpInFlight();
    if (bg) await Promise.race([bg, wait(30_000)]);
    if (bringUpInFlight()) { supersedeBringUp(); await wait(500); }
    return !bringUpInFlight();
  };
  // Every report a background bring-up makes, on its way to main's own (the agent log and the window).
  const reports: Array<{ daemon: string; via: string }> = [];
  const mainReport = onBackgroundBringUp((r) => { reports.push({ daemon: r.daemon, via: r.via }); mainReport(r); });
  const withProviders = (cfg: UserConfigShape, active: string, runMode: NonNullable<UserConfigShape["llm"]>["runMode"]): UserConfigShape => {
    const c = clone(cfg);
    const llm = c.llm ?? {};
    c.llm = {
      ...llm,
      activeTextProvider: active,
      providers: [...(llm.providers ?? []).filter((p) => p.id !== "aimlapi" && p.id !== "openrouter"),
        // Inline keys so the cloud rows are usable; nothing is ever sent with them.
        { id: "aimlapi", kind: "aimlapi", defaultChatModel: "x-ai/grok-4-6", apiKey: "t11-not-a-key" },
        { id: "openrouter", kind: "openrouter", defaultChatModel: "qwen/qwen3.7-flash", apiKey: "t11-not-a-key" }],
      runMode,
    };
    return c;
  };
  const fusionCfg = withProviders(live, "aimlapi", { mode: "fusion", fusion: { orchestratorProvider: "aimlapi", workerProvider: "local-llama" } });
  const localCfg = withProviders(live, "local-llama", { mode: "local" });
  const keepBin = process.env.ATOMIC_AGENT_BIN;
  try {
    process.env.ATOMIC_AGENT_BIN = guard;

    // 1. A ⇄ with the daemon down: back after the config, the daemon coming up behind it.
    await configSetWhole(fusionCfg);
    reset(2);
    const t0 = Date.now();
    const res = await swapFusionLegs();
    const ms = Date.now() - t0;
    const atReturn = verbs();
    const bg = bringUpInFlight();
    // Settings › Models › Start pressed while that start is on its way: it waits its turn and starts nothing twice.
    const settings = await js<{ ok: boolean; alreadyRunning?: boolean }>("window.atomic.modelsStart()");
    const r = bg ? await bg : null;
    await wait(300);
    const told = await js<string[]>("LOGS.slice(-6).map((l) => l[2])");
    const now = (await configGet()).config as UserConfigShape | undefined;
    check(
      "T11: a swap does not wait for the daemon, and brings one that is down up behind it",
      res.ok && res.restart === true && res.runMode?.after === "fusion" && !res.error
        && now?.llm?.activeTextProvider === "local-llama" && now.llm.runMode?.fusion?.workerProvider === "aimlapi"
        && !atReturn.some((v) => /^models (start|status)/.test(v))
        && r?.daemon === "started" && ["models list", "models status", "models start begin", "models start end"].every((x) => verbs().includes(x))
        && reports.length === 1 && reports[0]!.via === "swap" && reports[0]!.daemon === "started"
        && told.some((l) => /started the local model daemon \(qwen-3\.5-4b\)/.test(l)),
      `swap ${ms} ms; at return ${JSON.stringify(atReturn)}; background ${JSON.stringify(r)}; reports ${JSON.stringify(reports)}; verbs ${JSON.stringify(verbs())}`,
    );
    check(
      "T11: Settings' Start during that start waits its turn, starts nothing twice, and says the daemon is already running",
      settings?.ok === true && settings.alreadyRunning === true && count("models start begin") === 1,
      `settings ${JSON.stringify(settings)}; starts ${count("models start begin")}`,
    );
    const msg = await js<string>(`(async () => {
      const keep = {msg: LLMP.msg, status: LLMP.status, err: LLMP.statusErr};
      try { await llmDaemon('start'); return (LLMP.msg && LLMP.msg.text) || ''; }
      finally { LLMP.msg = keep.msg; LLMP.status = keep.status; LLMP.statusErr = keep.err; }
    })()`);
    check(
      "T11: Settings' Start on a daemon that is already up does not say it started one",
      msg === "local-llm: daemon already running" && count("models start begin") === 1,
      JSON.stringify(msg),
    );

    // 2. The daemon up: the swap back's background check starts nothing and reports nothing.
    reports.length = 0;
    reset(2, true);
    const res2 = await swapFusionLegs();
    const r2 = await (bringUpInFlight() ?? Promise.resolve(null));
    check(
      "T11: with the daemon up, a swap's background check starts nothing",
      res2.ok && r2?.daemon === "untouched" && verbs().includes("models status") && count("models start begin") === 0 && reports.length === 0,
      `background ${JSON.stringify(r2)}; verbs ${JSON.stringify(verbs())}; reports ${JSON.stringify(reports)}`,
    );

    // 3. The launch start loading on the local route, and the operator picks a cloud provider: the stop does not wait for the load.
    await configSetWhole(localCfg);
    reports.length = 0;
    reset(10);
    const launch = bringUpAtLaunch("qwen-3.5-4b");
    await until(() => verbs().includes("models start begin"), 10_000);
    const t3 = Date.now();
    const cloud = await activateProvider("aimlapi");
    const ms3 = Date.now() - t3;
    const atReturn3 = verbs();
    const r3 = await launch;
    await until(() => false, Math.max(0, 11_000 - (Date.now() - t3)));   // past the end the killed start would have had
    check(
      "T11: a cloud switch while the local model loads stops it at once, without waiting for the load",
      cloud.ok && cloud.daemon === "stopped" && ms3 < 8_000 && !atReturn3.includes("models start end") && atReturn3.includes("models stop"),
      `cloud switch ${ms3} ms (the load is 10 s); daemon ${cloud.daemon}; verbs at return ${JSON.stringify(atReturn3)}`,
    );
    check(
      "T11: the load that cloud switch superseded reports nothing and brings no daemon up after the stop",
      r3.daemon === "superseded" && reports.length === 0 && count("models start begin") === 1
        && !verbs().includes("models start end") && !existsSync(up),
      `launch ${JSON.stringify(r3)}; reports ${JSON.stringify(reports)}; verbs ${JSON.stringify(verbs())}; daemon up ${existsSync(up)}`,
    );

    // 4. Settings › Stop while a start is on its way: at once.
    reports.length = 0;
    reset(10);
    const launch4 = bringUpAtLaunch("qwen-3.5-4b");
    await until(() => verbs().includes("models start begin"), 10_000);
    const t4 = Date.now();
    const stop = await js<{ ok: boolean }>("window.atomic.modelsStop()");
    const ms4 = Date.now() - t4;
    const r4 = await launch4;
    await until(() => false, Math.max(0, 11_000 - (Date.now() - t4)));
    check(
      "T11: Settings' Stop while the local model loads stops it at once, and the load it ended reports nothing and comes back up never",
      stop?.ok === true && ms4 < 3_000 && r4.daemon === "superseded" && reports.length === 0
        && count("models start begin") === 1 && !verbs().includes("models start end") && !existsSync(up),
      `stop ${ms4} ms (the load is 10 s); launch ${JSON.stringify(r4)}; verbs ${JSON.stringify(verbs())}; daemon up ${existsSync(up)}`,
    );

    // 5. The launch start finds a ⇄'s bring-up on its way: one start, logged once.
    await configSetWhole(fusionCfg);
    reports.length = 0;
    reset(2);
    await swapFusionLegs();
    const adopted = bringUpAtLaunch("qwen-3.5-4b");
    const r5 = await adopted;
    await wait(200);
    check(
      "T11: the launch start that finds a swap's start on its way adopts it — one start, one log line",
      r5.daemon === "started" && count("models start begin") === 1 && reports.length === 1 && reports[0]!.via === "swap",
      `launch ${JSON.stringify(r5)}; reports ${JSON.stringify(reports)}; verbs ${JSON.stringify(verbs())}`,
    );

    // 6. A route change that makes the start moot — both seats to the cloud — ends it, and what it spawned goes.
    await configSetWhole(fusionCfg);
    reports.length = 0;
    reset(10);
    await swapFusionLegs();
    const bg6 = bringUpInFlight();
    await until(() => verbs().includes("models start begin"), 10_000);
    const both = await enterFusion({ orchestratorProvider: "openrouter", workerProvider: "aimlapi" });
    const r6 = bg6 ? await bg6 : null;
    await wait(300);
    check(
      "T11: moving the seats to the cloud ends a start on its way — no report, and the half-started daemon is stopped",
      both.ok && r6?.daemon === "superseded" && reports.length === 0 && verbs().includes("models stop")
        && !verbs().includes("models start end") && !existsSync(up),
      `enterFusion ${JSON.stringify({ ok: both.ok, error: both.error })}; background ${JSON.stringify(r6)}; verbs ${JSON.stringify(verbs())}`,
    );
  } catch (err) {
    check("T11: the daemon paths ran against a guarded agent", false, threw(err));
  } finally {
    onBackgroundBringUp(mainReport);
    // Never let the real binary back in while a start could still reach it.
    if (await settle()) {
      if (keepBin === undefined) delete process.env.ATOMIC_AGENT_BIN; else process.env.ATOMIC_AGENT_BIN = keepBin;
      rmSync(dir, { recursive: true, force: true });
    } else {
      check("T11: no bring-up was left running before the guard was taken away", false, "still running — the guard stays in place");
    }
    await configSetWhole(live);
  }

  // Launch: a Fusion in force with a local seat gets its daemon started like the
  // local route does (startLocalDaemonAtBoot); two cloud seats do not.
  {
    const lm = { mode: "managed", managed: { modelId: "qwen-3.5-4b" } };
    const fusionLocal: RunModeConfig = {
      llm: { activeTextProvider: "aimlapi", providers: [{ id: "local-llama", kind: "llama-server" }, { id: "aimlapi", kind: "aimlapi" }],
        runMode: { mode: "fusion", fusion: { orchestratorProvider: "aimlapi", workerProvider: "local-llama" } } },
      localModels: lm,
    } as RunModeConfig;
    const fusionCloud: RunModeConfig = {
      llm: { activeTextProvider: "aimlapi", providers: [{ id: "aimlapi", kind: "aimlapi" }, { id: "openrouter", kind: "openrouter" }],
        runMode: { mode: "fusion", fusion: { orchestratorProvider: "aimlapi", workerProvider: "openrouter" } } },
      localModels: lm,
    } as RunModeConfig;
    const a = runModeWantsDaemon(resolveRunMode(fusionLocal), lm);
    const b = runModeWantsDaemon(resolveRunMode(fusionCloud), lm);
    check("T11: at launch, Fusion with a local seat starts its model server; two cloud seats do not", a === true && b === false, JSON.stringify({ fusionLocal: a, fusionCloud: b }));
  }
}
