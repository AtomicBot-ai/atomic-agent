/* ---------------- Settings › Memory › Clear old memory (ATO-321) ----------------
   Loaded BEFORE renderer.js, so it only declares, and reads renderer.js
   globals (BR, render, memRefresh) at call time.
   The pure half (dates, the card's markup, the confirm's words) is shared
   with test/memory-forget.test.mjs.

   Test runs (E2E sessions, QA passes on this computer) leave notes and
   lessons that later chats recall as if they were about the person. The
   agent clears them by date (#1478, `atag memory forget --before <date>`):
   notes created before the date are deleted, lessons created before it are
   set aside (deprecated: out of recall, still readable). Profile facts stay.

   As ChatGPT's "Delete all memories" and Claude's "Reset memory": a button,
   then a confirm that says what goes and that it cannot be undone. Here the
   confirm also says how many, from a dry run of the same command, and a
   date bounds it so the memory made since stays. The confirm is drawn in
   the card, as this tab's note Delete asks (memory-edit.js). */

const MEMF = {open: false, date: '', phase: 'idle', counts: null, error: null};

/* Today as YYYY-MM-DD in local time: "before today" keeps what was made today. */
function memForgetToday(now) {
  const d = new Date(typeof now === 'number' ? now : Date.now());
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function memForgetDateOk(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof v === 'string' ? v : '');
  if (!m) return false;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3];
}

function memForgetPlural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

/* What the counts say, in a line: "12 notes and 3 lessons". */
function memForgetCountsLine(c) {
  return memForgetPlural(c.notes, 'note', 'notes') + ' and ' + memForgetPlural(c.lessons, 'lesson', 'lessons');
}

/* The confirm for counts `c` before `date`, as {title, msg, ok}, or null when nothing would go. */
function memForgetConfirm(c, date) {
  if (!c || (c.notes === 0 && c.lessons === 0)) return null;
  return {
    title: 'Clear memory from before ' + date + '?',
    msg: memForgetCountsLine(c) + ' made before that day leave what chats recall: the notes are deleted, the lessons set aside. '
      + 'What you told it about yourself (Profile) stays. This cannot be undone.',
    ok: 'Clear ' + memForgetCountsLine(c),
  };
}

/* The card under the toolbar. `st`: MEMF; `h`: {esc, ic}. */
function memForgetHTML(st, h) {
  if (!st || !st.open) return '';
  const {esc, ic} = h;
  const busy = st.phase === 'checking' || st.phase === 'clearing';
  const off = busy ? ' disabled' : '';
  let said = '';
  if (st.error) said = '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(st.error) + '</span></div>';
  else if (st.phase === 'confirm' && st.counts) {
    const ask = memForgetConfirm(st.counts, st.date);
    said = '<div class="tk-notice tk-notice--red" role="alertdialog" aria-label="' + esc(ask.title) + '" data-memf-confirm>' + ic('alert')
      + '<span class="grow"><b>' + esc(ask.title) + '</b> ' + esc(ask.msg) + '</span>'
      + '<button class="btn btn-g sm" data-act="memory:forgetNo">Cancel</button>'
      + '<button class="btn btn-danger sm" data-act="memory:forgetGo">' + esc(ask.ok) + '</button></div>';
  }
  else if (st.phase === 'empty') said = '<p class="sd-cap" data-memf-empty>Nothing in memory was made before ' + esc(st.date) + '.</p>';
  else if (st.phase === 'done' && st.counts) said = '<div class="tk-notice tk-notice--green" data-memf-done>' + ic('check') + '<span class="grow">Cleared '
    + esc(memForgetCountsLine(st.counts)) + '.</span></div>';
  return '<div class="tk-card pad sd-memforget" data-memf>'
    + '<div class="sd-pairhead">' + ic('trash') + '<b>Clear old memory</b><span class="sd-grow"></span>'
      + '<button class="iconbtn sm" data-act="memory:forget" title="Close" aria-label="Close">' + ic('x') + '</button></div>'
    + '<p class="sd-cap">For memory left by test runs or old experiments: notes and lessons made before the day you pick. Profile facts stay.</p>'
    + '<div class="sd-acts"><label class="sd-cap" for="memf-date">Made before</label>'
      + '<input id="memf-date" class="tk-inp" type="date" value="' + esc(st.date) + '" max="' + esc(memForgetToday()) + '"' + off + '>'
      + '<span class="sd-grow"></span>'
      + '<button class="btn btn-danger sm" data-act="memory:forgetCheck"' + off + '>'
        + (busy ? '<span class="tk-spin"></span>' + (st.phase === 'clearing' ? 'Clearing…' : 'Counting…') : 'Clear…') + '</button></div>'
    + said
    + '</div>';
}

/* The toolbar button that opens the card. */
function memForgetButtonHTML(h) {
  return '<button class="iconbtn sm' + (MEMF.open ? ' on' : '') + '" data-act="memory:forget" title="Clear old memory" aria-label="Clear old memory" aria-pressed="' + MEMF.open + '">'
    + h.ic('trash') + '</button>';
}

function memForgetRepaint() { if (typeof render === 'function') render(); }

async function memForgetRun(apply) {
  const api = typeof BR !== 'undefined' && BR && typeof BR.memoryForget === 'function' ? BR : null;
  if (!api) return {ok: false, error: 'This app cannot clear memory yet.'};
  try { return await api.memoryForget(MEMF.date, apply); } catch (e) { return {ok: false, error: String((e && e.message) || e)}; }
}

/** The memory: verbs this file owns (renderer.js memoryAct hands them over). */
function memForgetAct(verb) {
  if (verb === 'forget') {
    MEMF.open = !MEMF.open;
    if (MEMF.open) Object.assign(MEMF, {date: MEMF.date || memForgetToday(), phase: 'idle', counts: null, error: null});
    memForgetRepaint();
    return true;
  }
  if (verb === 'forgetCheck') {
    if (MEMF.phase === 'checking' || MEMF.phase === 'clearing') return true;
    const f = typeof document !== 'undefined' && document.getElementById('memf-date');
    if (f) MEMF.date = f.value;
    if (!memForgetDateOk(MEMF.date)) { Object.assign(MEMF, {phase: 'idle', error: 'Pick a day.'}); memForgetRepaint(); return true; }
    Object.assign(MEMF, {phase: 'checking', counts: null, error: null});
    memForgetRepaint();
    memForgetRun(false).then((res) => {
      if (!res || res.ok !== true) { Object.assign(MEMF, {phase: 'idle', error: (res && res.error) || 'Could not count the memory.'}); memForgetRepaint(); return; }
      const counts = {notes: res.notes || 0, lessons: res.lessons || 0};
      Object.assign(MEMF, {phase: memForgetConfirm(counts, MEMF.date) ? 'confirm' : 'empty', counts});
      memForgetRepaint();
    });
    return true;
  }
  if (verb === 'forgetNo') { Object.assign(MEMF, {phase: 'idle', counts: null, error: null}); memForgetRepaint(); return true; }
  if (verb === 'forgetGo') {
    if (MEMF.phase !== 'confirm' || !MEMF.counts) return true;
    Object.assign(MEMF, {phase: 'clearing', error: null});
    memForgetRepaint();
    memForgetRun(true).then((res) => {
      if (!res || res.ok !== true || res.applied !== true) {
        Object.assign(MEMF, {phase: 'idle', error: (res && res.error) || 'Could not clear the memory.'});
      } else {
        Object.assign(MEMF, {phase: 'done', counts: {notes: res.notes || 0, lessons: res.lessons || 0}});
        if (typeof memRefresh === 'function') memRefresh();
      }
      memForgetRepaint();
    });
    return true;
  }
  return false;
}

if (typeof document !== 'undefined') {
  document.addEventListener('input', (ev) => { if (ev.target && ev.target.id === 'memf-date') MEMF.date = ev.target.value; });
}

if (typeof module !== 'undefined') {
  module.exports = {MEMF, memForgetToday, memForgetDateOk, memForgetCountsLine, memForgetConfirm, memForgetHTML, memForgetButtonHTML, memForgetAct};
}
