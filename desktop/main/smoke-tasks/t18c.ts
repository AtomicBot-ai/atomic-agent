/**
 * Backlog 18, review S2 — the setup download's resume keeps a Hugging Face
 * vision model's projector (see main/release-fixes-smoke.ts; t18.ts holds the
 * item's own checks, R1 among them). Run with `--smoke --smoke-task=18`.
 *
 * R1 remembers a setup download across a quit, and the boot gate resumes it
 * with `atag models pull`, which brings the weights alone. The projector lived
 * only in memory (OB.pendingMmproj), so after a relaunch the model was started
 * text-only — the very start obFetchProjector's failure path refuses.
 *
 * One timeline, with a quit at each place one can come: the hand-over of a
 * vision pick, a quit mid-weights, a quit mid-projector (the weights on disk),
 * a projector that fails on that resume, and the launch after it. A quit is
 * the download in memory and setup's pick gone, a projector call in flight
 * never answering, and the reminder kept; the relaunch is the boot gate itself
 * (obBootGate).
 *
 * Nothing is downloaded and nothing restarts: the queue runs dry, `models
 * status`, the projector call (obProjectorPull — window.atomic is frozen) and
 * the activation are recorders, the flow is the test jump (testClose — no
 * config write), and everything touched is put back.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Row = { name: string; line: string; retry: boolean };
type Card = { title: string; rows: Row[] } | null;
type Mm = { id?: string; mmprojUrl?: string; mmprojFilename?: string; name?: string } | null | undefined;
type Marker = { id?: string; mmproj?: Mm; weightsLanded?: boolean } | null;
type Launch = { opened: number; calls: string[]; queue: string[]; projector: boolean; card: Card; marker: Marker };

const ID = "custom-smoke-t18c-vl";
const FILE = "mmproj-smoke-t18c.gguf";
const URL = `https://huggingface.co/smoke/t18c/resolve/main/${FILE}`;
const NAME = "Smoke T18c VL";

const HELPERS = String.raw`
  const tick = (ms) => new Promise((res) => setTimeout(res, ms));
  const txt = (n) => (n ? (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const card = () => {
    const el = document.getElementById('dlcard');
    if (!el || el.hidden || !el.firstElementChild) return null;
    return {title: txt(el.querySelector('.dlc-ttl > span')),
      rows: [...el.querySelectorAll('.dlc-row')].map((r) => ({name: txt(r.querySelector('.dlc-name')),
        line: txt(r.querySelector('.dlc-line')), retry: !!r.querySelector('.dlc-retry')}))};
  };
  // A first run's route: managed local with no model chosen yet — where a landed model starts by itself.
  const firstRunRoute = (cfg) => {
    const lm = Object.assign({}, (cfg && cfg.localModels) || {}, {mode: 'managed'});
    lm.managed = Object.assign({}, lm.managed || {}, {modelId: null});
    return Object.assign({}, cfg || {}, {localModels: lm});
  };
`;

export async function checks18c(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const ID = ${JSON.stringify(ID)}, FILE = ${JSON.stringify(FILE)};
    const MM = {id: ID, mmprojUrl: ${JSON.stringify(URL)}, mmprojFilename: FILE, name: ${JSON.stringify(NAME)}};
    const KEY = 'atag.setupDownload';
    const keep = {ob: Object.assign({}, OB), stamped: Object.assign({}, OB_STAMPED), log: OB_STAMP_LOG.slice(),
      status: window.obBackendStatusText, activate: window.obActivateLocal, pull: window.obProjectorPull,
      open: window.openOnboarding, dry: DL.dry, room: S.room, toasts: S.toasts.slice(), cfg: LIVE_CONFIG,
      refresh: window.refreshLiveConfig, marker: localStorage.getItem(KEY)};
    const marker = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return 'unreadable'; } };
    const queue = () => [DL.preparing, DL.job].concat(DL.queue).filter(Boolean).map((j) => j.kind + ':' + j.id);
    const calls = [], pulls = [], held = [];
    // How the projector call that is out ends; false when none is out.
    const answer = (res) => { const r = held.shift(); if (r) r(res); return !!r; };
    const state = () => ({calls: calls.slice(), queue: queue(), projector: !!DL.projector, card: card(), marker: marker()});
    /* The relaunch: the download in memory is gone with the app, and so is
       setup's pick; a projector call in flight never answers. The reminder is
       what the quit left. */
    const relaunch = async (saved) => {
      window.__dlClear();
      OB.pendingMmproj = null;
      held.length = 0;
      if (saved !== null) localStorage.setItem(KEY, saved); else localStorage.removeItem(KEY);
      // __dlClear lets the queue spawn again: the resumed one stays dry, nothing is downloaded.
      DL.dry = true;
      // A landing logs the stamp it owed; the test jump writes no config.
      OB.testClose = true;
      calls.length = 0;
      let opened = 0;
      window.openOnboarding = function () { opened++; };
      try { await obBootGate(FIRSTRUN); } finally { window.openOnboarding = keep.open; }
      for (let i = 0; i < 40 && !DL.job && !DL.projector; i++) await tick(50);
      await tick(100);
      return Object.assign({opened}, state());
    };
    const land = async () => {
      DL.dry = false;
      window.__dlFeed({id: ID, done: true, ok: true});
      DL.dry = true;
      await tick(150);
    };
    const out = {};
    try {
      window.__dlClear();
      try { localStorage.removeItem(KEY); } catch (e) { /* no storage */ }
      LIVE_CONFIG = firstRunRoute(keep.cfg);
      window.refreshLiveConfig = () => Promise.resolve();
      S.toasts = []; S.room = 'chat'; render();
      DL.dry = true;
      window.obBackendStatusText = () => { calls.push('status'); return Promise.resolve('backend: binary ok'); };
      window.obActivateLocal = async (id) => { calls.push('activate:' + id); };
      window.obProjectorPull = (p) => {
        calls.push('projector:' + p.id + ':' + p.mmprojFilename);
        pulls.push({id: p.id, mmprojUrl: p.mmprojUrl, mmprojFilename: p.mmprojFilename, name: p.name});
        return new Promise((res) => held.push(res));
      };

      // Launch 0, setup: a Hugging Face vision pick's Download, as obHfAdd ends
      // once main has added the model (hfAdd itself writes the catalogue: not called).
      window.__obOpen('local_hf_pick', {stamped:['localSetupSeenAt']});
      OB.pendingMmproj = Object.assign({}, MM);
      obDownloadAndHandOver(ID);
      for (let i = 0; i < 100 && OB.open; i++) await tick(100);
      await tick(100);
      out.handedOver = Object.assign({open: OB.open}, state());
      const midWeights = localStorage.getItem(KEY);
      // ... and its weights land in that same launch: the projector comes next.
      await land();
      out.landed0 = state();
      const midProjector = localStorage.getItem(KEY);

      // Launch 1, after a quit mid-weights.
      out.l1 = await relaunch(midWeights);
      await land();
      out.l1Landed = state();
      out.l1Answered = answer({ok: true, path: '/smoke/t18c/' + FILE});
      await tick(150);
      out.l1Done = state();

      // Launch 2, after a quit mid-projector: the weights are on disk.
      out.l2 = await relaunch(midProjector);
      out.l2Answered = answer({ok: false, error: 'smoke: HTTP 503 from the projector URL'});
      await tick(300);
      out.l2Failed = Object.assign({error: DL.error}, state());
      const afterFailure = localStorage.getItem(KEY);

      // Launch 3, after that failure.
      out.l3 = await relaunch(afterFailure);
      out.l3Answered = answer({ok: true, path: '/smoke/t18c/' + FILE});
      await tick(150);
      out.l3Done = state();
      out.pulls = pulls.slice();
      return out;
    } finally {
      held.length = 0;
      window.obBackendStatusText = keep.status; window.obActivateLocal = keep.activate; window.openOnboarding = keep.open;
      if (keep.pull) window.obProjectorPull = keep.pull; else delete window.obProjectorPull;
      window.__dlClear(); DL.dry = keep.dry; LIVE_CONFIG = keep.cfg; window.refreshLiveConfig = keep.refresh;
      try { if (keep.marker !== null) localStorage.setItem(KEY, keep.marker); else localStorage.removeItem(KEY); } catch (e) { /* no storage */ }
      if (OB.open) window.__obClose();
      const gen = OB.openGen;
      Object.assign(OB, keep.ob, {open: false, settling: false, openGen: gen});
      for (const k of Object.keys(OB_STAMPED)) delete OB_STAMPED[k];
      Object.assign(OB_STAMPED, keep.stamped);
      OB_STAMP_LOG.length = 0; keep.log.forEach((e) => OB_STAMP_LOG.push(e));
      S.room = keep.room; S.toasts = keep.toasts; render();
    }
  })()`);

  const PROJ = `projector:${ID}:${FILE}`, START = `activate:${ID}`;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const mmOk = (m: Mm) => !!m && m.id === ID && m.mmprojUrl === URL && m.mmprojFilename === FILE;
  const projectorRow = (c: Card) => !!c && c.rows.length === 1 && /^Vision projector · Starting/.test(c.rows[0]!.line);

  const h = r["handedOver"] as Launch & { open: boolean };
  check(
    "T18 R1 projector: a vision model's setup Download remembers its projector with the download",
    h.open === false && !!h.marker && h.marker.id === ID && mmOk(h.marker.mmproj) && h.marker.weightsLanded !== true
      && h.queue.includes(`weights:${ID}`),
    JSON.stringify(h),
  );

  const l1 = r["l1"] as Launch, l1Landed = r["l1Landed"] as Launch, l1Done = r["l1Done"] as Launch;
  const pulls = r["pulls"] as Mm[];
  check(
    "T18 R1 projector: relaunched mid-weights, the resume pulls the weights, then the projector, and only then starts the model",
    l1.opened === 0 && same(l1.calls, ["status"]) && l1.queue.includes(`weights:${ID}`)
      && same(l1Landed.calls, ["status", PROJ]) && l1Landed.projector && projectorRow(l1Landed.card)
      && !!l1Landed.marker && l1Landed.marker.weightsLanded === true && mmOk(l1Landed.marker.mmproj)
      && r["l1Answered"] === true && same(l1Done.calls, ["status", PROJ, START]) && l1Done.marker === null && l1Done.card === null
      && pulls.length > 0 && pulls.every((p) => mmOk(p) && p?.name === NAME),
    JSON.stringify({ l1, l1Landed, l1Done, pulls }),
  );

  const l0 = r["landed0"] as Launch, l2 = r["l2"] as Launch;
  check(
    "T18 R1 projector: relaunched with the weights on disk and the projector not, the resume fetches the projector alone (llama.cpp is in: models status says so first)",
    !!l0.marker && l0.marker.weightsLanded === true && mmOk(l0.marker.mmproj)
      && l2.opened === 0 && same(l2.calls, ["status", PROJ]) && l2.queue.length === 0 && l2.projector && projectorRow(l2.card),
    JSON.stringify({ landed0: l0, l2 }),
  );

  const l2Failed = r["l2Failed"] as Launch & { error: string | null };
  const l3 = r["l3"] as Launch, l3Done = r["l3Done"] as Launch;
  const failedRow = l2Failed.card && l2Failed.card.rows.length === 1 ? l2Failed.card.rows[0]! : null;
  check(
    "T18 R1 projector: a projector that fails on a resume is a failed row with Retry and the model is not started text-only; the next launch fetches it again and starts it once it lands",
    r["l2Answered"] === true && same(l2Failed.calls, ["status", PROJ]) && !l2Failed.projector
      && !!failedRow && failedRow.retry && /^Failed · smoke: HTTP 503/.test(failedRow.line) && /not started/.test(failedRow.line)
      && !!l2Failed.marker && l2Failed.marker.weightsLanded === true && mmOk(l2Failed.marker.mmproj)
      && l3.opened === 0 && same(l3.calls, ["status", PROJ]) && l3.queue.length === 0 && projectorRow(l3.card)
      && r["l3Answered"] === true && same(l3Done.calls, ["status", PROJ, START]) && l3Done.marker === null && l3Done.card === null,
    JSON.stringify({ l2Failed, l3, l3Done }),
  );
}
