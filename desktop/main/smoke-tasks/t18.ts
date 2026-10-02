import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BrowserWindow } from "electron";

import { configGet, configSetWhole } from "../agent-cli.js";

/**
 * Release-fix checks for backlog item 18 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=18`.
 *
 * 18 — "why am I sitting here". First-run Download parked the person on a
 * "Downloading your model" screen for minutes, and the #dlbar strip that
 * carried the download afterwards was a flex child between the toolbar and
 * the chat: the whole chat jumped down ~46px when it came and back up when
 * it went. Download now hands over the agent at once — the same hand-over
 * as "Start using the agent now" — and the download lives in a card floating
 * in the window's bottom-right corner (Atomic Chat's DownloadPanel).
 *
 * Nothing is downloaded and nothing restarts: the queue runs dry (DL.dry —
 * no child is spawned), `models status` and the activation are swapped for
 * recorders, the flow is the test jump (testClose — no closing write, no
 * agent bounce), and everything touched is put back. The card is read off
 * the DOM, not through a hook, so the same checks run against a build
 * without it and say what is missing.
 *
 * T18_SHOTS=<dir> also writes the card's screenshots there (light and dark,
 * open and folded) for the product owner.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Box = { top: number; bottom: number; left: number; right: number; width: number; height: number };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* The `tui.onboarding.*` stamps in this lane's own config file, read and put
   back whole — the hand-over below takes the real closing path, which writes
   them (the same snapshot-and-restore main.ts's onboardingTest does). */
type CfgTui = { tui?: { onboarding?: Record<string, unknown> } } & Record<string, unknown>;
async function readStamps(): Promise<Record<string, unknown> | null> {
  const r = await configGet();
  return r.ok && r.config ? { ...((r.config as CfgTui).tui?.onboarding ?? {}) } : null;
}
async function writeStamps(block: Record<string, unknown>): Promise<boolean> {
  const r = await configGet();
  if (!r.ok || !r.config) return false;
  const next = JSON.parse(JSON.stringify(r.config)) as CfgTui;
  next.tui = { ...(next.tui ?? {}), onboarding: block };
  return (await configSetWhole(next)).ok;
}

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
        retry: !!r.querySelector('.dlc-retry'), switch: !!r.querySelector('.dlc-switch')})),
      cloud: txt(el.querySelector('.dlc-cloud'))};
  };
  const strip = () => { const s = document.getElementById('dlbar'); return !!(s && !s.hidden && s.getBoundingClientRect().height > 0); };
  // A first run's route: managed local with no model chosen yet — where a landed model starts by itself.
  const firstRunRoute = (cfg) => {
    const lm = Object.assign({}, (cfg && cfg.localModels) || {}, {mode: 'managed'});
    lm.managed = Object.assign({}, lm.managed || {}, {modelId: null});
    return Object.assign({}, cfg || {}, {localModels: lm});
  };
`;

export async function checks18(js: Js, check: Check): Promise<void> {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed()) ?? null;
  const size = w ? (w.getContentSize() as [number, number]) : null;
  try {
    await handOver(js, check);
    await resumeAfterQuit(js, check);
    await geometry(js, check, w);
    await controls(js, check);
    if (w) await otherPulls(js, check, w);
    await readyRow(js, check);
    await heldStart(js, check);
    await setupRowRemoval(js, check);
    await switchBehindRuntime(js, check);
    await setupDoneElsewhere(js, check);
    if (process.env["T18_SHOTS"] && w) await shots(js, w, process.env["T18_SHOTS"]);
  } finally {
    if (w && size && !w.isDestroyed()) { w.setContentSize(size[0], size[1]); await wait(300); }
    await js<unknown>(`(() => { if (window.__dlClear) window.__dlClear(); S.toasts = []; renderToasts();
      document.documentElement.removeAttribute('data-theme');
      try { const t = localStorage.getItem('atag.theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch (e) { /* follow macOS */ }
      render(); })()`);
  }
}

/* (a) Download in the wizard closes it on the chat, with the card carrying
   the queued model; the model is still started when its weights land. */
async function handOver(js: Js, check: Check): Promise<void> {
  const stampsBefore = await readStamps();
  try {
    await handOverRun(js, check);
  } finally {
    if (stampsBefore) await writeStamps(stampsBefore);
  }
}

async function handOverRun(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const keep = {ob: Object.assign({}, OB), stamped: Object.assign({}, OB_STAMPED), log: OB_STAMP_LOG.slice(),
      status: window.obBackendStatusText, activate: window.obActivateLocal, dry: DL.dry, room: S.room, toasts: S.toasts.slice(),
      cfg: LIVE_CONFIG, refresh: window.refreshLiveConfig};
    const calls = [];
    const out = {};
    try {
      window.__dlClear();
      LIVE_CONFIG = firstRunRoute(keep.cfg);
      // The closing path re-reads the config; the staged first-run route has to outlive that.
      window.refreshLiveConfig = () => Promise.resolve();
      S.toasts = []; S.room = 'chat'; render();
      DL.dry = true;
      // A machine with no llama.cpp yet: the runtime is queued in front of the weights.
      window.obBackendStatusText = () => { calls.push('status'); return Promise.resolve('backend: binary missing'); };
      window.obActivateLocal = async (id) => { calls.push('activate:' + id); };
      OB.models = [{id:'smoke-t18-9b', name:'Smoke Model 9B GGUF', size:'6.2 GB', sizeGb:6.2, context:'32k',
        minRamGb:4, recommendedRamGb:8, downloaded:false}];
      OB.ram = 64;
      window.__obOpen('local_pick', {stamped:['localSetupSeenAt']});
      /* The real closing path, toast included — the test jump's testClose
         returns before the toast line, which is how this check once passed
         with the toast's guard gone. restarted: no agent bounce. */
      OB.testClose = false; OB.restarted = true;
      await tick(150);
      const go = document.querySelector('#onboarding .ob-foot [data-obact="nav:go"]');
      out.button = go ? txt(go) : null;
      if (go) go.click();
      for (let i = 0; i < 200 && OB.open; i++) await tick(100);   // up to 20 s: obSettle reads twice first, slow on a busy Mac
      await tick(150);
      out.open = OB.open; out.step = OB.step; out.wizardInDom = !!document.getElementById('onboarding');
      out.handOver = OB.handOver; out.outcome = OB.outcome; out.skipSecond = OB.skipSecondOffer;
      out.composer = !!document.getElementById('composer') && S.room === 'chat';
      out.card = card(); out.strip = strip();
      out.queue = (DL.job ? [DL.job.kind + ':' + DL.job.id] : []).concat(DL.queue.map((q) => q.kind + ':' + q.id));
      out.toastCarried = typeof obClosingToastCarried === 'function' ? obClosingToastCarried('local') : null;
      out.toasts = S.toasts.map((t) => t.t);
      // The flow closed through its closing write, not the test jump's early return.
      out.closedForReal = OB_STAMP_LOG.some((e) => e.step === 'finished' && e.written === true)
        || OB_STAMP_LOG.some((e) => e.step === 'finished' && e.owed === true);
      out.chip = txt(document.querySelector('#composer .pullchip'));
      // The runtime lands, then the weights move: the queue drains onto the model.
      window.__dlFeed({id:'llama.cpp', kind:'runtime', done:true, ok:true, sawProgress:true, upToDate:false});
      window.__dlFeed({id:'smoke-t18-9b', kind:'weights', percent:41, transferredBytes:2684354560, totalBytes:6657199308});
      await tick(60);
      out.moving = card();
      // ... and land, with the queue no longer dry: the activation is the shipped path.
      out.callsBeforeLand = calls.slice();
      DL.dry = false;
      window.__dlFeed({id:'smoke-t18-9b', done:true, ok:true});
      await tick(100);
      out.calls = calls.slice();
      out.after = card();
      out.toastCarriedIdle = typeof obClosingToastCarried === 'function' ? obClosingToastCarried('local') : null;
      return out;
    } finally {
      window.obBackendStatusText = keep.status; window.obActivateLocal = keep.activate;
      window.__dlClear(); DL.dry = keep.dry; LIVE_CONFIG = keep.cfg; window.refreshLiveConfig = keep.refresh;
      if (OB.open) window.__obClose();
      const gen = OB.openGen;
      Object.assign(OB, keep.ob, {open: false, settling: false, openGen: gen});
      for (const k of Object.keys(OB_STAMPED)) delete OB_STAMPED[k];
      Object.assign(OB_STAMPED, keep.stamped);
      OB_STAMP_LOG.length = 0; keep.log.forEach((e) => OB_STAMP_LOG.push(e));
      S.room = keep.room; S.toasts = keep.toasts; render();
    }
  })()`);
  const c = r["card"] as { rows: { name: string; line: string }[]; title: string; count: string } | null;
  check(
    "T18a: Download in the wizard closes setup at once and lands on the chat — the same hand-over as Start using the agent now",
    r["button"] === "Download 6.2 GB" && r["open"] === false && r["wizardInDom"] === false && r["composer"] === true
      && r["handOver"] === true && r["outcome"] === "local" && r["skipSecond"] === true,
    JSON.stringify({ button: r["button"], open: r["open"], step: r["step"], handOver: r["handOver"], outcome: r["outcome"], composer: r["composer"] }),
  );
  check(
    "T18a: the card in the corner shows the queued download — llama.cpp runtime, then the model by its own name",
    !!c && c.title === "Downloading" && c.count === "2" && c.rows.length === 2
      && c.rows[0]!.name === "llama.cpp runtime" && /^Starting/.test(c.rows[0]!.line)
      && c.rows[1]!.name === "Smoke Model 9B" && c.rows[1]!.line === "Queued"
      && JSON.stringify(r["queue"]) === JSON.stringify(["runtime:llama.cpp", "weights:smoke-t18-9b"])
      && /Downloading Smoke Model 9B/.test(String(r["chip"])),
    JSON.stringify({ card: c, queue: r["queue"], chip: r["chip"] }),
  );
  const moving = r["moving"] as { rows: { name: string; line: string }[] } | null;
  check(
    "T18a: as the weights move the row reads \"2.5 of 6.2 GB · 41% · …\"",
    !!moving && moving.rows.length === 1 && moving.rows[0]!.name === "Smoke Model 9B"
      && /^2\.5 of 6\.2 GB · 41% · /.test(moving.rows[0]!.line),
    JSON.stringify(moving),
  );
  check(
    "T18a: the model is still started when its weights land, and the card goes",
    JSON.stringify(r["callsBeforeLand"]) === JSON.stringify(["status"])
      && JSON.stringify(r["calls"]) === JSON.stringify(["status", "activate:smoke-t18-9b"]) && r["after"] === null,
    JSON.stringify({ before: r["callsBeforeLand"], after: r["calls"], card: r["after"] }),
  );
  check(
    "T18a: no \"Your model is downloading\" toast over the card — while it is up it says so itself (the real closing path)",
    r["toastCarried"] === true && r["toastCarriedIdle"] === false && r["closedForReal"] === true
      && !(r["toasts"] as string[]).some((t) => t === "Your model is downloading" || t === "Setup complete"),
    JSON.stringify({ carried: r["toastCarried"], idle: r["toastCarriedIdle"], closedForReal: r["closedForReal"], toasts: r["toasts"] }),
  );
}

/* R1 (review): Download hands over at once, so it must not stamp setup
   complete while the model is still coming down — a quit at 30% then left
   the next launch with no wizard, no download and no model. Now the stamp
   waits for the weights, the download is remembered, and the next launch
   resumes it in the card (`atag models pull` resumes a partial file). The
   relaunch is the boot gate itself (obBootGate) run on a cleared download,
   the state a quit leaves; the stamps are this lane's real config file. */
async function resumeAfterQuit(js: Js, check: Check): Promise<void> {
  const stampsBefore = await readStamps();
  try {
    if (stampsBefore) await writeStamps({ ...stampsBefore, completedAt: null, skippedAt: null });
    await resumeAfterQuitRun(js, check);
  } finally {
    if (stampsBefore) await writeStamps(stampsBefore);
  }
}

async function resumeAfterQuitRun(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const keep = {ob: Object.assign({}, OB), stamped: Object.assign({}, OB_STAMPED), log: OB_STAMP_LOG.slice(),
      status: window.obBackendStatusText, activate: window.obActivateLocal, open: window.openOnboarding,
      dry: DL.dry, room: S.room, toasts: S.toasts.slice(), cfg: LIVE_CONFIG, refresh: window.refreshLiveConfig};
    const KEY = 'atag.setupDownload';
    const marker = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return 'unreadable'; } };
    const stamp = async () => { const c = await window.atomic.configGet();
      return ((((c && c.config) || {}).tui || {}).onboarding || {}).completedAt || null; };
    const queue = () => [DL.preparing, DL.job].concat(DL.queue).filter(Boolean).map((j) => j.kind + ':' + j.id);
    const calls = [];
    const out = {};
    try {
      window.__dlClear();
      try { localStorage.removeItem(KEY); } catch (e) { /* no storage */ }
      LIVE_CONFIG = firstRunRoute(keep.cfg);
      window.refreshLiveConfig = () => Promise.resolve();
      S.toasts = []; S.room = 'chat'; render();
      DL.dry = true;
      window.obBackendStatusText = () => { calls.push('status'); return Promise.resolve('backend: binary missing'); };
      window.obActivateLocal = async (id) => { calls.push('activate:' + id); };
      OB.models = [{id:'smoke-t18-9b', name:'Smoke Model 9B GGUF', size:'6.2 GB', sizeGb:6.2, context:'32k',
        minRamGb:4, recommendedRamGb:8, downloaded:false}];
      OB.ram = 64;
      window.__obOpen('local_pick', {stamped:['localSetupSeenAt']});
      OB.testClose = false; OB.restarted = true;
      await tick(150);
      const go = document.querySelector('#onboarding .ob-foot [data-obact="nav:go"]');
      if (go) go.click();
      for (let i = 0; i < 200 && OB.open; i++) await tick(100);   // up to 20 s: obSettle reads twice first, slow on a busy Mac
      await tick(150);
      out.handedOver = {open: OB.open, stamp: await stamp(), marker: marker(), queue: queue()};
      // Quit here. The next launch: the download in memory is gone, the file and the reminder are not.
      const kept = localStorage.getItem(KEY);
      window.__dlClear();
      if (kept !== null) localStorage.setItem(KEY, kept);
      // __dlClear lets the queue spawn again: the resumed one stays dry, nothing is downloaded.
      DL.dry = true;
      calls.length = 0;
      let opened = 0;
      window.openOnboarding = function () { opened++; };
      out.gate = typeof obBootGate === 'function';
      if (out.gate) await obBootGate(FIRSTRUN);
      for (let i = 0; i < 400 && !DL.job; i++) await tick(50);   // up to 20 s
      window.openOnboarding = keep.open;
      out.relaunch = {opened, calls: calls.slice(), queue: queue(), card: card()};
      // The download finishes in the relaunched app: now setup is complete.
      window.__dlFeed({id:'llama.cpp', kind:'runtime', done:true, ok:true, sawProgress:true, upToDate:false});
      out.beforeLand = await stamp();
      DL.dry = false;
      window.__dlFeed({id:'smoke-t18-9b', done:true, ok:true});
      await tick(100);
      let landed = await stamp();
      for (let i = 0; i < 130 && !landed; i++) { await tick(150); landed = await stamp(); }   // up to 20 s
      out.landed = {stamp: landed, marker: marker(), calls: calls.slice(), card: card()};
      // And a setup download that is cancelled is not resumed next time.
      window.__dlSeed([{kind:'weights', id:'smoke-t18-9b'}]);
      if (typeof obSetupPullRemember === 'function') obSetupPullRemember('smoke-t18-9b');
      const remembered = marker();
      const x = document.querySelector('#dlcard .dlc-row .dlc-x[data-act="dlc:cancel"]');
      if (x) x.click();
      await tick(80);
      out.cancelled = {before: remembered, after: marker()};
      return out;
    } finally {
      window.obBackendStatusText = keep.status; window.obActivateLocal = keep.activate; window.openOnboarding = keep.open;
      window.__dlClear(); DL.dry = keep.dry; LIVE_CONFIG = keep.cfg; window.refreshLiveConfig = keep.refresh;
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
  const h = r["handedOver"] as { open: boolean; stamp: string | null; marker: { id?: string } | null; queue: string[] };
  check(
    "T18 R1: Download hands over without stamping setup complete — the model is not on disk yet — and remembers the download",
    h.open === false && h.stamp === null && !!h.marker && h.marker.id === "smoke-t18-9b"
      && h.queue.includes("weights:smoke-t18-9b"),
    JSON.stringify(h),
  );
  const re = r["relaunch"] as { opened: number; calls: string[]; queue: string[]; card: { rows: { name: string }[] } | null };
  check(
    "T18 R1: after a quit mid-download the next launch resumes it in the card, rather than leaving no model and no download",
    r["gate"] === true && re.opened === 0 && re.calls.includes("status")
      && re.queue.includes("weights:smoke-t18-9b") && !!re.card && re.card.rows.some((x) => x.name === "Smoke Model 9B"),
    JSON.stringify({ gate: r["gate"], ...re }),
  );
  const l = r["landed"] as { stamp: string | null; marker: unknown; calls: string[] };
  check(
    "T18 R1: when the weights land setup is stamped complete, the reminder goes, and the model starts",
    r["beforeLand"] === null && typeof l.stamp === "string" && l.marker === null && l.calls.includes("activate:smoke-t18-9b"),
    JSON.stringify({ beforeLand: r["beforeLand"], ...l }),
  );
  const cx = r["cancelled"] as { before: { id?: string } | null; after: unknown };
  check(
    "T18 R1: a setup download that is cancelled is not resumed on the next launch",
    !!cx.before && cx.before.id === "smoke-t18-9b" && cx.after === null,
    JSON.stringify(cx),
  );
}

/* (b)(c)(d) Where the card stands, at the smallest window and at the
   default one; that the chat does not move when it comes and goes (a
   conversation it would cover only lifts clear of it); that there is no
   strip; that toasts stay readable above it. */
async function geometry(js: Js, check: Check, w: BrowserWindow | null): Promise<void> {
  type Geo = {
    width: number; height: number; card: { box: Box } | null; folded: { box: Box } | null; strip: boolean;
    composer: Box | null; dock: Box | null; send: Box | null; chips: Box | null; toolbar: Box | null; main: Box | null;
    sendHit: boolean; chipHit: boolean; still: Record<string, number | null>[]; stillChat: Record<string, number | null>[];
    toasts: { shown: number; hidden: number; lowest: number; newest: boolean; limit: number } | null;
  };
  const sizes: [number, number][] = [[940, 620], [1280, 820]];
  for (const [cw, ch] of sizes) {
    if (w) { w.setContentSize(cw, ch); await wait(500); }
    const g = await js<Geo>(String.raw`(async () => {
      ${HELPERS}
      const keep = {room: S.room, log: S.log, toasts: S.toasts.slice(), console: S.console};
      const out = {width: innerWidth, height: innerHeight};
      // Where everything in the chat column is, to the pixel.
      const marks = () => ({main: (box(document.getElementById('main')) || {}).top ?? null,
        scroller: (box(document.getElementById('scroller')) || {}).top ?? null,
        composer: (box(document.getElementById('composer')) || {}).top ?? null,
        greeting: (box(document.querySelector('.emptyhead')) || {}).top ?? null,
        first: (box(document.querySelector('#scroller .turn')) || {}).top ?? null});
      // The card comes, folds, opens and goes; the chat is measured at each step.
      const cycle = async () => {
        const still = [marks()];
        window.__dlSeed([{kind:'runtime', id:'llama.cpp'}, {kind:'weights', id:'qwen-3.5-9b'}]);
        window.__dlFeed({id:'llama.cpp', kind:'runtime', percent:40, transferredBytes:30000000, totalBytes:75000000});
        await tick(120);
        still.push(marks());
        const f = document.querySelector('#dlcard .dlc-fold');
        if (f) f.click();
        await tick(80);
        still.push(marks());
        const b = document.querySelector('#dlcard .dlc-badge');
        if (b) b.click();
        await tick(80);
        still.push(marks());
        window.__dlClear();
        await tick(120);
        still.push(marks());
        return still;
      };
      try {
        window.__dlClear();
        S.toasts = []; S.room = 'chat'; render();
        await tick(120);
        // On the empty chat, and in a conversation.
        out.still = await cycle();
        S.log = [{id: nid(), k:'user', text:'smoke t18: what is in this folder?'},
          {id: nid(), k:'assistant', text:'smoke t18: a reply long enough to wrap onto a second line when the window is narrow, which is exactly when a strip pushing the chat down would show.'}];
        render();
        await tick(150);
        out.stillChat = await cycle();
        S.log = keep.log; render();
        await tick(120);
        // The two-job queue a fresh Mac gets, the runtime 40% of the way.
        window.__dlSeed([{kind:'runtime', id:'llama.cpp'}, {kind:'weights', id:'qwen-3.5-9b'}]);
        window.__dlFeed({id:'llama.cpp', kind:'runtime', percent:40, transferredBytes:30000000, totalBytes:75000000});
        await tick(120);
        out.card = card(); out.strip = strip();
        const comp = document.getElementById('composer');
        out.composer = box(comp);
        out.dock = box(document.querySelector('#content .composerwrap'));
        const send = document.querySelector('#composer .sendbtn');
        out.send = box(send);
        out.chips = box(document.querySelector('#composer .cfoot'));
        out.toolbar = box(document.getElementById('toolbar'));
        out.main = box(document.getElementById('main'));
        // A press on the send button and on the last chip reaches them, not the card.
        const hit = (b, sel) => { if (!b) return false; const n = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return !!(n && n.closest(sel)); };
        out.sendHit = hit(out.send, '.sendbtn');
        const chipEls = [...document.querySelectorAll('#composer .cfoot .cchip')];
        out.chipHit = chipEls.length > 0 && chipEls.every((n) => hit(box(n), '.cchip'));
        // Folded, the badge stands in the same corner.
        const fold = document.querySelector('#dlcard .dlc-fold');
        if (fold) fold.click();
        await tick(80);
        const badge = document.querySelector('#dlcard .dlc-badge');
        out.folded = badge ? {box: box(badge)} : null;
        if (badge) badge.click();
        await tick(80);
        // Toasts, with the card up: a short window holding five at once.
        for (let i = 0; i < 5; i++) toast('Smoke t18 toast ' + (i + 1), 'A second line, so it is as tall as most toasts are.');
        await tick(300);
        const live = [...document.querySelectorAll('#toasts > .toast')].filter((n) => !n.classList.contains('out'));
        const shown = live.filter((n) => !n.hidden && n.getBoundingClientRect().height > 0);
        const cardTop = (card() || {box: {top: 0}}).box.top;
        out.toasts = {shown: shown.length, hidden: live.length - shown.length, limit: cardTop,
          lowest: Math.round(Math.max(0, ...shown.map((n) => n.getBoundingClientRect().bottom))),
          newest: shown.length > 0 && shown[shown.length - 1] === live[live.length - 1]};
        S.toasts = []; renderToasts();
        window.__dlClear();
        return out;
      } finally {
        window.__dlClear();
        S.room = keep.room; S.log = keep.log; S.toasts = keep.toasts; render();
      }
    })()`);
    const tag = `${g.width}×${g.height}`;
    const c = g.card?.box ?? null;
    const corner = !!c && Math.abs(c.right - (g.width - 16)) <= 1 && c.top >= (g.toolbar?.bottom ?? 0);
    const clear = !!c && !!g.composer && !!g.dock && c.bottom <= g.dock.top && c.bottom <= g.composer.top
      && !!g.send && c.bottom <= g.send.top && g.sendHit && g.chipHit;
    check(
      `T18b: at ${tag} the card is in the bottom-right corner, above the composer — the send button and the chips are not under it`,
      g.width === cw && corner && clear,
      JSON.stringify({ card: c, composer: g.composer, dock: g.dock?.top, send: g.send, sendHit: g.sendHit, chipHit: g.chipHit, toolbar: g.toolbar?.bottom }),
    );
    const f = g.folded?.box ?? null;
    check(
      `T18b: at ${tag} folded, the round badge holds the same corner, above the composer`,
      !!f && f.width === 44 && f.height === 44 && Math.abs(f.right - (g.width - 16)) <= 1 && !!g.dock && f.bottom <= g.dock.top,
      JSON.stringify({ badge: f, dock: g.dock?.top }),
    );
    const steady = (s: Record<string, number | null>[], keys = ["main", "scroller", "composer", "greeting", "first"]) => s.length === 5
      && keys.every((k) => s.every((m) => m[k] === s[0]![k]));
    /* Chat review Д19: the transcript sits on the composer now, so a
       conversation the card would cover lifts clear of it when the card comes
       and settles back when it goes (marks 1–3 with the card, 0 and 4
       without); folding and opening the card move nothing, and the empty chat
       does not move at all. */
    const chat = g.stillChat;
    const first = (i: number) => chat[i]?.["first"] ?? null;
    const lifted = chat.length === 5 && first(0) !== null && first(1) === first(2) && first(2) === first(3)
      && first(4) === first(0) && (first(1) ?? 0) <= (first(0) ?? 0);
    check(
      `T18c: at ${tag} the empty chat does not move when the card comes, folds, opens and goes; a conversation only lifts clear of it, and folding or opening moves nothing`,
      steady(g.still) && g.still[0]!["greeting"] !== null && steady(chat, ["main", "scroller", "composer"]) && lifted
        && g.still[0]!["composer"] !== null,
      JSON.stringify({ empty: g.still[0], chat: g.stillChat[0], firsts: [0, 1, 2, 3, 4].map(first), moved: [...g.still, ...g.stillChat].filter((m, i, a) =>
        JSON.stringify(m) !== JSON.stringify(i < g.still.length ? g.still[0] : g.stillChat[0])) }),
    );
    check(
      `T18d: at ${tag} there is no download strip between the toolbar and the chat while the card shows`,
      g.strip === false && !!g.main && !!g.toolbar && g.main.top === g.toolbar.bottom && !!c,
      JSON.stringify({ strip: g.strip, toolbar: g.toolbar?.bottom, main: g.main?.top }),
    );
    const t = g.toasts;
    check(
      `T18b: at ${tag} the toasts stop above the card, and the newest one is always shown`,
      !!t && t.shown >= 1 && t.newest && t.lowest <= t.limit,
      JSON.stringify(t),
    );
  }
}

/* (e)(f) Fold and unfold, the count, Cancel, a failure's Retry, and the
   cloud offer — each through the card's own buttons. */
async function controls(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const keep = {cancel: window.dlCancel, room: S.room};
    const out = {};
    let cancels = 0;
    const press = async (sel) => { const n = document.querySelector(sel); if (n) n.click(); await tick(60); return !!n; };
    try {
      window.__dlClear();
      S.room = 'chat'; render();
      window.__dlSeed([{kind:'runtime', id:'llama.cpp'}, {kind:'weights', id:'qwen-3.5-9b'}]);
      await tick(60);
      out.open = card();
      out.folded = (await press('#dlcard .dlc-fold')) ? card() : null;
      out.foldedLabel = (document.querySelector('#dlcard .dlc-badge') || {getAttribute: () => null}).getAttribute('aria-expanded');
      out.unfolded = (await press('#dlcard .dlc-badge')) ? card() : null;

      // Cancel on the running row: the setup download's own cancel path.
      if (typeof window.dlCancel === 'function') {
        const real = window.dlCancel;
        window.dlCancel = function () { cancels++; return real.apply(this, arguments); };
      }
      const x = document.querySelector('#dlcard .dlc-row .dlc-x');
      out.cancelAct = x ? x.dataset.act : null;
      if (x) x.click();
      await tick(60);
      out.cancels = cancels;
      out.afterCancel = {queued: DL.queue.length, cancelled: !!(DL.job && DL.job.cancelled), card: card()};
      // Its child exits non-zero, as a killed one does: a cancel, not a failure.
      window.__dlFeed({id:'llama.cpp', kind:'runtime', done:true, ok:false, error:'models update exited with code null', sawProgress:false, upToDate:false});
      await tick(60);
      out.afterExit = {card: card(), failed: DL.failed ? DL.failed.length : null, job: !!DL.job};

      // A failure stays, with Retry; Retry puts it back in the queue.
      window.__dlSeed([{kind:'weights', id:'qwen-3.5-9b'}]);
      window.__dlFeed({id:'qwen-3.5-9b', done:true, ok:false, error:'network unreachable'});
      await tick(60);
      out.failed = card();
      out.retried = (await press('#dlcard .dlc-retry')) ? {card: card(), job: DL.job ? DL.job.kind + ':' + DL.job.id : null} : null;
      window.__dlFeed({id:'qwen-3.5-9b', done:true, ok:false, error:'network unreachable'});
      await tick(60);
      out.dismissed = (await press('#dlcard .dlc-row .dlc-x[data-act^="dlc:dismiss"]')) ? card() : 'no dismiss';

      // A queued row's own Cancel takes only that row.
      window.__dlSeed([{kind:'runtime', id:'llama.cpp'}, {kind:'weights', id:'qwen-3.5-9b'}]);
      await tick(60);
      const second = document.querySelectorAll('#dlcard .dlc-row .dlc-x')[1];
      if (second) second.click();
      await tick(60);
      out.dropped = {card: card(), head: DL.job ? DL.job.kind : null, queued: DL.queue.length};

      // "Set up a cloud model meanwhile" opens the cloud setup the composer and Settings use.
      out.cloudLink = (card() || {}).cloud || '';
      await press('#dlcard .dlc-cloud');
      await tick(150);
      const pop = document.querySelector('#overlays .selpop');
      out.cloud = {sel: SEL.open, phase: WIZ.phase, title: txt(pop && pop.querySelector('.selttl')), rows: pop ? pop.querySelectorAll('[data-wiz-kind]').length : 0};
      // Its own Cancel closes it again, onto the agent window and the card.
      await press('#overlays .selpop [data-act="wiz:cancel"]');
      await tick(150);
      out.cancelled = {sel: SEL.open, phase: WIZ.phase, pop: !!document.querySelector('#overlays .selpop'), card: !!card()};
      act('close');
      await tick(60);
      return out;
    } finally {
      if (keep.cancel) window.dlCancel = keep.cancel;
      act('close');
      window.__dlClear();
      S.room = keep.room; render();
    }
  })()`);
  type Card = { title: string; count: string; folded: boolean; rows: { name: string; line: string; cancel: string | null; retry: boolean }[]; cloud: string } | null;
  const open = r["open"] as Card, folded = r["folded"] as Card, unfolded = r["unfolded"] as Card;
  check(
    "T18e: with two downloads the card says 2, folds to a round badge that still says 2, and opens again",
    !!open && open.count === "2" && open.rows.length === 2 && !open.folded
      && !!folded && folded.folded && folded.count === "2" && folded.rows.length === 0 && r["foldedLabel"] === "false"
      && !!unfolded && !unfolded.folded && unfolded.rows.length === 2,
    JSON.stringify({ open, folded, unfolded }),
  );
  const ac = r["afterCancel"] as { queued: number; cancelled: boolean; card: Card };
  const ax = r["afterExit"] as { card: Card; failed: number | null; job: boolean };
  check(
    "T18e: a row's Cancel takes the setup download's cancel path — the child is stopped, what was queued behind it goes, and its exit is not a failure",
    r["cancelAct"] === "dlc:cancel" && r["cancels"] === 1 && ac.queued === 0 && ac.cancelled === true
      && !!ac.card && ac.card.rows.length === 1 && /Cancelling/.test(ac.card.rows[0]!.line)
      && ax.card === null && ax.failed === 0 && ax.job === false,
    JSON.stringify({ act: r["cancelAct"], cancels: r["cancels"], afterCancel: ac, afterExit: ax }),
  );
  const failed = r["failed"] as Card;
  const retried = r["retried"] as { card: Card; job: string | null } | null;
  check(
    "T18e: a failed download stays as a row with its error and Retry, and Retry queues it again",
    !!failed && failed.title === "Download failed" && failed.rows.length === 1 && failed.rows[0]!.retry
      && /network unreachable/.test(failed.rows[0]!.line) && /Set up a cloud model instead/.test(failed.cloud)
      && !!retried && retried.job === "weights:qwen-3.5-9b" && !!retried.card && retried.card.rows.length === 1
      && !retried.card.rows[0]!.retry && /^Starting/.test(retried.card.rows[0]!.line),
    JSON.stringify({ failed, retried }),
  );
  check("T18e: a failed row can be dismissed", r["dismissed"] === null, JSON.stringify(r["dismissed"]));
  const dropped = r["dropped"] as { card: Card; head: string | null; queued: number };
  check(
    "T18e: a queued row's Cancel takes only that row; the running one carries on",
    dropped.head === "runtime" && dropped.queued === 0 && !!dropped.card && dropped.card.rows.length === 1
      && dropped.card.rows[0]!.name === "llama.cpp runtime",
    JSON.stringify(dropped),
  );
  const cloud = r["cloud"] as { sel: boolean; phase: string | null; title: string; rows: number };
  const cancelled = r["cancelled"] as { sel: boolean; phase: string | null; pop: boolean; card: boolean };
  check(
    "T18f: \"Set up a cloud model meanwhile\" opens the cloud setup the composer and Settings use, and its Cancel closes it",
    r["cloudLink"] === "Set up a cloud model meanwhile" && cloud.sel === true && cloud.phase === "pick_kind"
      && cloud.title === "Add a provider" && cloud.rows > 0
      && cancelled.sel === false && cancelled.phase === null && cancelled.pop === false && cancelled.card === true,
    JSON.stringify({ link: r["cloudLink"], cloud, cancelled }),
  );
}

/* (g) The composer picker's pull and Settings › Models' pull report in the
   same card, through the real `cli:pull` channel. Only frames that END a pull
   badly are sent: a good one would start the model and restart the agent. */
async function otherPulls(js: Js, check: Check, w: BrowserWindow): Promise<void> {
  const send = (ev: Record<string, unknown>) => w.webContents.send("cli:pull", ev);
  const read = () => js<unknown>(String.raw`(() => { ${HELPERS} return card(); })()`);
  type Card = { title: string; rows: { name: string; line: string; cancel: string | null; retry: boolean }[] } | null;
  await js<unknown>(`(() => { window.__t18Keep = {sel: SEL.pulling, line: SEL.pullLine, err: SEL.err, llm: LLMP.pulling,
    status: LLMP.statusErr, log: LLMP.pullLog}; window.__dlClear(); S.room = 'chat';
    SEL.pulling = 'smoke-t18-sel'; SEL.pullLine = ''; render(); })()`);
  try {
    await wait(100);
    const selStarting = (await read()) as Card;
    send({ id: "smoke-t18-sel", line: "[=====               ] 25%  1.00 GB / 4.00 GB  file", kind: "weights",
      percent: 25, transferredBytes: 1073741824, totalBytes: 4294967296 });
    await wait(200);
    const selMoving = (await read()) as Card;
    send({ id: "smoke-t18-sel", done: true, ok: false, error: "smoke t18: the picker's pull failed" });
    await wait(200);
    const selFailed = (await read()) as Card;
    await js<unknown>(`(() => { const x = document.querySelector('#dlcard .dlc-row .dlc-x[data-act^="dlc:dismiss"]'); if (x) x.click(); })()`);
    await wait(100);
    const dismissed = (await read()) as Card;
    // Settings › Models: its row, and its own Cancel through the card.
    await js<unknown>("(() => { LLMP.pulling = {kind:'chat', id:'smoke-t18-llm'}; LLMP.pullLog = []; llmRepaint(); })()");
    await wait(100);
    send({ id: "smoke-t18-llm", line: "[==========          ] 50%  2.00 GB / 4.00 GB  file", kind: "weights",
      percent: 50, transferredBytes: 2147483648, totalBytes: 4294967296 });
    await wait(200);
    const llm = (await read()) as Card;
    await js<unknown>("(() => { const x = document.querySelector('#dlcard .dlc-row .dlc-x'); if (x) x.click(); })()");
    await wait(150);
    const llmPulling = await js<unknown>("LLMP.pulling");
    // The cancelled child exits non-zero: a cancel, not a failure.
    send({ id: "smoke-t18-llm", done: true, ok: false, error: "download exited with code null" });
    await wait(200);
    const afterCancel = (await read()) as Card;
    check(
      "T18g: the composer picker's pull is a row in the card — named, then moving, then a failure with Retry that can be dismissed",
      !!selStarting && selStarting.rows.length === 1 && /^Starting/.test(selStarting.rows[0]!.line)
        && selStarting.rows[0]!.cancel === "sel:cancelPull"
        && !!selMoving && /^1\.0 of 4\.0 GB · 25% · /.test(selMoving.rows[0]?.line ?? "")
        && !!selFailed && selFailed.title === "Download failed" && selFailed.rows[0]!.retry
        && /the picker's pull failed/.test(selFailed.rows[0]!.line) && dismissed === null,
      JSON.stringify({ selStarting, selMoving, selFailed, dismissed }),
    );
    check(
      "T18g: Settings › Models' pull is a row too, its Cancel is Settings' own, and the cancelled exit leaves no failure",
      !!llm && llm.rows.length === 1 && llm.rows[0]!.cancel === "llm:cancelPull" && /^2\.0 of 4\.0 GB · 50% · /.test(llm.rows[0]!.line)
        && llmPulling === null && afterCancel === null,
      JSON.stringify({ llm, llmPulling, afterCancel }),
    );
  } finally {
    await js<unknown>(`(() => { const k = window.__t18Keep || {}; SEL.pulling = k.sel || null; SEL.pullLine = k.line || '';
      SEL.err = k.err || null; LLMP.pulling = k.llm || null; LLMP.statusErr = k.status || null; LLMP.pullLog = k.log || [];
      delete window.__t18Keep; window.__dlClear(); act('close'); render(); })()`);
  }
}

/* (h) Backlog 18 follow-up (Nadya, 01.10): a model that lands while the agent
   is already on another model — here a cloud provider set up meanwhile — is
   not switched to by itself. The card keeps "<model> is ready" with Switch and
   a dismiss: Switch is the start it did not get, once; dismiss keeps the cloud
   model. With no other model by then it starts by itself, as before. The
   landing is the shipped path (obPullFinished); the start is a recorder. */
async function readyRow(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const keep = {cfg: LIVE_CONFIG, activate: window.obActivateLocal, snap: window.bswSnapshot, models: OB.models,
      room: S.room, dry: DL.dry};
    const calls = [];
    let snaps = 0;
    const out = {};
    const cloud = Object.assign({}, LIVE_CONFIG || {}, {llm: {activeTextProvider: 'smoke-t18-cloud', providers: [
      {id: 'smoke-t18-cloud', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', defaultChatModel: 'smoke/cloud-model'}]}});
    const another = () => (typeof obRunsOnAnotherModel === 'function' ? obRunsOnAnotherModel('smoke-t18-9b') : null);
    // Seeded dry (nothing is spawned); the last job lands with the queue no longer dry.
    const land = async (jobs) => {
      window.__dlSeed(jobs);
      for (const j of jobs.slice(0, -1)) window.__dlFeed({id: j.id, kind: j.kind, done: true, ok: true, sawProgress: true, upToDate: false});
      DL.dry = false;
      window.__dlFeed({id: jobs[jobs.length - 1].id, done: true, ok: true});
      await tick(80);
    };
    try {
      window.__dlClear();
      S.room = 'chat';
      window.obActivateLocal = async (id) => { calls.push('activate:' + id); };
      window.bswSnapshot = () => { snaps++; return Promise.resolve(); };
      OB.models = [{id: 'smoke-t18-9b', name: 'Smoke Model 9B GGUF', downloaded: false}];
      // A cloud model set up while the runtime and then the model came down.
      LIVE_CONFIG = cloud; render();
      out.onCloud = another();
      await land([{kind: 'runtime', id: 'llama.cpp'}, {kind: 'weights', id: 'smoke-t18-9b'}]);
      out.landed = {calls: calls.slice(), card: card(), snaps};
      const sw = document.querySelector('#dlcard .dlc-switch');
      out.switchBefore = {button: !!sw, calls: calls.slice()};
      if (sw) sw.click();
      await tick(80);
      out.switched = {calls: calls.slice(), card: card()};
      // Again, and dismissed this time: the cloud model stays.
      calls.length = 0;
      await land([{kind: 'weights', id: 'smoke-t18-9b'}]);
      out.again = card();
      const x = document.querySelector('#dlcard .dlc-row.is-ready .dlc-x');
      if (x) x.click();
      await tick(80);
      out.dismissed = {calls: calls.slice(), card: card(), route: LIVE_CONFIG && LIVE_CONFIG.llm ? LIVE_CONFIG.llm.activeTextProvider : null};
      // No other model by then (a first run's local route, nothing chosen yet): it starts by itself.
      calls.length = 0;
      LIVE_CONFIG = firstRunRoute(keep.cfg); render();
      out.onLocal = another();
      await land([{kind: 'weights', id: 'smoke-t18-9b'}]);
      out.local = {calls: calls.slice(), card: card()};
      return out;
    } finally {
      window.obActivateLocal = keep.activate; window.bswSnapshot = keep.snap;
      LIVE_CONFIG = keep.cfg; OB.models = keep.models;
      window.__dlClear(); DL.dry = keep.dry;
      S.room = keep.room; render();
    }
  })()`);
  type Card = { title: string; cloud: string; rows: { name: string; line: string; cancel: string | null; switch: boolean }[] } | null;
  const landed = r["landed"] as { calls: string[]; card: Card; snaps: number };
  const c = landed.card;
  check(
    "T18h: a model that lands while the agent is on a cloud model is not switched to — the card says it is ready, once, with Switch",
    r["onCloud"] === true && landed.calls.length === 0 && !!c && c.title === "Download complete" && c.rows.length === 1
      && c.rows[0]!.name === "Smoke Model 9B is ready" && c.rows[0]!.switch && c.rows[0]!.cancel === "dlc:keep"
      && /stays on its current model until you switch/.test(c.rows[0]!.line) && c.cloud === "" && landed.snaps >= 1,
    JSON.stringify({ onCloud: r["onCloud"], ...landed }),
  );
  const before = r["switchBefore"] as { button: boolean; calls: string[] };
  const switched = r["switched"] as { calls: string[]; card: Card };
  check(
    "T18h: Switch starts it, exactly once, and the row goes",
    before.button && before.calls.length === 0
      && JSON.stringify(switched.calls) === JSON.stringify(["activate:smoke-t18-9b"]) && switched.card === null,
    JSON.stringify({ before, switched }),
  );
  const dismissed = r["dismissed"] as { calls: string[]; card: Card; route: string | null };
  const again = r["again"] as Card;
  check(
    "T18h: dismissing the ready row keeps the cloud model and starts nothing",
    !!again && again.rows.length === 1 && again.rows[0]!.switch
      && dismissed.calls.length === 0 && dismissed.card === null && dismissed.route === "smoke-t18-cloud",
    JSON.stringify({ again, dismissed }),
  );
  const local = r["local"] as { calls: string[]; card: Card };
  check(
    "T18h: with no other model by then the model still starts by itself when its weights land",
    r["onLocal"] === false && JSON.stringify(local.calls) === JSON.stringify(["activate:smoke-t18-9b"]) && local.card === null,
    JSON.stringify({ onLocal: r["onLocal"], ...local }),
  );
}

/* R4 (review): a model whose weights land with something still queued had
   its start held behind ANY queued job, and only a landing runtime released
   it. A retried X queued behind a new pick Y: Y landed and never started, and
   the leftover hold fired later on an unrelated runtime and switched the
   model. The hold is for one thing — the runtime the model needs — and it
   goes with that runtime, landed or failed. The landings are the shipped
   path; dlNext runs as itself but always dry, so nothing is spawned; the start
   is a recorder that moves the route the way a real start does. */
async function heldStart(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const keep = {cfg: LIVE_CONFIG, activate: window.obActivateLocal, next: window.dlNext, snap: window.bswSnapshot,
      models: OB.models, room: S.room, dry: DL.dry};
    const calls = [];
    const out = {};
    const firstRun = () => firstRunRoute(keep.cfg);
    const realNext = keep.next;
    const feed = (ev) => { window.__dlFeed(ev); };
    const runtimeNow = () => { DL.job = {kind: 'runtime', id: 'llama.cpp', percent: 0, transferredBytes: 0, totalBytes: 0, sawProgress: false}; };
    try {
      window.__dlClear();
      S.room = 'chat';
      window.dlNext = function () { const d = DL.dry; DL.dry = true; try { return realNext.apply(this, arguments); } finally { DL.dry = d; } };
      window.obActivateLocal = async (id) => {
        calls.push('activate:' + id);
        LIVE_CONFIG.localModels = Object.assign({}, LIVE_CONFIG.localModels, {managed: Object.assign({}, LIVE_CONFIG.localModels.managed, {modelId: id})});
      };
      window.bswSnapshot = () => Promise.resolve();
      OB.models = [{id: 'smoke-x', name: 'Smoke X'}, {id: 'smoke-y', name: 'Smoke Y'}];

      // A — X failed earlier; setup is re-run for Y; Retry on X queues X behind Y.
      LIVE_CONFIG = firstRun(); render();
      window.__dlSeed([{kind: 'weights', id: 'smoke-y'}]);
      DL.dry = false;
      dlFail({kind: 'weights', id: 'smoke-x'}, 'smoke: the earlier pull of X failed'); render();
      const retry = document.querySelector('#dlcard .dlc-row.is-failed .dlc-retry');
      if (retry) retry.click();
      await tick(60);
      out.queued = DL.queue.map((q) => q.kind + ':' + q.id);
      feed({id: 'smoke-y', done: true, ok: true});
      await tick(60);
      out.yLanded = {calls: calls.slice(), held: DL.activateAfter, job: DL.job ? DL.job.kind + ':' + DL.job.id : null};
      feed({id: 'smoke-x', done: true, ok: true});
      await tick(60);
      out.xLanded = {calls: calls.slice(), held: DL.activateAfter, card: card()};
      // Later, a runtime that has nothing to do with either lands.
      runtimeNow();
      feed({id: 'llama.cpp', kind: 'runtime', done: true, ok: true, sawProgress: false, upToDate: true});
      await tick(60);
      out.unrelated = {calls: calls.slice(), held: DL.activateAfter};

      // B — the hold's own job: a runtime re-queued behind the weights. The start waits for it.
      calls.length = 0;
      window.__dlClear(); LIVE_CONFIG = firstRun(); render();
      window.__dlSeed([{kind: 'weights', id: 'smoke-y'}]);
      DL.queue.push({kind: 'runtime', id: 'llama.cpp'});
      DL.dry = false;
      feed({id: 'smoke-y', done: true, ok: true});
      await tick(60);
      out.waits = {calls: calls.slice(), held: DL.activateAfter, job: DL.job ? DL.job.kind : null};
      feed({id: 'llama.cpp', kind: 'runtime', done: true, ok: true, sawProgress: true, upToDate: false});
      await tick(60);
      out.released = {calls: calls.slice(), held: DL.activateAfter};

      // C — that runtime fails instead: the hold goes with it, and nothing fires later.
      calls.length = 0;
      window.__dlClear(); LIVE_CONFIG = firstRun(); render();
      window.__dlSeed([{kind: 'weights', id: 'smoke-y'}]);
      DL.queue.push({kind: 'runtime', id: 'llama.cpp'});
      DL.dry = false;
      feed({id: 'smoke-y', done: true, ok: true});
      await tick(60);
      feed({id: 'llama.cpp', kind: 'runtime', done: true, ok: false, error: 'models update exited with code 1', sawProgress: false, upToDate: false});
      await tick(60);
      out.failedRuntime = {calls: calls.slice(), held: DL.activateAfter};
      runtimeNow();
      feed({id: 'llama.cpp', kind: 'runtime', done: true, ok: true, sawProgress: false, upToDate: true});
      await tick(60);
      out.laterRuntime = {calls: calls.slice(), held: DL.activateAfter};
      return out;
    } finally {
      window.dlNext = keep.next; window.obActivateLocal = keep.activate; window.bswSnapshot = keep.snap;
      LIVE_CONFIG = keep.cfg; OB.models = keep.models;
      window.__dlClear(); DL.dry = keep.dry;
      S.room = keep.room; render();
    }
  })()`);
  const y = r["yLanded"] as { calls: string[]; held: string | null; job: string | null };
  check(
    "T18 R4: a model that lands with another model queued behind it starts — the hold is not for that",
    JSON.stringify(r["queued"]) === JSON.stringify(["weights:smoke-x"]) && y.job === "weights:smoke-x"
      && JSON.stringify(y.calls) === JSON.stringify(["activate:smoke-y"]) && y.held === null,
    JSON.stringify({ queued: r["queued"], y }),
  );
  const x = r["xLanded"] as { calls: string[]; held: string | null; card: { rows: { name: string; switch: boolean }[] } | null };
  const u = r["unrelated"] as { calls: string[]; held: string | null };
  check(
    "T18 R4: the retried model landing after that does not take over from the one just started — it asks — and a later, unrelated runtime starts nothing",
    JSON.stringify(x.calls) === JSON.stringify(["activate:smoke-y"]) && !!x.card
      && x.card.rows.some((row) => row.name === "Smoke X is ready" && row.switch)
      && JSON.stringify(u.calls) === JSON.stringify(["activate:smoke-y"]) && u.held === null,
    JSON.stringify({ x, u }),
  );
  const w = r["waits"] as { calls: string[]; held: string | null; job: string | null };
  const rel = r["released"] as { calls: string[]; held: string | null };
  check(
    "T18 R4: a model whose runtime is queued behind it waits for that runtime, then starts once",
    w.job === "runtime" && w.calls.length === 0 && w.held === "smoke-y"
      && JSON.stringify(rel.calls) === JSON.stringify(["activate:smoke-y"]) && rel.held === null,
    JSON.stringify({ w, rel }),
  );
  const f = r["failedRuntime"] as { calls: string[]; held: string | null };
  const later = r["laterRuntime"] as { calls: string[]; held: string | null };
  check(
    "T18 R4: when that runtime fails the hold goes with it — nothing fires on a later runtime",
    f.calls.length === 0 && f.held === null && later.calls.length === 0 && later.held === null,
    JSON.stringify({ f, later }),
  );
}

/* S1 (second review): the resume reminder lives exactly as long as the setup
   model's row. Every way that row leaves the card forgets it — the queued
   row's × behind a llama.cpp runtime (a first run without one), the running
   row's Cancel, a failed row's dismiss — and a Cancel or a drop that leaves
   the row standing does not. The queue is seeded dry. */
async function setupRowRemoval(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const KEY = 'atag.setupDownload';
    const marker = () => { try { const m = JSON.parse(localStorage.getItem(KEY) || 'null'); return m ? m.id : null; } catch (e) { return 'unreadable'; } };
    const remember = (id) => { if (typeof obSetupPullRemember === 'function') obSetupPullRemember(id); };
    const press = async (sel) => { const n = document.querySelector(sel); if (n) n.click(); await tick(60); return !!n; };
    const keep = {room: S.room, dry: DL.dry};
    const out = {};
    try {
      window.__dlClear(); S.room = 'chat'; render();
      // The queued model behind the runtime, as a first run without llama.cpp shows it.
      window.__dlSeed([{kind: 'runtime', id: 'llama.cpp'}, {kind: 'weights', id: 'smoke-s1'}]);
      remember('smoke-s1');
      await tick(60);
      out.queued = {before: marker(), button: await press('#dlcard .dlc-x[data-act="dlc:drop:weights:smoke-s1"]'),
        after: marker(), queue: DL.queue.map((q) => q.kind + ':' + q.id), head: DL.job ? DL.job.kind : null};
      // A runtime queued behind the model goes: the model's row stays, and so does its reminder.
      window.__dlSeed([{kind: 'weights', id: 'smoke-s1'}]);
      DL.queue.push({kind: 'runtime', id: 'llama.cpp', run: DL.job.run}); render();
      remember('smoke-s1');
      await tick(60);
      out.runtimeDropped = {button: await press('#dlcard .dlc-x[data-act="dlc:drop:runtime:llama.cpp"]'), after: marker()};
      // The running row's Cancel.
      window.__dlSeed([{kind: 'weights', id: 'smoke-s1'}]);
      remember('smoke-s1');
      await tick(60);
      out.running = {button: await press('#dlcard .dlc-row .dlc-x[data-act="dlc:cancel"]'), after: marker()};
      window.__dlFeed({id: 'smoke-s1', done: true, ok: false, error: 'download exited with code null'});
      // A Cancel on another download, with the setup model queued behind it as a run of its own: it stays, so does the reminder.
      window.__dlSeed([{kind: 'weights', id: 'smoke-other'}]);
      DL.queue.push({kind: 'weights', id: 'smoke-s1', run: DL.job.run + 1000}); render();
      remember('smoke-s1');
      await tick(60);
      out.otherCancelled = {button: await press('#dlcard .dlc-row .dlc-x[data-act="dlc:cancel"]'), after: marker(),
        queue: DL.queue.map((q) => q.kind + ':' + q.id)};
      window.__dlFeed({id: 'smoke-other', done: true, ok: false, error: 'download exited with code null'});
      // A failed row's dismiss.
      window.__dlSeed([{kind: 'weights', id: 'smoke-s1'}]);
      remember('smoke-s1');
      window.__dlFeed({id: 'smoke-s1', done: true, ok: false, error: 'smoke: network unreachable'});
      await tick(60);
      out.failed = {button: await press('#dlcard .dlc-row.is-failed .dlc-x'), after: marker()};
      return out;
    } finally {
      window.__dlClear(); DL.dry = keep.dry; S.room = keep.room; render();
    }
  })()`);
  type Step = { button: boolean; after: string | null; before?: string | null; queue?: string[]; head?: string | null };
  const q = r["queued"] as Step, rt = r["runtimeDropped"] as Step, run = r["running"] as Step;
  const other = r["otherCancelled"] as Step, f = r["failed"] as Step;
  check(
    "T18 S1: the setup model's queued row taken off the card forgets the resume reminder — the runtime in front carries on",
    q.before === "smoke-s1" && q.button && q.after === null && JSON.stringify(q.queue) === "[]" && q.head === "runtime",
    JSON.stringify(q),
  );
  check(
    "T18 S1: the running row's Cancel and a failed row's dismiss forget it too",
    run.button && run.after === null && f.button && f.after === null,
    JSON.stringify({ run, f }),
  );
  check(
    "T18 S1: a drop or a Cancel that leaves the setup model's row on the card keeps its reminder",
    rt.button && rt.after === "smoke-s1" && other.button && other.after === "smoke-s1"
      && JSON.stringify(other.queue) === JSON.stringify(["weights:smoke-s1"]),
    JSON.stringify({ rt, other }),
  );
}

/* S4 (second review): the llama.cpp runtime failed, the model landed while the
   agent was on a cloud model, and the card asks. Switch pressed while a
   retried runtime is still coming waits for it and starts the model once; a
   ready row that was switched or dismissed is the person's answer, and a
   runtime landing later never brings it back or starts it again. The
   landings are the shipped path; dlNext runs as itself but always dry; the
   start is a recorder. */
async function switchBehindRuntime(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const keep = {cfg: LIVE_CONFIG, activate: window.obActivateLocal, next: window.dlNext, snap: window.bswSnapshot,
      models: OB.models, room: S.room, dry: DL.dry, toasts: S.toasts.slice()};
    const calls = [];
    const realNext = keep.next;
    const cloud = Object.assign({}, keep.cfg || {}, {llm: {activeTextProvider: 'smoke-t18-cloud', providers: [
      {id: 'smoke-t18-cloud', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', defaultChatModel: 'smoke/cloud-model'}]}});
    const press = async (sel) => { const n = document.querySelector(sel); if (n) n.click(); await tick(60); return !!n; };
    const ready = () => !!document.querySelector('#dlcard .dlc-row.is-ready');
    const feed = (ev) => window.__dlFeed(ev);
    // The runtime fails, then the model lands on a cloud route: the ready row, and the runtime's failure row.
    const stage = async () => {
      calls.length = 0;
      window.__dlClear(); LIVE_CONFIG = cloud; render();
      window.__dlSeed([{kind: 'runtime', id: 'llama.cpp'}, {kind: 'weights', id: 'smoke-s4'}]);
      DL.dry = false;
      feed({id: 'llama.cpp', kind: 'runtime', done: true, ok: false, error: 'models update exited with code 1', sawProgress: false, upToDate: false});
      feed({id: 'smoke-s4', done: true, ok: true});
      await tick(80);
      return ready();
    };
    const retryRuntime = () => press('#dlcard .dlc-row.is-failed .dlc-retry');
    const runtimeLands = async () => { feed({id: 'llama.cpp', kind: 'runtime', done: true, ok: true, sawProgress: true, upToDate: false}); await tick(80); };
    const out = {};
    try {
      S.room = 'chat';
      window.dlNext = function () { const d = DL.dry; DL.dry = true; try { return realNext.apply(this, arguments); } finally { DL.dry = d; } };
      window.obActivateLocal = async (id) => { calls.push('activate:' + id); };
      window.bswSnapshot = () => Promise.resolve();
      OB.models = [{id: 'smoke-s4', name: 'Smoke S4'}];

      // A — Switch while the retried runtime is still coming down.
      out.a = {staged: await stage()};
      out.a.retried = await retryRuntime();
      out.a.pending = !!(DL.job && DL.job.kind === 'runtime');
      out.a.switchButton = await press('#dlcard .dlc-switch');
      out.a.afterSwitch = {calls: calls.slice(), ready: ready()};
      await runtimeLands();
      out.a.afterRuntime = {calls: calls.slice(), ready: ready()};

      // B — dismissed, then the runtime retried and landed.
      out.b = {staged: await stage()};
      out.b.dismissed = await press('#dlcard .dlc-row.is-ready .dlc-x');
      out.b.retried = await retryRuntime();
      await runtimeLands();
      out.b.after = {calls: calls.slice(), ready: ready()};

      // C — switched while the runtime had failed (nothing pending), then the runtime retried and landed.
      out.c = {staged: await stage()};
      out.c.switchButton = await press('#dlcard .dlc-switch');
      out.c.afterSwitch = calls.slice();
      out.c.retried = await retryRuntime();
      await runtimeLands();
      out.c.after = {calls: calls.slice(), ready: ready()};
      return out;
    } finally {
      window.dlNext = keep.next; window.obActivateLocal = keep.activate; window.bswSnapshot = keep.snap;
      LIVE_CONFIG = keep.cfg; OB.models = keep.models;
      window.__dlClear(); DL.dry = keep.dry;
      S.room = keep.room; S.toasts = keep.toasts; render();
    }
  })()`);
  const a = r["a"] as { staged: boolean; retried: boolean; pending: boolean; switchButton: boolean;
    afterSwitch: { calls: string[]; ready: boolean }; afterRuntime: { calls: string[]; ready: boolean } };
  check(
    "T18 S4: Switch pressed while the llama.cpp runtime is still coming waits for it, then starts the model once — no second question",
    a.staged && a.retried && a.pending && a.switchButton && a.afterSwitch.calls.length === 0 && !a.afterSwitch.ready
      && JSON.stringify(a.afterRuntime.calls) === JSON.stringify(["activate:smoke-s4"]) && !a.afterRuntime.ready,
    JSON.stringify(a),
  );
  const b = r["b"] as { staged: boolean; dismissed: boolean; retried: boolean; after: { calls: string[]; ready: boolean } };
  const c = r["c"] as { staged: boolean; switchButton: boolean; afterSwitch: string[]; retried: boolean; after: { calls: string[]; ready: boolean } };
  check(
    "T18 S4: a ready row that was dismissed or switched is never brought back, or started again, by a runtime landing later",
    b.staged && b.dismissed && b.retried && b.after.calls.length === 0 && !b.after.ready
      && c.staged && c.switchButton && JSON.stringify(c.afterSwitch) === JSON.stringify(["activate:smoke-s4"]) && c.retried
      && JSON.stringify(c.after.calls) === JSON.stringify(["activate:smoke-s4"]) && !c.after.ready,
    JSON.stringify({ b, c }),
  );
}

/* S3 (second review, its first half): setup finishing on another route — here
   a cloud model, the second-backend offer skipped — forgets an earlier setup
   download's reminder, which would otherwise restart on every launch a
   download the person has moved past. A setup download still running in this
   session keeps its reminder. The flow is the test jump (testClose), so the
   closing write is decided but not made. */
async function setupDoneElsewhere(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    ${HELPERS}
    const KEY = 'atag.setupDownload';
    const marker = () => { try { const m = JSON.parse(localStorage.getItem(KEY) || 'null'); return m ? m.id : null; } catch (e) { return 'unreadable'; } };
    const remember = (id) => { if (typeof obSetupPullRemember === 'function') obSetupPullRemember(id); };
    const keep = {ob: Object.assign({}, OB), stamped: Object.assign({}, OB_STAMPED), log: OB_STAMP_LOG.slice(),
      room: S.room, dry: DL.dry, toasts: S.toasts.slice()};
    // Setup closes on a cloud model: the second-backend offer skipped, the import step already offered.
    const finishOnCloud = async () => {
      window.__obOpen('propose_second', {stamped: ['importOfferedAt', 'proposedSecondBackendAt']});
      window.__obSeed({offer: 'local', outcome: 'cloud'});
      await tick(100);
      window.__obKey('esc');
      for (let i = 0; i < 200 && OB.open; i++) await tick(100);   // up to 20 s: obSettle reads first
      return {open: OB.open, closing: OB_STAMP_LOG.filter((e) => e.step === 'finished').map((e) => e.leaf)};
    };
    const out = {};
    try {
      window.__dlClear(); S.room = 'chat'; render();
      // A reminder left by an earlier session's setup download, which failed; nothing of it in memory now.
      remember('smoke-s3');
      out.earlier = {before: marker(), flow: await finishOnCloud(), after: marker()};
      // A setup download still running when setup finishes elsewhere keeps its reminder.
      window.__dlSeed([{kind: 'weights', id: 'smoke-s3'}]);
      remember('smoke-s3');
      out.running = {before: marker(), flow: await finishOnCloud(), after: marker()};
      return out;
    } finally {
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
  type Run = { before: string | null; after: string | null; flow: { open: boolean; closing: string[] } };
  const e = r["earlier"] as Run, run = r["running"] as Run;
  check(
    "T18 S3: setup finishing on a cloud model forgets an earlier setup download's reminder — it is not restarted on the next launch",
    e.before === "smoke-s3" && e.flow.open === false && e.flow.closing.includes("completedAt") && e.after === null,
    JSON.stringify(e),
  );
  check(
    "T18 S3: a setup download still running when setup finishes elsewhere keeps its reminder",
    run.before === "smoke-s3" && run.flow.open === false && run.after === "smoke-s3",
    JSON.stringify(run),
  );
}

/* For the product owner: the card on the chat, light and dark, open and
   folded, at the default window size. Only with T18_SHOTS set. */
async function shots(js: Js, w: BrowserWindow, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  // An empty composer: a draft starting with "/" would open the slash list over the card.
  await js<unknown>("(() => { window.__t18Draft = S.draft; S.draft = ''; render(); })()");
  const stage = (theme: string, folded: boolean, rows: string) => js<unknown>(String.raw`(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});
    window.__dlClear();
    S.toasts = []; S.room = 'chat';
    if (!OB.models.some((m) => m.id === 'qwen-3.5-9b')) OB.models = OB.models.concat([{id:'qwen-3.5-9b', name:'Qwen 3.5 9B'}]);
    const GiB = 1073741824;
    if (${JSON.stringify(rows)} === 'two') {
      window.__dlSeed([{kind:'runtime', id:'llama.cpp'}, {kind:'weights', id:'qwen-3.5-9b'}]);
      window.__dlFeed({id:'llama.cpp', kind:'runtime', percent:60, transferredBytes:Math.round(0.6 * 70 * 1048576), totalBytes:70 * 1048576});
    } else if (${JSON.stringify(rows)} === 'ready') {
      // On a cloud model by the time the weights landed: the ready row.
      window.__t18Cfg = window.__t18Cfg || LIVE_CONFIG;
      LIVE_CONFIG = Object.assign({}, window.__t18Cfg, {llm: {activeTextProvider: 'openrouter', providers: [
        {id: 'openrouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', defaultChatModel: 'openrouter/auto'}]}});
      DL.ready = {id: 'qwen-3.5-9b'};
    } else if (${JSON.stringify(rows)} === 'failed') {
      window.__dlSeed([{kind:'weights', id:'qwen-3.5-9b'}]);
      window.__dlFeed({id:'qwen-3.5-9b', done:true, ok:false, error:'the connection to huggingface.co was reset'});
    } else {
      window.__dlSeed([{kind:'weights', id:'qwen-3.5-9b'}]);
      window.__dlFeed({id:'qwen-3.5-9b', kind:'weights', percent:41, transferredBytes:Math.round(2.5 * GiB), totalBytes:Math.round(6.2 * GiB)});
      DL.rate = (3.7 * GiB) / 180; DL.samples = 4;
    }
    DLC.collapsed = ${folded ? "true" : "false"};
    render();
    await tick(400);
  })()`);
  const cases: [string, string, boolean, string, number, number][] = [
    ["card-light-open.png", "light", false, "one", 1280, 820],
    ["card-dark-open.png", "dark", false, "one", 1280, 820],
    ["card-light-folded.png", "light", true, "two", 1280, 820],
    ["card-dark-folded.png", "dark", true, "two", 1280, 820],
    ["card-light-two-rows.png", "light", false, "two", 1280, 820],
    ["card-dark-failed.png", "dark", false, "failed", 1280, 820],
    ["card-light-940.png", "light", false, "two", 940, 620],
    ["card-dark-940-open.png", "dark", false, "one", 940, 620],
    ["card-light-ready.png", "light", false, "ready", 1280, 820],
    ["card-dark-ready.png", "dark", false, "ready", 1280, 820],
  ];
  for (const [file, theme, folded, rows, cw, ch] of cases) {
    const [nw, nh] = w.getContentSize();
    if (nw !== cw || nh !== ch) { w.setContentSize(cw, ch); await wait(500); }
    await stage(theme, folded, rows);
    const img = await w.webContents.capturePage();
    writeFileSync(join(dir, file), img.toPNG());
    // The ready case borrows a cloud route; every other case is on the real one.
    await js<unknown>("(() => { if (window.__t18Cfg) { LIVE_CONFIG = window.__t18Cfg; delete window.__t18Cfg; } DL.ready = null; })()");
  }
  await js<unknown>("(() => { window.__dlClear(); DLC.collapsed = false; S.draft = window.__t18Draft || ''; delete window.__t18Draft; render(); })()");
}
