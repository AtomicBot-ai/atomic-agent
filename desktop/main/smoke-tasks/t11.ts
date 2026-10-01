/**
 * Release-fix checks for backlog item 11 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=11`.
 *
 * 11 — Fusion's ⇄ while the local model loads. A press during another switch
 * hit the one-switch-at-a-time guard and a toast that faded, and a swap that
 * did get through stuck: it waited on `models status` and, with the daemon
 * down, a whole `models start`. Now the press queues the swap and the seats
 * repaint traded on every press, the queued swap runs once when the switch
 * ahead has landed (and goes with its failure), and a swap of a Fusion in
 * force leaves the daemon alone.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configGet, configSetWhole, type UserConfigShape } from "../agent-cli.js";
import { resolveBinary } from "../agent-client.js";
import { runModeWantsDaemon, swapFusionLegs } from "../backend-switch.js";
import { planEnterFusion, planSwapLegs, resolveRunMode, type RunModeConfig } from "../run-mode.js";

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
 * One renderer scenario on the staged Fusion composer: `body` runs with a
 * switch landing ahead of it (`ahead`, settled by `land(result)`), `press()`
 * is a real click on ⇄ (or `/runmode swap`), `seats()` reads the three chips
 * off the DOM, and every swap that reaches the SWXBR funnel is recorded in
 * `calls` instead of going to main — answered at once, or held until
 * `release(result)` when the body sets `hold = true`. Everything it touches
 * is put back.
 */
const scenario = (body: string) => `(async () => {
  const tick = (ms) => new Promise((res) => setTimeout(res, ms));
  const keep = {cfg: LIVE_CONFIG, queued: FZ.swapQueued, swap: SWXBR.swapFusionLegs, busy: S.busy, err: SWX.err,
    times: Object.assign({}, SWX.times), lastMs: SWX.lastMs};
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
  let land = null;
  try {
    LIVE_CONFIG = ${JSON.stringify(fusion())}; FZ.swapQueued = false; S.busy = false; SWX.err = null;
    SWXBR.swapFusionLegs = () => {
      calls.push({want: SWX.want ? JSON.parse(JSON.stringify(SWX.want)) : null, seats: seats()});
      SWX.route = 'swapFusionLegs';
      return hold ? new Promise((res) => { release = res; }) : Promise.resolve({ok: true});
    };
    render();
    const idle = seats();
    // The switch ahead: the workers control starting the local model.
    const ahead = swxRun('starting qwen-3.5-4b…', {backend: 'fusion'}, () => new Promise((res) => { land = res; }));
    await tick(30);
    const t0 = S.toasts.length;
    ${body}
  } finally {
    FZ.swapQueued = false;
    if (land) land({ok: true});
    if (release) release({ok: true});
    await tick(50);
    SWXBR.swapFusionLegs = keep.swap; LIVE_CONFIG = keep.cfg; FZ.swapQueued = keep.queued; S.busy = keep.busy; SWX.err = keep.err;
    SWX.times = keep.times; SWX.lastMs = keep.lastMs;
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
      const pending = SWX.pending;
      const presses = [press('click'), press('click'), press('slash')];
      const toasts = S.toasts.slice(t0).map((t) => t.t + (t.s ? ' / ' + t.s : ''));
      const callsBefore = calls.length;
      land({ok: true});
      await ahead;
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
    check("T11: ⇄ while the model loads queues the swap", false, `threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const b = await js<{ queued: Seats; calls: number; after: Seats; err: string | null }>(scenario(`
      const queued = press('click');
      land({ok: false, error: 'smoke t11: the model did not load'});
      await ahead;
      await tick(400);
      return {queued, calls: calls.length, after: seats(), err: SWX.err};
    `));
    check(
      "T11: a load that fails takes the queued swap with it — the seats roll back and its failure line stays",
      traded(b.queued) && b.calls === 0 && asIs(b.after) && !b.after.queued && /smoke t11: the model did not load/.test(b.err ?? ""),
      JSON.stringify(b),
    );
  } catch (err) {
    check("T11: a load that fails takes the queued swap with it", false, `threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const c = await js<{ held: { queued: boolean; calls: number }; flushed: { queued: boolean; calls: number } }>(scenario(`
      press('click');
      S.busy = true;   // a turn took the composer while the load was landing
      land({ok: true});
      await ahead;
      await tick(300);
      const held = {queued: FZ.swapQueued, calls: calls.length};
      S.busy = false;
      fzFlushQueuedSwap();   // what the turn's end calls
      await tick(300);
      return {held, flushed: {queued: FZ.swapQueued, calls: calls.length}};
    `));
    check(
      "T11: a queued swap waits out a turn that holds the composer, then runs once",
      c.held.queued && c.held.calls === 0 && !c.flushed.queued && c.flushed.calls === 1,
      JSON.stringify(c),
    );
  } catch (err) {
    check("T11: a queued swap waits out a turn", false, `threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  /* swxSettle re-reads the config BEFORE swxRun's `finally` drops the want,
     and then waits up to 3 s for the coding mode: the swap's paint has to
     hold over a file that already has the traded seats, not trade it back. */
  const landedFile = fusion();
  planSwapLegs(landedFile, () => true);
  try {
    const e = await js<{ pressed: Seats; inFlight: Seats; reRead: Seats; done: Seats; calls: number; pending: number }>(scenario(`
      land({ok: true});
      await ahead;
      await tick(50);
      hold = true;
      const pressed = press('click');   // nothing landing now: the swap goes at once
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
    check("T11: a swap in flight paints the traded seats", false, `threw: ${err instanceof Error ? err.message : String(err)}`);
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
    swapLooks: runModeWantsDaemon(after, swapped.localModels ?? {}, v),
    // the same landing judged without the verdict is what the write used to do
    sameLandingWithoutVerdict: runModeWantsDaemon(after, swapped.localModels ?? {}),
    enterLooks: runModeWantsDaemon(resolveRunMode(entering), entering.localModels ?? {}, ve),
    handSwitched: { seatsOnly: vh.seatsOnly, looks: runModeWantsDaemon(resolveRunMode(handSwitched), handSwitched.localModels ?? {}, vh) },
  };
  check(
    "T11: a swap of a Fusion in force is seats-only and does not look at the daemon; entering Fusion still does",
    v.write && d.seatsOnly === true && d.swapLooks === false && d.sameLandingWithoutVerdict === true
      && after.orchestratorProviderId === "local-llama" && after.workerProviderId === "aimlapi"
      && d.enterLooks === true && d.handSwitched.seatsOnly === false && d.handSwitched.looks === true,
    JSON.stringify(d),
  );

  /* The real swapFusionLegs against this state dir, the local model on disk
     and its daemon down — the case that stuck. Every CLI call goes through a
     guard that writes its verb down and refuses `models start` and
     `models stop`, so no llama-server can come up here whatever the code does. */
  const live = (await configGet()).config as UserConfigShape | undefined;
  const bin = resolveBinary();
  if (!live || !bin) {
    check("T11: a swap writes the traded seats and leaves the local daemon alone", false, !live ? "config not read" : "no agent binary");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "aa-t11-"));
  const log = join(dir, "verbs.log");
  const guard = join(dir, "atag-guard.sh");
  const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
  writeFileSync(guard, [
    "#!/bin/sh",
    `printf '%s %s\\n' "$1" "$2" >> ${q(log)}`,
    `case "$1 $2" in "models start"|"models stop") echo "t11 guard: $1 $2 refused" >&2; exit 3;; esac`,
    `exec ${q(bin)} "$@"`,
    "",
  ].join("\n"));
  chmodSync(guard, 0o755);
  writeFileSync(log, "");
  const keepBin = process.env.ATOMIC_AGENT_BIN;
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
    const t0 = Date.now();
    const res = await swapFusionLegs();
    const ms = Date.now() - t0;
    if (keepBin === undefined) delete process.env.ATOMIC_AGENT_BIN; else process.env.ATOMIC_AGENT_BIN = keepBin;
    const verbs = readFileSync(log, "utf8").split("\n").filter(Boolean);
    const models = verbs.filter((x) => /^models /.test(x));
    const now = (await configGet()).config as UserConfigShape | undefined;
    // `verbs` is every CLI call in that window; on a quiet window it is the swap's alone.
    check(
      "T11: a swap writes the traded seats and leaves the local daemon alone — daemon untouched, no models start",
      w.ok && res.ok && res.daemon === "untouched" && !res.error && res.restart === true && res.runMode?.after === "fusion"
        && now?.llm?.activeTextProvider === "local-llama" && now.llm.runMode?.fusion?.orchestratorProvider === "local-llama"
        && now.llm.runMode?.fusion?.workerProvider === "aimlapi"
        && !models.some((x) => /^models (start|stop)$/.test(x)),
      `${ms} ms; daemon ${res.daemon ?? "-"}; error ${res.error ?? "none"}; verbs ${JSON.stringify(verbs)}`,
    );
  } catch (err) {
    check("T11: a swap writes the traded seats and leaves the local daemon alone", false, `threw: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (keepBin === undefined) delete process.env.ATOMIC_AGENT_BIN; else process.env.ATOMIC_AGENT_BIN = keepBin;
    await configSetWhole(live);
    rmSync(dir, { recursive: true, force: true });
  }
}
