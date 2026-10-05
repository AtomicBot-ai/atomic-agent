import { configGet, configSetWhole } from "../agent-cli.js";

/**
 * Release-fix check (see main/release-fixes-smoke.ts). Run alone with
 * `--smoke --smoke-task=104`.
 *
 * 104 (ATO-239) — first-run setup on a cloud model, then "Set up local
 * models too": Download closed the wizard the moment the model started
 * coming down, and the import step (bring your data from other agents) was
 * never shown. Reproduced on 05.10 by Valera on macOS and by Nadya on
 * Windows, build 225f9470. Download there was handed over like the first
 * backend's (Backlog 18), which skips the import step on purpose. Now the
 * flow goes on to the import step with the download running behind it, and
 * the import step's own way out closes setup with the download still going,
 * in the card in the corner.
 *
 * Driven through the flow's own key router and buttons, from the cloud
 * step's success on. Stood in: the readiness read (a cloud model in, no
 * local one — whatever this lane's config holds), the import scan (one
 * source, so the step has something to offer on any machine), and
 * `models status` (the runtime is there); the queue runs dry (DL.dry — no
 * child is spawned) and the flow is the test jump (testClose — no closing
 * write, no agent bounce). The stamps and the managed-mode write the flow
 * makes on the way are real writes, so the whole config is put back.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const show = (s: unknown) => JSON.stringify(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function checks104(js: Js, check: Check): Promise<void> {
  const before = await configGet();
  const snapshot = before.ok && before.config ? (JSON.parse(JSON.stringify(before.config)) as unknown) : null;
  try {
    await run(js, check);
  } finally {
    // The stamps are written without blocking the repaint: let the last of them land before the config is put back.
    await wait(1000);
    if (snapshot) await configSetWhole(snapshot);
  }
}

async function run(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    const until = async (ok, ms) => { for (let i = 0; i < ms / 100 && !ok(); i++) await tick(100); return ok(); };
    const txt = (n) => (n ? (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim() : '');
    const card = () => {
      const el = document.getElementById('dlcard');
      if (!el || el.hidden || !el.firstElementChild) return null;
      return {rows: [...el.querySelectorAll('.dlc-row')].map((row) => ({name: txt(row.querySelector('.dlc-name')), line: txt(row.querySelector('.dlc-line'))}))};
    };
    const KEY = 'atag.setupDownload';
    const reminder = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return 'unreadable'; } };
    const pull = () => ({running: dlStatus() === 'running',
      jobs: [DL.preparing, DL.job].concat(DL.queue).filter(Boolean).map((j) => j.kind + ':' + j.id)});
    const ID = 'smoke-t104-9b';
    const keep = {ob: Object.assign({}, OB), stamped: Object.assign({}, OB_STAMPED), log: OB_STAMP_LOG.slice(),
      readiness: window.obReadiness, detect: window.obDetectAgents, status: window.obBackendStatusText,
      activate: window.obActivateLocal, dry: DL.dry, room: S.room, toasts: S.toasts.slice()};
    const out = {};
    try {
      window.__dlClear();
      S.toasts = []; S.room = 'chat'; render();
      DL.dry = true;
      // A cloud model is in and no local one; the stamps are the ones this pass has written.
      window.obReadiness = async () => ({cloudReady: true, localReady: false,
        stamps: Object.fromEntries(Object.keys(OB_STAMPED).map((k) => [k, 'smoke t104']))});
      window.obDetectAgents = async () => [{id: 'smoke-t104', label: 'Smoke T104 agent', dir: '/tmp/smoke-t104', enabled: false}];
      window.obBackendStatusText = () => Promise.resolve('backend: binary ok');
      window.obActivateLocal = async () => {};
      window.__obOpen('choose');
      OB.models = [{id: ID, name: 'Smoke T104 Model GGUF', size: '6.2 GB', sizeGb: 6.2, context: '32k',
        minRamGb: 4, recommendedRamGb: 8, downloaded: false}];
      OB.ram = 64;
      // The cloud route, then the cloud step's success — the line the add-provider wizard ends on in setup.
      window.__obKey(String(OB_CHOICES.findIndex((c) => c.id === 'cloud') + 1));
      out.cloudStep = OB.step;
      obDispatch({type: 'providers_wizard_succeeded'});
      await until(() => OB.step === 'propose_second', 20000);
      out.propose = {step: OB.step, offer: OB.offer, outcome: OB.outcome,
        rows: [...document.querySelectorAll('#onboarding .ob-row .t')].map(txt)};
      // "Set up local models too", the first row.
      window.__obKey('enter');
      await tick(150);
      out.pickStep = OB.step;
      const go = document.querySelector('#onboarding .ob-foot [data-obact="nav:go"]');
      out.button = go ? txt(go) : null;
      if (go) go.click();
      await until(() => !OB.open || OB.step === 'import_pick', 20000);
      await until(() => DL.job !== null, 5000);
      out.data = Object.assign({open: OB.open, step: OB.step, handOver: OB.handOver, outcome: OB.outcome,
        sources: OB.importAgents.map((a) => a.id), skip: txt(document.querySelector('#onboarding [data-obact="import:skip"]'))}, pull());
      // The import step's own way out.
      const skip = document.querySelector('#onboarding [data-obact="import:skip"]');
      if (skip) skip.click();
      await until(() => !OB.open, 20000);
      await tick(150);
      out.closed = Object.assign({open: OB.open, step: OB.step, handOver: OB.handOver, wizardInDom: !!document.getElementById('onboarding'),
        card: card(), reminder: reminder()}, pull());
      out.stamps = OB_STAMP_LOG.map((e) => ({leaf: e.leaf, step: e.step, owed: e.owed === true}));
      return out;
    } finally {
      window.obReadiness = keep.readiness; window.obDetectAgents = keep.detect;
      window.obBackendStatusText = keep.status; window.obActivateLocal = keep.activate;
      window.__dlClear(); DL.dry = keep.dry;
      try { localStorage.removeItem(KEY); } catch (e) { /* no storage */ }
      if (OB.open) window.__obClose();
      const gen = OB.openGen;
      Object.assign(OB, keep.ob, {open: false, settling: false, openGen: gen});
      for (const k of Object.keys(OB_STAMPED)) delete OB_STAMPED[k];
      Object.assign(OB_STAMPED, keep.stamped);
      OB_STAMP_LOG.length = 0; keep.log.forEach((e) => OB_STAMP_LOG.push(e));
      S.room = keep.room; S.toasts = keep.toasts; render();
    }
  })()`);
  const propose = r["propose"] as { step: string; offer: string | null; outcome: string | null; rows: string[] } | undefined;
  check(
    "T104: after the cloud step, setup offers local models too",
    r["cloudStep"] === "cloud" && !!propose && propose.step === "propose_second" && propose.offer === "local"
      && propose.outcome === "cloud" && propose.rows[0] === "Set up local models too",
    show({ cloudStep: r["cloudStep"], propose }),
  );
  const data = r["data"] as { open: boolean; step: string; handOver: boolean; outcome: string | null; sources: string[];
    skip: string; running: boolean; jobs: string[] } | undefined;
  check(
    "T104: Download on the local model goes on to the import step instead of closing setup, and the download keeps running",
    r["pickStep"] === "local_pick" && /^Download/.test(String(r["button"])) && !!data
      && data.open === true && data.step === "import_pick" && data.handOver === false && data.outcome === "cloud"
      && JSON.stringify(data.sources) === JSON.stringify(["smoke-t104"]) && data.skip !== ""
      && data.running === true && JSON.stringify(data.jobs) === JSON.stringify(["weights:smoke-t104-9b"]),
    show({ pickStep: r["pickStep"], button: r["button"], data }),
  );
  const closed = r["closed"] as { open: boolean; step: string; handOver: boolean; wizardInDom: boolean;
    card: { rows: { name: string; line: string }[] } | null; reminder: { id?: string; stamped?: boolean } | null;
    running: boolean; jobs: string[] } | undefined;
  const stamps = (r["stamps"] as { leaf: string; step: string; owed: boolean }[] | undefined) ?? [];
  check(
    "T104: skipping the import step closes setup with the download still going, in the card in the corner",
    !!closed && closed.open === false && closed.wizardInDom === false && closed.handOver === false
      && closed.running === true && JSON.stringify(closed.jobs) === JSON.stringify(["weights:smoke-t104-9b"])
      && !!closed.card && closed.card.rows.some((row) => /Smoke T104/.test(row.name)),
    show(closed),
  );
  check(
    "T104: the import step was offered once, setup is stamped complete on the cloud model, and the download is remembered for a quit",
    stamps.filter((e) => e.leaf === "importOfferedAt").length === 1
      && stamps.some((e) => e.leaf === "completedAt" && e.step === "finished" && e.owed === false)
      && !!closed && !!closed.reminder && closed.reminder.id === "smoke-t104-9b" && closed.reminder.stamped === true,
    show({ stamps, reminder: closed?.reminder }),
  );
}
