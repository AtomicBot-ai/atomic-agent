import { BrowserWindow } from "electron";

/**
 * Release-fix checks for Danya's Settings items (desktop-release-fixes,
 * 01.10: "Settings: general" and "General"), run as item 47 (see
 * main/release-fixes-smoke.ts). Run alone with `--smoke --smoke-task=47`.
 *
 * Д25 — the close control was a bare × at the end of the section's title row:
 *   it read as "close this section" and closed all of Settings. It says Done.
 * Д26 — the "auto · refreshed …" readout stood in a place of its own in each
 *   pane that polls (Tasks, Skills, Memory, MCP servers): after the search
 *   box, after the counts, at the right end of the toolbar, at its left end.
 *   One status line now, drawn by the window in its header beside Done; the
 *   panes keep their counts. Skills' own readout went with the Skills items
 *   (Д44), whose tab counts replace its counts line.
 * Д27 — the toasts stood at the top right of the app window, so over Settings
 *   they straddled its right edge and sat on its close control. They stand
 *   inside the settings window now, in its body card's bottom right corner.
 * Д28 — the General switches had an "On" / "Off" word beside them.
 *
 * Nothing is written: no switch is pressed, a pane's poll state is staged and
 * put back inside the one synchronous block that reads it (so no poll can land
 * in between), the toasts are the check's own and are cleared, the window
 * size is put back, and Settings reopens on the section it did.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Failed = { err?: string };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const PANES = ["tasks", "skills", "memory", "mcp"] as const;

async function safe<T>(js: Js, code: string): Promise<T & Failed> {
  try {
    return await js<T & Failed>(code);
  } catch (e) {
    return { err: `the renderer threw: ${message(e)}` } as T & Failed;
  }
}

/* The section Settings reopens on (atag.settingsSection) is written by every
   opening; the one the check found is put back. */
type Last = { section: string | null; connections: string | null };
const LAST_READ = "({section: SETTINGS_LAST.section || null, connections: SETTINGS_LAST.connections || null})";
const lastRestore = (l: Last) => `(() => {
  SETTINGS_LAST.section = ${JSON.stringify(l.section)}; SETTINGS_LAST.connections = ${JSON.stringify(l.connections)};
  try { if (SETTINGS_LAST.section) localStorage.setItem('atag.settingsSection', SETTINGS_LAST.section); else localStorage.removeItem('atag.settingsSection'); } catch (e) { /* no storage */ }
})()`;

/** The app window the smoke drives (the renderer's index.html). */
function appWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && /index\.html$/.test(w.webContents.getURL())) ?? null;
}

/* Д25: the header's close control in every pane, then a click on it and an Escape. */
const DONE = String.raw`(async () => {
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__settingsClose(); await tick(50);
  const seen = [];
  for (const [pane] of SETTINGS_TABS) {
    window.__settingsOpen(pane); await tick(60);
    const tb = document.querySelector('#settings .settb');
    const b = tb && tb.querySelector('[data-act="settings:close"]');
    seen.push({pane, tag: b ? b.tagName : '', text: b ? b.textContent.trim() : '', bareX: !!(tb && tb.querySelector('.iconbtn[data-act="settings:close"]')),
      all: document.querySelectorAll('#settings [data-act="settings:close"]').length});
  }
  const b = document.querySelector('#settings .settb [data-act="settings:close"]');
  if (b) b.click();
  await tick(50);
  const byDone = !S.settings;
  window.__settingsOpen('general'); await tick(60);
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
  await tick(50);
  const byEsc = !S.settings;
  window.__settingsClose();
  return {panes: SETTINGS_TABS.length, seen, byDone, byEsc};
})()`;
type Done = { panes: number; seen: Array<{ pane: string; tag: string; text: string; bareX: boolean; all: number }>; byDone: boolean; byEsc: boolean };

/* Д26: each pane that polls, with its poll state staged three ways — fresh,
   paused, refreshing — and read in the same synchronous block; then a pane
   that does not poll, and the in-place repaint a quiet poll makes. */
const STATUS = String.raw`(async () => {
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__settingsClose(); await tick(50);
  const T0 = Date.now() - 3 * 60 * 1000, T1 = Date.now() - 2 * 3600 * 1000;
  const hm = (t) => new Date(t).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
  const read = () => {
    const st = document.querySelector('#settings .settb .set-status');
    const line = st && st.querySelector('.set-statusin');
    const done = document.querySelector('#settings .settb [data-act="settings:close"]');
    const rs = line ? line.getBoundingClientRect() : null, rd = done ? done.getBoundingClientRect() : null;
    const resume = st && st.querySelector('button.set-resume');
    // The right edge of what the line ends in — Resume when paused — against Done.
    const end = resume ? resume.getBoundingClientRect() : rs;
    return {text: line ? line.textContent.trim() : '', shown: !!st && getComputedStyle(st).display !== 'none',
      gap: end && rd ? Math.round(rd.left - end.right) : null, right: end ? Math.round(end.right) : null,
      lines: document.querySelectorAll('#settings .set-statusin').length,
      inPane: document.querySelectorAll(['.set-readout', '.sd-status', ...['tasks', 'skills', 'memory', 'mcp'].map((p) => '[data-act="' + p + ':auto"]')]
        .map((sel) => '#settings .setbody ' + sel).join(', ')).length,
      resume: resume ? {text: resume.textContent.trim(), act: resume.dataset.act} : null,
      dot: line && line.querySelector('.tk-dot') ? (line.querySelector('.tk-dot--green') ? 'green' : 'hollow') : null,
      counts: ((document.querySelector('#settings .setbody .set-counts') || {}).textContent || '').trim()};
  };
  const loading = {tasks: () => TK.loading, skills: () => SK.busy, memory: () => MEM.loading, mcp: () => MCP.loading};
  const out = {want: {fresh: 'Updated ' + hm(T0), paused: 'Auto-refresh paused · updated ' + hm(T0), busy: 'Updating…', repainted: 'Updated ' + hm(T1)}, panes: {}};
  for (const pane of ['tasks', 'skills', 'memory', 'mcp']) {
    window.__settingsOpen(pane);
    for (let i = 0; i < 50 && loading[pane](); i++) await tick(100);
    await tick(100);
    const keep = {tk: {mode: TK.mode, auto: TK.auto, loading: TK.loading, at: TK.lastRefreshedAt},
      skp: {mode: SKP.mode, view: SKP.view, hubCard: SKP.hubCard, auto: SKP.auto, removeConfirm: SKP.removeConfirm, busy: SKP.busy}, sk: {busy: SK.busy, at: SK.at},
      mem: {mode: MEM.mode, auto: MEM.auto, loading: MEM.loading, at: MEM.lastRefreshedAt},
      mcp: {auto: MCP.auto, loading: MCP.loading, at: MCP.lastRefreshedAt, addModal: MCP.addModal, removeConfirm: MCP.removeConfirm}};
    const stage = (auto, busy, at) => {
      if (pane === 'tasks') Object.assign(TK, {mode: 'list', auto, loading: busy, lastRefreshedAt: at});
      if (pane === 'skills') { Object.assign(SKP, {mode: 'list', view: 'skills', hubCard: null, auto, removeConfirm: null, busy: false}); Object.assign(SK, {busy, at}); }
      if (pane === 'memory') Object.assign(MEM, {mode: 'list', auto, loading: busy, lastRefreshedAt: at});
      if (pane === 'mcp') Object.assign(MCP, {auto, loading: busy, lastRefreshedAt: at, addModal: null, removeConfirm: null});
    };
    const r = {};
    try {
      stage(true, false, T0); render(); r.fresh = read();
      stage(false, false, T0); render(); r.paused = read();
      // Resume turns the pane's refreshing back on (Skills has no switch of its own to turn).
      if (pane !== 'skills') {
        const b = document.querySelector('#settings .settb .set-resume');
        if (b) b.click();
        r.resumed = {auto: {tasks: TK.auto, memory: MEM.auto, mcp: MCP.auto}[pane], text: read().text};
      }
      stage(true, true, T0); render(); r.busy = read();
      // A view that stops the poll: the time stays, the dot is not the live green.
      if (pane === 'mcp') { stage(true, false, T0); MCP.addModal = {json: '', error: null}; r.held = settingsStatusHTML('mcp'); MCP.addModal = null; }
      // A quiet poll that changed nothing repaints the line in place: no rebuilt window.
      stage(true, false, T0); render();
      const win = document.querySelector('#settings .setwin');
      stage(true, false, T1);
      settingsStatusRepaint();
      r.repainted = Object.assign(read(), {sameWindow: document.querySelector('#settings .setwin') === win});
    } finally {
      Object.assign(TK, {mode: keep.tk.mode, auto: keep.tk.auto, loading: keep.tk.loading, lastRefreshedAt: keep.tk.at});
      Object.assign(SKP, keep.skp); Object.assign(SK, keep.sk);
      Object.assign(MEM, {mode: keep.mem.mode, auto: keep.mem.auto, loading: keep.mem.loading, lastRefreshedAt: keep.mem.at});
      Object.assign(MCP, {auto: keep.mcp.auto, loading: keep.mcp.loading, lastRefreshedAt: keep.mcp.at, addModal: keep.mcp.addModal, removeConfirm: keep.mcp.removeConfirm});
      render();
    }
    out.panes[pane] = r;
  }
  window.__settingsOpen('general'); await tick(60);
  out.general = read();
  window.__settingsClose();
  return out;
})()`;
type Line = {
  text: string; shown: boolean; gap: number | null; right: number | null; lines: number; inPane: number;
  resume: { text: string; act: string } | null; dot: string | null; counts: string;
};
type Status = {
  want: { fresh: string; paused: string; busy: string; repainted: string };
  panes: Record<string, {
    fresh: Line; paused: Line; busy: Line; repainted: Line & { sameWindow: boolean };
    resumed?: { auto: boolean; text: string }; held?: string;
  }>;
  general: Line;
};

/* Д27: two toasts raised over Settings, measured against its window, then
   with Settings closed against the app window. Only the check's own toasts
   are cleared after. */
const TOASTS = String.raw`(async () => {
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return {top: r.top, bottom: r.bottom, left: r.left, right: r.right}; };
  const within = (a, b) => !!a && !!b && a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
  const meets = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const mine = (t) => String(t.t).indexOf('Smoke t47') === 0;
  const live = () => [...document.querySelectorAll('#toasts > .toast')].filter((n) => !n.classList.contains('out') && !n.hidden && mine({t: (n.querySelector('.toast-t') || {}).textContent || ''}));
  window.__settingsClose(); await tick(50);
  window.__settingsOpen('general'); await tick(100);
  try {
    toast('Smoke t47 toast one', 'A second line, so it is as tall as most toasts are.');
    toast('Smoke t47 toast two, with a title long enough to wrap inside the toast', 'and a line under it');
    await tick(450);
    const win = box(document.querySelector('#settings .setwin')), card = box(document.querySelector('#settings .setmain'));
    const head = box(document.querySelector('#settings .settb')), done = box(document.querySelector('#settings .settb [data-act="settings:close"]'));
    const t = live().map(box);
    const over = {n: t.length, inCard: t.every((r) => within(r, card)), inWin: t.every((r) => within(r, win)),
      clearOfHeader: t.every((r) => !meets(r, head)), clearOfDone: t.every((r) => !meets(r, done)),
      inView: t.every((r) => r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5), toasts: t, card};
    // Seven at once: the oldest step aside before the column reaches the header; the newest always shows.
    for (let i = 3; i <= 7; i++) toast('Smoke t47 toast ' + i, 'A second line, so it is as tall as most toasts are.');
    await tick(450);
    const shown = live();
    const all = [...document.querySelectorAll('#toasts > .toast')].filter((n) => !n.classList.contains('out') && mine({t: (n.querySelector('.toast-t') || {}).textContent || ''}));
    const many = {n: shown.length, newest: shown.length > 0 && shown[shown.length - 1] === all[all.length - 1],
      clearOfHeader: shown.map(box).every((r) => r.top >= head.bottom - 0.5 && !meets(r, done)), inCard: shown.map(box).every((r) => within(r, card))};
    window.__settingsClose(); await tick(100);
    const bar = box(document.getElementById('toolbar'));
    const u = live().slice(-2).map(box);
    const chat = {n: u.length, corner: u.every((r) => Math.abs(r.right - (innerWidth - 16)) <= 1 && r.top >= bar.bottom - 0.5)};
    return {width: innerWidth, height: innerHeight, over, many, chat};
  } finally {
    window.__settingsClose();
    S.toasts = S.toasts.filter((x) => !mine(x)); renderToasts();
  }
})()`;
type Rect = { top: number; bottom: number; left: number; right: number };
type Toasts = {
  width: number; height: number;
  over: { n: number; inCard: boolean; inWin: boolean; clearOfHeader: boolean; clearOfDone: boolean; inView: boolean; toasts: Rect[]; card: Rect | null };
  many: { n: number; newest: boolean; clearOfHeader: boolean; inCard: boolean };
  chat: { n: number; corner: boolean };
};

/* Д28: the General rows that end in a switch, read without their title and
   description; then the naming switch with a write staged as on its way. */
const SWITCHES = String.raw`(async () => {
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  const beside = (row) => { const c = row.cloneNode(true); c.querySelectorAll('.body').forEach((n) => n.remove()); return c.textContent.trim(); };
  window.__settingsClose(); await tick(50);
  window.__settingsOpen('general'); await tick(300);
  const rows = () => [...document.querySelectorAll('#settings .setbody .tk-setrow')].filter((r) => r.querySelector('.tk-switch'));
  const now = rows();
  const out = {labels: now.map((r) => r.querySelector('.tk-switch').getAttribute('aria-label')), words: now.map(beside),
    states: now.map((r) => r.querySelectorAll('.set-state').length), checked: now.map((r) => r.querySelector('.tk-switch').getAttribute('aria-checked'))};
  const keep = NAMES.busy;
  try {
    NAMES.busy = true; render();
    const row = rows().find((r) => r.querySelector('[data-act="names:toggle"]'));
    const sw = row && row.querySelector('.tk-switch');
    out.busy = row ? {spin: !!row.querySelector('.tk-spin'), aria: sw.getAttribute('aria-busy'), disabled: sw.disabled, words: beside(row)} : null;
  } finally {
    NAMES.busy = keep; render();
    window.__settingsClose();
  }
  return out;
})()`;
type Switches = { labels: string[]; words: string[]; states: number[]; checked: string[]; busy: { spin: boolean; aria: string | null; disabled: boolean; words: string } | null };

export async function checks47(js: Js, check: Check): Promise<void> {
  const last = await safe<Last>(js, LAST_READ);
  try {
    await run(js, check);
  } finally {
    await safe<void>(js, "window.__settingsClose()");
    if (!last.err) await safe<void>(js, lastRestore(last));
  }
}

async function run(js: Js, check: Check): Promise<void> {
  // Д25
  const d = await safe<Done>(js, DONE);
  check(
    "T47 Д25: every section's header closes Settings with a Done button, not a bare ×",
    !d.err && d.panes > 0 && d.seen.length === d.panes && d.seen.every((s) => s.tag === "BUTTON" && s.text === "Done" && !s.bareX && s.all === 1),
    d.err ?? JSON.stringify(d.seen.filter((s) => !(s.tag === "BUTTON" && s.text === "Done" && !s.bareX && s.all === 1))),
  );
  check(
    "T47 Д25: Done closes Settings, and Escape still does",
    !d.err && d.byDone && d.byEsc,
    d.err ?? JSON.stringify({ byDone: d.byDone, byEsc: d.byEsc }),
  );

  // Д26
  const s = await safe<Status>(js, STATUS);
  const lines: Array<Status["panes"][string]> = s.err ? [] : PANES.map((p) => s.panes[p]!);
  check(
    "T47 Д26: Tasks, Skills, Memory and MCP servers draw no readout of their own; the header carries one status line",
    !s.err && lines.every((r) => [r.fresh, r.paused, r.busy].every((l) => l.lines === 1 && l.inPane === 0 && l.shown)),
    s.err ?? JSON.stringify(Object.fromEntries(PANES.map((p) => [p, { lines: s.panes[p]!.fresh.lines, inPane: s.panes[p]!.fresh.inPane }]))),
  );
  check(
    "T47 Д26: the line says the same things in the same words in each — updated at, paused, updating",
    !s.err && lines.every((r) => r.fresh.text === s.want.fresh && r.fresh.dot === "green" && r.paused.text === s.want.paused && r.busy.text === s.want.busy),
    s.err ?? JSON.stringify({ want: s.want, got: Object.fromEntries(PANES.map((p) => [p, [s.panes[p]!.fresh.text, s.panes[p]!.fresh.dot, s.panes[p]!.paused.text, s.panes[p]!.busy.text]])) }),
  );
  const switched = PANES.filter((p) => p !== "skills");
  check(
    "T47 Д26: paused, the line carries a Resume that turns the pane's refreshing back on",
    !s.err && switched.every((p) => {
      const r = s.panes[p]!;
      return !!r.paused.resume && r.paused.resume.text === "Resume" && r.paused.resume.act === `${p}:auto`
        && !!r.resumed && r.resumed.auto === true && r.resumed.text === s.want.fresh && !r.fresh.resume;
    }),
    s.err ?? JSON.stringify(Object.fromEntries(switched.map((p) => [p, { resume: s.panes[p]!.paused.resume, resumed: s.panes[p]!.resumed }]))),
  );
  const held = s.err ? "" : s.panes["mcp"]!.held ?? "";
  check(
    "T47 Д26: while a view stops the pane's poll (MCP's add-server box) the line keeps its time without the live dot",
    !s.err && held.includes(s.want.fresh) && held.includes("tk-dot--hollow") && !held.includes("tk-dot--green"),
    s.err ?? held,
  );
  const rights = lines.map((r) => r.fresh.right), gaps = lines.map((r) => r.fresh.gap);
  check(
    "T47 Д26: …and stands in the same place in each, right beside Done",
    !s.err && rights.every((x) => x !== null && x === rights[0]) && gaps.every((x) => x !== null && x === gaps[0] && x > 0 && x <= 16),
    s.err ?? JSON.stringify({ rights, gaps }),
  );
  check(
    "T47 Д26: a quiet poll repaints the line in place, and a pane that does not poll (General) shows none",
    !s.err && lines.every((r) => r.repainted.text === s.want.repainted && r.repainted.sameWindow) && !s.general.shown && s.general.lines === 0,
    s.err ?? JSON.stringify({ repainted: Object.fromEntries(PANES.map((p) => [p, s.panes[p]!.repainted])), general: s.general }),
  );
  const counts = s.err ? null : Object.fromEntries(PANES.map((p) => [p, s.panes[p]!.fresh.counts]));
  check(
    "T47 Д26: the counts the readouts carried stay in the panes' toolbars",
    !!counts && /^\d+ (tasks?|of \d+)$/.test(counts["tasks"]!) && /^\d+ shown$/.test(counts["memory"]!) && /^\d+ servers?$/.test(counts["mcp"]!),
    s.err ?? JSON.stringify(counts),
  );

  // Д27, on the default window and on the narrowest the app allows.
  const w = appWindow();
  if (!w) {
    check("T47 Д27: over Settings the toasts stand inside its window", false, "no app window to resize");
  } else {
    const size = w.getContentSize() as [number, number];
    const min = w.getMinimumSize() as [number, number];
    try {
      for (const [cw, ch] of [[1280, 820], [min[0] || 940, min[1] || 620]] as Array<[number, number]>) {
        w.setContentSize(cw, ch);
        await wait(500);
        const t = await safe<Toasts>(js, TOASTS);
        const o = t.err ? null : t.over;
        check(
          `T47 Д27: at ${cw}×${ch} toasts over Settings stand inside its body card, clear of its header and Done, and nothing is cut off`,
          !!o && o.n === 2 && o.inCard && o.inWin && o.clearOfHeader && o.clearOfDone && o.inView,
          t.err ?? JSON.stringify({ window: `${t.width}×${t.height}`, over: t.over }),
        );
        check(
          `T47 Д27: at ${cw}×${ch} seven toasts at once stop short of the header — the oldest step aside, the newest shows`,
          !t.err && t.many.n >= 1 && t.many.newest && t.many.clearOfHeader && t.many.inCard,
          t.err ?? JSON.stringify(t.many),
        );
        check(
          `T47 Д27: at ${cw}×${ch} with Settings closed they are back at the top right, under the toolbar`,
          !t.err && t.chat.n === 2 && t.chat.corner,
          t.err ?? JSON.stringify(t.chat),
        );
      }
    } finally {
      if (!w.isDestroyed()) {
        w.setContentSize(size[0], size[1]);
        await wait(400);
      }
    }
  }

  // Д28
  const g = await safe<Switches>(js, SWITCHES);
  const named = ["Notify when a turn ends", "Anonymous usage analytics", "Name chats automatically"];
  check(
    "T47 Д28: the General switches stand alone — no On / Off word beside them — and still say their state",
    !g.err && named.every((n) => g.labels.includes(n)) && g.words.every((x) => x === "") && g.states.every((n) => n === 0)
      && g.checked.every((c) => c === "true" || c === "false"),
    g.err ?? JSON.stringify({ labels: g.labels, words: g.words, states: g.states, checked: g.checked }),
  );
  check(
    "T47 Д28: while a write is on its way a spinner stands where the word was, and the switch says busy and waits",
    !g.err && !!g.busy && g.busy.spin && g.busy.aria === "true" && g.busy.disabled && g.busy.words === "",
    g.err ?? JSON.stringify(g.busy),
  );
}
