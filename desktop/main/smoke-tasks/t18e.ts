import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProjectorStatusAnswer, SmokeDownloads } from "../release-fixes-smoke.js";

/**
 * Backlog 18, the rare cases deferred from its reviews — a Hugging Face vision
 * model's projector among the other downloads (see main/release-fixes-smoke.ts;
 * t18.ts holds the item's own checks). Run with `--smoke --smoke-task=18`.
 *
 *   D1 (F8) — the projector and a retried llama.cpp runtime ran at once: main's
 *        projector guard ignored `models update`, × on either row stopped only
 *        the projector, and the model could start while the binary was being
 *        replaced. The embedding pull's guard ignored the projector the same way.
 *   D2 — a runtime Retry after the projector failed started the model text-only.
 *   D3 — dismissing a failed projector row kept the resume reminder, so the
 *        next launch fetched the projector again.
 *   D4 — a window reopened over a projector main still runs was refused
 *        instead of following it, as it follows the weights and the runtime.
 *   D5 — the projector-only resume never checked that llama.cpp is installed.
 *   D6 — an early projector Cancel waited for `models status` to return.
 *
 * Nothing is downloaded and nothing restarts. In the renderer the queue runs as
 * itself but never spawns (dlNext always dry), and `models status`, the
 * projector call (obProjectorPull) and the model start are recorders; a landing
 * logs the stamp it owed (OB.testClose). In main a stand-in holds a download
 * slot with no child behind it, and the projector's `models status` read is
 * stood in, so a projector call that gets through reads no data dir, or one
 * where its file already is: nothing is fetched. An embedding pull is asked
 * for under an id the CLI's own check refuses, so no child is started either.
 * Everything touched is put back.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Row = { name: string; line: string; cancel: string | null; retry: boolean };
type Card = { title: string; rows: Row[] } | null;
type Jobs = { job: string | null; queue: string[]; projector: string | null; failed: string[] };
type Answer = { ok?: boolean; error?: string; running?: { kind?: string; id?: string } | null; alreadyPresent?: boolean } | null;
type Marker = { id?: string; weightsLanded?: boolean; fails?: number } | null;

const ID = "custom-smoke-t18e-vl";
const FILE = "mmproj-smoke-t18e.gguf";
const URL = `https://huggingface.co/smoke/t18e/resolve/main/${FILE}`;
const NAME = "Smoke T18e VL";
const PROJ = `projector:${ID}`;
const START = `activate:${ID}`;

/* Shared by every probe below. Its state lives on window.__t18e so a scenario
   can span two `js` calls (D4: main is answered in between); restore() ends it. */
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
  const T = window.__t18e || (window.__t18e = {calls: [], held: [], opened: 0, statusText: 'backend: binary ok',
    keep: {status: window.obBackendStatusText, activate: window.obActivateLocal, pull: window.obProjectorPull,
      next: window.dlNext, open: window.openOnboarding, refresh: window.refreshLiveConfig, snap: window.bswSnapshot,
      cfg: LIVE_CONFIG, dry: DL.dry, models: OB.models, testClose: OB.testClose, log: OB_STAMP_LOG.slice(),
      room: S.room, toasts: S.toasts.slice(), marker: localStorage.getItem(KEY)}});
  const calls = T.calls, held = T.held, keep = T.keep;
  const marker = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return 'unreadable'; } };
  // The setup download's reminder, as the hand-over writes it for a vision pick.
  const remember = (extra) => localStorage.setItem(KEY, JSON.stringify(Object.assign(
    {id: ID, stateDir: (FIRSTRUN && FIRSTRUN.stateDir) || null, at: Date.now(), mmproj: MM}, extra || {})));
  const jobs = () => ({job: DL.job ? DL.job.kind + ':' + DL.job.id + (DL.job.cancelled ? ':cancelled' : '') : null,
    queue: DL.queue.map((q) => q.kind + ':' + q.id), projector: DL.projector ? DL.projector.id : null,
    failed: DL.failed.map((f) => f.kind + ':' + f.id)});
  // How the projector call that is out ends; false when none is out.
  const answer = (res) => { const r = held.shift(); if (r) r(res); return !!r; };
  const feed = (ev) => window.__dlFeed(ev);
  // A control in the card's row that has this name.
  const pressIn = async (name, sel) => {
    const row = [...document.querySelectorAll('#dlcard .dlc-row')].find((r) => txt(r.querySelector('.dlc-name')) === name);
    const n = row ? row.querySelector(sel) : null;
    if (n) n.click();
    await tick(80);
    return n ? (n.dataset.act || true) : null;
  };
  const stage = () => {
    window.__dlClear();
    try { localStorage.removeItem(KEY); } catch (e) { /* no storage */ }
    calls.length = 0; held.length = 0; T.opened = 0; T.statusText = 'backend: binary ok';
    S.room = 'chat'; S.toasts = [];
    window.obBackendStatusText = () => { calls.push('status'); return Promise.resolve(T.statusText); };
    window.obActivateLocal = async (id) => { calls.push('activate:' + id); };
    window.obProjectorPull = (p) => { calls.push('projector:' + p.id); return new Promise((res) => held.push(res)); };
    window.openOnboarding = function () { T.opened++; };
    window.refreshLiveConfig = () => Promise.resolve();
    window.bswSnapshot = () => Promise.resolve();
    // The queue runs as itself, but nothing it starts is spawned.
    window.dlNext = function () { const d = DL.dry; DL.dry = true; try { return keep.next.apply(this, arguments); } finally { DL.dry = d; } };
    LIVE_CONFIG = firstRunRoute(keep.cfg);
    OB.models = [{id: ID, name: NAME + ' GGUF'}];
    OB.pendingMmproj = null;
    OB.testClose = true;
    OB_STAMP_LOG.length = 0;
    DL.dry = false;
    render();
  };
  const restore = () => {
    held.length = 0;
    window.obBackendStatusText = keep.status; window.obActivateLocal = keep.activate; window.openOnboarding = keep.open;
    if (keep.pull) window.obProjectorPull = keep.pull; else delete window.obProjectorPull;
    window.dlNext = keep.next; window.refreshLiveConfig = keep.refresh; window.bswSnapshot = keep.snap;
    window.__dlClear(); DL.dry = keep.dry; LIVE_CONFIG = keep.cfg;
    try { if (keep.marker !== null) localStorage.setItem(KEY, keep.marker); else localStorage.removeItem(KEY); } catch (e) { /* no storage */ }
    OB.models = keep.models; OB.testClose = keep.testClose; OB.pendingMmproj = null;
    OB_STAMP_LOG.length = 0; keep.log.forEach((e) => OB_STAMP_LOG.push(e));
    S.room = keep.room; S.toasts = keep.toasts; render();
    delete window.__t18e;
  };
  // A quit and a relaunch: the download in memory is gone, the reminder is what the quit left, and the boot gate runs.
  const relaunch = async () => {
    const saved = localStorage.getItem(KEY);
    window.__dlClear();
    if (saved !== null) localStorage.setItem(KEY, saved); else localStorage.removeItem(KEY);
    held.length = 0; calls.length = 0; T.opened = 0;
    DL.dry = false;
    await obBootGate(FIRSTRUN);
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
      await js<unknown>(`(() => { ${HELPERS} restore(); })()`).catch(() => undefined);
    }
  };
  await step("D1 (F8) main", () => mainGuards(js, check, main));
  await step("D1 (F8)", () => projectorBehindRuntime(js, check));
  await step("D2", () => runtimeRetryAfterProjector(js, check));
  await step("D3", () => dismissFailedProjector(js, check));
  await step("D4", () => reopenOverProjector(js, check, main));
  await step("D5", () => resumeChecksRuntime(js, check));
  await step("D6", () => earlyProjectorCancel(js, check, main));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const lines = (c: Card) => (c ? c.rows.map((r) => `${r.name} | ${r.line}`) : null);

/* D1 (F8), main: every download handler refuses while any other download runs,
   and names it. Nothing runs behind the stand-ins: a projector call that got
   through would read the stood-in status, find no data dir and fetch nothing. */
async function mainGuards(js: Js, check: Check, main: SmokeDownloads): Promise<void> {
  const undoStatus = main.projectorStatus(async () => ({ ok: false, error: "smoke t18e: models status stood in" }));
  const releaseRuntime = main.hold("runtime", "llama.cpp");
  let projector: Answer = null;
  try {
    projector = await js<Answer>(
      `window.atomic.hfProjector(${JSON.stringify(ID)}, ${JSON.stringify(URL)}, ${JSON.stringify(FILE)}, ${JSON.stringify(NAME)})`);
  } finally {
    releaseRuntime();
    undoStatus();
  }
  check(
    "T18 D1 (F8): with the llama.cpp runtime downloading, main refuses a vision projector and names the runtime — the two never run at once",
    !!projector && projector.ok === false && projector.error === "a download is already running"
      && projector.running?.kind === "runtime" && projector.running?.id === "llama.cpp",
    JSON.stringify(projector),
  );
  const releaseProjector = main.hold("projector", "custom-smoke-t18e-held");
  let embedding: Answer = null;
  try {
    embedding = await js<Answer>("window.atomic.modelsPullEmbedding('smoke t18e: not a model id')");
  } finally {
    releaseProjector();
  }
  check(
    "T18 D1 (F8): with a vision projector downloading, main refuses an embedding pull and names the projector — a Cancel in Settings cannot stop the projector instead",
    !!embedding && embedding.ok === false && embedding.error === "a download is already running"
      && embedding.running?.kind === "projector" && embedding.running?.id === "custom-smoke-t18e-held",
    JSON.stringify(embedding),
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
      out.landed = Object.assign({calls: calls.slice(), card: card(), marker: marker()}, jobs());
      feed({id: 'llama.cpp', kind: 'runtime', done: true, ok: true, sawProgress: true, upToDate: false});
      await tick(120);
      out.runtimeLanded = Object.assign({calls: calls.slice(), card: card()}, jobs());
      out.answered = answer({ok: true, path: '/smoke/t18e/' + FILE});
      await tick(150);
      out.done = Object.assign({calls: calls.slice(), card: card(), marker: marker(), stamped: stamped()}, jobs());

      // (b) The runtime's × while the projector waits behind it.
      await begin();
      out.cancelAct = await pressIn('llama.cpp runtime', '.dlc-x');
      out.cancelled = Object.assign({calls: calls.slice(), card: card()}, jobs());
      // The killed child exits non-zero: a cancel, not a failure.
      feed({id: 'llama.cpp', kind: 'runtime', done: true, ok: false, error: 'models update exited with code null', sawProgress: false, upToDate: false});
      await tick(120);
      out.afterExit = Object.assign({calls: calls.slice(), card: card()}, jobs());

      // (c) The waiting projector's own ×.
      await begin();
      out.dropAct = await pressIn(NAME, '.dlc-x');
      out.dropped = Object.assign({calls: calls.slice(), card: card(), marker: marker()}, jobs());
      feed({id: 'llama.cpp', kind: 'runtime', done: true, ok: true, sawProgress: true, upToDate: false});
      await tick(120);
      out.afterDrop = Object.assign({calls: calls.slice(), card: card()}, jobs());
      return out;
    } finally {
      restore();
    }
  })()`);
  const landed = r["landed"] as Jobs & { calls: string[]; card: Card; marker: Marker };
  const rl = r["runtimeLanded"] as Jobs & { calls: string[]; card: Card };
  const done = r["done"] as Jobs & { calls: string[]; card: Card; marker: Marker; stamped: number };
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
  const cancelled = r["cancelled"] as Jobs & { calls: string[]; card: Card };
  const afterExit = r["afterExit"] as Jobs & { calls: string[]; card: Card };
  check(
    "T18 D1 (F8): the runtime's × stops only the runtime — the projector waiting behind it stays, and comes down once the runtime has exited",
    r["cancelAct"] === "dlc:cancel" && cancelled.job === "runtime:llama.cpp:cancelled" && cancelled.calls.length === 0
      && same(lines(cancelled.card), ["llama.cpp runtime | Cancelling…", `${NAME} | Vision projector · Queued`])
      && same(afterExit.calls, [PROJ]) && afterExit.projector === ID && afterExit.job === null && afterExit.failed.length === 0,
    JSON.stringify({ act: r["cancelAct"], cancelled, afterExit }),
  );
  const dropped = r["dropped"] as Jobs & { calls: string[]; card: Card; marker: Marker };
  const afterDrop = r["afterDrop"] as Jobs & { calls: string[]; card: Card };
  check(
    "T18 D1 (F8): the waiting projector's × takes it off and forgets the resume reminder — nothing comes down or starts when the runtime lands",
    r["dropAct"] === `dlc:drop:projector:${ID}` && same(lines(dropped.card), ["llama.cpp runtime | Starting…"])
      && dropped.marker === null && dropped.calls.length === 0
      && afterDrop.calls.length === 0 && afterDrop.projector === null && afterDrop.card === null,
    JSON.stringify({ act: r["dropAct"], dropped, afterDrop }),
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
      feed({id: 'llama.cpp', kind: 'runtime', done: true, ok: false, error: 'smoke t18e: models update exited with code 1', sawProgress: false, upToDate: false});
      await tick(60);
      feed({id: ID, done: true, ok: true});
      await tick(120);
      out.asked = calls.slice();
      out.answered = answer({ok: false, error: 'smoke t18e: HTTP 503 from the projector URL'});
      await tick(150);
      out.failed = Object.assign({card: card()}, jobs());
      out.retryRuntime = await pressIn('llama.cpp runtime', '.dlc-retry');
      out.retried = Object.assign({held: DL.activateAfter}, jobs());
      feed({id: 'llama.cpp', kind: 'runtime', done: true, ok: true, sawProgress: true, upToDate: false});
      await tick(150);
      out.runtimeLanded = Object.assign({calls: calls.slice(), card: card()}, jobs());
      out.retryProjector = await pressIn(NAME, '.dlc-retry');
      await tick(60);
      out.projectorAsked = calls.slice();
      out.answered2 = answer({ok: true, path: '/smoke/t18e/' + FILE});
      await tick(150);
      out.done = Object.assign({calls: calls.slice(), card: card(), marker: marker()}, jobs());
      return out;
    } finally {
      restore();
    }
  })()`);
  const failed = r["failed"] as Jobs & { card: Card };
  const retried = r["retried"] as Jobs & { held: string | null };
  const rl = r["runtimeLanded"] as Jobs & { calls: string[]; card: Card };
  check(
    "T18 D2: a llama.cpp Retry after the vision projector failed does not start the model text-only when the runtime lands — the projector's row still waits for its own Retry",
    same(r["asked"], [PROJ]) && r["answered"] === true
      && same([...failed.failed].sort(), [`projector:${ID}`, "runtime:llama.cpp"]) && !!failed.card && failed.card.rows.every((x) => x.retry)
      && typeof r["retryRuntime"] === "string" && retried.held === null && retried.job === "runtime:llama.cpp"
      && same(rl.calls, [PROJ]) && same(rl.failed, [`projector:${ID}`])
      && !!rl.card && rl.card.rows.length === 1 && rl.card.rows[0]!.name === NAME && rl.card.rows[0]!.retry,
    JSON.stringify({ asked: r["asked"], failed, retried, runtimeLanded: rl }),
  );
  const done = r["done"] as Jobs & { calls: string[]; card: Card; marker: Marker };
  check(
    "T18 D2: the projector's own Retry, once it lands, starts the model — once",
    typeof r["retryProjector"] === "string" && same(r["projectorAsked"], [PROJ, PROJ]) && r["answered2"] === true
      && same(done.calls, [PROJ, PROJ, START]) && done.card === null && done.marker === null,
    JSON.stringify({ retry: r["retryProjector"], asked: r["projectorAsked"], done }),
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
      out.resumed = Object.assign({calls: calls.slice()}, jobs());
      out.answered = answer({ok: false, error: 'smoke t18e: HTTP 503 from the projector URL'});
      await tick(150);
      out.failed = {card: card(), marker: marker()};
      out.dismissAct = await pressIn(NAME, '.dlc-x');
      out.dismissed = {card: card(), marker: marker()};
      // The next launch.
      await relaunch();
      out.next = Object.assign({calls: calls.slice(), card: card()}, jobs());
      return out;
    } finally {
      restore();
    }
  })()`);
  const failed = r["failed"] as { card: Card; marker: Marker };
  const dismissed = r["dismissed"] as { card: Card; marker: Marker };
  const next = r["next"] as Jobs & { calls: string[]; card: Card };
  check(
    "T18 D3: dismissing a failed vision projector forgets the resume reminder — the next launch fetches nothing behind the person's back",
    (r["resumed"] as { calls: string[] }).calls.includes(PROJ) && r["answered"] === true
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
  let release: ((a: ProjectorStatusAnswer) => void) | null = null;
  let reads = 0;
  const undo = main.projectorStatus(() => {
    reads++;
    return new Promise<ProjectorStatusAnswer>((res) => { release = res; });
  });
  let ended = false;
  try {
    const during = await js<Record<string, any>>(String.raw`(async () => {
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
      return Object.assign({calls: calls.slice(), card: card(), error: DL.error}, jobs());
    })()`);
    const readsWhileRunning = reads;
    // The download main runs ends: its file is on disk.
    if (release) (release as (a: ProjectorStatusAnswer) => void)({ ok: true, status: { dataDir: dir } });
    const after = await js<Record<string, any>>(String.raw`(async () => {
      ${HELPERS}
      try {
        const first = await T.first;
        for (let i = 0; i < 100 && (DL.projector || !calls.includes(START)); i++) await tick(50);
        await tick(100);
        return Object.assign({first, calls: calls.slice(), card: card(), marker: marker(), stamped: stamped()}, jobs());
      } finally {
        restore();
      }
    })()`);
    ended = true;
    check(
      "T18 D4: a window reopened over a vision projector main still runs follows it — no \"Download failed\", the projector row stays on",
      during["projector"] === ID && (during["failed"] as string[]).length === 0 && same(during["calls"], ["status", PROJ])
        && same(lines(during["card"] as Card), [`${NAME} | Vision projector · Starting…`]) && readsWhileRunning === 1,
      JSON.stringify({ during, reads: readsWhileRunning }),
    );
    const first = after["first"] as Answer;
    check(
      "T18 D4: when that download ends, both windows' calls have its answer — the model starts once, setup is stamped, the reminder goes",
      !!first && first.ok === true && first.alreadyPresent === true && after["projector"] === null
        && same(after["calls"], ["status", PROJ, START]) && after["card"] === null && after["marker"] === null
        && after["stamped"] === 1 && (after["failed"] as string[]).length === 0 && reads === 1,
      JSON.stringify({ after, reads }),
    );
  } finally {
    undo();
    // Main's call must not stay open on a read nobody answers.
    if (release) (release as (a: ProjectorStatusAnswer) => void)({ ok: false, error: "smoke t18e: released" });
    if (!ended) await js<unknown>(`(() => { ${HELPERS} restore(); })()`).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
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
      out.resumed = Object.assign({calls: calls.slice(), card: card()}, jobs());
      feed({id: 'llama.cpp', kind: 'runtime', done: true, ok: true, sawProgress: true, upToDate: false});
      await tick(120);
      out.runtimeLanded = Object.assign({calls: calls.slice(), card: card()}, jobs());
      out.answered = answer({ok: true, path: '/smoke/t18e/' + FILE});
      await tick(150);
      out.done = Object.assign({calls: calls.slice(), card: card(), marker: marker()}, jobs());

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
      out.reading = Object.assign({calls: calls.slice(), card: card()}, jobs());
      out.cancelAct = await pressIn(NAME, '.dlc-x');
      if (releaseStatus) releaseStatus('backend: binary missing');
      await tick(150);
      out.cancelled = Object.assign({calls: calls.slice(), card: card(), marker: marker()}, jobs());
      return out;
    } finally {
      restore();
    }
  })()`);
  const resumed = r["resumed"] as Jobs & { calls: string[]; card: Card };
  const rl = r["runtimeLanded"] as Jobs & { calls: string[]; card: Card };
  const done = r["done"] as Jobs & { calls: string[]; card: Card; marker: Marker };
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
  const reading = r["reading"] as Jobs & { calls: string[]; card: Card };
  const cancelled = r["cancelled"] as Jobs & { calls: string[]; card: Card; marker: Marker };
  check(
    "T18 D5: a Cancel while that resume still reads models status starts nothing, and forgets the reminder",
    same(reading.calls, ["status"]) && same(lines(reading.card), [`${NAME} | Vision projector · Starting…`])
      && r["cancelAct"] === "dlc:cancel"
      && same(cancelled.calls, ["status"]) && cancelled.job === null && cancelled.projector === null
      && cancelled.queue.length === 0 && cancelled.card === null && cancelled.marker === null,
    JSON.stringify({ reading, act: r["cancelAct"], cancelled }),
  );
}

/* D6: main's projector call is still in its `models status` read — stood in
   to answer in 3 s, with no data dir, so nothing is fetched either way — when
   the projector row's × is pressed. */
async function earlyProjectorCancel(js: Js, check: Check, main: SmokeDownloads): Promise<void> {
  const undo = main.projectorStatus(() => new Promise<ProjectorStatusAnswer>((res) => {
    setTimeout(() => res({ ok: false, error: "smoke t18e: models status stood in" }), 3000);
  }));
  try {
    const r = await js<Record<string, any>>(String.raw`(async () => {
      ${HELPERS}
      try {
        stage();
        window.obProjectorPull = (p) => { calls.push('projector:' + p.id); return keep.pull(p); };
        obFetchProjector(ID, MM);
        await tick(150);
        const out = {starting: card()};
        const x = document.querySelector('#dlcard .dlc-row .dlc-x');
        out.act = x ? x.dataset.act : null;
        const t0 = Date.now();
        if (x) x.click();
        // Up to 5 s: past the stood-in read, so main's call has ended either way.
        for (let i = 0; i < 250 && DL.projector; i++) await tick(20);
        out.ms = Date.now() - t0;
        await tick(100);
        out.after = Object.assign({calls: calls.slice(), card: card(), error: DL.error}, jobs());
        return out;
      } finally {
        restore();
      }
    })()`);
    const after = r["after"] as Jobs & { calls: string[]; card: Card; error: string | null };
    check(
      "T18 D6: a vision projector's × pressed while main still reads models status ends it at once — not when that read returns",
      same(lines(r["starting"] as Card), [`${NAME} | Vision projector · Starting…`]) && r["act"] === "dlc:cancel"
        && typeof r["ms"] === "number" && (r["ms"] as number) < 1000
        && same(after.calls, [PROJ]) && after.projector === null && after.card === null && after.failed.length === 0
        && /cancelled/.test(after.error ?? ""),
      JSON.stringify(r),
    );
  } finally {
    undo();
  }
}
