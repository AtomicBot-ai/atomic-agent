/* ATO-2534: the "● Logbook" chip at the right of the toolbar, shown while
   the logbook is on or paused. A click opens its menu: what it is doing,
   Pause for 30 minutes, Pause for 1 hour, Resume, Stop. The same choices
   are in the menu bar icon's menu (main/logbook-tray.ts).

   The chip is the logbook's visible mark: the runtime captures only while
   this window says the chip is on screen (or the menu bar icon is up). The
   window says so on every change and again every 15 s; a hidden or
   minimized window says no. Main: main/logbook-ipc.ts.

   Precedent: Rewind and Screenpipe keep a recording mark in the menu bar
   with Pause there; Microsoft Recall shows a tray icon while it saves
   snapshots. Loaded before renderer.js; it uses that file's globals (esc,
   renderToolbar) only at run time. */

const LBK = {view: null, open: false, busy: '', error: '', details: false, reported: null, timer: null};

function lbkBridge() {
  return typeof BR !== 'undefined' && BR && typeof BR.logbookStatus === 'function' ? BR : null;
}

function lbkEsc(s) {
  return typeof esc === 'function' ? esc(s) : String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
}

function lbkShowsChip(view) {
  return !!view && (view.state === 'on' || view.state === 'paused');
}

/** "until 14:30" for a pause. */
function lbkUntil(ms) {
  if (typeof ms !== 'number') return '';
  const d = new Date(ms);
  return 'until ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function lbkStateLine(view) {
  if (view.state === 'paused') return ('Paused ' + lbkUntil(view.pausedUntil)).trim();
  const notes = view.notesToday === 1 ? '1 note today' : view.notesToday + ' notes today';
  return 'A note every ' + view.intervalMinutes + ' min, ' + notes;
}

/** The toolbar's chip; renderer.js renderToolbar puts it first in .tb-right. */
function logbookChipHTML() {
  const v = LBK.view;
  if (!lbkShowsChip(v)) return '';
  const paused = v.state === 'paused';
  const label = paused ? 'Logbook paused' : 'Logbook';
  return '<button class="lbkchip' + (paused ? ' paused' : '') + '" data-lbk="menu" aria-haspopup="menu"'
    + ' aria-expanded="' + LBK.open + '" title="' + lbkEsc(label + ': ' + lbkStateLine(v)) + '">'
    + '<span class="lbkdot" aria-hidden="true"></span>' + lbkEsc(label) + '</button>';
}

function lbkMenuHTML() {
  const v = LBK.view;
  if (!LBK.open || !lbkShowsChip(v)) return '';
  const dis = LBK.busy ? ' disabled' : '';
  const item = (act, label) => '<button role="menuitem" class="lbkitem" data-lbk="' + act + '"' + dis + '>'
    + lbkEsc(LBK.busy === act ? 'Working...' : label) + '</button>';
  const rows = v.state === 'paused'
    ? item('resume', 'Resume')
    : item('pause:30', 'Pause for 30 minutes') + item('pause:60', 'Pause for 1 hour');
  const err = LBK.error
    ? '<div class="lbkerr" role="alert">' + lbkEsc(LBK.error.title)
      + ' <button class="lbklink" data-lbk="details">' + (LBK.details ? 'Hide details' : 'Details') + '</button>'
      + (LBK.details ? '<div class="lbkdetails">' + lbkEsc(LBK.error.details) + '</div>' : '') + '</div>'
    : '';
  const skipped = v.lastOutcome === 'skipped' && v.lastReason
    ? '<div class="lbknote">Last check skipped: ' + lbkEsc(v.lastReason) + '</div>' : '';
  return '<div class="lbkmenu" role="menu" aria-label="Logbook">'
    + '<div class="lbkhead"><span class="lbkdot' + (v.state === 'paused' ? ' paused' : '') + '" aria-hidden="true"></span>'
    + '<div><b>' + (v.state === 'paused' ? 'Logbook paused' : 'Logbook is on') + '</b>'
    + '<div class="lbksub">' + lbkEsc(lbkStateLine(v)) + '</div></div></div>'
    + skipped + err + rows + item('stop', 'Stop the logbook')
    + (typeof logbookTimelineOpen === 'function' ? item('timeline', 'Open the timeline') : '')
    + '</div>';
}

function lbkRoot() {
  let el = document.getElementById('lbk-root');
  if (!el) { el = document.createElement('div'); el.id = 'lbk-root'; document.body.appendChild(el); }
  return el;
}

function lbkPlaceMenu() {
  const chip = document.querySelector('.lbkchip');
  const menu = document.querySelector('.lbkmenu');
  if (!chip || !menu) return;
  const r = chip.getBoundingClientRect();
  menu.style.top = Math.round(r.bottom + 6) + 'px';
  menu.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
}

function lbkChipOnScreen() {
  return !!document.querySelector('.lbkchip') && document.visibilityState === 'visible';
}

/** Tells main whether the chip is on screen: on a change, and every 15 s while it is. */
function lbkReport(force) {
  const br = lbkBridge();
  if (!br || typeof br.logbookChipVisible !== 'function') return;
  const shown = lbkChipOnScreen();
  if (!force && shown === LBK.reported) return;
  LBK.reported = shown;
  br.logbookChipVisible(shown);
}

function lbkDraw() {
  const root = lbkRoot();
  root.innerHTML = lbkMenuHTML();
  lbkPlaceMenu();
  lbkReport(false);
}

/** A new state from main: redraw the toolbar only when the chip changes. */
function lbkSet(view) {
  const before = logbookChipHTML();
  LBK.view = view && typeof view === 'object' ? view : null;
  if (!lbkShowsChip(LBK.view)) LBK.open = false;
  if (before !== logbookChipHTML() && typeof renderToolbar === 'function') renderToolbar();
  lbkDraw();
}

async function lbkAct(token) {
  const br = lbkBridge();
  if (!br || LBK.busy) return;
  const [action, mins] = token.split(':');
  LBK.busy = token;
  LBK.error = '';
  lbkDraw();
  let r;
  try { r = await br.logbookAct(action, mins ? Number(mins) : undefined); } catch (e) { r = {ok: false, error: 'The app did not answer.'}; }
  LBK.busy = '';
  if (r && r.ok) { LBK.open = false; lbkSet(r.view); return; }
  const verb = action === 'stop' ? 'stop' : action === 'resume' ? 'resume' : 'pause';
  LBK.error = {title: 'Could not ' + verb + ' the logbook.', details: (r && r.error) || 'No answer.'};
  LBK.details = false;
  lbkDraw();
}

function lbkClick(e) {
  const el = e.target.closest ? e.target.closest('[data-lbk]') : null;
  if (!el) {
    if (LBK.open && !(e.target.closest && e.target.closest('.lbkmenu'))) { LBK.open = false; lbkSet(LBK.view); }
    return;
  }
  const what = el.getAttribute('data-lbk');
  if (what === 'menu') { LBK.open = !LBK.open; LBK.error = ''; lbkSet(LBK.view); return; }
  if (what === 'details') { LBK.details = !LBK.details; lbkDraw(); return; }
  if (what === 'timeline') { LBK.open = false; lbkSet(LBK.view); logbookTimelineOpen(); return; }
  void lbkAct(what);
}

function lbkBoot() {
  const br = lbkBridge();
  if (!br) return;
  document.addEventListener('click', lbkClick);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && LBK.open) { LBK.open = false; lbkSet(LBK.view); } });
  document.addEventListener('visibilitychange', () => lbkReport(true));
  window.addEventListener('resize', lbkPlaceMenu);
  if (typeof br.onLogbook === 'function') br.onLogbook(lbkSet);
  br.logbookStatus().then((r) => { if (r && r.ok) lbkSet(r.view); }).catch(() => {});
  LBK.timer = setInterval(() => { if (LBK.reported || lbkChipOnScreen()) lbkReport(true); }, 15000);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.addEventListener) {
  window.addEventListener('load', lbkBoot);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {LBK, logbookChipHTML, lbkMenuHTML, lbkSet, lbkAct, lbkReport, lbkStateLine, lbkShowsChip};
}
