/* ATO-2514: "Create tasks" under meeting notes.

   The meeting-notes skill (starter-skills/meeting-notes) writes its action
   items as one table, `| # | Task | Owner | Due |`, and until now offered to
   schedule them only after a typed "yes". A reply that holds that table
   gets a Create tasks button in its action row: it opens a short list of
   the items, each ticked, with its owner and a date (the due date when the
   notes give one, else tomorrow), and creates one scheduled reminder per
   ticked item through the same `task create` the Cron jobs pane uses
   (BR.taskCreate, kind `at`, 09:00 local). The reminders land on the task
   board and in Settings, Cron jobs. Nothing is created without the click.

   Like Granola's and Otter's "action items to tasks" and Zoom AI notes'
   follow-up list. Drawn into its own #mtt-root, outside render(). Loaded
   before renderer.js; uses BR, S, esc, ic and toast only at run time. The
   pure part is exported for test/meeting-tasks.test.mjs. */

const MTT = {open: false, items: [], busy: false, error: null};

function mttCells(line) {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function mttPlain(s) {
  return String(s || '').replace(/\*\*|__|`/g, '').trim().replace(/^"(.*)"$/, '$1').trim();
}

/** The action items of a meeting-notes reply: [{task, owner, due}] ('' when unknown); [] when there is no such table. */
function meetingActionItems(text) {
  const lines = String(text || '').split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s*\|\s*#\s*\|\s*Task\s*\|\s*Owner\s*\|\s*Due\s*\|\s*$/i.test(l));
  if (at < 0) return [];
  const out = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!/^\s*\|/.test(l)) break;
    if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) continue;   // the |---| row
    const c = mttCells(l);
    const task = mttPlain(c[1]);
    if (!task || /^none\.?$/i.test(task)) continue;
    const owner = mttPlain(c[2]);
    const due = mttPlain(c[3]);
    out.push({task, owner: /^unassigned$/i.test(owner) ? '' : owner, due: /^not set$/i.test(due) ? '' : due});
  }
  return out;
}

function mttTwo(n) { return String(n).padStart(2, '0'); }

/** `YYYY-MM-DD` for the date input: the due date when it is one, else the day after `now`. */
function meetingTaskDay(due, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(due || '').trim());
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  const d = new Date(Number.isFinite(now) ? now : Date.now());
  d.setDate(d.getDate() + 1);
  return d.getFullYear() + '-' + mttTwo(d.getMonth() + 1) + '-' + mttTwo(d.getDate());
}

/** 09:00 local on that day, in Unix ms; NaN for a date that is not one. */
function meetingTaskAt(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return NaN;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9, 0, 0, 0);
  return d.getMonth() === Number(m[2]) - 1 ? d.getTime() : NaN;
}

/** The message the reminder runs with. */
function meetingTaskMessage(item) {
  return 'Reminder from meeting notes: ' + item.task + (item.owner ? ' (owner: ' + item.owner + ')' : '')
    + '. Remind me about this in one or two plain sentences. Do not do the task yourself.';
}

/** The button in a reply's action row, only when the reply holds action items. */
function meetingTasksButtonHTML(m) {
  if (!m || m.k !== 'assistant' || m.placeholder || typeof BR === 'undefined' || !BR || !BR.taskCreate) return '';
  if (!meetingActionItems(m.text).length) return '';
  return '<button class="msgact mttbtn" data-mtt-open="' + esc(m.id) + '" title="Create tasks from the action items" aria-label="Create tasks from the action items">'
    + ic('tasks') + '<span>Create tasks</span></button>';
}

function mttRoot() {
  let el = document.getElementById('mtt-root');
  if (!el) { el = document.createElement('div'); el.id = 'mtt-root'; document.body.appendChild(el); }
  return el;
}

function mttPaint() {
  if (typeof document === 'undefined') return;
  if (!MTT.open) { mttRoot().innerHTML = ''; return; }
  const today = meetingTaskDay('', Date.now() - 86_400_000);
  const rows = MTT.items.map((it, i) => '<label class="mttrow">'
    + '<input type="checkbox" data-mtt-pick="' + i + '"' + (it.pick ? ' checked' : '') + (MTT.busy ? ' disabled' : '') + '>'
    + '<span class="mttmain"><span class="mtttask">' + esc(it.task) + '</span>'
    + '<span class="mttowner">' + esc(it.owner ? 'Owner: ' + it.owner : 'No owner named') + '</span></span>'
    + '<input type="date" class="mttday" data-mtt-day="' + i + '" value="' + esc(it.day) + '" min="' + esc(today) + '" aria-label="Reminder date"' + (MTT.busy ? ' disabled' : '') + '>'
    + '</label>').join('');
  const n = MTT.items.filter((it) => it.pick).length;
  mttRoot().innerHTML = '<div class="sheetwrap mttwrap" data-mtt="close"><div class="sheet mttsheet" role="dialog" aria-label="Create tasks">'
    + '<div class="sheethead"><div class="ttl">Create tasks</div><button class="iconbtn sheetx" data-mtt="close" title="Close" aria-label="Close">' + ic('x') + '</button></div>'
    + '<div class="sheetbody"><p class="mttintro">Each ticked item becomes a reminder at 9:00 on its date. They show on the task board and in Settings, Cron jobs.</p>'
    + rows + (MTT.error ? '<p class="mtterr">' + esc(MTT.error) + '</p>' : '') + '</div>'
    + '<div class="sheetfoot"><button class="btn btn-g sm" data-mtt="close"' + (MTT.busy ? ' disabled' : '') + '>Cancel</button>'
    + '<button class="btn btn-p sm" data-mtt="create"' + (n && !MTT.busy ? '' : ' disabled') + '>'
    + (MTT.busy ? 'Creating…' : 'Create ' + n + (n === 1 ? ' task' : ' tasks')) + '</button></div></div></div>';
}

function meetingTasksOpen(id) {
  const m = typeof S !== 'undefined' && Array.isArray(S.log) ? S.log.find((x) => x.id === id) : null;
  const items = m ? meetingActionItems(m.text) : [];
  if (!items.length) return;
  MTT.items = items.map((it) => ({...it, pick: true, day: meetingTaskDay(it.due, Date.now())}));
  MTT.open = true; MTT.busy = false; MTT.error = null;
  mttPaint();
}

async function meetingTasksCreate() {
  if (MTT.busy) return;
  const chosen = MTT.items.filter((it) => it.pick);
  const now = Date.now();
  if (chosen.some((it) => !(meetingTaskAt(it.day) > now))) { MTT.error = 'Pick a date that is still ahead for every ticked item.'; mttPaint(); return; }
  MTT.busy = true; MTT.error = null; mttPaint();
  let made = 0;
  for (const it of chosen) {
    let r = null;
    try { r = await BR.taskCreate({message: meetingTaskMessage(it), kind: 'at', expression: String(meetingTaskAt(it.day))}); } catch (e) { r = null; }
    if (r && r.ok) { made++; it.pick = false; }
  }
  MTT.busy = false;
  if (made === chosen.length) {
    MTT.open = false; mttPaint();
    toast(made === 1 ? 'Task created' : made + ' tasks created', 'They are on the task board and in Settings, Cron jobs.');
    if (typeof tasksRefresh === 'function') tasksRefresh();
    return;
  }
  MTT.error = made ? made + ' of ' + chosen.length + ' were created. The rest could not be; try again.' : 'The tasks could not be created. Try again in a moment.';
  mttPaint();
  toast('Could not create every task', MTT.error, 'bad');
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const open = t.closest('[data-mtt-open]');
    if (open) { e.preventDefault(); meetingTasksOpen(open.getAttribute('data-mtt-open')); return; }
    const b = t.closest('[data-mtt]');
    if (!b) return;
    const verb = b.getAttribute('data-mtt');
    if (verb === 'close' && (b === t || b.tagName === 'BUTTON') && !MTT.busy) { MTT.open = false; mttPaint(); }
    else if (verb === 'create') { e.preventDefault(); meetingTasksCreate(); }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.getAttribute) return;
    const pick = t.getAttribute('data-mtt-pick'), day = t.getAttribute('data-mtt-day');
    if (pick !== null && MTT.items[+pick]) { MTT.items[+pick].pick = !!t.checked; mttPaint(); }
    else if (day !== null && MTT.items[+day]) { MTT.items[+day].day = String(t.value || ''); MTT.error = null; }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && MTT.open && !MTT.busy) { e.stopPropagation(); MTT.open = false; mttPaint(); }
  }, true);
}

if (typeof module !== 'undefined') {
  module.exports = {meetingActionItems, meetingTaskDay, meetingTaskAt, meetingTaskMessage, meetingTasksButtonHTML};
}
