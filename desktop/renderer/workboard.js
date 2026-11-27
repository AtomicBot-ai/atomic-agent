/* ---------------- ATO-2257: the task board ----------------
   Loaded before renderer.js; declares only. The pure half is shared with the
   Node checks (test/workboard.test.mjs); the renderer half reads renderer.js
   globals (S, BR, render, act, toast, esc, relTime) at call time, as
   agent-hub.js does.

   The agent's tasks as cards in five lanes, after Vibe Kanban and the
   Hermes/OpenClaw workboards: To do, In progress, Review, Blocked, Done. A
   card's lane comes from its task's status until someone moves it (drag it
   to another lane, or pick one in its menu); moving never runs, pauses or
   ends the task (src/tasks/task-board-lanes.ts). A card shows the task's
   message, its assignee (an agent profile name) and note, both editable, and
   a Run now button that is the Cron jobs tab's own run (agent:runTask).

   Opened from the sidebar's Task board row and the palette (`board:open`). */

const WB_LANES = [['todo', 'To do'], ['doing', 'In progress'], ['review', 'Review'], ['blocked', 'Blocked'], ['done', 'Done']];
/** The ids the agent mints (`t-<uuid>`); anything else never reaches main. */
const WB_SAFE_ID = /^[\w.-]{1,64}$/;
const WB_ASSIGNEE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WB_NOTE_MAX = 2000;
const WB_TITLE_MAX = 140;
const WB_REFRESH_MS = 8000;

function wbEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}
function wbIsLane(lane) { return WB_LANES.some(([l]) => l === lane); }

/** A card's title: the first line of its task's message, cut short. */
function wbTitle(card) {
  const msg = String((card && card.task && card.task.userMessage) || '').trim();
  const line = msg.split(/\r?\n/)[0] || '(no message)';
  return line.length > WB_TITLE_MAX ? line.slice(0, WB_TITLE_MAX - 1) + '…' : line;
}

/** Cards in every lane, in board order; each lane keeps the agent's order (newest first). */
function wbGroup(cards) {
  const list = Array.isArray(cards) ? cards.filter((c) => c && c.task && WB_SAFE_ID.test(String(c.task.id))) : [];
  return WB_LANES.map(([lane, label]) => ({lane, label, cards: list.filter((c) => (wbIsLane(c.lane) ? c.lane : 'todo') === lane)}));
}

/** Whether a card may go to `lane`: a known lane other than the one it is in. */
function wbCanMove(card, lane) {
  if (!card || !card.task) return {ok: false, reason: 'no such card'};
  if (!wbIsLane(lane)) return {ok: false, reason: 'unknown lane'};
  if (card.lane === lane) return {ok: false, reason: 'already there'};
  return {ok: true};
}

/** The cards after moving one, before the agent answers (put back if it refuses). */
function wbApplyMove(cards, id, lane) {
  return (cards || []).map((c) => (c && c.task && c.task.id === id ? Object.assign({}, c, {lane, laneSource: 'board'}) : c));
}

/** The note / assignee form's values as the patch main checks, or an error line. */
function wbEditPatch(draft) {
  const note = String((draft && draft.note) || '').trim();
  const assignee = String((draft && draft.assignee) || '').trim();
  if (note.length > WB_NOTE_MAX) return {ok: false, error: 'The note is longer than ' + WB_NOTE_MAX + ' characters.'};
  if (assignee && !WB_ASSIGNEE.test(assignee)) return {ok: false, error: 'An assignee is a profile name: lowercase letters, digits, - and _.'};
  return {ok: true, patch: {note: note || null, assignee: assignee || null}};
}

/** One card. `o`: {rel, running (id being run), editing (id), draft, error}. */
function wbCardHTML(card, o) {
  const opts = o || {};
  const t = card.task, id = String(t.id);
  const busy = opts.running === id;
  const meta = [t.status];
  if (t.recurring) meta.push('recurring');
  if (typeof opts.rel === 'function' && t.updatedAt) meta.push(opts.rel(t.updatedAt));
  const who = card.assignee ? '<span class="wb-who">@' + wbEsc(card.assignee) + '</span>' : '';
  const note = card.note ? '<div class="wb-note">' + wbEsc(card.note) + '</div>' : '';
  const move = '<select class="wb-move" data-wb-move="' + wbEsc(id) + '" aria-label="Move to lane">'
    + WB_LANES.map(([l, label]) => '<option value="' + l + '"' + (l === card.lane ? ' selected' : '') + '>' + label + '</option>').join('') + '</select>';
  let body = '<div class="wb-t">' + wbEsc(wbTitle(card)) + '</div>'
    + '<div class="wb-meta">' + wbEsc(meta.join(' · ')) + who + '</div>' + note;
  if (opts.editing === id) {
    const d = opts.draft || {};
    body += '<div class="wb-edit">'
      + '<textarea data-wb-draft="note" rows="3" maxlength="' + WB_NOTE_MAX + '" placeholder="Note for this card">' + wbEsc(d.note || '') + '</textarea>'
      + '<input data-wb-draft="assignee" placeholder="Assignee (profile name)" value="' + wbEsc(d.assignee || '') + '" spellcheck="false">'
      + (opts.error ? '<div class="wb-err">' + wbEsc(opts.error) + '</div>' : '')
      + '<div class="wb-row"><button class="btn btn-p sm" data-act="board:save:' + wbEsc(id) + '">Save</button>'
      + '<button class="btn btn-g sm" data-act="board:cancel">Cancel</button></div></div>';
  } else {
    body += '<div class="wb-row">'
      + '<button class="btn btn-g sm" data-act="board:run:' + wbEsc(id) + '"' + (opts.running || t.status === 'running' ? ' disabled' : '') + '>'
      + (busy ? '<span class="tk-spin"></span>' : '') + 'Run now</button>'
      + '<button class="btn btn-g sm" data-act="board:edit:' + wbEsc(id) + '">Note</button>' + move + '</div>';
  }
  return '<div class="wb-card' + (t.status === 'running' ? ' wb-card--live' : '') + '" draggable="true" data-wb-id="' + wbEsc(id) + '">' + body + '</div>';
}

/** The lanes. */
function wbBoardHTML(cards, o) {
  return '<div class="wb-lanes">' + wbGroup(cards).map((g) => '<section class="wb-lane" data-wb-lane="' + g.lane + '" aria-label="' + wbEsc(g.label) + '">'
    + '<div class="wb-lane-h">' + wbEsc(g.label) + ' <span class="wb-lane-n">' + g.cards.length + '</span></div>'
    + '<div class="wb-cards">' + (g.cards.length ? g.cards.map((c) => wbCardHTML(c, o)).join('') : '<div class="wb-empty">Drop a card here</div>') + '</div>'
    + '</section>').join('') + '</div>';
}

/* ---- renderer side (globals from renderer.js, read at call time) ---- */

const WB = {cards: null, loading: false, error: null, unsupported: false, running: null, editing: null, draft: null, editError: null, seq: 0, timer: null};

async function wbLoad() {
  if (!BR || typeof BR.taskBoard !== 'function') { WB.unsupported = true; render(); return; }
  const seq = ++WB.seq;
  WB.loading = true;
  let res = null;
  try { res = await BR.taskBoard(); } catch { res = null; }
  if (seq !== WB.seq) return;
  WB.loading = false;
  if (!res || !res.ok) {
    WB.unsupported = !!(res && res.unsupported);
    WB.error = WB.unsupported ? null : ((res && res.error) || 'Could not read the tasks.');
  } else {
    WB.error = null; WB.unsupported = false;
    WB.cards = Array.isArray(res.data && res.data.cards) ? res.data.cards : [];
  }
  if (S.room === 'board' && !WB.editing) render();
}

function wbFind(id) { return (WB.cards || []).find((c) => c.task && c.task.id === id) || null; }

async function wbMove(id, lane) {
  const card = wbFind(id);
  if (!wbCanMove(card, lane).ok) return;
  const before = WB.cards;
  WB.cards = wbApplyMove(WB.cards, id, lane);
  WB.seq++;   // a load already on its way would put the old lane back
  render();
  const res = await BR.moveTaskCard(id, {lane});
  if (!res || !res.ok) { WB.cards = before; toast("Couldn't move the card", (res && res.error) || '', 'bad'); render(); return; }
  wbLoad();
}

async function wbRun(id) {
  if (WB.running || typeof BR.runTask !== 'function') return;
  WB.running = id; render();
  let res = null;
  try { res = await BR.runTask(id); } catch { res = null; }
  WB.running = null;
  if (!res || !res.ok) toast("Couldn't run the task", (res && res.error) || '', 'bad');
  wbLoad();
}

async function wbSave(id) {
  const checked = wbEditPatch(WB.draft);
  if (!checked.ok) { WB.editError = checked.error; render(); return; }
  const res = await BR.moveTaskCard(id, checked.patch);
  if (!res || !res.ok) { WB.editError = (res && res.error) || 'Could not save.'; render(); return; }
  WB.editing = null; WB.draft = null; WB.editError = null;
  wbLoad();
}

/** Every few seconds while the board is on screen and nothing is being typed. */
function wbPoll() {
  if (WB.timer) return;
  WB.timer = setInterval(() => {
    if (S.room !== 'board') { clearInterval(WB.timer); WB.timer = null; return; }
    if (!WB.editing && !WB.loading && document.visibilityState === 'visible') wbLoad();
  }, WB_REFRESH_MS);
}

function workboardView() {
  if (WB.cards === null && !WB.loading && !WB.error && !WB.unsupported) setTimeout(wbLoad, 0);
  let body = '<div class="wb-head"><p class="sd-cap grow">Your agent\'s tasks by stage. Drag a card to another lane; moving it does not run or stop the task.</p>'
    + '<button class="btn btn-g sm" data-act="board:refresh">' + ic('refresh') + 'Refresh</button></div>';
  if (WB.unsupported) body += '<div class="tk-empty"><p>This agent has no task board yet. Update Atomic Agent to use it; your tasks are in Cron jobs.</p></div>';
  else if (WB.error) body += '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(WB.error) + '</span></div>';
  if (WB.cards === null && !WB.unsupported && !WB.error) body += '<div class="tk-empty"><span class="tk-spin"></span><p>Reading tasks…</p></div>';
  else if (WB.cards && !WB.cards.length) body += '<div class="tk-empty"><p>No tasks yet. Schedule one in Cron jobs, or ask the agent to do something later.</p></div>';
  else if (WB.cards) body += wbBoardHTML(WB.cards, {rel: relTime, running: WB.running, editing: WB.editing, draft: WB.draft, error: WB.editError});
  return '<div class="scroller"><div class="wb">' + body + '</div></div>';
}

/** `board:<verb>` from act(): open · refresh · run:<id> · edit:<id> · save:<id> · cancel. */
function boardAct(v) {
  const i = v.indexOf(':');
  const verb = i < 0 ? v : v.slice(0, i), id = i < 0 ? '' : v.slice(i + 1);
  if (verb === 'open') { S.settings = null; S.room = 'board'; WB.error = null; wbPoll(); render(); wbLoad(); return; }
  if (verb === 'refresh') { wbLoad(); return; }
  if (!WB_SAFE_ID.test(id) && verb !== 'cancel') return;
  if (verb === 'run') { wbRun(id); return; }
  if (verb === 'edit') { const c = wbFind(id); WB.editing = id; WB.editError = null; WB.draft = {note: (c && c.note) || '', assignee: (c && c.assignee) || ''}; render(); return; }
  if (verb === 'save') { wbSave(id); return; }
  if (verb === 'cancel') { WB.editing = null; WB.draft = null; WB.editError = null; render(); }
}

/* Drag between lanes (HTML5), the lane menu, and the form's draft, delegated
   once on the document: the room's markup is rebuilt on every render. */
function wbInstall(doc) {
  let dragId = null;
  doc.addEventListener('dragstart', (e) => {
    const card = e.target && e.target.closest && e.target.closest('.wb-card[data-wb-id]');
    if (!card) return;
    dragId = card.getAttribute('data-wb-id');
    try { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; } catch { /* no transfer */ }
  });
  doc.addEventListener('dragover', (e) => {
    const lane = dragId && e.target && e.target.closest && e.target.closest('.wb-lane');
    if (!lane) return;
    e.preventDefault();
    lane.classList.add('wb-lane--over');
  });
  doc.addEventListener('dragleave', (e) => {
    const lane = e.target && e.target.closest && e.target.closest('.wb-lane');
    if (lane && !lane.contains(e.relatedTarget)) lane.classList.remove('wb-lane--over');
  });
  doc.addEventListener('drop', (e) => {
    const lane = dragId && e.target && e.target.closest && e.target.closest('.wb-lane[data-wb-lane]');
    if (!lane) return;
    e.preventDefault();
    const id = dragId; dragId = null;
    if (WB_SAFE_ID.test(id)) wbMove(id, lane.getAttribute('data-wb-lane'));
  });
  doc.addEventListener('dragend', () => { dragId = null; doc.querySelectorAll('.wb-lane--over').forEach((n) => n.classList.remove('wb-lane--over')); });
  doc.addEventListener('change', (e) => {
    const sel = e.target && e.target.closest && e.target.closest('select[data-wb-move]');
    if (sel) wbMove(sel.getAttribute('data-wb-move'), sel.value);
  });
  doc.addEventListener('input', (e) => {
    const field = e.target && e.target.getAttribute && e.target.getAttribute('data-wb-draft');
    if (field && WB.draft) WB.draft[field] = e.target.value;
  });
}
if (typeof document !== 'undefined' && typeof module === 'undefined') wbInstall(document);

if (typeof module !== 'undefined') module.exports = {WB_LANES, wbEsc, wbTitle, wbGroup, wbCanMove, wbApplyMove, wbEditPatch, wbCardHTML, wbBoardHTML};
