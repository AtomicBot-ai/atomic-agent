/**
 * Release-fix checks for backlog item 18, review round S (see
 * main/release-fixes-smoke.ts; they run with `--smoke-task=18`).
 *
 * S5 — on macOS closing the window is not quitting: the setup pull runs on in
 *      main, and the window reopened from the dock resumes it (obBootGate).
 *      Main refused that second pull, the card said "Download failed" and the
 *      real pull's `done` frame reached nobody. Main's refusal now names the
 *      download it runs, and a window asking for that very job follows it.
 * S6 — a setup download that lands before the agent connected (no LIVE_CONFIG
 *      yet) read "no config" as "no model chosen" and started itself over a
 *      cloud model. The config is read first.
 * S3 — a resume that fails on every launch is not tried again by itself after
 *      two failed resumes in a row; the card keeps the failed row with Retry.
 * A cancelled setup pull whose bytes finished as the Cancel came in (the child
 *      exited 0) starts and stamps nothing.
 *
 * Nothing is downloaded and nothing restarts: the queue's call to main
 * (dlSpawn), `models status`, the config read and the model start are
 * recorders standing in for them, and the landing's stamp is logged rather
 * than written (OB.testClose). Everything touched is put back.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Row = { name: string; line: string; retry: boolean; switch: boolean };
type Card = { title: string; rows: Row[] } | null;

const ID = "smoke-t18-9b";

/* The card as a person reads it, a first run's route, the reminder, and what
   every block below swaps out and puts back. */
const HELPERS = String.raw`
  const tick = (ms) => new Promise((res) => setTimeout(res, ms));
  const txt = (n) => (n ? (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const card = () => {
    const el = document.getElementById('dlcard');
    if (!el || el.hidden || !el.firstElementChild) return null;
    return {title: txt(el.querySelector('.dlc-ttl > span')),
      rows: [...el.querySelectorAll('.dlc-row')].map((r) => ({name: txt(r.querySelector('.dlc-name')),
        line: txt(r.querySelector('.dlc-line')), retry: !!r.querySelector('.dlc-retry'), switch: !!r.querySelector('.dlc-switch')}))};
  };
  const firstRunRoute = (cfg) => {
    const lm = Object.assign({}, (cfg && cfg.localModels) || {}, {mode: 'managed'});
    lm.managed = Object.assign({}, lm.managed || {}, {modelId: null});
    return Object.assign({}, cfg || {}, {localModels: lm});
  };
  const ID = '${ID}';
  const GiB = 1024 * 1024 * 1024;
  const KEY = 'atag.setupDownload';
  const marker = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return 'unreadable'; } };
  const remember = (extra) => localStorage.setItem(KEY, JSON.stringify(Object.assign(
    {id: ID, stateDir: (FIRSTRUN && FIRSTRUN.stateDir) || null, at: Date.now()}, extra || {})));
  const queue = () => [DL.preparing, DL.job].concat(DL.queue).filter(Boolean).map((j) => j.kind + ':' + j.id);
  const keep = {status: window.obBackendStatusText, activate: window.obActivateLocal, open: window.openOnboarding,
    spawn: window.dlSpawn, refresh: window.refreshLiveConfig, snap: window.bswSnapshot, cfg: LIVE_CONFIG,
    dry: DL.dry, models: OB.models, testClose: OB.testClose, sel: SEL.pulling, log: OB_STAMP_LOG.slice(),
    room: S.room, toasts: S.toasts.slice()};
  const calls = [];
  let opened = 0;
  const stage = () => {
    window.__dlClear();
    try { localStorage.removeItem(KEY); } catch (e) { /* no storage */ }
    S.room = 'chat'; S.toasts = [];
    window.obBackendStatusText = () => { calls.push('status'); return Promise.resolve('backend: binary ok'); };
    window.obActivateLocal = async (id) => { calls.push('activate:' + id); };
    window.openOnboarding = function () { opened++; };
    window.refreshLiveConfig = () => Promise.resolve();
    window.bswSnapshot = () => Promise.resolve();
    LIVE_CONFIG = firstRunRoute(keep.cfg);
    OB.models = [{id: ID, name: 'Smoke Model 9B GGUF', size: '6.2 GB', sizeGb: 6.2, downloaded: false}];
    // The landing's stamp is logged (OB_STAMP_LOG), not written to this lane's config.
    OB.testClose = true;
    OB_STAMP_LOG.length = 0;
    render();
  };
  const restore = () => {
    window.obBackendStatusText = keep.status; window.obActivateLocal = keep.activate; window.openOnboarding = keep.open;
    if (typeof keep.spawn === 'function') window.dlSpawn = keep.spawn;
    window.refreshLiveConfig = keep.refresh; window.bswSnapshot = keep.snap;
    window.__dlClear(); DL.dry = keep.dry; LIVE_CONFIG = keep.cfg;
    try { localStorage.removeItem(KEY); } catch (e) { /* no storage */ }
    OB.models = keep.models; OB.testClose = keep.testClose; SEL.pulling = keep.sel;
    OB_STAMP_LOG.length = 0; keep.log.forEach((e) => OB_STAMP_LOG.push(e));
    S.room = keep.room; S.toasts = keep.toasts; render();
  };
  // The boot gate as a reopened window runs it, waited out until the queue has had main's answer.
  const reopen = async (settled) => {
    await obBootGate(FIRSTRUN);
    for (let i = 0; i < 100 && !settled(); i++) await tick(50);
    await tick(80);
  };
`;

export async function checks18d(js: Js, check: Check): Promise<void> {
  await reopenOverRunningPull(js, check);
  await landsBeforeConfig(js, check);
  await resumeRetryCap(js, check);
  await cancelThenFinished(js, check);
}

/* S5: the window is reopened while main still runs the setup pull. The queue's
   call to main (dlSpawn) is a recorder answering as main does: refused, with
   the running download named. */
async function reopenOverRunningPull(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const out = {seam: typeof dlSpawn === 'function'};
    // Without the seam the queue would ask the real main for a real pull: nothing runs.
    if (!out.seam) return out;
    const busy = (running) => ({ok: false, error: 'a download is already running', running});
    const lastOf = (id, kind, percent, done, total) => ({id, kind, percent, transferredBytes: done, totalBytes: total,
      line: '[' + '='.repeat(Math.round(percent / 5)).padEnd(20) + '] ' + percent + '%  ' + (done / GiB).toFixed(2) + ' GB / '
        + (total / GiB).toFixed(2) + ' GB  ' + id});
    let answer = () => ({ok: true, started: true});
    const spawned = () => calls.some((c) => c.indexOf('spawn:') === 0);
    try {
      stage();
      window.dlSpawn = (job) => { calls.push('spawn:' + job.kind + ':' + job.id); return Promise.resolve(answer(job)); };
      DL.dry = false;

      // (a) Main runs this model's pull, 41% down.
      remember();
      answer = () => busy({kind: 'weights', id: ID, last: lastOf(ID, 'weights', 41, 2684354560, 6657199308)});
      await reopen(spawned);
      out.same = {opened, calls: calls.slice(), queue: queue(), failed: DL.failed.map((f) => f.kind + ':' + f.id),
        error: DL.error, card: card()};
      window.__dlFeed({id: ID, kind: 'weights', percent: 60, transferredBytes: 3994319585, totalBytes: 6657199308});
      out.sameMoving = card();
      window.__dlFeed({id: ID, done: true, ok: true});
      await tick(120);
      out.sameLanded = {calls: calls.slice(), card: card(), marker: marker(), failed: DL.failed.length,
        stamped: OB_STAMP_LOG.filter((e) => e.step === 'landed').length};

      // (b) Main runs the llama.cpp runtime in front of it: followed too, then the weights are asked for.
      stage(); calls.length = 0; opened = 0;
      window.obBackendStatusText = () => { calls.push('status'); return Promise.resolve('backend: binary missing'); };
      DL.dry = false;
      remember();
      answer = (job) => job.kind === 'runtime'
        ? busy({kind: 'runtime', id: 'llama.cpp', last: lastOf('llama.cpp', 'runtime', 30, 9663676, 32212254)})
        : {ok: true, started: true};
      await reopen(spawned);
      out.runtime = {queue: queue(), failed: DL.failed.map((f) => f.kind + ':' + f.id), runtimeError: DL.runtimeError, card: card()};
      window.__dlFeed({id: 'llama.cpp', kind: 'runtime', done: true, ok: true, sawProgress: true, upToDate: false});
      await tick(80);
      out.runtimeNext = {calls: calls.slice(), queue: queue()};
      window.__dlFeed({id: ID, done: true, ok: true});
      await tick(120);
      out.runtimeLanded = {calls: calls.slice(), card: card(), failed: DL.failed.map((f) => f.kind + ':' + f.id)};

      // (c) Main runs a different model's pull: still a refusal, and its frames are not this job's.
      stage(); calls.length = 0; opened = 0;
      DL.dry = false;
      remember();
      answer = () => busy({kind: 'weights', id: 'smoke-t18-other', last: lastOf('smoke-t18-other', 'weights', 80, 800, 1000)});
      await reopen(() => DL.failed.length > 0 || (spawned() && !!DL.job && DL.job.id === ID && DL.job.sawProgress));
      out.other = {queue: queue(), failed: DL.failed.map((f) => f.kind + ':' + f.id), card: card()};
      window.__dlFeed({id: 'smoke-t18-other', done: true, ok: true});
      await tick(120);
      out.otherAfter = {calls: calls.slice(), marker: marker()};

      // (d) Main runs this model's pull for the composer of this very window: not taken a second time.
      stage(); calls.length = 0; opened = 0;
      DL.dry = false;
      remember();
      SEL.pulling = ID;
      answer = () => busy({kind: 'weights', id: ID, last: null});
      await reopen(() => DL.failed.length > 0 || (spawned() && !!DL.job && DL.job.id === ID && DL.job.sawProgress));
      out.owned = {queue: queue(), failed: DL.failed.map((f) => f.kind + ':' + f.id)};
      SEL.pulling = keep.sel;
      return out;
    } finally {
      restore();
    }
  })()`);
  if (r["seam"] !== true) {
    check("T18 S5: the setup queue asks main for a download through dlSpawn (the seam these checks stand in for main at)", false,
      "no dlSpawn in the renderer — the checks below did not run");
    return;
  }
  const same = r["same"] as { opened: number; calls: string[]; queue: string[]; failed: string[]; error: string | null; card: Card };
  const moving = r["sameMoving"] as Card;
  const landed = r["sameLanded"] as { calls: string[]; card: Card; marker: unknown; failed: number; stamped: number };
  check(
    "T18 S5: a window reopened while main still runs its model's pull follows it — no \"Download failed\", the card at main's 41%",
    same.opened === 0 && JSON.stringify(same.calls) === JSON.stringify(["status", `spawn:weights:${ID}`])
      && JSON.stringify(same.queue) === JSON.stringify([`weights:${ID}`]) && same.failed.length === 0 && same.error === null
      && !!same.card && same.card.title === "Downloading" && same.card.rows.length === 1
      && same.card.rows[0]!.name === "Smoke Model 9B" && /^2\.5 of 6\.2 GB · 41%/.test(same.card.rows[0]!.line)
      && !!moving && /^3\.7 of 6\.2 GB · 60%/.test(moving.rows[0]?.line ?? ""),
    JSON.stringify({ same, moving }),
  );
  check(
    "T18 S5: the followed pull's done frame reaches obPullFinished — the model starts, setup is stamped, the reminder goes",
    JSON.stringify(landed.calls) === JSON.stringify(["status", `spawn:weights:${ID}`, `activate:${ID}`])
      && landed.card === null && landed.marker === null && landed.failed === 0 && landed.stamped === 1,
    JSON.stringify(landed),
  );
  const rt = r["runtime"] as { queue: string[]; failed: string[]; runtimeError: string | null; card: Card };
  const rtNext = r["runtimeNext"] as { calls: string[]; queue: string[] };
  const rtLanded = r["runtimeLanded"] as { calls: string[]; card: Card; failed: string[] };
  check(
    "T18 S5: the llama.cpp runtime main is still fetching in front of the model is followed the same way, then the weights are asked for",
    JSON.stringify(rt.queue) === JSON.stringify(["runtime:llama.cpp", `weights:${ID}`]) && rt.failed.length === 0 && rt.runtimeError === null
      && !!rt.card && rt.card.title === "Downloading" && rt.card.rows[0]?.name === "llama.cpp runtime" && /30%/.test(rt.card.rows[0]?.line ?? "")
      && JSON.stringify(rtNext.calls) === JSON.stringify(["status", "spawn:runtime:llama.cpp", `spawn:weights:${ID}`])
      && JSON.stringify(rtNext.queue) === JSON.stringify([`weights:${ID}`])
      && rtLanded.calls[rtLanded.calls.length - 1] === `activate:${ID}` && rtLanded.card === null && rtLanded.failed.length === 0,
    JSON.stringify({ rt, rtNext, rtLanded }),
  );
  const other = r["other"] as { queue: string[]; failed: string[]; card: Card };
  const otherAfter = r["otherAfter"] as { calls: string[]; marker: { id?: string } | null };
  const owned = r["owned"] as { queue: string[]; failed: string[] };
  check(
    "T18 S5: another model's pull running in main is still a refusal (Download failed, Retry), its done frame starts nothing; nor is a pull this window follows taken twice",
    other.queue.length === 0 && JSON.stringify(other.failed) === JSON.stringify([`weights:${ID}`])
      && !!other.card && other.card.title === "Download failed" && !!other.card.rows[0]?.retry
      && !otherAfter.calls.some((c) => c.indexOf("activate:") === 0) && !!otherAfter.marker && otherAfter.marker.id === ID
      && owned.queue.length === 0 && JSON.stringify(owned.failed) === JSON.stringify([`weights:${ID}`]),
    JSON.stringify({ other, otherAfter, owned }),
  );
}

/* S6: the resumed download lands before the agent has connected — no
   LIVE_CONFIG yet. The config read (refreshLiveConfig) is a recorder that
   puts the staged config in place, as the real read would. */
async function landsBeforeConfig(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const out = {};
    const cloud = Object.assign({}, keep.cfg || {}, {llm: {activeTextProvider: 'smoke-t18-cloud', providers: [
      {id: 'smoke-t18-cloud', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', defaultChatModel: 'smoke/cloud-model'}]}});
    const landBeforeConnect = async (config) => {
      stage(); calls.length = 0;
      let reads = 0;
      window.refreshLiveConfig = async () => { reads++; if (config) LIVE_CONFIG = config; };
      window.__dlSeed([{kind: 'weights', id: ID}]);
      // The agent has not connected: nothing has read its config yet.
      LIVE_CONFIG = null;
      DL.dry = false;
      window.__dlFeed({id: ID, done: true, ok: true});
      for (let i = 0; i < 20 && !calls.length && !DL.ready; i++) await tick(50);
      await tick(60);
      return {reads, calls: calls.slice(), ready: DL.ready ? DL.ready.id : null, card: card()};
    };
    try {
      // The person moved to a cloud model while it came down.
      out.cloud = await landBeforeConnect(cloud);
      // A first run's local route, nothing chosen yet: it still starts by itself.
      out.local = await landBeforeConnect(firstRunRoute(keep.cfg));
      // A config that cannot be read at all: not knowing is no reason to switch.
      out.unread = await landBeforeConnect(null);
      return out;
    } finally {
      restore();
    }
  })()`);
  const cloud = r["cloud"] as { reads: number; calls: string[]; ready: string | null; card: Card };
  const local = r["local"] as { reads: number; calls: string[]; ready: string | null };
  const unread = r["unread"] as { reads: number; calls: string[]; ready: string | null; card: Card };
  check(
    "T18 S6: a setup download landing before the agent connected reads the config first — on a cloud model it asks (\"is ready\" · Switch) instead of switching",
    cloud.reads === 1 && cloud.calls.length === 0 && cloud.ready === ID
      && !!cloud.card && cloud.card.rows.length === 1 && cloud.card.rows[0]!.name === "Smoke Model 9B is ready" && cloud.card.rows[0]!.switch,
    JSON.stringify(cloud),
  );
  check(
    "T18 S6: on a first run's local route, read the same way, the model still starts by itself; with no config to read at all, the card asks",
    local.reads === 1 && JSON.stringify(local.calls) === JSON.stringify([`activate:${ID}`]) && local.ready === null
      && unread.reads === 1 && unread.calls.length === 0 && unread.ready === ID,
    JSON.stringify({ local, unread }),
  );
}

/* S3: the same remembered download fails on every launch (its id gone from
   the catalogue). A launch is the boot gate run on a cleared download, the
   reminder kept — the state a quit leaves. */
async function resumeRetryCap(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const out = {};
    const GONE = 'model ' + ID + ' is not in the catalogue';
    const launch = async () => {
      const kept = localStorage.getItem(KEY);
      stage();
      if (kept !== null) localStorage.setItem(KEY, kept);
      DL.dry = true;
      calls.length = 0; opened = 0;
      await reopen(() => !!DL.job || DL.failed.length > 0);
      return {opened, calls: calls.slice(), queue: queue(), card: card()};
    };
    try {
      stage();
      remember();
      for (const n of [1, 2]) {
        const l = await launch();
        window.__dlFeed({id: ID, done: true, ok: false, error: GONE});
        await tick(60);
        l.marker = marker();
        out['launch' + n] = l;
      }
      out.launch3 = await launch();
      out.launch3.marker = marker();
      // Retry is still there, and still starts it.
      const retry = document.querySelector('#dlcard .dlc-retry');
      out.retryButton = !!retry;
      calls.length = 0;
      if (retry) retry.click();
      for (let i = 0; i < 40 && !DL.job; i++) await tick(50);
      out.retried = {calls: calls.slice(), queue: queue()};
      return out;
    } finally {
      restore();
    }
  })()`);
  type Launch = { opened: number; calls: string[]; queue: string[]; card: Card; marker: { fails?: number; error?: string } | null };
  const l1 = r["launch1"] as Launch, l2 = r["launch2"] as Launch, l3 = r["launch3"] as Launch;
  const retried = r["retried"] as { calls: string[]; queue: string[] };
  check(
    "T18 S3: a resume that fails is counted on its reminder, launch after launch",
    l1.calls.includes("status") && l1.queue.includes(`weights:${ID}`) && l1.marker?.fails === 1
      && l2.calls.includes("status") && l2.queue.includes(`weights:${ID}`) && l2.marker?.fails === 2
      && /not in the catalogue/.test(String(l2.marker?.error)),
    JSON.stringify({ l1, l2 }),
  );
  check(
    "T18 S3: after two failed resumes in a row the next launch does not try again — the card keeps the failed row, its reason and Retry, and setup does not open over it",
    l3.calls.length === 0 && l3.queue.length === 0 && l3.opened === 0 && !!l3.marker && l3.marker.fails === 2
      && !!l3.card && l3.card.title === "Download failed" && l3.card.rows.length === 1
      && l3.card.rows[0]!.name === "Smoke Model 9B" && /not in the catalogue/.test(l3.card.rows[0]!.line) && l3.card.rows[0]!.retry
      && r["retryButton"] === true && retried.calls.includes("status") && retried.queue.includes(`weights:${ID}`),
    JSON.stringify({ l3, retryButton: r["retryButton"], retried }),
  );
}

/* A Cancel that comes in as the bytes finish: the child exits 0 and its
   `done` frame says ok. The person said stop. */
async function cancelThenFinished(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    try {
      stage();
      window.__dlSeed([{kind: 'weights', id: ID}]);
      remember();
      const x = document.querySelector('#dlcard .dlc-row .dlc-x[data-act="dlc:cancel"]');
      if (x) x.click(); else dlCancel();
      await tick(60);
      DL.dry = false;
      window.__dlFeed({id: ID, done: true, ok: true});
      await tick(120);
      return {button: !!x, calls: calls.slice(), landed: DL.landed, ready: DL.ready, failed: DL.failed.length, card: card(),
        stamped: OB_STAMP_LOG.filter((e) => e.step === 'landed').length, marker: marker()};
    } finally {
      restore();
    }
  })()`);
  check(
    "T18 cancel: a setup pull cancelled as its bytes finished (exit 0) starts nothing and stamps nothing",
    r["button"] === true && (r["calls"] as string[]).length === 0 && r["landed"] === null && r["ready"] === null
      && r["failed"] === 0 && r["card"] === null && r["stamped"] === 0 && r["marker"] === null,
    JSON.stringify(r),
  );
}
