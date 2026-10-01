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
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configGet, configSetWhole, type UserConfigShape } from "../agent-cli.js";
import { resolveBinary } from "../agent-client.js";
import {
  afterBackgroundBringUp,
  backgroundBringUp,
  runModeDaemonPlan,
  runModeWantsDaemon,
  swapFusionLegs,
  trackBringUp,
  type BringUp,
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

  /* One bring-up at a time: the launch start and a swap's background start
     share one slot, and a path that touches the daemon waits for it. */
  {
    const ran: string[] = [];
    let release: () => void = () => {};
    const first = trackBringUp(() => new Promise<BringUp>((res) => { ran.push("first"); release = () => res({ daemon: "started" }); }));
    const second = trackBringUp(async () => { ran.push("second"); return { daemon: "started" }; });
    let waited = false;
    const waiter = afterBackgroundBringUp().then((r) => { waited = true; return r; });
    await wait(50);
    const early = { waited, inFlight: backgroundBringUp() === first };
    release();
    const r = await waiter;
    await wait(0);
    check(
      "T11: one daemon bring-up at a time — a second asked for while one runs gets that one, and the daemon's other paths wait for it",
      second === first && JSON.stringify(ran) === '["first"]' && early.inFlight && !early.waited && r?.daemon === "started"
        && backgroundBringUp() === null,
      JSON.stringify({ ran, early, r, after: backgroundBringUp() }),
    );
  }

  /* The real swapFusionLegs against this state dir, the local model on disk
     and its daemon down — the case that stuck. Every CLI call goes through a
     guard that writes its verb down. `models start` and `models stop` never
     reach the agent: the start is a two-second sleep that answers ok, so no
     llama-server can come up here whatever the code does; and `models status`
     says `running` while the guard's flag file is there. */
  const live = (await configGet()).config as UserConfigShape | undefined;
  const bin = resolveBinary();
  if (!live || !bin) {
    check("T11: a swap does not wait for the daemon, and brings one that is down up behind it", false, !live ? "config not read" : "no agent binary");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "aa-t11-"));
  const log = join(dir, "verbs.log");
  const up = join(dir, "daemon-up");
  const guard = join(dir, "atag-guard.sh");
  const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
  writeFileSync(guard, [
    "#!/bin/sh",
    `case "$1 $2" in`,
    `  "models start") echo "models start begin" >> ${q(log)}; sleep 2; echo "models start end" >> ${q(log)}; exit 0;;`,
    `  "models stop") echo "models stop" >> ${q(log)}; exit 0;;`,
    `  "models status") echo "models status" >> ${q(log)}`,
    `    if [ -f ${q(up)} ]; then printf 'mode:           managed\\ndaemon:         running (pid 1)\\nhealth:         ok\\n'; exit 0; fi;;`,
    `  *) printf '%s %s\\n' "$1" "$2" >> ${q(log)};;`,
    "esac",
    `exec ${q(bin)} "$@"`,
    "",
  ].join("\n"));
  chmodSync(guard, 0o755);
  writeFileSync(log, "");
  const keepBin = process.env.ATOMIC_AGENT_BIN;
  const verbs = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  // Never let the real binary back in while a background start could still reach it.
  const settle = async () => { const bg = backgroundBringUp(); if (bg) await Promise.race([bg, wait(60_000)]); return !backgroundBringUp(); };
  try {
    const staged = clone(live);
    const llm = staged.llm ?? {};
    staged.llm = {
      ...llm,
      activeTextProvider: "aimlapi",
      providers: [...(llm.providers ?? []).filter((p) => p.id !== "aimlapi"), { id: "aimlapi", kind: "aimlapi", defaultChatModel: "x-ai/grok-4-6" }],
      runMode: { ...llm.runMode, mode: "fusion", fusion: { orchestratorProvider: "aimlapi", workerProvider: "local-llama" } },
    };
    const w = await configSetWhole(staged);
    process.env.ATOMIC_AGENT_BIN = guard;

    // 1. The daemon is down.
    const t0 = Date.now();
    const res = await swapFusionLegs();
    const ms = Date.now() - t0;
    const atReturn = verbs();
    const bg = backgroundBringUp();
    // Settings › Models › Start pressed while that start is still running: it waits for it, and starts nothing twice.
    const settings = await js<{ ok: boolean }>("window.atomic.modelsStart()");
    const r = bg ? await bg : null;
    const all = verbs();
    await wait(300);
    const told = await js<string[]>("LOGS.slice(-6).map((l) => l[2])");
    const now = (await configGet()).config as UserConfigShape | undefined;
    check(
      "T11: a swap does not wait for the daemon, and brings one that is down up behind it",
      w.ok && res.ok && res.restart === true && res.runMode?.after === "fusion" && !res.error
        && now?.llm?.activeTextProvider === "local-llama" && now.llm.runMode?.fusion?.orchestratorProvider === "local-llama"
        && now.llm.runMode?.fusion?.workerProvider === "aimlapi"
        // the swap was back before the start it set off had finished
        && !atReturn.includes("models start end")
        && r?.daemon === "started" && ["models list", "models status", "models start begin", "models start end"].every((x) => all.includes(x))
        && told.some((l) => /started the local model daemon \(qwen-3\.5-4b\)/.test(l)),
      `swap ${ms} ms; at return ${JSON.stringify(atReturn)}; background ${JSON.stringify(r)}; all ${JSON.stringify(all)}; window ${JSON.stringify(told.slice(-2))}`,
    );
    check(
      "T11: Settings' Start pressed during that background start waits for it and does not start the daemon twice",
      settings?.ok === true && all.filter((x) => x === "models start begin").length === 1,
      `settings ${JSON.stringify(settings)}; starts ${all.filter((x) => x === "models start begin").length}`,
    );

    // 2. The daemon is up: the swap back starts nothing.
    writeFileSync(up, "");
    writeFileSync(log, "");
    const res2 = await swapFusionLegs();
    const bg2 = backgroundBringUp();
    const r2 = bg2 ? await bg2 : null;
    const all2 = verbs();
    check(
      "T11: with the daemon up, a swap's background check starts nothing",
      res2.ok && r2?.daemon === "untouched" && all2.includes("models status") && !all2.some((x) => /^models (start|stop)/.test(x)),
      `background ${JSON.stringify(r2)}; verbs ${JSON.stringify(all2)}`,
    );
  } catch (err) {
    check("T11: a swap does not wait for the daemon, and brings one that is down up behind it", false, threw(err));
  } finally {
    if (await settle()) {
      if (keepBin === undefined) delete process.env.ATOMIC_AGENT_BIN; else process.env.ATOMIC_AGENT_BIN = keepBin;
      rmSync(dir, { recursive: true, force: true });
    } else {
      check("T11: the background bring-up settled before the guard was taken away", false, "still running after 60 s — the guard stays in place");
      if (existsSync(up)) rmSync(up, { force: true });
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
