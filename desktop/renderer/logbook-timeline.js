/* ATO-2526: the logbook's day timeline. One day's notes, newest first,
   each with its time, the app in front and what the model wrote. A note
   can be deleted, or the whole day, each after a confirm; deleted notes
   are gone for good (the day file is rewritten).

   Opened from Settings › Logbook, the Logbook chip's menu and the menu bar
   icon (app:logbookTimeline). Drawn into #lbt-root over the window, closed
   with Escape or the X. Main: main/logbook-timeline-ipc.ts.

   Precedent: Rewind's and Microsoft Recall's timelines, with per-snapshot
   delete and delete-a-range. Loaded before renderer.js; it uses that
   file's globals (esc, ic) only at run time. */

const LBT = {open: false, day: 'today', realDay: null, loading: false, entries: null, err: null, details: false, confirm: null, busy: false, msg: null, days: []};

function lbtBridge() { return typeof BR !== 'undefined' && BR && typeof BR.logbookDay === 'function' ? BR : null; }

function lbtEsc(s) {
  return typeof esc === 'function' ? esc(s) : String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
}

/** "14:05" from a note's ISO time, in the person's clock. */
function lbtClock(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** "Thursday, Nov 27" for a YYYY-MM-DD day. */
function lbtDayName(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  if (!m) return day === 'yesterday' ? 'Yesterday' : 'Today';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, {weekday: 'long', month: 'short', day: 'numeric'});
}

/** This computer's YYYY-MM-DD for today (0) or yesterday (-1). */
function lbtKey(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function lbtRoot() {
  let el = document.getElementById('lbt-root');
  if (!el) { el = document.createElement('div'); el.id = 'lbt-root'; document.body.appendChild(el); }
  return el;
}

function lbtListHTML() {
  if (LBT.loading && !LBT.entries) return '<div class="lbt-empty"><span class="tk-spin"></span><p>Reading notes...</p></div>';
  if (!LBT.entries) return '';
  if (!LBT.entries.length) return '<div class="lbt-empty"><h4>No notes on this day</h4><p>Notes show up here while the logbook is on.</p></div>';
  const rows = LBT.entries.slice().reverse().map((e) => {
    const asking = LBT.confirm === e.at;
    return '<li class="lbt-row">'
      + '<span class="lbt-time">' + lbtEsc(lbtClock(e.at)) + '</span>'
      + '<div class="lbt-body">' + (e.app ? '<span class="lbt-app">' + lbtEsc(e.app) + '</span>' : '') + '<p>' + lbtEsc(e.text) + '</p></div>'
      + (asking
        ? '<span class="lbt-ask">Delete this note? <button class="btn btn-p xs" data-lbt="del:' + lbtEsc(e.at) + '"' + (LBT.busy ? ' disabled' : '') + '>Delete</button>'
          + '<button class="btn btn-g xs" data-lbt="cancel">Keep</button></span>'
        : '<button class="iconbtn sm" data-lbt="ask:' + lbtEsc(e.at) + '" title="Delete this note" aria-label="Delete this note"' + (LBT.busy ? ' disabled' : '') + '>'
          + (typeof ic === 'function' ? ic('trash') : 'x') + '</button>')
      + '</li>';
  });
  return '<ol class="lbt-list">' + rows.join('') + '</ol>';
}

function lbtHTML() {
  if (!LBT.open) return '';
  const n = LBT.entries ? LBT.entries.length : 0;
  const options = ['today', 'yesterday'].concat(LBT.days.filter((d) => d !== lbtKey(0) && d !== lbtKey(-1)))
    .map((d) => '<option value="' + lbtEsc(d) + '"' + (d === LBT.day ? ' selected' : '') + '>' + lbtEsc(d === 'today' ? 'Today' : d === 'yesterday' ? 'Yesterday' : lbtDayName(d)) + '</option>').join('');
  const err = LBT.err
    ? '<div class="lbkerr" role="alert">' + lbtEsc(LBT.err.title) + ' <button class="lbklink" data-lbt="details">' + (LBT.details ? 'Hide details' : 'Details') + '</button>'
      + (LBT.details ? '<div class="lbkdetails">' + lbtEsc(LBT.err.details) + '</div>' : '') + '</div>'
    : '';
  const msg = LBT.msg ? '<div class="lbt-msg" role="status">' + lbtEsc(LBT.msg) + '</div>' : '';
  const wipe = n
    ? (LBT.confirm === '*'
      ? '<span class="lbt-ask">Delete all ' + n + (n === 1 ? ' note' : ' notes') + ' from ' + lbtEsc(lbtDayName(LBT.realDay || LBT.day)) + '? This cannot be undone.'
        + ' <button class="btn btn-p xs" data-lbt="delall"' + (LBT.busy ? ' disabled' : '') + '>Delete the day</button><button class="btn btn-g xs" data-lbt="cancel">Keep</button></span>'
      : '<button class="btn btn-s xs" data-lbt="askall"' + (LBT.busy ? ' disabled' : '') + '>Delete the whole day</button>')
    : '';
  return '<div class="lbt-scrim" data-lbt="close"></div>'
    + '<section class="lbt-sheet" role="dialog" aria-modal="true" aria-label="Logbook timeline">'
    + '<header class="lbt-head"><h3>Logbook timeline</h3><span class="grow"></span>'
    + '<select data-lbt-day aria-label="Day">' + options + '</select>'
    + '<button class="iconbtn sm" data-lbt="close" title="Close" aria-label="Close">' + (typeof ic === 'function' ? ic('x') : 'x') + '</button></header>'
    + '<div class="lbt-tools"><span class="lbt-count">' + (LBT.entries ? (n === 1 ? '1 note' : n + ' notes') : '') + '</span><span class="grow"></span>' + wipe + '</div>'
    + err + msg + '<div class="lbt-scroll">' + lbtListHTML() + '</div></section>';
}

function lbtDraw() {
  if (typeof document === 'undefined') return;
  lbtRoot().innerHTML = lbtHTML();
}

async function lbtLoad() {
  const br = lbtBridge();
  if (!br) return;
  LBT.loading = true; LBT.err = null; LBT.confirm = null; lbtDraw();
  try {
    const r = await br.logbookDay(LBT.day);
    if (r && r.ok) { LBT.entries = r.entries; LBT.realDay = r.day; }
    else { LBT.entries = null; LBT.err = {title: 'Could not read the notes.', details: (r && r.error) || 'No answer.'}; }
  } catch (e) {
    LBT.entries = null; LBT.err = {title: 'Could not read the notes.', details: String((e && e.message) || e)};
  } finally {
    LBT.loading = false;
  }
  lbtDraw();
}

async function lbtDelete(input, done) {
  const br = lbtBridge();
  if (!br || LBT.busy) return;
  LBT.busy = true; LBT.err = null; LBT.msg = null; lbtDraw();
  try {
    const r = await br.logbookDelete(input);
    if (r && r.ok) { done(r.removed); LBT.confirm = null; }
    else LBT.err = {title: 'Could not delete.', details: (r && r.error) || 'No answer.'};
  } catch (e) {
    LBT.err = {title: 'Could not delete.', details: String((e && e.message) || e)};
  } finally {
    LBT.busy = false;
  }
  lbtDraw();
}

/** Opens the timeline on a day (today when none). */
function logbookTimelineOpen(day) {
  LBT.open = true; LBT.day = day || 'today'; LBT.entries = null; LBT.msg = null; LBT.details = false;
  const view = typeof LBK !== 'undefined' && LBK.view ? LBK.view : typeof LBS !== 'undefined' && LBS.view ? LBS.view : null;
  LBT.days = view && Array.isArray(view.days) ? view.days : [];
  lbtLoad();
}

function lbtClose() { LBT.open = false; LBT.confirm = null; lbtDraw(); }

function lbtClick(e) {
  const el = e.target && e.target.closest ? e.target.closest('[data-lbt]') : null;
  if (!el || !LBT.open) return;
  const what = el.getAttribute('data-lbt');
  if (what === 'close') { lbtClose(); return; }
  if (what === 'cancel') { LBT.confirm = null; lbtDraw(); return; }
  if (what === 'details') { LBT.details = !LBT.details; lbtDraw(); return; }
  if (what === 'askall') { LBT.confirm = '*'; lbtDraw(); return; }
  const day = LBT.realDay;
  if (what === 'delall' && day) {
    lbtDelete({day, all: true}, (removed) => { LBT.entries = []; LBT.msg = removed === 1 ? '1 note deleted.' : removed + ' notes deleted.'; });
    return;
  }
  if (what.startsWith('ask:')) { LBT.confirm = what.slice(4); lbtDraw(); return; }
  if (what.startsWith('del:') && day) {
    const at = what.slice(4);
    lbtDelete({day, at: [at]}, () => { LBT.entries = (LBT.entries || []).filter((x) => x.at !== at); LBT.msg = 'Note deleted.'; });
  }
}

function lbtBoot() {
  if (!lbtBridge()) return;
  document.addEventListener('click', lbtClick);
  document.addEventListener('change', (e) => {
    if (e.target && e.target.matches && e.target.matches('[data-lbt-day]')) { LBT.day = e.target.value; LBT.msg = null; lbtLoad(); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && LBT.open) { e.stopPropagation(); lbtClose(); } }, true);
  if (typeof BR.onLogbookTimeline === 'function') BR.onLogbookTimeline(() => logbookTimelineOpen());
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.addEventListener) {
  window.addEventListener('load', lbtBoot);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {LBT, lbtHTML, lbtClick, lbtClock, logbookTimelineOpen};
}
