import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BrowserWindow } from "electron";

/**
 * Backlog 18, review follow-ups — the download card against the rest of the
 * window (see main/release-fixes-smoke.ts; t18.ts holds the item's own checks).
 * Run with `--smoke --smoke-task=18`.
 *
 *   F2 — the composer picker's download and a provider setup the card opens
 *        over it: its progress goes to its own line, and its landing leaves
 *        the setup (and the key being typed) alone; leaving the setup drops
 *        what it wrote and leaves nothing stale for the next chip click.
 *   F3 — the setup queue never loses a job: a Retry pressed while a new
 *        Download is still starting stays queued, and a Cancel takes only
 *        what depends on the cancelled job.
 *   F5 — a projector Cancel is honoured however early it comes (main) and
 *        however late (the renderer starts nothing after it).
 *   F6 — in a conversation the card does not cover the newest message or an
 *        approval's buttons, and it stands clear of the open inspector.
 *   F7 — a projector call that is rejected becomes a failed row with Retry.
 *
 * Nothing is downloaded and nothing restarts: the setup queue runs dry, the
 * composer pull and its landing go through the real `cli:pull` channel with
 * the local-model switch swapped for a recorder, and the one real projector
 * call answers from a file this check puts on disk (or is cancelled before
 * it reads it). window.atomic is frozen, so the stand-ins are the renderer's
 * own IPC-facing helpers (obBackendStatusText, obProjectorPull, SWXBR).
 *
 * T18B_SHOTS=<dir> also writes a conversation with an approval and the open
 * card at 1280×820, light and dark (and with the inspector open).
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Box = { top: number; bottom: number; left: number; right: number; width: number; height: number };
type Row = { name: string; line: string; cancel: string | null; retry: boolean };
type Card = { box: Box; title: string; count: string; folded: boolean; rows: Row[]; cloud: string } | null;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* Shared by every probe below: a tick, a box, the card as a person reads it. */
const HELPERS = String.raw`
  const tick = (ms) => new Promise((res) => setTimeout(res, ms));
  const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect();
    return {top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right),
      width: Math.round(r.width), height: Math.round(r.height)}; };
  const txt = (n) => (n ? (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const card = () => {
    const el = document.getElementById('dlcard');
    if (!el || el.hidden || !el.firstElementChild) return null;
    return {box: box(el.firstElementChild), title: txt(el.querySelector('.dlc-ttl > span')),
      count: txt(el.querySelector('.dlc-count, .dlc-n')), folded: !!el.querySelector('.dlc-badge'),
      rows: [...el.querySelectorAll('.dlc-row')].map((r) => ({name: txt(r.querySelector('.dlc-name')),
        line: txt(r.querySelector('.dlc-line')), cancel: (r.querySelector('.dlc-x') || {dataset: {}}).dataset.act || null,
        retry: !!r.querySelector('.dlc-retry')})),
      cloud: txt(el.querySelector('.dlc-cloud'))};
  };
  const jobs = () => ({job: DL.job ? DL.job.kind + ':' + DL.job.id + (DL.job.cancelled ? ':cancelled' : '') : null,
    queue: DL.queue.map((q) => q.kind + ':' + q.id), failed: DL.failed.map((f) => f.kind + ':' + f.id),
    preparing: DL.preparing ? DL.preparing.kind + ':' + DL.preparing.id : null});
`;

export async function checks18b(js: Js, check: Check): Promise<void> {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed()) ?? null;
  const size = w ? (w.getContentSize() as [number, number]) : null;
  try {
    if (w) await composerPull(js, check, w);
    await queue(js, check);
    await projector(js, check);
    await chatRoom(js, check, w);
    if (process.env["T18B_SHOTS"] && w) await shots(js, w, process.env["T18B_SHOTS"]);
  } finally {
    if (w && size && !w.isDestroyed()) { w.setContentSize(size[0], size[1]); await wait(300); }
    await js<unknown>(`(() => { if (window.__dlClear) window.__dlClear(); S.toasts = []; renderToasts();
      document.documentElement.removeAttribute('data-theme');
      try { const t = localStorage.getItem('atag.theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch (e) { /* follow macOS */ }
      render(); })()`);
  }
}

/* F2 — the composer picker's pull, the provider setup the card opens over
   it, and that pull landing while a key is being typed. */
async function composerPull(js: Js, check: Check, w: BrowserWindow): Promise<void> {
  const send = (ev: Record<string, unknown>) => w.webContents.send("cli:pull", ev);
  const ID = "smoke-t18b-sel";
  const HALF = "custom-smoke-t18b-invalid-v1";
  await js<unknown>(String.raw`(() => {
    window.__t18bKeep = {sel: SEL.pulling, line: SEL.pullLine, err: SEL.err, kind: SEL.kind,
      wiz: {phase: WIZ.phase, row: WIZ.row, unfinishedId: WIZ.unfinishedId, apiKey: WIZ.apiKey, baseUrl: WIZ.baseUrl,
        alone: WIZ.alone, error: WIZ.error, forId: WIZ.forId},
      local: S.localModel, pick: SWXBR.selectLocalModel, drop: window.wizRemoveIfIncomplete, room: S.room, draft: S.draft};
    window.__t18bCalls = [];
    // The landing selects the model: main's switch is a recorder, so nothing restarts.
    SWXBR.selectLocalModel = (id) => { window.__t18bCalls.push('select:' + id); return Promise.resolve({ok: true}); };
    // Leaving the setup drops the entry it wrote and never finished: recorded, not removed.
    window.wizRemoveIfIncomplete = (id) => { window.__t18bCalls.push('drop:' + id); return Promise.resolve(); };
    window.__dlClear(); act('close');
    S.room = 'chat'; S.draft = '';
    // The composer picker's Download: the pull is SEL's, and its popover shows it.
    SEL.pulling = ${JSON.stringify(ID)}; SEL.pullLine = 'starting…'; SEL.err = null;
    SEL.open = true; SEL.kind = 'model';
    render();
  })()`);
  try {
    await wait(150);
    const line1 = "[=====               ] 25%  1.00 GB / 4.00 GB  smoke-t18b";
    send({ id: ID, line: line1, kind: "weights", percent: 25, transferredBytes: 1073741824, totalBytes: 4294967296 });
    await wait(200);
    const own = await js<{ line: string }>(
      "({line: ((document.querySelector('#overlays .selpop .selpullline') || {}).textContent || '')})");
    // Closed, the pull goes on in the card — whose cloud link opens the provider setup.
    await js<unknown>("(() => { const s = document.querySelector('#overlays .scrim'); if (s) s.click(); })()");
    await wait(150);
    await js<unknown>("(() => { const c = document.querySelector('#dlcard .dlc-cloud'); if (c) c.click(); })()");
    await wait(200);
    const capsOf = `[...document.querySelectorAll('#overlays .selpop [data-wiz-kind] .cap')].map((n) => n.textContent)`;
    const before = await js<{ phase: string | null; caps: string[] }>(`({phase: WIZ.phase, caps: ${capsOf}})`);
    const line2 = "[==========          ] 50%  2.00 GB / 4.00 GB  smoke-t18b";
    send({ id: ID, line: line2, kind: "weights", percent: 50, transferredBytes: 2147483648, totalBytes: 4294967296 });
    await wait(200);
    const after = await js<{ caps: string[]; anywhere: boolean }>(`({caps: ${capsOf},
      anywhere: [...document.querySelectorAll('#overlays .popover *')].some((n) => n.children.length === 0 && n.textContent === ${JSON.stringify(line2)})})`);
    check(
      "T18-F2: a composer download's progress goes to its own line, never into the provider setup the card opens over it",
      own.line === line1 && before.phase === "pick_kind" && before.caps.length > 0
        && JSON.stringify(after.caps) === JSON.stringify(before.caps) && !after.anywhere,
      JSON.stringify({ own: own.line, phase: before.phase, before: before.caps.slice(0, 2), after: after.caps.slice(0, 2), anywhere: after.anywhere }),
    );

    // The person picks the custom endpoint and is typing its key. The entry an
    // earlier pass wrote (Back from the model step) is still unfinished.
    await js<unknown>(`(() => { const i = KIND_ROWS.findIndex((k) => k.custom);
      const r = document.querySelector('#overlays .selpop [data-wiz-kind="' + i + '"]'); if (r) r.click(); })()`);
    await wait(150);
    await js<unknown>(`(() => {
      WIZ.unfinishedId = ${JSON.stringify(HALF)};
      const type = (n, v) => { n.focus(); n.value = v; n.dispatchEvent(new Event('input', {bubbles: true})); };
      const u = document.getElementById('wiz-url'); if (u) type(u, 'https://smoke-t18b.invalid/v1');
      const k = document.getElementById('wiz-key'); if (k) { type(k, 'sk-smoke-t18b'); k.setSelectionRange(4, 4); }
    })()`);
    // The download lands.
    send({ id: ID, done: true, ok: true });
    await wait(600);
    const landed = await js<Record<string, unknown>>(`(() => { const k = document.getElementById('wiz-key');
      const u = document.getElementById('wiz-url');
      return {open: SEL.open, phase: WIZ.phase, pop: !!document.querySelector('#overlays .selpop'),
        url: u ? u.value : null, key: k ? k.value : null, focused: !!k && document.activeElement === k,
        caret: k ? k.selectionStart : null, pulling: SEL.pulling, unfinished: WIZ.unfinishedId,
        calls: window.__t18bCalls.slice()}; })()`);
    const calls = (landed["calls"] as string[]) ?? [];
    check(
      "T18-F2: that download landing while a key is typed selects the model and leaves the setup up — fields, focus and caret kept",
      landed["open"] === true && landed["pop"] === true && landed["phase"] === "configure"
        && landed["url"] === "https://smoke-t18b.invalid/v1" && landed["key"] === "sk-smoke-t18b"
        && landed["focused"] === true && landed["caret"] === 4 && landed["pulling"] === null
        && calls.includes(`select:${ID}`) && !calls.some((c) => c.startsWith("drop:")) && landed["unfinished"] === HALF,
      JSON.stringify(landed),
    );

    // Leaving it — a click outside, as Escape does — and the next chip click.
    await js<unknown>("(() => { const s = document.querySelector('#overlays .scrim'); if (s) s.click(); })()");
    await wait(200);
    const left = await js<Record<string, unknown>>(
      "({open: SEL.open, phase: WIZ.phase, unfinished: WIZ.unfinishedId, calls: window.__t18bCalls.slice()})");
    const chip = await js<string | null>(`(() => {
      const c = document.querySelector('#composer .cfoot [data-sel-open="model"]:not([data-sel-dl])')
        || document.querySelector('#composer .cfoot [data-sel-open]:not([data-sel-dl])');
      if (c) c.click();
      return c ? c.dataset.selOpen : null; })()`);
    await wait(300);
    const next = await js<Record<string, unknown>>(`({open: SEL.open, phase: WIZ.phase, kind: SEL.kind,
      wizard: !!document.querySelector('#overlays .selpop [data-wiz-kind], #overlays #wiz-key, #overlays #wiz-url'),
      title: ((document.querySelector('#overlays .selpop .selttl') || {}).textContent || '')})`);
    check(
      "T18-F2: leaving that setup drops the entry it never finished and clears it — the next chip click opens the chip's own popover",
      left["open"] === false && left["phase"] === null && left["unfinished"] === null
        && ((left["calls"] as string[]) ?? []).includes(`drop:${HALF}`)
        && !!chip && next["open"] === true && next["phase"] === null && next["wizard"] === false && next["kind"] === chip,
      JSON.stringify({ left, chip, next }),
    );

    // Every close of the selector (closeSelector — the custom-endpoint and
    // Download-more rows, a switch that lands with nothing over it) takes the
    // setup drawn in it along, as act('close') does.
    const HALF2 = `${HALF}-2`;
    const direct = await js<Record<string, unknown>>(`(() => {
      act('close');
      SEL.open = true; WIZ.row = KIND_ROWS.find((k) => k.custom); WIZ.phase = 'configure';
      WIZ.unfinishedId = ${JSON.stringify(HALF2)}; render();
      const up = !!document.querySelector('#overlays .selpop #wiz-key');
      closeSelector();
      return {up, open: SEL.open, phase: WIZ.phase, unfinished: WIZ.unfinishedId,
        pop: !!document.querySelector('#overlays .selpop'), calls: window.__t18bCalls.slice()}; })()`);
    check(
      "T18-F2: closing the selector closes the provider setup drawn in it — cleared and its unfinished entry dropped, nothing stale to reopen",
      direct["up"] === true && direct["open"] === false && direct["pop"] === false && direct["phase"] === null
        && direct["unfinished"] === null && ((direct["calls"] as string[]) ?? []).includes(`drop:${HALF2}`),
      JSON.stringify(direct),
    );
  } finally {
    await js<unknown>(`(() => { const k = window.__t18bKeep || {};
      WIZ.unfinishedId = null; act('close');
      SWXBR.selectLocalModel = k.pick; window.wizRemoveIfIncomplete = k.drop;
      SEL.pulling = k.sel || null; SEL.pullLine = k.line || ''; SEL.err = k.err || null; if (k.kind) SEL.kind = k.kind;
      Object.assign(WIZ, k.wiz || {});
      S.localModel = k.local; S.room = k.room || 'chat'; S.draft = k.draft || '';
      delete window.__t18bKeep; delete window.__t18bCalls; window.__dlClear(); render(); })()`);
  }
}

/* F3 — the setup queue: a Retry while a Download is still starting, and a
   Cancel that takes only what depends on the job it cancels. */
async function queue(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const keep = {status: window.obBackendStatusText, activate: window.obActivateLocal, room: S.room, managed: OB.managedWrite,
      pullStart: window.dlPullStart};
    const out = {};
    const press = async (sel) => { const n = document.querySelector(sel); if (n) n.click(); await tick(80); return n ? (n.dataset.act || true) : null; };
    try {
      window.__dlClear(); S.room = 'chat'; render();
      window.obActivateLocal = async () => {};
      OB.managedWrite = null;
      let release = null;
      window.obBackendStatusText = () => new Promise((res) => { release = res; });

      // (a) An earlier download failed; Download is pressed for another model,
      // and while it reads models status the failed one is retried.
      DL.dry = true;
      dlFail({kind:'weights', id:'smoke-t18b-old'}, 'smoke t18b: the connection was reset');
      const started = obStartLocalPull('smoke-t18b-new', false);
      await tick(80);
      out.preparing = Object.assign({card: card()}, jobs());
      await press('#dlcard .dlc-retry');
      out.retried = Object.assign({card: card()}, jobs());
      if (release) release('backend: binary ok');
      await started;
      await tick(80);
      out.started = Object.assign({card: card()}, jobs());

      // ... and the same, with the new download cancelled while it is still starting.
      window.__dlClear(); DL.dry = true; release = null;
      dlFail({kind:'weights', id:'smoke-t18b-old'}, 'smoke t18b: the connection was reset');
      const again = obStartLocalPull('smoke-t18b-new', false);
      await tick(80);
      await press('#dlcard .dlc-retry');
      out.prepAct = await press('#dlcard .dlc-row .dlc-x[data-act="dlc:cancel"]');
      if (release) release('backend: binary ok');
      await again;
      await tick(80);
      out.prepCancelled = Object.assign({card: card()}, jobs());

      // (b) The runtime runs for model A; B failed earlier and is retried behind them.
      window.__dlClear();
      window.__dlSeed([{kind:'runtime', id:'llama.cpp'}, {kind:'weights', id:'smoke-t18b-a'}]);
      dlFail({kind:'weights', id:'smoke-t18b-b'}, 'smoke t18b: failed earlier');
      render(); await tick(60);
      await press('#dlcard .dlc-retry');
      out.beforeCancel = jobs();
      out.cancelAct = await press('#dlcard .dlc-row .dlc-x[data-act="dlc:cancel"]');
      out.afterCancel = Object.assign({card: card()}, jobs());
      // The killed child exits non-zero: a cancel, not a failure.
      window.__dlFeed({id:'llama.cpp', kind:'runtime', done:true, ok:false, error:'models update exited with code null', sawProgress:false, upToDate:false});
      await tick(80);
      out.afterExit = Object.assign({card: card()}, jobs());

      // A model runs; the llama.cpp runtime failed earlier and is retried behind it.
      window.__dlClear();
      window.__dlSeed([{kind:'weights', id:'smoke-t18b-x'}]);
      dlFail({kind:'runtime', id:'llama.cpp'}, 'smoke t18b: the runtime failed');
      render(); await tick(60);
      await press('#dlcard .dlc-retry');
      await press('#dlcard .dlc-row .dlc-x[data-act="dlc:cancel"]');
      out.runtimeKept = Object.assign({card: card()}, jobs());
      window.__dlFeed({id:'smoke-t18b-x', done:true, ok:false, error:'download exited with code null'});
      await tick(80);
      out.runtimeRuns = Object.assign({card: card()}, jobs());

      // Two retries queued behind a running model; the first one runs and is cancelled.
      window.__dlClear();
      window.__dlSeed([{kind:'weights', id:'smoke-t18b-j'}]);
      dlFail({kind:'weights', id:'smoke-t18b-r1'}, 'smoke t18b: failed earlier');
      dlFail({kind:'weights', id:'smoke-t18b-r2'}, 'smoke t18b: failed earlier');
      render(); await tick(60);
      await press('#dlcard .dlc-retry');
      await press('#dlcard .dlc-retry');
      window.__dlFeed({id:'smoke-t18b-j', done:true, ok:true});
      await tick(80);
      out.retryRuns = jobs();
      await press('#dlcard .dlc-row .dlc-x[data-act="dlc:cancel"]');
      out.retryCancelled = jobs();
      window.__dlFeed({id:'smoke-t18b-r1', done:true, ok:false, error:'download exited with code null'});
      await tick(80);
      out.secondRuns = jobs();

      // (a) Main refuses the new Download's start (another pull got there first);
      // a Retry pressed while it was still starting is queued behind it.
      window.__dlClear(); release = null;
      const starts = [];
      window.dlPullStart = (job) => {
        starts.push(job.kind + ':' + job.id);
        return job.id === 'smoke-t18b-x2' ? Promise.resolve({ok: false, error: 'a download is already running'})
          : Promise.reject(new Error('smoke t18b: the bridge refused the call'));
      };
      DL.dry = false;   // the starts go to the stand-in above, never to main
      dlFail({kind:'weights', id:'smoke-t18b-y2'}, 'smoke t18b: failed earlier');
      const third = obStartLocalPull('smoke-t18b-x2', false);
      await tick(80);
      await press('#dlcard .dlc-retry');
      if (release) release('backend: binary ok');
      await third;
      await tick(150);
      out.refused = Object.assign({card: card(), starts: starts.slice(), busy: dlBusy()}, jobs());
      return out;
    } finally {
      window.obBackendStatusText = keep.status; window.obActivateLocal = keep.activate; OB.managedWrite = keep.managed;
      if (keep.pullStart) window.dlPullStart = keep.pullStart; else delete window.dlPullStart;
      window.__dlClear(); S.room = keep.room; render();
    }
  })()`);
  const lines = (c: Card) => (c ? c.rows.map((x) => x.line) : null);
  const started = r["started"] as { card: Card; job: string | null; queue: string[] };
  check(
    "T18-F3a: a Retry pressed while a new Download is still starting stays queued behind it — the queue is not overwritten",
    JSON.stringify(r["retried"].queue) === JSON.stringify(["weights:smoke-t18b-old"])
      && started.job === "weights:smoke-t18b-new" && JSON.stringify(started.queue) === JSON.stringify(["weights:smoke-t18b-old"])
      && JSON.stringify(lines(started.card)) === JSON.stringify(["Starting…", "Queued"]),
    JSON.stringify({ preparing: r["preparing"], retried: r["retried"], started: r["started"] }),
  );
  const pc = r["prepCancelled"] as { card: Card; job: string | null; queue: string[]; preparing: string | null };
  check(
    "T18-F3a: a Cancel on that new download while it is still starting leaves the retried one, which then runs",
    r["prepAct"] === "dlc:cancel" && pc.preparing === null && pc.job === "weights:smoke-t18b-old" && pc.queue.length === 0
      && JSON.stringify(lines(pc.card)) === JSON.stringify(["Starting…"]),
    JSON.stringify({ act: r["prepAct"], after: pc }),
  );
  const ac = r["afterCancel"] as { card: Card; job: string | null; queue: string[] };
  const ax = r["afterExit"] as { card: Card; job: string | null; queue: string[]; failed: string[] };
  check(
    "T18-F3b: Cancel on the running runtime takes the model it was fetched for, not a retried download behind them — that one runs next",
    JSON.stringify(r["beforeCancel"].queue) === JSON.stringify(["weights:smoke-t18b-a", "weights:smoke-t18b-b"])
      && r["cancelAct"] === "dlc:cancel" && ac.job === "runtime:llama.cpp:cancelled"
      && JSON.stringify(ac.queue) === JSON.stringify(["weights:smoke-t18b-b"])
      && ax.job === "weights:smoke-t18b-b" && ax.queue.length === 0 && ax.failed.length === 0
      && JSON.stringify(lines(ax.card)) === JSON.stringify(["Starting…"]),
    JSON.stringify({ before: r["beforeCancel"], afterCancel: ac, afterExit: ax }),
  );
  const rk = r["runtimeKept"] as { job: string | null; queue: string[] };
  const rr = r["runtimeRuns"] as { card: Card; job: string | null; queue: string[]; failed: string[] };
  check(
    "T18-F3b: a retried llama.cpp runtime queued behind a running model survives that model's Cancel and runs next",
    rk.job === "weights:smoke-t18b-x:cancelled" && JSON.stringify(rk.queue) === JSON.stringify(["runtime:llama.cpp"])
      && rr.job === "runtime:llama.cpp" && rr.queue.length === 0 && rr.failed.length === 0,
    JSON.stringify({ kept: rk, runs: rr }),
  );
  const q = (k: string) => r[k] as { job: string | null; queue: string[]; failed: string[] };
  check(
    "T18-F3b: a Cancel on a retried download takes only it — another Retry queued behind it runs next",
    q("retryRuns").job === "weights:smoke-t18b-r1" && JSON.stringify(q("retryRuns").queue) === JSON.stringify(["weights:smoke-t18b-r2"])
      && q("retryCancelled").job === "weights:smoke-t18b-r1:cancelled"
      && JSON.stringify(q("retryCancelled").queue) === JSON.stringify(["weights:smoke-t18b-r2"])
      && q("secondRuns").job === "weights:smoke-t18b-r2" && q("secondRuns").failed.length === 0,
    JSON.stringify({ runs: r["retryRuns"], cancelled: r["retryCancelled"], second: r["secondRuns"] }),
  );
  const rf = r["refused"] as { card: Card; starts: string[]; busy: boolean; job: string | null; queue: string[]; failed: string[] };
  check(
    "T18-F3a: a Download whose start main refuses is a failed row and the queue goes on — the Retry behind it is not left on Queued to refuse every later Download",
    JSON.stringify(rf.starts) === JSON.stringify(["weights:smoke-t18b-x2", "weights:smoke-t18b-y2"])
      && rf.job === null && rf.queue.length === 0 && rf.busy === false
      && JSON.stringify([...rf.failed].sort()) === JSON.stringify(["weights:smoke-t18b-x2", "weights:smoke-t18b-y2"])
      && !!rf.card && rf.card.rows.length === 2 && rf.card.rows.every((x) => x.retry),
    JSON.stringify(rf),
  );
}

/* F5 and F7 — the vision projector's Cancel and a rejected projector call. */
async function projector(js: Js, check: Check): Promise<void> {
  const ID = "custom-smoke-t18b";
  const FILE = "smoke-t18b-mmproj.gguf";
  const URL = `https://huggingface.co/smoke/t18b/resolve/main/${FILE}`;
  // Where main looks: `models status`'s data dir (read again if a loaded machine lets the CLI time out).
  type St = { ok?: boolean; status?: { dataDir?: string | null }; error?: string } | null;
  let st: St = null;
  for (let i = 0; i < 3 && !(st && st.ok && st.status && st.status.dataDir); i++) {
    st = await js<St>("window.atomic.modelsStatus()");
  }
  const dataDir = st && st.ok && st.status ? st.status.dataDir ?? null : null;
  const dir = dataDir ? join(dataDir, "models", ID) : null;
  /* The one real projector call below must never fetch anything: the file is
     put where main looks first, so a call that is not cancelled answers
     "already on disk" from it. */
  if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, FILE), "smoke t18b: not a projector\n"); }
  const onDisk = !!dir && existsSync(join(dir, FILE));
  try {
    // F5 (main): a Cancel while main is still reading `models status` for the projector.
    type Early = { cancel: unknown; res: { ok?: boolean; error?: string; alreadyPresent?: boolean } | null; ms: number };
    const early = onDisk ? await js<Early>(`(async () => {
      const t0 = Date.now();
      const p = window.atomic.hfProjector(${JSON.stringify(ID)}, ${JSON.stringify(URL)}, ${JSON.stringify(FILE)}, 'Smoke T18b');
      const cancel = await window.atomic.cancelPull();
      const res = await p;
      return {cancel, res, ms: Date.now() - t0};
    })()`) : null;
    check(
      "T18-F5: a projector Cancel pressed while main still reads models status reaches it — the download stops there, nothing is fetched",
      !!early && early.cancel === true && !!early.res && early.res.ok === false && /cancelled/.test(early.res.error ?? "")
        && !early.res.alreadyPresent,
      JSON.stringify({ dataDir, onDisk, early, status: dataDir ? undefined : st }),
    );

    // F5 (renderer): the Cancel came too late — the projector landed anyway.
    const late = await js<Record<string, any>>(String.raw`(async () => {
      ${HELPERS}
      const keep = {pull: window.obProjectorPull, activate: window.obActivateLocal, room: S.room};
      const calls = [];
      try {
        window.__dlClear(); S.room = 'chat'; render();
        window.obActivateLocal = async (id) => { calls.push('activate:' + id); };
        let release = null;
        window.obProjectorPull = () => new Promise((res) => { release = res; });
        obFetchProjector(${JSON.stringify(ID)}, {id: ${JSON.stringify(ID)}, mmprojUrl: ${JSON.stringify(URL)},
          mmprojFilename: ${JSON.stringify(FILE)}, name: 'Smoke T18b'});
        await tick(80);
        const out = {starting: card()};
        const x = document.querySelector('#dlcard .dlc-row .dlc-x');
        out.act = x ? x.dataset.act : null;
        if (x) x.click();
        await tick(80);
        out.cancelling = card();
        if (release) release({ok: true, path: '/smoke/t18b/' + ${JSON.stringify(FILE)}});
        for (let i = 0; i < 40 && DL.projector; i++) await tick(100);
        await tick(100);
        out.after = {card: card(), projector: !!DL.projector, failed: DL.failed.length, calls: calls.slice()};
        return out;
      } finally {
        if (keep.pull) window.obProjectorPull = keep.pull; else delete window.obProjectorPull;
        window.obActivateLocal = keep.activate;
        window.__dlClear(); S.room = keep.room; render();
      }
    })()`);
    const starting = late["starting"] as Card, cancelling = late["cancelling"] as Card;
    const lateAfter = late["after"] as { card: Card; projector: boolean; failed: number; calls: string[] };
    check(
      "T18-F5: a projector that lands after its Cancel does not start the model, and leaves no row behind",
      !!starting && /^Vision projector · Starting/.test(starting.rows[0]?.line ?? "")
        && !!cancelling && /Cancelling/.test(cancelling.rows[0]?.line ?? "")
        && lateAfter.calls.length === 0 && !lateAfter.projector && lateAfter.failed === 0 && lateAfter.card === null,
      JSON.stringify({ act: late["act"], starting, cancelling, after: lateAfter }),
    );

    // F7: the projector call itself is rejected.
    const rej = await js<Record<string, any>>(String.raw`(async () => {
      ${HELPERS}
      const keep = {activate: window.obActivateLocal, room: S.room, toasts: S.toasts.slice()};
      const calls = [];
      try {
        window.__dlClear(); S.room = 'chat'; S.toasts = []; render();
        window.obActivateLocal = async (id) => { calls.push('activate:' + id); };
        /* A name the bridge cannot clone: the real window.atomic.hfProjector
           rejects before anything reaches main, as it does when main's handler
           throws. Nothing is fetched. */
        const pending = {id:'custom-smoke-t18b-f7', mmprojUrl:'https://huggingface.co/smoke/t18b/resolve/main/f7.gguf',
          mmprojFilename:'f7.gguf', name: () => 'smoke t18b'};
        try { obFetchProjector('custom-smoke-t18b-f7', pending); } catch (e) { /* the stuck state is what is measured */ }
        for (let i = 0; i < 20 && DL.projector; i++) await tick(100);
        await tick(100);
        const out = {first: {card: card(), projector: !!DL.projector, seq: DL.failSeq,
          refused: !!(dlBusy() || DL.projector || SEL.pulling || LLMP.pulling)}};
        const retry = document.querySelector('#dlcard .dlc-retry');
        out.retry = !!retry;
        if (retry) retry.click();
        for (let i = 0; i < 20 && DL.projector; i++) await tick(100);
        await tick(100);
        out.second = {card: card(), projector: !!DL.projector, seq: DL.failSeq, toasts: S.toasts.map((t) => t.t), calls: calls.slice()};
        return out;
      } finally {
        window.obActivateLocal = keep.activate;
        window.__dlClear(); S.room = keep.room; S.toasts = keep.toasts; render();
      }
    })()`);
    const first = rej["first"] as { card: Card; projector: boolean; seq: number; refused: boolean };
    const second = rej["second"] as { card: Card; projector: boolean; seq: number; toasts: string[]; calls: string[] };
    check(
      "T18-F7: a rejected projector call becomes a failed row with Retry, and nothing is left on Starting… to refuse the next download",
      !first.projector && !first.refused && !!first.card && first.card.rows.length === 1 && first.card.rows[0]!.retry
        && /^Failed · /.test(first.card.rows[0]!.line) && first.card.title === "Download failed"
        && rej["retry"] === true && second.seq === first.seq + 1 && !second.projector
        && !second.toasts.includes("One download at a time") && second.calls.length === 0,
      JSON.stringify(rej),
    );
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/* F6 — a conversation ending on an approval, with the card open: at the
   default window and the smallest one, and with the inspector open. */
async function chatRoom(js: Js, check: Check, w: BrowserWindow | null): Promise<void> {
  type Hit = { box: Box | null; hit: boolean; at: string | null };
  type Geo = {
    width: number; height: number; scroller: Box | null; appr: Box | null; abort: Hit; allow: Hit; deny: Hit;
    card: Box | null; dock: Box | null; inspector: Box | null; stuck: boolean | null; room: string;
  };
  const cases: [number, number, boolean][] = [[1280, 820, false], [940, 620, false], [1280, 820, true]];
  for (const [cw, ch, inspector] of cases) {
    if (w) { w.setContentSize(cw, ch); await wait(500); }
    const r = await js<{ plain: Geo; withCard: Geo; gone: Geo; empty: Record<string, number | null>[] }>(String.raw`(async () => {
      ${HELPERS}
      const keep = {log: S.log, pending: S.pending, focused: S.apprFocused, stick: S.stick, insp: S.inspector,
        room: S.room, draft: S.draft, toasts: S.toasts.slice()};
      const measure = () => {
        const sc = document.getElementById('scroller');
        const appr = document.getElementById('apprcard');
        const btn = (sel) => {
          const n = appr && appr.querySelector(sel);
          const b = box(n);
          const hit = b ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null;
          return {box: b, hit: !!(hit && n && (hit === n || n.contains(hit))),
            at: hit ? (hit.id || (hit.getAttribute && hit.getAttribute('class')) || hit.tagName) : null};
        };
        const insp = document.getElementById('inspector');
        const c = card();
        return {width: innerWidth, height: innerHeight, scroller: box(sc), appr: box(appr),
          abort: btn('.apprabort'), allow: btn('[data-appr="y"]'), deny: btn('#denybtn'),
          card: c ? c.box : null, dock: box(document.querySelector('#content .composerwrap')),
          inspector: insp && insp.getBoundingClientRect().width > 0 ? box(insp) : null,
          stuck: sc ? sc.scrollHeight - sc.scrollTop - sc.clientHeight < 2 : null,
          room: getComputedStyle(document.documentElement).getPropertyValue('--dlcard-chat').trim()};
      };
      const emptyMarks = () => ({greeting: (box(document.querySelector('.emptyhead')) || {}).top ?? null,
        chips: (box(document.querySelector('.emptychat .ghost')) || {}).top ?? null,
        chipsRight: (box(document.querySelector('.emptychat .ghost')) || {}).right ?? null});
      try {
        window.__dlClear(); S.toasts = []; renderToasts();
        S.room = 'chat'; S.draft = ''; S.inspector = ${inspector ? "true" : "false"};
        // The empty chat first: the card's overlap there is left as it is.
        S.log = []; S.pending = null; render(); await tick(120);
        const empty = [emptyMarks()];
        window.__dlSeed([{kind:'runtime', id:'llama.cpp'}, {kind:'weights', id:'qwen-3.5-9b'}]);
        await tick(120);
        empty.push(emptyMarks());
        window.__dlClear(); await tick(80);
        // A conversation long enough to scroll, ending on an approval the agent waits on.
        const log = [];
        for (let i = 0; i < 6; i++) {
          log.push({id: nid(), k: 'user', text: 'smoke t18b: question ' + (i + 1) + ' about the files in this folder'});
          log.push({id: nid(), k: 'assistant', text: 'smoke t18b: answer ' + (i + 1)
            + ' — a reply long enough to wrap onto a second line in a narrow window, so the transcript scrolls past the card.'});
        }
        const req = {id: nid(), k: 'approval', approvalId: 'smoke-t18b-appr', tool: 'os.fs.write', cat: 'fs_write_workspace',
          kind: CATEGORY_LABEL.fs_write_workspace, lvl: 2, reason: 'smoke fixture', preview: '(no preview)', shape: '',
          affectsBase: 'notes.md', affectsDir: '', sessionGrants: false, sessionId: S.agentSession};
        log.push(req);
        S.log = log; S.pending = req; S.apprFocused = true; S.stick = true;
        render(); await tick(200);
        const plain = measure();
        // The two-job queue a fresh Mac gets: the tallest card the setup draws.
        window.__dlSeed([{kind:'runtime', id:'llama.cpp'}, {kind:'weights', id:'qwen-3.5-9b'}]);
        window.__dlFeed({id:'llama.cpp', kind:'runtime', percent:40, transferredBytes:30000000, totalBytes:75000000});
        await tick(300);
        const withCard = measure();
        window.__dlClear(); await tick(200);
        const gone = measure();
        return {plain, withCard, gone, empty};
      } finally {
        window.__dlClear();
        S.log = keep.log; S.pending = keep.pending; S.apprFocused = keep.focused; S.stick = keep.stick;
        S.inspector = keep.insp; S.room = keep.room; S.draft = keep.draft; S.toasts = keep.toasts; render();
      }
    })()`);
    const g = r.withCard;
    const tag = `${cw}×${ch}${inspector ? " with the inspector open" : ""}`;
    const c = g.card;
    const reach = !!c && g.abort.hit && g.allow.hit && g.deny.hit && !!g.appr && g.appr.bottom <= c.top
      && !!g.abort.box && !!g.scroller && g.abort.box.top >= g.scroller.top && g.stuck === true;
    if (!inspector) {
      const e = r.empty;
      check(
        `T18-F6: at ${tag}, in a conversation with the card open, the approval at its end sits above the card — a press on Abort run, Allow once and Deny reaches it`,
        g.width === cw && reach && r.plain.abort.hit && r.gone.abort.hit && r.gone.stuck === true
          && e.length === 2 && e[0]!["greeting"] !== null && e[0]!["greeting"] === e[1]!["greeting"] && e[0]!["chips"] === e[1]!["chips"],
        JSON.stringify({ card: c, appr: g.appr, abort: g.abort, allow: g.allow.hit, deny: g.deny.hit, scroller: g.scroller,
          stuck: g.stuck, room: g.room, plain: r.plain.abort.hit, gone: { hit: r.gone.abort.hit, stuck: r.gone.stuck, room: r.gone.room }, empty: e }),
      );
    } else {
      const i = g.inspector;
      check(
        `T18-F6: at ${tag} the card stands clear of the inspector and above the composer, and the approval stays within reach`,
        g.width === cw && !!i && !!c && c.right <= i.left - 8 && !!g.dock && c.bottom <= g.dock.top && reach,
        JSON.stringify({ card: c, inspector: i, dock: g.dock?.top, appr: g.appr, abort: g.abort, stuck: g.stuck, room: g.room }),
      );
    }
  }
}

/* For the product owner: the conversation with an approval and the open card
   at 1280×820, light and dark, and with the inspector open. Only with
   T18B_SHOTS set. */
async function shots(js: Js, w: BrowserWindow, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await js<unknown>(`(() => { window.__t18bShot = {log: S.log, pending: S.pending, focused: S.apprFocused, stick: S.stick,
    insp: S.inspector, room: S.room, draft: S.draft}; })()`);
  const stage = (theme: string, inspector: boolean) => js<unknown>(String.raw`(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});
    window.__dlClear(); S.toasts = []; renderToasts();
    S.room = 'chat'; S.draft = ''; S.inspector = ${inspector ? "true" : "false"};
    if (!OB.models.some((m) => m.id === 'qwen-3.5-9b')) OB.models = OB.models.concat([{id:'qwen-3.5-9b', name:'Qwen 3.5 9B'}]);
    const log = [
      {id: nid(), k: 'user', text: 'What is in this folder?'},
      {id: nid(), k: 'assistant', text: 'Three things: a notes file, a drafts folder with four documents, and a script that renames photos by the date they were taken.'},
      {id: nid(), k: 'user', text: 'Add a line to the notes file saying the drafts are ready for review.'},
      {id: nid(), k: 'assistant', text: 'I will append one line to notes.md. Writing to a file needs your OK first.'},
    ];
    const req = {id: nid(), k: 'approval', approvalId: 'smoke-t18b-shot', tool: 'os.fs.write', cat: 'fs_write_workspace',
      kind: CATEGORY_LABEL.fs_write_workspace, lvl: 2, reason: 'append a line to notes.md', preview: '(no preview)', shape: '',
      affectsBase: 'notes.md', affectsDir: '', sessionGrants: false, sessionId: S.agentSession};
    log.push(req);
    S.log = log; S.pending = req; S.apprFocused = true; S.stick = true;
    window.__dlSeed([{kind:'runtime', id:'llama.cpp'}, {kind:'weights', id:'qwen-3.5-9b'}]);
    window.__dlFeed({id:'llama.cpp', kind:'runtime', percent:60, transferredBytes:Math.round(0.6 * 70 * 1048576), totalBytes:70 * 1048576});
    render();
    await tick(400);
  })()`);
  const cases: [string, string, boolean][] = [
    ["chat-approval-card-light.png", "light", false],
    ["chat-approval-card-dark.png", "dark", false],
    ["chat-approval-card-inspector-light.png", "light", true],
  ];
  const [nw, nh] = w.getContentSize();
  if (nw !== 1280 || nh !== 820) { w.setContentSize(1280, 820); await wait(500); }
  /* An occluded window stops painting and capturePage returns its last frame
     (other windows cover this one while several smokes run side by side): as
     the main suite's screenshot does, it is brought up and repainted first. */
  const throttled = w.webContents.getBackgroundThrottling();
  w.webContents.setBackgroundThrottling(false);
  // Brought up without taking the keyboard from whatever the person is typing into.
  w.showInactive();
  w.moveTop();
  try {
    for (const [file, theme, inspector] of cases) {
      await stage(theme, inspector);
      w.webContents.invalidate();
      await wait(500);
      const img = await w.webContents.capturePage();
      writeFileSync(join(dir, file), img.toPNG());
    }
  } finally {
    w.webContents.setBackgroundThrottling(throttled);
  }
  await js<unknown>(`(() => { const k = window.__t18bShot || {}; window.__dlClear();
    S.log = k.log || []; S.pending = k.pending || null; S.apprFocused = !!k.focused; S.stick = k.stick !== false;
    S.inspector = !!k.insp; S.room = k.room || 'chat'; S.draft = k.draft || ''; delete window.__t18bShot; render(); })()`);
}
