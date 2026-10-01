import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserWindow } from "electron";

import type { ProjectorStatusAnswer, SmokeDownloads } from "../release-fixes-smoke.js";

/**
 * Backlog 18, the rare cases deferred from its reviews — a Hugging Face vision
 * model's projector among the other downloads (see main/release-fixes-smoke.ts;
 * t18.ts holds the item's own checks). Run with `--smoke --smoke-task=18`.
 *
 *   D1 (F8) — the projector and a retried llama.cpp runtime ran at once: main's
 *        projector guard ignored `models update`, × on either row stopped only
 *        the projector, and the model could start while the binary was being
 *        replaced. The embedding pull's guard ignored the projector the same
 *        way, and Settings' own `models update` took no slot at all. Held
 *        behind that runtime, a vision model must also lose its start with it,
 *        as a text model does (R4).
 *   D2 — a runtime Retry after the projector failed started the model text-only.
 *   D3 — dismissing a failed projector row kept the resume reminder, so the
 *        next launch fetched the projector again.
 *   D4 — a window reopened over a projector main still runs was refused
 *        instead of following it, as it follows the weights and the runtime.
 *   D5 — the projector-only resume never checked that llama.cpp is installed.
 *   D6 — an early projector Cancel waited for `models status` to return.
 *   D7 — the composer's chip knew the queue alone: while the projector came
 *        down or waited its turn it offered "Set up a model", whose Download
 *        then refused, and behind the llama.cpp runtime it said "Downloading
 *        your model".
 *   D8 — the same chip during the composer picker's or Settings › Models'
 *        download of a chat model: "Set up a model" on the setup slot, nothing
 *        or "Download a model" on the managed route's model slot.
 *
 * Nothing is downloaded and nothing restarts. Main runs this whole file offline
 * (smokeDownloads.offline): every download handler refuses before it spawns or
 * fetches anything, whatever a check asks of it. In the renderer the queue runs
 * as itself but never spawns (dlNext always dry, and dlSpawn a recorder
 * besides), and `models status`, the projector call (obProjectorPull) and the
 * model start are recorders; a landing logs the stamp it owed (OB.testClose).
 * In main a stand-in holds a download slot with no child behind it, and the
 * projector's `models status` read is stood in, so the projector calls that do
 * reach main read no data dir, or one where their file already is. An
 * embedding pull is asked for under an id agent-cli's own id check refuses
 * before any spawn. Everything touched is put back.
 *
 * T18E_SHOTS=<dir> also writes the card with a projector waiting behind the
 * llama.cpp runtime at 1280×820, light and dark, for the product owner.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Row = { name: string; line: string; cancel: string | null; retry: boolean };
type Card = { title: string; rows: Row[] } | null;
type Jobs = { job: string | null; queue: string[]; projector: string | null; failed: string[] };
type Answer = { ok?: boolean; error?: string; running?: { kind?: string; id?: string } | null; alreadyPresent?: boolean } | string | null;
type Marker = { id?: string; weightsLanded?: boolean; fails?: number } | null;
type Seen = Jobs & { calls: string[]; card: Card; marker?: Marker; landed?: string | null; held?: string | null };
type Chip = Jobs & { route: string; needsSetup: boolean; text: string; tag: string | null; slot: string | null; pull: boolean;
  act: string | null; opened: number; waiting?: string[]; preparing?: string | null; calls?: string[] };

const ID = "custom-smoke-t18e-vl";
const FILE = "mmproj-smoke-t18e.gguf";
const URL = `https://huggingface.co/smoke/t18e/resolve/main/${FILE}`;
const FILE2 = "mmproj-smoke-t18e-other.gguf";
const URL2 = `https://huggingface.co/smoke/t18e/resolve/main/${FILE2}`;
const NAME = "Smoke T18e VL";
const PROJ = `projector:${ID}`;
const START = `activate:${ID}`;
const BUSY = "a download is already running";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** `p`, or a rejection after `ms`: a regression that leaves a call unanswered fails, and the cleanup after it still runs. */
function within<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, late]).finally(() => { if (timer) clearTimeout(timer); });
}

/* Shared by every probe below. Its state lives on window.__t18e so a scenario
   can span two `js` calls (D4, D6: main is answered in between); restore() ends it. */
const HELPERS = String.raw`
  const tick = (ms) => new Promise((res) => setTimeout(res, ms));
  const txt = (n) => (n ? (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const card = () => {
    const el = document.getElementById('dlcard');
    if (!el || el.hidden || !el.firstElementChild) return null;
    return {title: txt(el.querySelector('.dlc-ttl > span')),
      rows: [...el.querySelectorAll('.dlc-row')].map((r) => ({name: txt(r.querySelector('.dlc-name')),
        line: txt(r.querySelector('.dlc-line')), cancel: (r.querySelector('.dlc-x') || {dataset: {}}).dataset.act || null,
        retry: !!r.querySelector('.dlc-retry')}))};
  };
  // A first run's route: managed local with no model chosen yet — where a landed model starts by itself.
  const firstRunRoute = (cfg) => {
    const lm = Object.assign({}, (cfg && cfg.localModels) || {}, {mode: 'managed'});
    lm.managed = Object.assign({}, lm.managed || {}, {modelId: null});
    return Object.assign({}, cfg || {}, {localModels: lm});
  };
  const ID = '${ID}', FILE = '${FILE}', NAME = '${NAME}';
  const MM = {id: ID, mmprojUrl: '${URL}', mmprojFilename: FILE, name: NAME};
  const PROJ = '${PROJ}', START = '${START}';
  const KEY = 'atag.setupDownload';
  const T = window.__t18e || (window.__t18e = {calls: [], held: [], spawns: [], opened: 0, statusText: 'backend: binary ok',
    keep: {status: window.obBackendStatusText, activate: window.obActivateLocal, pull: window.obProjectorPull,
      next: window.dlNext, spawn: window.dlSpawn, open: window.openOnboarding, refresh: window.refreshLiveConfig,
      snap: window.bswSnapshot, cfg: LIVE_CONFIG, dry: DL.dry, models: OB.models, testClose: OB.testClose,
      log: OB_STAMP_LOG.slice(), room: S.room, toasts: S.toasts.slice(), marker: localStorage.getItem(KEY),
      ext: {url: EXT.url, model: EXT.model}, sel: SEL.pulling, selLine: SEL.pullLine, selLocal: SEL.local,
      localLoaded: BSW.localLoaded, llm: LLMP.pulling, llmLog: LLMP.pullLog}});
  const calls = T.calls, held = T.held, keep = T.keep;
  const marker = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return 'unreadable'; } };
  // The setup download's reminder, as the hand-over writes it for a vision pick.
  const remember = (extra) => localStorage.setItem(KEY, JSON.stringify(Object.assign(
    {id: ID, stateDir: (FIRSTRUN && FIRSTRUN.stateDir) || null, at: Date.now(), mmproj: MM}, extra || {})));
  const jobs = () => ({job: DL.job ? DL.job.kind + ':' + DL.job.id + (DL.job.cancelled ? ':cancelled' : '') : null,
    queue: DL.queue.map((q) => q.kind + ':' + q.id), projector: DL.projector ? DL.projector.id : null,
    failed: DL.failed.map((f) => f.kind + ':' + f.id)});
  const seen = (more) => Object.assign({calls: calls.slice(), card: card()}, jobs(), more || {});
  // How the projector call that is out ends; false when none is out.
  const answer = (res) => { const r = held.shift(); if (r) r(res); return !!r; };
  const feed = (ev) => window.__dlFeed(ev);
  const runtimeEnds = (ok) => feed(ok
    ? {id: 'llama.cpp', kind: 'runtime', done: true, ok: true, sawProgress: true, upToDate: false}
    : {id: 'llama.cpp', kind: 'runtime', done: true, ok: false, error: 'smoke t18e: models update exited with code 1', sawProgress: false, upToDate: false});
  // A control in the card's row that has this name.
  const pressIn = async (name, sel) => {
    const row = [...document.querySelectorAll('#dlcard .dlc-row')].find((r) => txt(r.querySelector('.dlc-name')) === name);
    const n = row ? row.querySelector(sel) : null;
    if (n) n.click();
    await tick(80);
    return n ? (n.dataset.act || true) : null;
  };
  // The chip where the route's controls go (D7, D8): the setup slot, or the model slot. Read at once.
  const peek = () => {
    const foot = document.querySelector('#composer .cfoot');
    const el = foot ? foot.querySelector('.pullchip') || foot.querySelector('.setupchip') || foot.querySelector('.modelchip') : null;
    return Object.assign({route: selBackend(), needsSetup: composerNeedsSetup(), text: txt(el), tag: el ? el.tagName : null,
      slot: !el ? null : el.classList.contains('modelchip') ? 'model' : el.classList.contains('setupchip') ? 'setup' : 'other',
      pull: !!el && el.classList.contains('pullchip'), act: el ? el.getAttribute('data-act') : null, opened: 0}, jobs());
  };
  // The same, and with click: what a click on it opens (setup is a recorder here).
  const chip = async (click) => {
    const out = peek();
    const el = click ? document.querySelector('#composer .cfoot .pullchip, #composer .cfoot .setupchip') : null;
    if (el) {
      const was = T.opened;
      el.click();
      await tick(60);
      out.opened = T.opened - was;
    }
    return out;
  };
  // The setup slot: the agent's default route, its server read already with nothing answering, so the poller does not ask again.
  const onSetupRoute = () => {
    const lm = Object.assign({}, (keep.cfg && keep.cfg.localModels) || {}, {mode: 'external', url: DEFAULT_LLAMA_URL});
    LIVE_CONFIG = Object.assign({}, keep.cfg || {}, {localModels: lm});
    EXT.url = DEFAULT_LLAMA_URL; EXT.model = null;
    render();
  };
  const stage = () => {
    window.__dlClear();
    try { localStorage.removeItem(KEY); } catch (e) { /* no storage */ }
    calls.length = 0; held.length = 0; T.spawns.length = 0; T.opened = 0; T.statusText = 'backend: binary ok';
    S.room = 'chat'; S.toasts = [];
    // No other download runs: the composer picker's and Settings' slots are empty.
    SEL.pulling = null; LLMP.pulling = null;
    window.obBackendStatusText = () => { calls.push('status'); return Promise.resolve(T.statusText); };
    window.obActivateLocal = async (id) => { calls.push('activate:' + id); };
    window.obProjectorPull = (p) => { calls.push('projector:' + p.id); return new Promise((res) => held.push(res)); };
    window.openOnboarding = function () { T.opened++; };
    window.refreshLiveConfig = () => Promise.resolve();
    window.bswSnapshot = () => Promise.resolve();
    // The queue runs as itself, but nothing it starts is spawned: dlNext stays dry, and its one call to main is a recorder.
    window.dlNext = function () { const d = DL.dry; DL.dry = true; try { return keep.next.apply(this, arguments); } finally { DL.dry = d; } };
    window.dlSpawn = (job) => { T.spawns.push(job.kind + ':' + job.id); return Promise.resolve({ok: true, started: true}); };
    LIVE_CONFIG = firstRunRoute(keep.cfg);
    OB.models = [{id: ID, name: NAME + ' GGUF'}];
    OB.pendingMmproj = null;
    OB.testClose = true;
    OB_STAMP_LOG.length = 0;
    DL.dry = false;
    render();
  };
  // Everything back; a step that throws still lets the next ones run.
  const restore = () => {
    held.length = 0;
    try {
      window.obBackendStatusText = keep.status; window.obActivateLocal = keep.activate; window.openOnboarding = keep.open;
      if (keep.pull) window.obProjectorPull = keep.pull; else delete window.obProjectorPull;
      if (keep.spawn) window.dlSpawn = keep.spawn;
      window.dlNext = keep.next; window.refreshLiveConfig = keep.refresh; window.bswSnapshot = keep.snap;
      LIVE_CONFIG = keep.cfg; OB.models = keep.models; OB.testClose = keep.testClose; OB.pendingMmproj = null;
      OB_STAMP_LOG.length = 0; keep.log.forEach((e) => OB_STAMP_LOG.push(e));
      S.room = keep.room; S.toasts = keep.toasts;
      EXT.url = keep.ext.url; EXT.model = keep.ext.model;
      SEL.pulling = keep.sel; SEL.pullLine = keep.selLine; SEL.local = keep.selLocal; BSW.localLoaded = keep.localLoaded;
      LLMP.pulling = keep.llm; LLMP.pullLog = keep.llmLog;
      try { window.__dlClear(); } catch (e) { /* the rest is put back all the same */ }
      DL.dry = keep.dry;
      try { if (keep.marker !== null) localStorage.setItem(KEY, keep.marker); else localStorage.removeItem(KEY); } catch (e) { /* no storage */ }
      try { render(); } catch (e) { /* the next render paints it */ }
    } finally {
      delete window.__t18e;
    }
  };
  // A quit and a relaunch: the download in memory is gone, the reminder is what the quit left, and the boot gate runs.
  const relaunch = async () => {
    const saved = localStorage.getItem(KEY);
    window.__dlClear();
    if (saved !== null) localStorage.setItem(KEY, saved); else localStorage.removeItem(KEY);
    held.length = 0; calls.length = 0; T.opened = 0;
    DL.dry = false;
    /* The gate reads the config through the real CLI first ('atag config get'),
       and on a loaded Mac that read can fail: then it resumes nothing, as a real
       launch would not either. With a reminder to resume, it is read again —
       up to three launches — rather than calling that a failure of the resume. */
    const moved = () => !!(DL.job || DL.projector || DL.preparing || DL.failed.length || calls.length);
    for (let tries = 0; tries < 3; tries++) {
      await obBootGate(FIRSTRUN);
      if (moved() || localStorage.getItem(KEY) === null) break;
    }
    for (let i = 0; i < 60 && !DL.job && !DL.projector && !calls.includes(PROJ); i++) await tick(50);
    await tick(100);
  };
  const stamped = () => OB_STAMP_LOG.filter((e) => e.step === 'landed').length;
`;

export async function checks18e(js: Js, check: Check, main: SmokeDownloads): Promise<void> {
  // Each scenario on its own: one that throws is one FAIL, and the next still runs.
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      check(`T18 ${name}: its checks ran to the end`, false, err instanceof Error ? err.message : String(err));
      await restore(js);
    }
  };
  const online = main.offline();
  try {
    await step("D1 (F8) main", () => mainGuards(js, check, main));
    await step("D1 (F8)", () => projectorBehindRuntime(js, check));
    await step("D1 (F8)", () => runtimeRefused(js, check));
    await step("D1 (F8)", () => startStaysGone(js, check));
    await step("D1 (F8) Settings", () => settingsUpdateRefused(js, check, main));
    await step("D2", () => runtimeRetryAfterProjector(js, check));
    await step("D2", () => runtimeRetryAfterLanding(js, check));
    await step("D3", () => dismissFailedProjector(js, check));
    await step("D4", () => reopenOverProjector(js, check, main));
    await step("D5", () => resumeChecksRuntime(js, check));
    await step("D6", () => earlyProjectorCancel(js, check, main));
    await step("D7", () => chipFollowsProjector(js, check));
    await step("D8", () => chipFollowsOtherPulls(js, check));
    if (process.env["T18E_SHOTS"]) await shots(js, process.env["T18E_SHOTS"]);
  } finally {
    online();
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const lines = (c: Card | undefined) => (c ? c.rows.map((r) => `${r.name} | ${r.line}`) : null);
const refusedFor = (a: Answer, kind: string, id: string) =>
  !!a && typeof a === "object" && a.ok === false && a.error === BUSY && a.running?.kind === kind && a.running?.id === id;

/* D1 (F8), main: every download handler refuses while any other download runs,
   and names it. Nothing runs behind the stand-ins, and main is offline: a call
   that got through would be refused there instead, or, for the projector, read
   the stood-in status, find no data dir and fetch nothing. */
async function mainGuards(js: Js, check: Check, main: SmokeDownloads): Promise<void> {
  const undoStatus = main.projectorStatus(async () => ({ ok: false, error: "smoke t18e: models status stood in" }));
  const releaseRuntime = main.hold("runtime", "llama.cpp");
  let projector: Answer = null;
  try {
    projector = await within(10_000, "the projector call", js<Answer>(
      `window.atomic.hfProjector(${JSON.stringify(ID)}, ${JSON.stringify(URL)}, ${JSON.stringify(FILE)}, ${JSON.stringify(NAME)})`));
  } finally {
    releaseRuntime();
    undoStatus();
  }
  check(
    "T18 D1 (F8): with the llama.cpp runtime downloading, main refuses a vision projector and names the runtime — the two never run at once",
    refusedFor(projector, "runtime", "llama.cpp"),
    JSON.stringify(projector),
  );
  const releaseProjector = main.hold("projector", "custom-smoke-t18e-held");
  let embedding: Answer = null;
  let update: Answer = null;
  try {
    embedding = await within(10_000, "the embedding pull", js<Answer>("window.atomic.modelsPullEmbedding('smoke t18e: not a model id')"));
    update = await within(10_000, "Settings' models update", js<Answer>("window.atomic.modelsUpdate()"));
  } finally {
    releaseProjector();
  }
  check(
    "T18 D1 (F8): with a vision projector downloading, main refuses an embedding pull and names the projector — a Cancel in Settings cannot stop the projector instead",
    refusedFor(embedding, "projector", "custom-smoke-t18e-held"),
    JSON.stringify(embedding),
  );
  check(
    "T18 D1 (F8): with a vision projector downloading, main refuses Settings' llama.cpp update too and names the projector — the binary is not replaced under a download",
    refusedFor(update, "projector", "custom-smoke-t18e-held"),
    JSON.stringify(update),
  );
}

/* D1 (F8), renderer: the vision model's weights download with a failed
   llama.cpp runtime retried behind them (a run of its own). The weights land
   with the runtime next in the queue. */
async function projectorBehindRuntime(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const out = {};
    const begin = async () => {
      stage();
      remember();
      window.__dlSeed([{kind: 'weights', id: ID}]);
      DL.dry = false;
      dlFail({kind: 'runtime', id: 'llama.cpp'}, 'smoke t18e: the runtime download failed earlier');
      render(); await tick(60);
      const retried = await pressIn('llama.cpp runtime', '.dlc-retry');
      feed({id: ID, done: true, ok: true});
      await tick(120);
      return retried;
    };
    try {
      // (a) The runtime lands, then the projector.
      out.retried = await begin();
      out.landed = seen({marker: marker()});
      runtimeEnds(true);
      await tick(120);
      out.runtimeLanded = seen();
      out.answered = answer({ok: true, path: '/smoke/t18e/' + FILE});
      await tick(150);
      out.done = seen({marker: marker(), stamped: stamped()});

      // (b) The runtime's × while the projector waits behind it.
      await begin();
      out.cancelAct = await pressIn('llama.cpp runtime', '.dlc-x');
      out.cancelled = seen();
      // The killed child exits non-zero: a cancel, not a failure.
      feed({id: 'llama.cpp', kind: 'runtime', done: true, ok: false, error: 'models update exited with code null', sawProgress: false, upToDate: false});
      await tick(120);
      out.afterExit = seen();
      out.cancelAnswered = answer({ok: true, path: '/smoke/t18e/' + FILE});
      await tick(150);
      out.cancelLanded = seen({marker: marker(), landed: DL.landed, stamped: stamped()});

      // (c) The waiting projector's own ×.
      await begin();
      out.dropAct = await pressIn(NAME, '.dlc-x');
      out.dropped = seen({marker: marker()});
      runtimeEnds(true);
      await tick(120);
      out.afterDrop = seen();

      // (d) The runtime fails instead; then it is retried, and lands.
      await begin();
      runtimeEnds(false);
      await tick(120);
      out.failedRuntime = seen();
      out.failAnswered = answer({ok: true, path: '/smoke/t18e/' + FILE});
      await tick(150);
      out.failLanded = seen({marker: marker()});
      out.retryAct = await pressIn('llama.cpp runtime', '.dlc-retry');
      out.retriedHeld = DL.activateAfter;
      runtimeEnds(true);
      await tick(150);
      out.failRetried = seen({marker: marker()});
      return out;
    } finally {
      restore();
    }
  })()`);
  const landed = r["landed"] as Seen, rl = r["runtimeLanded"] as Seen, done = r["done"] as Seen & { stamped: number };
  check(
    "T18 D1 (F8): a vision model whose weights land with a retried llama.cpp runtime next waits for it — its projector is a queued row, not a second download",
    typeof r["retried"] === "string" && /^dlc:retry:/.test(r["retried"] as string)
      && landed.calls.length === 0 && landed.job === "runtime:llama.cpp" && landed.projector === null
      && same(lines(landed.card), ["llama.cpp runtime | Starting…", `${NAME} | Vision projector · Queued`])
      && landed.card?.rows[1]?.cancel === `dlc:drop:projector:${ID}` && landed.marker?.weightsLanded === true,
    JSON.stringify({ retried: r["retried"], landed }),
  );
  check(
    "T18 D1 (F8): only once the runtime is in does the projector come down, and only after it lands does the model start — once",
    landed.calls.length === 0 && same(rl.calls, [PROJ]) && rl.projector === ID && rl.job === null
      && same(lines(rl.card), [`${NAME} | Vision projector · Starting…`])
      && r["answered"] === true && same(done.calls, [PROJ, START]) && done.card === null && done.marker === null && done.stamped === 1,
    JSON.stringify({ runtimeLanded: rl, done }),
  );
  const cancelled = r["cancelled"] as Seen, afterExit = r["afterExit"] as Seen;
  const cancelLanded = r["cancelLanded"] as Seen & { stamped: number };
  check(
    "T18 D1 (F8): the runtime's × stops only the runtime — the projector waiting behind it stays, and comes down once the runtime has exited",
    r["cancelAct"] === "dlc:cancel" && cancelled.job === "runtime:llama.cpp:cancelled" && cancelled.calls.length === 0
      && same(lines(cancelled.card), ["llama.cpp runtime | Cancelling…", `${NAME} | Vision projector · Queued`])
      && same(afterExit.calls, [PROJ]) && afterExit.projector === ID && afterExit.job === null && afterExit.failed.length === 0,
    JSON.stringify({ act: r["cancelAct"], cancelled, afterExit }),
  );
  check(
    "T18 D1 (F8): with the runtime it waited for cancelled, the landed projector does not start the model — as a text model's start goes with its runtime — and the reminder stays for the next launch",
    r["cancelAnswered"] === true && same(cancelLanded.calls, [PROJ]) && cancelLanded.card === null && cancelLanded.stamped === 0
      && cancelLanded.marker?.id === ID && cancelLanded.marker?.weightsLanded === true,
    JSON.stringify(cancelLanded),
  );
  const dropped = r["dropped"] as Seen, afterDrop = r["afterDrop"] as Seen;
  check(
    "T18 D1 (F8): the waiting projector's × takes it off and forgets the resume reminder — nothing comes down or starts when the runtime lands",
    r["dropAct"] === `dlc:drop:projector:${ID}` && same(lines(dropped.card), ["llama.cpp runtime | Starting…"])
      && dropped.marker === null && dropped.calls.length === 0
      && afterDrop.calls.length === 0 && afterDrop.projector === null && afterDrop.card === null,
    JSON.stringify({ act: r["dropAct"], dropped, afterDrop }),
  );
  const failedRuntime = r["failedRuntime"] as Seen, failLanded = r["failLanded"] as Seen, failRetried = r["failRetried"] as Seen;
  check(
    "T18 D1 (F8): with that runtime failed the landed projector starts nothing either; a Retry on the runtime then starts the model once it lands",
    same(failedRuntime.calls, [PROJ]) && same(failedRuntime.failed, ["runtime:llama.cpp"])
      && r["failAnswered"] === true && same(failLanded.calls, [PROJ]) && failLanded.marker?.id === ID
      && same(lines(failLanded.card), ["llama.cpp runtime | Failed · smoke t18e: models update exited with code 1"])
      && typeof r["retryAct"] === "string" && r["retriedHeld"] === ID
      && same(failRetried.calls, [PROJ, START]) && failRetried.card === null && failRetried.marker === null,
    JSON.stringify({ failedRuntime, failLanded, retry: r["retryAct"], held: r["retriedHeld"], failRetried }),
  );
}

/* D1 (F8): the retried runtime does not even start — main refuses it, another
   download having got there first. That runtime did not land either, so what
   was held for it goes, as for a cancelled or a failed one: a vision model's
   start, and a text model's (R4). This time the queue asks main for its jobs,
   through the dlSpawn recorder, which refuses the runtime. */
async function runtimeRefused(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const out = {};
    let refuse = true;
    const asking = () => {
      window.dlNext = keep.next;
      window.dlSpawn = (job) => {
        T.spawns.push(job.kind + ':' + job.id);
        return Promise.resolve(job.kind === 'runtime' && refuse
          ? {ok: false, error: 'a download is already running', running: {kind: 'weights', id: 'smoke-t18e-other', last: null}}
          : {ok: true, started: true});
      };
    };
    try {
      // The vision model.
      stage(); asking(); refuse = true;
      remember();
      window.__dlSeed([{kind: 'weights', id: ID}]);
      DL.dry = false;
      dlFail({kind: 'runtime', id: 'llama.cpp'}, 'smoke t18e: the runtime download failed earlier');
      render(); await tick(60);
      out.retried = await pressIn('llama.cpp runtime', '.dlc-retry');
      feed({id: ID, done: true, ok: true});
      await tick(150);
      out.refused = seen({spawns: T.spawns.slice()});
      out.answered = answer({ok: true, path: '/smoke/t18e/' + FILE});
      await tick(150);
      out.landed = seen({marker: marker(), landed: DL.landed});
      // Main is free again: Retry on the runtime, which lands.
      refuse = false;
      out.retryAct = await pressIn('llama.cpp runtime', '.dlc-retry');
      out.held = DL.activateAfter;
      runtimeEnds(true);
      await tick(150);
      out.done = seen({marker: marker()});

      // A text model, held for the same refused runtime; later an unrelated runtime lands.
      stage(); asking(); refuse = true;
      window.__dlSeed([{kind: 'weights', id: 'smoke-t18e-text'}]);
      DL.dry = false;
      dlFail({kind: 'runtime', id: 'llama.cpp'}, 'smoke t18e: the runtime download failed earlier');
      render(); await tick(60);
      await pressIn('llama.cpp runtime', '.dlc-retry');
      feed({id: 'smoke-t18e-text', done: true, ok: true});
      await tick(150);
      out.textRefused = seen({held: DL.activateAfter});
      DL.job = {kind: 'runtime', id: 'llama.cpp', percent: 0, transferredBytes: 0, totalBytes: 0, sawProgress: false};
      runtimeEnds(true);
      await tick(150);
      out.textLater = seen();
      return out;
    } finally {
      restore();
    }
  })()`);
  const refused = r["refused"] as Seen & { spawns: string[] }, landed = r["landed"] as Seen, done = r["done"] as Seen;
  check(
    "T18 D1 (F8): a retried runtime that main refuses to start takes the vision model's held start with it — the projector lands and starts nothing; once a Retry brings the runtime in, the model starts",
    typeof r["retried"] === "string" && same(refused.spawns, ["runtime:llama.cpp"]) && same(refused.failed, ["runtime:llama.cpp"])
      && same(refused.calls, [PROJ]) && refused.projector === ID
      && r["answered"] === true && same(landed.calls, [PROJ]) && landed.landed === ID && landed.marker?.id === ID
      && typeof r["retryAct"] === "string" && r["held"] === ID
      && same(done.calls, [PROJ, START]) && done.card === null && done.marker === null,
    JSON.stringify({ retried: r["retried"], refused, landed, retry: r["retryAct"], held: r["held"], done }),
  );
  const textRefused = r["textRefused"] as Seen, textLater = r["textLater"] as Seen;
  check(
    "T18 D1 (F8): a text model's start held for that refused runtime goes with it too (R4) — a later, unrelated runtime landing starts nothing",
    textRefused.held === null && same(textRefused.failed, ["runtime:llama.cpp"]) && textRefused.calls.length === 0
      && textLater.calls.length === 0,
    JSON.stringify({ textRefused, textLater }),
  );
}

/* D1 (F8), the other ways a runtime does not land, and what comes after: the
   projector that came down without its start fails and is retried from its
   row; the runtime's child exits 0 just as its Cancel comes in; and a runtime
   still queued behind another model's download is taken off the card. */
async function startStaysGone(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const out = {};
    const begin = async () => {
      stage();
      remember();
      window.__dlSeed([{kind: 'weights', id: ID}]);
      DL.dry = false;
      dlFail({kind: 'runtime', id: 'llama.cpp'}, 'smoke t18e: the runtime download failed earlier');
      render(); await tick(60);
      await pressIn('llama.cpp runtime', '.dlc-retry');
      feed({id: ID, done: true, ok: true});
      await tick(120);
    };
    try {
      // (e) Cancelled runtime; the projector then fails, and is retried from its row.
      await begin();
      await pressIn('llama.cpp runtime', '.dlc-x');
      feed({id: 'llama.cpp', kind: 'runtime', done: true, ok: false, error: 'models update exited with code null', sawProgress: false, upToDate: false});
      await tick(120);
      out.eAnswered = answer({ok: false, error: 'smoke t18e: the connection was reset'});
      await tick(150);
      out.eFailed = seen({marker: marker()});
      out.eRetry = await pressIn(NAME, '.dlc-retry');
      await tick(60);
      out.eAnswered2 = answer({ok: true, path: '/smoke/t18e/' + FILE});
      await tick(150);
      out.eLanded = seen({marker: marker(), landed: DL.landed});

      // (f) The runtime's child exits 0 as its Cancel comes in.
      await begin();
      await pressIn('llama.cpp runtime', '.dlc-x');
      runtimeEnds(true);
      await tick(120);
      out.fAnswered = answer({ok: true, path: '/smoke/t18e/' + FILE});
      await tick(150);
      out.fLanded = seen({marker: marker()});

      // (g) A runtime queued behind another model's download is taken off; the vision model waited on it.
      stage();
      remember();
      OB.models = OB.models.concat([{id: 'smoke-t18e-y', name: 'Smoke T18e Y'}]);
      window.__dlSeed([{kind: 'weights', id: ID}]);
      DL.dry = false;
      DL.queue.push({kind: 'weights', id: 'smoke-t18e-y', run: DL.runSeq + 100});
      DL.queue.push({kind: 'runtime', id: 'llama.cpp', run: DL.runSeq + 101});
      render(); await tick(60);
      feed({id: ID, done: true, ok: true});
      await tick(120);
      out.gParked = seen();
      out.gDrop = await pressIn('llama.cpp runtime', '.dlc-x');
      feed({id: 'smoke-t18e-y', done: true, ok: true});
      await tick(150);
      out.gAnswered = answer({ok: true, path: '/smoke/t18e/' + FILE});
      await tick(150);
      out.gLanded = seen({marker: marker()});
      return out;
    } finally {
      restore();
    }
  })()`);
  const eFailed = r["eFailed"] as Seen, eLanded = r["eLanded"] as Seen;
  check(
    "T18 D1 (F8): a vision model's start gone with its cancelled runtime stays gone when its projector fails and is retried from its row — no start without llama.cpp, the reminder kept",
    r["eAnswered"] === true && same(eFailed.failed, [`projector:${ID}`]) && eFailed.marker?.id === ID
      && typeof r["eRetry"] === "string" && /^dlc:retry:/.test(r["eRetry"] as string) && r["eAnswered2"] === true
      && same(eLanded.calls, [PROJ, PROJ]) && eLanded.card === null && eLanded.landed === ID && eLanded.marker?.id === ID,
    JSON.stringify({ eFailed, retry: r["eRetry"], eLanded }),
  );
  const fLanded = r["fLanded"] as Seen;
  check(
    "T18 D1 (F8): a runtime cancelled as its child exits 0 counts as cancelled — the held vision model is not started when its projector lands, as a text model's hold is dropped",
    r["fAnswered"] === true && same(fLanded.calls, [PROJ]) && fLanded.card === null && fLanded.marker?.id === ID,
    JSON.stringify(fLanded),
  );
  const gParked = r["gParked"] as Seen, gLanded = r["gLanded"] as Seen;
  check(
    "T18 D1 (F8): a queued runtime taken off the card takes the held vision model's start with it — its projector lands and starts nothing, while the model in front starts as it lands",
    gParked.job === "weights:smoke-t18e-y" && same(gParked.queue, ["runtime:llama.cpp"])
      && same(lines(gParked.card), ["Smoke T18e Y | Starting…", "llama.cpp runtime | Queued", `${NAME} | Vision projector · Queued`])
      && r["gDrop"] === "dlc:drop:runtime:llama.cpp" && r["gAnswered"] === true
      && same(gLanded.calls, [PROJ, "activate:smoke-t18e-y"]) && gLanded.card === null && gLanded.marker?.id === ID,
    JSON.stringify({ gParked, drop: r["gDrop"], gLanded }),
  );
}

/* D1 (F8), Settings: B (the llama.cpp update) while a download runs is refused
   by main. Settings says so where it stays, and not "updating…" for good. */
async function settingsUpdateRefused(js: Js, check: Check, main: SmokeDownloads): Promise<void> {
  const probe = String.raw`(async () => {
    const keep = {msg: LLMP.msg, err: LLMP.statusErr, busy: LLMP.busy, refresh: window.llmRefresh};
    try {
      LLMP.busy = false; LLMP.msg = null; LLMP.statusErr = null;
      window.llmRefresh = () => Promise.resolve();
      await llmBackendUpdate();
      return {msg: LLMP.msg ? LLMP.msg.text : null, busy: LLMP.busy};
    } finally {
      LLMP.msg = keep.msg; LLMP.statusErr = keep.err; LLMP.busy = keep.busy; window.llmRefresh = keep.refresh;
    }
  })()`;
  const release = main.hold("projector", "custom-smoke-t18e-held");
  let busy: { msg: string | null; busy: boolean } | null = null;
  try {
    busy = await within(10_000, "Settings' update", js<{ msg: string | null; busy: boolean }>(probe));
  } finally {
    release();
  }
  // Main offline and nothing running: a plain failure, said the same way.
  const failed = await within(10_000, "Settings' update", js<{ msg: string | null; busy: boolean }>(probe));
  check(
    "T18 D1 (F8): Settings' llama.cpp update refused while a projector downloads says so and stays said — what is downloading, no \"updating…\" left behind; a plain failure is said the same way",
    !!busy && busy.busy === false
      && busy.msg === "! the llama.cpp backend was not updated: the vision projector of smoke-t18e-held is downloading. Update it once that has finished."
      && failed.busy === false && failed.msg === "! models update failed: smoke: offline, nothing is downloaded",
    JSON.stringify({ busy, failed }),
  );
}

/* D2: a first run without llama.cpp. The runtime fails, the weights go on and
   land, and the projector fails too: two failed rows. Retry on the runtime. */
async function runtimeRetryAfterProjector(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const out = {};
    try {
      stage();
      remember();
      window.__dlSeed([{kind: 'runtime', id: 'llama.cpp'}, {kind: 'weights', id: ID}]);
      DL.dry = false;
      runtimeEnds(false);
      await tick(60);
      feed({id: ID, done: true, ok: true});
      await tick(120);
      out.asked = calls.slice();
      out.answered = answer({ok: false, error: 'smoke t18e: HTTP 503 from the projector URL'});
      await tick(150);
      out.failed = seen();
      out.retryRuntime = await pressIn('llama.cpp runtime', '.dlc-retry');
      out.retried = seen({held: DL.activateAfter});
      runtimeEnds(true);
      await tick(150);
      out.runtimeLanded = seen();
      out.retryProjector = await pressIn(NAME, '.dlc-retry');
      await tick(60);
      out.projectorAsked = calls.slice();
      out.answered2 = answer({ok: true, path: '/smoke/t18e/' + FILE});
      await tick(150);
      out.done = seen({marker: marker()});
      return out;
    } finally {
      restore();
    }
  })()`);
  const failed = r["failed"] as Seen, retried = r["retried"] as Seen, rl = r["runtimeLanded"] as Seen;
  check(
    "T18 D2: a llama.cpp Retry after the vision projector failed does not start the model text-only when the runtime lands — the projector's row still waits for its own Retry",
    same(r["asked"], [PROJ]) && r["answered"] === true
      && same([...failed.failed].sort(), [`projector:${ID}`, "runtime:llama.cpp"]) && !!failed.card && failed.card.rows.every((x) => x.retry)
      && typeof r["retryRuntime"] === "string" && retried.held === null && retried.job === "runtime:llama.cpp"
      && same(rl.calls, [PROJ]) && same(rl.failed, [`projector:${ID}`])
      && !!rl.card && rl.card.rows.length === 1 && rl.card.rows[0]!.name === NAME && rl.card.rows[0]!.retry,
    JSON.stringify({ asked: r["asked"], failed, retried, runtimeLanded: rl }),
  );
  const done = r["done"] as Seen;
  check(
    "T18 D2: the projector's own Retry, once it lands, starts the model — once",
    typeof r["retryProjector"] === "string" && same(r["projectorAsked"], [PROJ, PROJ]) && r["answered2"] === true
      && same(done.calls, [PROJ, PROJ, START]) && done.card === null && done.marker === null,
    JSON.stringify({ retry: r["retryProjector"], asked: r["projectorAsked"], done }),
  );
}

/* D2, the other half: the runtime failed, the weights and the projector landed,
   and the start without llama.cpp is the one a runtime Retry is for. */
async function runtimeRetryAfterLanding(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const out = {};
    try {
      stage();
      remember();
      window.__dlSeed([{kind: 'runtime', id: 'llama.cpp'}, {kind: 'weights', id: ID}]);
      DL.dry = false;
      runtimeEnds(false);
      await tick(60);
      feed({id: ID, done: true, ok: true});
      await tick(120);
      out.answered = answer({ok: true, path: '/smoke/t18e/' + FILE});
      await tick(150);
      out.landed = seen({landed: DL.landed});
      out.retryRuntime = await pressIn('llama.cpp runtime', '.dlc-retry');
      out.held = DL.activateAfter;
      runtimeEnds(true);
      await tick(150);
      out.done = seen();
      return out;
    } finally {
      restore();
    }
  })()`);
  const landed = r["landed"] as Seen, done = r["done"] as Seen;
  check(
    "T18 D2: once the projector has landed, a llama.cpp Retry starts the model again when the runtime lands — the start that had no runtime",
    r["answered"] === true && same(landed.calls, [PROJ, START]) && landed.landed === ID
      && typeof r["retryRuntime"] === "string" && r["held"] === ID
      && same(done.calls, [PROJ, START, START]) && done.card === null,
    JSON.stringify({ landed, retry: r["retryRuntime"], held: r["held"], done }),
  );
}

/* D3: the weights landed before a quit, the projector did not. The relaunch
   fetches the projector alone, it fails, and its failed row is dismissed. */
async function dismissFailedProjector(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const out = {};
    try {
      stage();
      remember({weightsLanded: true});
      await relaunch();
      out.resumed = seen();
      out.answered = answer({ok: false, error: 'smoke t18e: HTTP 503 from the projector URL'});
      await tick(150);
      out.failed = {card: card(), marker: marker()};
      out.dismissAct = await pressIn(NAME, '.dlc-x');
      out.dismissed = {card: card(), marker: marker()};
      // The next launch.
      await relaunch();
      out.next = seen();
      return out;
    } finally {
      restore();
    }
  })()`);
  const failed = r["failed"] as { card: Card; marker: Marker };
  const dismissed = r["dismissed"] as { card: Card; marker: Marker };
  const next = r["next"] as Seen;
  check(
    "T18 D3: dismissing a failed vision projector forgets the resume reminder — the next launch fetches nothing behind the person's back",
    (r["resumed"] as Seen).calls.includes(PROJ) && r["answered"] === true
      && !!failed.card && failed.card.rows.length === 1 && failed.card.rows[0]!.retry && failed.marker?.id === ID
      && typeof r["dismissAct"] === "string" && /^dlc:dismiss:/.test(r["dismissAct"] as string)
      && dismissed.card === null && dismissed.marker === null
      && !next.calls.includes(PROJ) && next.projector === null && next.job === null && next.card === null,
    JSON.stringify({ resumed: r["resumed"], failed, act: r["dismissAct"], dismissed, next }),
  );
}

/* D4: on macOS closing the window is not quitting. The closed window's
   projector call is still running in main — held in its `models status` read —
   when the reopened window resumes the projector. Main is then answered with a
   data dir that already holds the file, so the call ends "already on disk". */
async function reopenOverProjector(js: Js, check: Check, main: SmokeDownloads): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "aa-t18e-"));
  mkdirSync(join(dir, "models", ID), { recursive: true });
  writeFileSync(join(dir, "models", ID, FILE), "smoke t18e: not a projector\n");
  // Every read main starts is held; all of them are answered by the end, whatever happens.
  const reads: ((a: ProjectorStatusAnswer) => void)[] = [];
  const undo = main.projectorStatus(() => new Promise<ProjectorStatusAnswer>((res) => { reads.push(res); }));
  const answerReads = (a: ProjectorStatusAnswer) => { reads.splice(0).forEach((res) => res(a)); };
  let ended = false;
  try {
    const during = await within(30_000, "the reopened window", js<Record<string, any>>(String.raw`(async () => {
      ${HELPERS}
      stage();
      // The real call to main this time, recorded on its way.
      window.obProjectorPull = (p) => { calls.push('projector:' + p.id); return keep.pull(p); };
      // The closed window's call, which main runs on.
      T.first = window.atomic.hfProjector(ID, MM.mmprojUrl, FILE, NAME);
      await tick(150);
      remember({weightsLanded: true});
      await relaunch();
      await tick(300);
      const out = seen({error: DL.error});
      // Another file under the same model is not that download: refused at once, naming it.
      out.other = await Promise.race([window.atomic.hfProjector(ID, '${URL2}', '${FILE2}', NAME), tick(3000).then(() => 'no answer in 3 s')]);
      return out;
    })()`));
    const readsWhileRunning = reads.length;
    // The download main runs ends: its file is on disk.
    answerReads({ ok: true, status: { dataDir: dir } });
    const after = await within(30_000, "the projector's end", js<Record<string, any>>(String.raw`(async () => {
      ${HELPERS}
      try {
        const first = await Promise.race([T.first, tick(10000).then(() => 'no answer in 10 s')]);
        for (let i = 0; i < 100 && (DL.projector || !calls.includes(START)); i++) await tick(50);
        await tick(100);
        return seen({first, marker: marker(), stamped: stamped()});
      } finally {
        restore();
      }
    })()`));
    ended = true;
    const followed = (during["calls"] as string[]).filter((c) => c !== "status");
    check(
      "T18 D4: a window reopened over a vision projector main still runs follows it — no \"Download failed\", the projector row stays on",
      during["projector"] === ID && (during["failed"] as string[]).length === 0 && same(followed, [PROJ]) && during["error"] === null
        && same(lines(during["card"] as Card), [`${NAME} | Vision projector · Starting…`]) && readsWhileRunning === 1,
      JSON.stringify({ during, reads: readsWhileRunning }),
    );
    check(
      "T18 D4: another projector file under the same model is still a refusal that names the running download — only the very same download is followed",
      refusedFor(during["other"] as Answer, "projector", ID),
      JSON.stringify(during["other"]),
    );
    const first = after["first"] as Answer;
    check(
      "T18 D4: when that download ends, both windows' calls have its answer — the model starts once, setup is stamped, the reminder goes",
      !!first && typeof first === "object" && first.ok === true && first.alreadyPresent === true && after["projector"] === null
        && same((after["calls"] as string[]).filter((c) => c !== "status"), [PROJ, START]) && after["card"] === null
        && after["marker"] === null && after["stamped"] === 1 && (after["failed"] as string[]).length === 0,
      JSON.stringify({ after }),
    );
  } finally {
    undo();
    // Main's calls must not stay open on a read nobody answers; the window is put back once they have ended.
    answerReads({ ok: false, error: "smoke t18e: released" });
    if (!ended) { await wait(300); await restore(js); }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The window put back from whatever a scenario left — also after one that threw. */
async function restore(js: Js): Promise<void> {
  await js<unknown>(`(() => { ${HELPERS} restore(); })()`).catch(() => undefined);
}

/* D5: the weights landed before a quit, the projector did not, and llama.cpp
   is not installed (its download failed, or it was removed). */
async function resumeChecksRuntime(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const out = {};
    try {
      // (a) The runtime first, then the projector, then the start.
      stage();
      T.statusText = 'backend: binary missing';
      remember({weightsLanded: true});
      await relaunch();
      out.resumed = seen();
      runtimeEnds(true);
      await tick(120);
      out.runtimeLanded = seen();
      out.answered = answer({ok: true, path: '/smoke/t18e/' + FILE});
      await tick(150);
      out.done = seen({marker: marker()});

      // (b) A Cancel while the resume still reads models status.
      stage();
      let releaseStatus = null;
      window.obBackendStatusText = () => { calls.push('status'); return new Promise((res) => { releaseStatus = res; }); };
      remember({weightsLanded: true});
      const saved = localStorage.getItem(KEY);
      window.__dlClear();
      localStorage.setItem(KEY, saved);
      calls.length = 0;
      await obBootGate(FIRSTRUN);
      await tick(120);
      out.reading = seen({marker: marker()});
      out.cancelAct = await pressIn(NAME, '.dlc-x');
      if (releaseStatus) releaseStatus('backend: binary missing');
      await tick(150);
      out.cancelled = seen({marker: marker()});

      // (c) The runtime that resume fetches is cancelled: the projector waiting in its run goes with it.
      stage();
      T.statusText = 'backend: binary missing';
      remember({weightsLanded: true});
      await relaunch();
      out.runtimeRun = seen({marker: marker()});
      out.runtimeCancelAct = await pressIn('llama.cpp runtime', '.dlc-x');
      out.runtimeCancelled = seen({marker: marker()});
      feed({id: 'llama.cpp', kind: 'runtime', done: true, ok: false, error: 'models update exited with code null', sawProgress: false, upToDate: false});
      await tick(150);
      out.runtimeExited = seen({marker: marker()});
      return out;
    } finally {
      restore();
    }
  })()`);
  const resumed = r["resumed"] as Seen, rl = r["runtimeLanded"] as Seen, done = r["done"] as Seen;
  check(
    "T18 D5: a projector-only resume reads models status first, and with no llama.cpp binary it fetches the runtime before the projector",
    same(resumed.calls, ["status"]) && resumed.job === "runtime:llama.cpp" && resumed.projector === null
      && same(lines(resumed.card), ["llama.cpp runtime | Starting…", `${NAME} | Vision projector · Queued`]),
    JSON.stringify(resumed),
  );
  check(
    "T18 D5: the projector comes down once the runtime is in, and the model starts once it lands",
    same(rl.calls, ["status", PROJ]) && rl.projector === ID && rl.job === null
      && r["answered"] === true && same(done.calls, ["status", PROJ, START]) && done.card === null && done.marker === null,
    JSON.stringify({ runtimeLanded: rl, done }),
  );
  const reading = r["reading"] as Seen, cancelled = r["cancelled"] as Seen;
  check(
    "T18 D5: a Cancel while that resume still reads models status starts nothing, and forgets the reminder",
    same(reading.calls, ["status"]) && same(lines(reading.card), [`${NAME} | Vision projector · Starting…`])
      && reading.marker?.id === ID && r["cancelAct"] === "dlc:cancel"
      && same(cancelled.calls, ["status"]) && cancelled.job === null && cancelled.projector === null
      && cancelled.queue.length === 0 && cancelled.card === null && cancelled.marker === null,
    JSON.stringify({ reading, act: r["cancelAct"], cancelled }),
  );
  const run = r["runtimeRun"] as Seen, rc = r["runtimeCancelled"] as Seen, rx = r["runtimeExited"] as Seen;
  check(
    "T18 D5: the runtime's × on that resume takes the projector waiting in its run too, and forgets the reminder — nothing comes down or starts after it",
    run.job === "runtime:llama.cpp" && run.marker?.id === ID && r["runtimeCancelAct"] === "dlc:cancel"
      && same(lines(rc.card), ["llama.cpp runtime | Cancelling…"]) && rc.marker === null
      && same(rx.calls, ["status"]) && rx.projector === null && rx.job === null && rx.card === null,
    JSON.stringify({ run, act: r["runtimeCancelAct"], cancelled: rc, exited: rx }),
  );
}

/* D6: main's projector call is in its `models status` read — stood in, and
   left unanswered until the end — when the projector row's × is pressed. */
async function earlyProjectorCancel(js: Js, check: Check, main: SmokeDownloads): Promise<void> {
  const reads: ((a: ProjectorStatusAnswer) => void)[] = [];
  const undo = main.projectorStatus(() => new Promise<ProjectorStatusAnswer>((res) => { reads.push(res); }));
  let ended = false;
  try {
    const r = await within(30_000, "the projector's Cancel", js<Record<string, any>>(String.raw`(async () => {
      ${HELPERS}
      stage();
      // The real call to main, its answer and when it came recorded on the way back.
      T.main = null;
      window.obProjectorPull = (p) => {
        calls.push('projector:' + p.id);
        return keep.pull(p).then((res) => { T.main = {res, at: Date.now()}; return res; });
      };
      obFetchProjector(ID, MM);
      await tick(150);
      const out = {starting: card()};
      const x = document.querySelector('#dlcard .dlc-row .dlc-x');
      out.act = x ? x.dataset.act : null;
      const t0 = Date.now();
      if (x) x.click();
      // Up to 5 s for main's answer; the read it was waiting on is still unanswered all that time.
      for (let i = 0; i < 250 && !T.main; i++) await tick(20);
      out.main = T.main ? {res: T.main.res, ms: T.main.at - t0} : null;
      await tick(100);
      out.after = seen({error: DL.error});
      return out;
    })()`));
    const readsLeft = reads.length;
    // Main's read answers only now, long after the Cancel; then the window is put back.
    reads.splice(0).forEach((res) => res({ ok: false, error: "smoke t18e: models status stood in" }));
    await wait(300);
    await restore(js);
    ended = true;
    const after = r["after"] as Seen & { error: string | null };
    const answered = r["main"] as { res: Answer; ms: number } | null;
    check(
      "T18 D6: a vision projector's × pressed while main still reads models status ends the download at once — main answers \"cancelled\" before that read does",
      same(lines(r["starting"] as Card), [`${NAME} | Vision projector · Starting…`]) && r["act"] === "dlc:cancel" && readsLeft === 1
        && !!answered && answered.ms < 1000 && typeof answered.res === "object" && !!answered.res
        && answered.res.ok === false && /projector download was cancelled/.test(answered.res.error ?? "")
        && same(after.calls, [PROJ]) && after.projector === null && after.card === null && after.failed.length === 0
        && /cancelled/.test(after.error ?? ""),
      JSON.stringify({ ...r, readsLeft }),
    );
  } finally {
    undo();
    reads.splice(0).forEach((res) => res({ ok: false, error: "smoke t18e: released" }));
    if (!ended) { await wait(300); await restore(js); }
  }
}

/* D7: the composer's chip read the setup download through dlBusy() and
   dlModelName(), which know the queue alone. While the vision model's projector
   came down, or waited for the queue, the chip went back to "Set up a model" —
   whose setup then refused its Download, a download being already running — or,
   on the managed route, to the route's own controls; and with the projector
   parked behind the llama.cpp runtime it said "Downloading your model". Both
   places the chip stands are read: the setup slot (the agent's default server,
   where nothing answers: composerNeedsSetup) and the model slot of the managed
   route setup writes. */
async function chipFollowsProjector(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    // The weights land with a retried llama.cpp runtime next: the projector waits behind it (D1).
    const park = async () => {
      remember();
      window.__dlSeed([{kind: 'weights', id: ID}]);
      DL.dry = false;
      dlFail({kind: 'runtime', id: 'llama.cpp'}, 'smoke t18e: the runtime download failed earlier');
      render(); await tick(60);
      await pressIn('llama.cpp runtime', '.dlc-retry');
      feed({id: ID, done: true, ok: true});
      await tick(120);
    };
    // The projector's row in the card: the name it goes by there.
    const row = () => { const c = card(); const p = c && c.rows.find((x) => /^Vision projector/.test(x.line)); return p ? p.name : null; };
    const run = async (slot) => {
      const out = {};
      // (a) The projector queued behind the runtime.
      stage(); if (slot === 'setup') onSetupRoute();
      await park();
      out.parked = Object.assign(await chip(true), {waiting: DL.projectorQueue.map((p) => p.id)});
      // (b) The runtime is in: the projector comes down.
      runtimeEnds(true);
      await tick(120);
      out.fetching = await chip(true);
      // (c) It lands, and the model starts.
      out.answered = answer({ok: true, path: '/smoke/t18e/' + FILE});
      await tick(150);
      out.landed = Object.assign(await chip(false), {calls: calls.slice()});
      // (d) A projector-only resume (D5): its Starting… while models status is read, then the projector.
      stage(); if (slot === 'setup') onSetupRoute();
      let releaseStatus = null;
      window.obBackendStatusText = () => { calls.push('status'); return new Promise((res) => { releaseStatus = res; }); };
      obResumeProjector(ID, MM);
      await tick(80);
      out.preparing = Object.assign(await chip(true), {preparing: DL.preparing ? DL.preparing.kind + ':' + DL.preparing.id : null});
      if (releaseStatus) releaseStatus('backend: binary ok');
      await tick(120);
      out.resumed = await chip(true);
      out.resumeAnswered = answer({ok: true, path: '/smoke/t18e/' + FILE});
      await tick(150);
      out.resumeLanded = Object.assign(await chip(false), {calls: calls.slice()});
      return out;
    };
    try {
      const out = {setup: await run('setup'), model: await run('model')};
      /* (e) A model no list in the window knows by name: setup's own list
         (OB.models) is read on its model step, and a relaunch has none. A
         Hugging Face model's id is custom-<slug>; the chip names it as its
         row in the card does. */
      stage();
      OB.models = [];
      await park();
      out.unnamed = Object.assign(await chip(false), {row: row()});
      runtimeEnds(true);
      await tick(120);
      out.unnamedFetching = Object.assign(await chip(false), {row: row()});
      out.unnamedAnswered = answer({ok: true, path: '/smoke/t18e/' + FILE});
      await tick(150);
      return out;
    } finally {
      restore();
    }
  })()`);
  const slots = ["setup", "model"] as const;
  const route = { setup: { route: "custom", needsSetup: true }, model: { route: "local", needsSetup: false } };
  const at = (slot: (typeof slots)[number], key: string) => (r[slot]?.[key] ?? null) as Chip | null;
  // Downloading <the model>, a plain label in the chip's own slot: no control, and a click on it opens nothing.
  const names = (c: Chip | null, slot: (typeof slots)[number]) =>
    !!c && c.route === route[slot].route && c.needsSetup === route[slot].needsSetup
      && c.pull && c.slot === slot && c.tag === "SPAN" && c.text === `Downloading ${NAME}` && !c.act && c.opened === 0;
  const each = (key: string, more: (c: Chip, slot: (typeof slots)[number]) => boolean) =>
    slots.every((s) => { const c = at(s, key); return names(c, s) && more(c!, s); });
  const detail = (...keys: string[]) =>
    JSON.stringify(Object.fromEntries(slots.map((s) => [s, Object.fromEntries(keys.map((k) => [k, r[s]?.[k] ?? null]))])));
  check(
    "T18 D7: with a vision model's projector queued behind the llama.cpp runtime, the composer's chip says Downloading <the model>, not Downloading your model — in the setup slot and in the managed route's model slot",
    each("parked", (c) => c.job === "runtime:llama.cpp" && c.projector === null && same(c.waiting, [ID])),
    detail("parked"),
  );
  check(
    "T18 D7: while that projector comes down the chip stays — not Set up a model, whose setup would refuse its Download, nor the route's own controls — and a click on it opens nothing",
    each("fetching", (c) => c.projector === ID && c.job === null && c.queue.length === 0),
    detail("fetching"),
  );
  check(
    "T18 D7: a projector-only resume names the model from its Starting… on, and keeps the chip while the projector comes down",
    each("preparing", (c) => c.preparing === `projector:${ID}` && c.projector === null)
      && each("resumed", (c) => c.projector === ID && c.job === null),
    detail("preparing", "resumed"),
  );
  // Gone once it lands: the setup slot offers setup again; the managed route draws its own controls.
  const back = (c: Chip | null, slot: (typeof slots)[number]) =>
    !!c && !c.pull && c.projector === null && c.route === route[slot].route
      && (slot === "model" || (c.text === "Set up a model" && c.act === "onboarding:choose"));
  check(
    "T18 D7: once the projector lands the chip goes — the setup slot offers Set up a model again — and the model starts, once",
    slots.every((s) => back(at(s, "landed"), s) && back(at(s, "resumeLanded"), s)
      && r[s]?.answered === true && r[s]?.resumeAnswered === true
      && same(at(s, "landed")?.calls, [PROJ, START]) && same(at(s, "resumeLanded")?.calls, ["status", PROJ, START])),
    detail("landed", "resumeLanded"),
  );
  const unnamed = r["unnamed"] as (Chip & { row: string | null }) | null;
  const unnamedFetching = r["unnamedFetching"] as (Chip & { row: string | null }) | null;
  check(
    "T18 D7: a vision model no list in the window knows by name — as after a relaunch — is named on the chip as its row in the card names it, queued and coming down",
    !!unnamed?.row && unnamed.pull && unnamed.text === `Downloading ${unnamed.row}` && unnamed.job === "runtime:llama.cpp"
      && !!unnamedFetching && unnamedFetching.pull && unnamedFetching.row === unnamed.row
      && unnamedFetching.text === `Downloading ${unnamed.row}` && unnamedFetching.projector === ID
      && r["unnamedAnswered"] === true,
    JSON.stringify({ unnamed, unnamedFetching }),
  );
}

/* D8: the other two downloads the card follows — the composer picker's
   (SEL.pulling) and Settings › Models' (LLMP.pulling, its vision projector
   phase included) — left the chip as it was. On the setup slot it offered
   "Set up a model", whose Download then refused, a download being already
   running; on the managed route with no model to show it drew nothing, or
   "Download a model". A chat model is what they bring down, and it is started
   when it lands, as the setup download's is. An embedding model is not: nothing
   waits on it, and the card offers no cloud model beside one either. Each pull
   is started and ended as its owner does it, without a download and without a
   frame on the pull channel: the picker renders (selPull), Settings repaints
   only itself and the card (llmRepaint), so the chip is read at once after it.
   Its review: a chosen model removed since (its id is kept) read as the model
   during the picker's download, and a repaint swapped the chip for an equal
   one, dropping a hover or the focus on it. */
async function chipFollowsOtherPulls(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const PICK = 'smoke-t18e-pick', SETS = 'smoke-t18e-settings', EMB = 'smoke-t18e-embedding', ACTIVE = 'smoke-t18e-active';
    const pick = (id) => { SEL.pulling = id; SEL.pullLine = 'starting…'; render(); };
    const settings = (p) => { LLMP.pulling = p; LLMP.pullLog = []; llmRepaint(); };
    const begin = (slot) => {
      stage();
      OB.models = OB.models.concat([{id: PICK, name: 'Smoke Pick 4B GGUF'}, {id: SETS, name: 'Smoke Settings 9B GGUF'}]);
      if (slot === 'setup') onSetupRoute();
    };
    // Whether a repaint that changes nothing keeps the chip itself: a mark on the element, which a swap would drop.
    const marked = () => { const el = document.querySelector('#composer .cfoot .pullchip, #composer .cfoot .setupchip, #composer .cfoot .modelchip'); if (el) el.__t18e = 1; return !!el; };
    const kept = () => { const el = document.querySelector('#composer .cfoot .pullchip, #composer .cfoot .setupchip, #composer .cfoot .modelchip'); return !!el && el.__t18e === 1; };
    const out = {setup: {}, model: {}};
    try {
      // The setup slot.
      begin('setup');
      out.setup.before = peek();
      out.setup.keptSetup = marked() && (llmRepaint(), kept());
      pick(PICK);
      out.setup.pick = await chip(true);
      SEL.pulling = null; render();
      out.setup.pickEnded = peek();
      settings({kind: 'chat', id: SETS});
      out.setup.settings = peek();
      out.setup.settingsClick = await chip(true);
      marked();
      settings({kind: 'chat', id: SETS, phase: 'mmproj'});
      out.setup.projector = peek();
      out.setup.keptPull = kept();
      settings(null);
      out.setup.settingsEnded = peek();
      settings({kind: 'embedding', id: EMB});
      out.setup.embedding = Object.assign(peek(), {offer: !!document.querySelector('#dlcard .dlc-cloud')});
      settings(null);

      // The managed route's model slot, with nothing on disk and nothing chosen: the call to download one.
      begin('model');
      SEL.local = [{id: PICK, name: 'Smoke Pick 4B GGUF', downloaded: false}, {id: SETS, name: 'Smoke Settings 9B GGUF', downloaded: false}];
      BSW.localLoaded = true;
      render();
      out.model.before = peek();
      pick(PICK);
      out.model.pick = peek();
      SEL.pulling = null; render();
      settings({kind: 'chat', id: SETS});
      out.model.settings = peek();
      settings(null);
      out.model.settingsEnded = peek();
      // A chosen model removed since (models remove keeps its id), and nothing else on disk.
      const gone = Object.assign({}, LIVE_CONFIG.localModels);
      gone.managed = Object.assign({}, gone.managed || {}, {modelId: 'smoke-t18e-gone'});
      LIVE_CONFIG = Object.assign({}, LIVE_CONFIG, {localModels: gone});
      render();
      out.model.goneBefore = peek();
      pick(PICK);
      out.model.gonePick = peek();
      SEL.pulling = null; render();
      // A model on disk and chosen: its chip stays while another one comes down.
      SEL.local = SEL.local.concat([{id: ACTIVE, name: 'Smoke Active 2B GGUF', downloaded: true}]);
      const lm = Object.assign({}, LIVE_CONFIG.localModels);
      lm.managed = Object.assign({}, lm.managed || {}, {modelId: ACTIVE});
      LIVE_CONFIG = Object.assign({}, LIVE_CONFIG, {localModels: lm});
      render();
      out.model.active = peek();
      pick(PICK);
      out.model.activePick = peek();
      SEL.pulling = null; render();
      settings({kind: 'chat', id: SETS});
      out.model.activeSettings = peek();
      settings(null);
      // Settings' repaint and the facts' (bswRepaint), with nothing changed: the chosen model's chip is the same element.
      out.model.keptActive = marked() && (llmRepaint(), bswRepaint(), kept());
      return out;
    } finally {
      restore();
    }
  })()`);
  const s = (r["setup"] ?? {}) as Record<string, Chip & { offer?: boolean }>;
  const m = (r["model"] ?? {}) as Record<string, Chip>;
  const on = (c: Chip | undefined, slot: "setup" | "model") =>
    !!c && (slot === "setup" ? c.route === "custom" && c.needsSetup : c.route === "local" && !c.needsSetup);
  // Downloading <the model>, a plain label in the chip's own slot: no control, and a click on it opens nothing.
  const downloading = (c: Chip | undefined, slot: "setup" | "model", name: string) =>
    on(c, slot) && !!c && c.slot === slot && c.pull && c.tag === "SPAN" && !c.act && c.text === `Downloading ${name}` && c.opened === 0;
  const offersSetup = (c: Chip | undefined) =>
    on(c, "setup") && !!c && c.slot === "setup" && !c.pull && c.text === "Set up a model" && c.act === "onboarding:choose";
  const shows = (c: Chip | undefined, text: string) => on(c, "model") && !!c && c.slot === "model" && !c.pull && c.text === text;
  check(
    "T18 D8: on the setup slot the composer picker's download reads Downloading <the model> — not Set up a model, whose setup would refuse its Download — a click on it opens nothing, and Set up a model is back once it ends",
    offersSetup(s["before"]) && downloading(s["pick"], "setup", "Smoke Pick 4B") && offersSetup(s["pickEnded"]),
    JSON.stringify({ before: s["before"], pick: s["pick"], ended: s["pickEnded"] }),
  );
  check(
    "T18 D8: Settings › Models' download reads the same, its vision projector phase too, though Settings repaints only itself and the card",
    downloading(s["settings"], "setup", "Smoke Settings 9B") && downloading(s["settingsClick"], "setup", "Smoke Settings 9B")
      && downloading(s["projector"], "setup", "Smoke Settings 9B") && offersSetup(s["settingsEnded"]),
    JSON.stringify({ settings: s["settings"], click: s["settingsClick"], projector: s["projector"], ended: s["settingsEnded"] }),
  );
  check(
    "T18 D8: an embedding model's download leaves Set up a model as it is — nothing waits on it, and the card offers no cloud model beside it",
    offersSetup(s["embedding"]) && s["embedding"]?.offer === false,
    JSON.stringify(s["embedding"]),
  );
  check(
    "T18 D8: on the managed route with no model to run, the model slot reads Downloading <the model> while the picker or Settings brings one down — not nothing, nor Download a model, nor a chosen model removed since — and a model on disk keeps its chip",
    shows(m["before"], "Download a model") && downloading(m["pick"], "model", "Smoke Pick 4B")
      && downloading(m["settings"], "model", "Smoke Settings 9B") && shows(m["settingsEnded"], "Download a model")
      && shows(m["goneBefore"], "Download a model") && downloading(m["gonePick"], "model", "Smoke Pick 4B")
      && shows(m["active"], "Smoke Active 2B") && shows(m["activePick"], "Smoke Active 2B") && shows(m["activeSettings"], "Smoke Active 2B"),
    JSON.stringify(m),
  );
  check(
    "T18 D8: a repaint that changes nothing keeps the chip itself — Set up a model, Downloading <the model> across Settings' projector phase, a chosen model's chip under Settings' repaint and the facts' — so a hover or the focus on it stays",
    r["setup"]?.["keptSetup"] === true && r["setup"]?.["keptPull"] === true && r["model"]?.["keptActive"] === true,
    JSON.stringify({ setup: r["setup"]?.["keptSetup"], pull: r["setup"]?.["keptPull"], active: r["model"]?.["keptActive"] }),
  );
}

/* For the product owner: the card as D1 leaves it — the llama.cpp runtime
   coming down, the vision projector queued behind it — at 1280×820, light and
   dark. Only with T18E_SHOTS set. */
async function shots(js: Js, dir: string): Promise<void> {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
  if (!w) return;
  mkdirSync(dir, { recursive: true });
  const [nw, nh] = w.getContentSize() as [number, number];
  if (nw !== 1280 || nh !== 820) { w.setContentSize(1280, 820); await wait(500); }
  /* An occluded window stops painting and capturePage returns its last frame:
     as t18b's shots do, it is brought up (without the keyboard) and repainted. */
  const throttled = w.webContents.getBackgroundThrottling();
  w.webContents.setBackgroundThrottling(false);
  w.showInactive();
  w.moveTop();
  try {
    for (const theme of ["light", "dark"]) {
      await js<unknown>(String.raw`(async () => {
        ${HELPERS}
        stage();
        document.documentElement.setAttribute('data-theme', '${theme}');
        window.__dlSeed([{kind: 'runtime', id: 'llama.cpp'}]);
        feed({id: 'llama.cpp', kind: 'runtime', percent: 40, transferredBytes: 28 * 1048576, totalBytes: 70 * 1048576});
        DL.projectorQueue.push({id: ID, pending: MM, run: null});
        render();
        await tick(400);
      })()`);
      w.webContents.invalidate();
      await wait(500);
      const img = await w.webContents.capturePage();
      writeFileSync(join(dir, `card-projector-queued-${theme}.png`), img.toPNG());
    }
  } finally {
    w.webContents.setBackgroundThrottling(throttled);
    if (nw !== 1280 || nh !== 820) w.setContentSize(nw, nh);
    await js<unknown>(String.raw`(() => {
      ${HELPERS}
      restore();
      document.documentElement.removeAttribute('data-theme');
      try { const t = localStorage.getItem('atag.theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch (e) { /* follow macOS */ }
      render();
    })()`).catch(() => undefined);
  }
}
