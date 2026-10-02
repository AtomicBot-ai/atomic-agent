import { BrowserWindow, screen } from "electron";

/**
 * Release-fix checks for backlog item 36 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=36`.
 *
 * 36 — Nadya, 02.10: in macOS full screen the Settings nav column looked cut
 * off, Diagnostics the last row showing. Diagnostics is the last of the nine
 * sections, and nothing in the renderer knows about full screen: the settings
 * window follows the size of the app window alone. What the code could do was
 * cut rows off on a window too short for them, about 360px of rows that
 * nothing scrolled, so the settings window's own edge cut the last ones. The
 * nav scrolls now, keeps its scroll across the window's rebuilds and brings
 * the section's row into view; and the settings window keeps out of the band
 * the system's controls sit over (macOS's traffic lights, Windows' caption
 * buttons), in every window state.
 *
 * The checks walk window sizes rather than the full-screen switch, which
 * would move the window to a Space of its own in the middle of the run (and
 * cover the other smokes' windows): the default window, the smallest the app
 * allows, one as tall as the screen's work area, and one shorter than the app
 * allows, its minimum lowered for the check. The window's size and minimum
 * are put back, Settings is closed and reopens on the section it did.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Failed = { err?: string };
type Box = { top: number; bottom: number; left: number; right: number; height: number };
type Geometry = {
  vw: number; vh: number; platform: string; win: Box; menu: Box; rows: number; heights: number[];
  scroll: { top: number; height: number; client: number; overflow: string };
  on: string; onWhole: boolean;
  /** Each row after the nav alone was scrolled to it: whole in the nav, inside the settings window and the app window. */
  reach: Array<{ label: string; whole: boolean; inWin: boolean; inView: boolean }>;
  /** The nav scrolled half way, then the window rebuilt by render(). */
  kept: { before: number; after: number } | null;
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

/* Settings opened afresh on Diagnostics, the last row, and measured. */
const MEASURE = String.raw`(async () => {
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  const box = (n) => { const r = n.getBoundingClientRect(); return {top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height}; };
  window.__settingsClose(); await tick(50);
  window.__settingsOpen('diagnostics'); await tick(200);
  const win = document.querySelector('#settings .setwin');
  const menu = document.querySelector('#settings .setmenu');
  if (!win || !menu) return {err: 'no settings window'};
  const rows = [...menu.querySelectorAll('.menurow')];
  const m = box(menu), w = box(win);
  const whole = (r) => r.top >= m.top - 0.5 && r.bottom <= m.bottom + 0.5 && r.height > 0;
  const on = menu.querySelector('.menurow.on');
  const out = {vw: innerWidth, vh: innerHeight, win: w, menu: m, rows: rows.length, heights: rows.map((r) => Math.round(box(r).height)),
    platform: ['darwin', 'win32', 'linux'].find((p) => document.body.classList.contains('platform-' + p)) || '',
    scroll: {top: menu.scrollTop, height: menu.scrollHeight, client: menu.clientHeight, overflow: getComputedStyle(menu).overflowY},
    on: on ? ((on.querySelector('.lb') || on).textContent || '').trim() : '', onWhole: !!on && whole(box(on)), reach: [], kept: null};
  const keep = menu.scrollTop;
  for (const r of rows) {
    menu.scrollTop = r.offsetTop - menu.offsetTop;
    const b = box(r);
    out.reach.push({label: ((r.querySelector('.lb') || r).textContent || '').trim(), whole: whole(b),
      inWin: b.top >= w.top - 0.5 && b.bottom <= w.bottom + 0.5, inView: b.top >= 0 && b.bottom <= innerHeight + 0.5});
  }
  menu.scrollTop = keep;
  const room = menu.scrollHeight - menu.clientHeight;
  if (room > 4) {
    menu.scrollTop = Math.round(room / 2);
    const before = menu.scrollTop;
    render();
    const again = document.querySelector('#settings .setmenu');
    out.kept = {before, after: again ? again.scrollTop : -1};
  }
  return out;
})()`;

export async function checks36(js: Js, check: Check): Promise<void> {
  const w = appWindow();
  if (!w) {
    check("T36: the settings nav fits every window size", false, "no app window to resize");
    return;
  }
  const size = w.getContentSize() as [number, number];
  const min = w.getMinimumSize() as [number, number];
  const work = screen.getDisplayMatching(w.getBounds()).workAreaSize;
  const last = await safe<Last>(js, LAST_READ);
  const at = async (cw: number, ch: number): Promise<Geometry & Failed> => {
    w.setContentSize(cw, ch);
    await wait(500);
    return safe<Geometry>(js, MEASURE);
  };
  /* The room the settings window keeps above and below itself: the 52px band
     where macOS and Windows draw their window controls, 24px under a normal
     frame (Linux); centred in a window with more room than that. */
  const band = (g: Geometry) => (g.platform === "darwin" || g.platform === "win32" ? 52 : 24);
  const placed = (g: Geometry) => {
    const want = Math.max(band(g), (g.vh - 700) / 2);
    return Math.abs(g.win.top - want) <= 1 && Math.abs(g.vh - g.win.bottom - want) <= 1;
  };
  const inside = (g: Geometry) => g.win.top >= 0 && g.win.left >= 0 && g.win.bottom <= g.vh + 0.5 && g.win.right <= g.vw + 0.5;
  const allWhole = (g: Geometry) => g.rows === 9 && g.reach.length === 9 && g.reach.every((r) => r.whole && r.inWin && r.inView);
  const summary = (g: Geometry & Failed) => g.err ?? JSON.stringify({
    window: `${g.vw}×${g.vh}`, win: { top: g.win.top, bottom: g.win.bottom }, menu: { top: g.menu.top, bottom: g.menu.bottom }, scroll: g.scroll,
    on: g.on, onWhole: g.onWhole, cut: g.reach.filter((r) => !(r.whole && r.inWin && r.inView)).map((r) => r.label), heights: g.heights, kept: g.kept,
  });
  try {
    // The default window: nothing scrolls, nothing moved.
    const dflt = await at(1280, 820);
    check(
      "T36: on the default window all nine rows show whole with nothing to scroll, and the settings window sits where it did",
      !dflt.err && allWhole(dflt) && dflt.scroll.height <= dflt.scroll.client + 1 && placed(dflt) && inside(dflt),
      summary(dflt),
    );

    // The smallest window the app allows: still no scrolling, and the controls' band is clear.
    const small = await at(min[0] || 940, min[1] || 620);
    check(
      "T36: on the smallest window the app allows all nine rows show whole, under the band the window controls sit over",
      !small.err && allWhole(small) && small.scroll.height <= small.scroll.client + 1 && placed(small) && inside(small),
      summary(small),
    );

    // As tall as the screen allows, the size full screen gives the window.
    const tallH = Math.max(820, work.height - 40);
    const tall = await at(Math.min(work.width, 1600), tallH);
    check(
      "T36: on a window as tall as the screen all nine rows show whole and the settings window is centred",
      !tall.err && allWhole(tall) && tall.scroll.height <= tall.scroll.client + 1 && placed(tall) && inside(tall),
      summary(tall),
    );

    // Shorter than the app allows: the nav has to scroll, and it does.
    w.setMinimumSize(min[0] || 940, 300);
    const short = await at(1100, 380);
    check(
      "T36: on a window too short for the rows the nav scrolls instead of cutting them off — each one is reached whole, at its own height",
      !short.err && short.vh <= 400 && short.scroll.overflow === "auto" && short.scroll.height > short.scroll.client
        && allWhole(short) && short.heights.every((h) => h === 32) && placed(short) && inside(short),
      summary(short),
    );
    check(
      "T36: opening Settings on its last section brings that row into view, and a rebuild keeps the nav where it was scrolled",
      !short.err && short.on === "Diagnostics" && short.onWhole && short.kept !== null && short.kept.before > 0 && Math.abs(short.kept.after - short.kept.before) <= 1,
      summary(short),
    );
  } finally {
    await safe<void>(js, "window.__settingsClose()");
    if (!last.err) await safe<void>(js, lastRestore(last));
    if (!w.isDestroyed()) {
      w.setContentSize(size[0], size[1]);
      w.setMinimumSize(min[0], min[1]);
      await wait(400);
    }
  }
}
