/* ---------------- ATO-2476: reorder queued messages ----------------
   Loaded after queue-edit.js and before renderer.js; declares only. The
   queue above the composer (.qtray / .qchip) ran in the order the messages
   were typed: to change it the person had to remove messages and type them
   again. Now, as in Cursor's queue and Eigent's QueuedBox:
   - a chip can be dragged to another place; a bar shows where it will land;
   - a focused chip moves with Alt+Up / Alt+Down (Option on a Mac; Left and
     Right too, the tray wraps like a line of text), and the new place is
     read out by a screen reader;
   - "Send next" on a chip puts it at the front, so it runs right after the
     turn that is running now.

   The order is S.queued's, the list drainQueued sends from the front of.
   STEER.ahead counts the refused steers parked at its front: a message moved
   in among them joins them, one moved out of them leaves them, so the
   watermark stays a prefix of the queue (qorderMove).

   A message being edited (queue-edit.js) is out of S.queued and drawn at
   QEDIT.at. The others move around it as they look on screen: a keyboard
   step over the field only hops the field, and a drop beside it lands on
   the side of it the bar showed (qorderEditAt). Its own chip is not moved.

   The pure part is exported for test/queue-reorder.test.mjs. */

const QORDER = {from: -1, text: null, over: -1, side: '', focus: -1};
const QORDER_TYPE = 'application/x-atomic-queued';

/**
 * Moves the message at `from` to index `to` of `queue` (in place; `to` is
 * its index once moved). Returns the new STEER.ahead, or null for no move.
 */
function qorderMove(queue, from, to, ahead) {
  if (!Array.isArray(queue) || !(from >= 0) || from >= queue.length) return null;
  const dest = Math.max(0, Math.min(Number(to) || 0, queue.length - 1));
  const mark = Math.max(0, Math.min(Number(ahead) || 0, queue.length));
  if (dest === from) return mark;
  const was = from < mark;
  const rest = was ? mark - 1 : mark;
  queue.splice(dest, 0, queue.splice(from, 1)[0]);
  return rest + ((dest < rest || (dest === rest && was)) ? 1 : 0);
}

/**
 * Where the field being edited stands after a move from `from` to `to`
 * (S.queued indexes). `editAt` is QEDIT.at (-1: none); `afterEdit`: a
 * message landing right beside the field goes after it.
 */
function qorderEditAt(editAt, from, to, afterEdit) {
  if (!(editAt >= 0)) return editAt;
  let at = editAt;
  if (from < at) at -= 1;
  if (to < at || (to === at && !afterEdit)) at += 1;
  return at;
}

/** Where chip `i` (S.queued index) is drawn: one further on behind the field. */
function qorderScreenAt(i, editAt) {
  return i + (editAt >= 0 && editAt <= i ? 1 : 0);
}

/**
 * A keyboard step of chip `i` of `n`: `dir` -1 earlier, +1 later. Returns
 * `{to, after}` for queueMoveMessage, or null at either end.
 */
function qorderStep(i, n, dir, editAt) {
  if (!(i >= 0) || i >= n) return null;
  const e = editAt >= 0 ? editAt : -1;
  if (dir < 0) {
    if (e === i) return {to: i, after: false};             // only the field is in front of it: hop the field
    return i > 0 ? {to: i - 1, after: true} : null;
  }
  if (e === i + 1) return {to: i, after: true};            // only the field is behind it
  return i < n - 1 ? {to: i + 1, after: false} : null;
}

/**
 * A drop on chip `j` (`side` 'before' or 'after') of the chip dragged from
 * `from`: `{to, after}`, or null when it would stay where it is.
 */
function qorderDropPlan(from, j, side, editAt) {
  if (!(from >= 0) || !(j >= 0)) return null;
  const after = side === 'after';
  let to = after ? j + 1 : j;
  if (from < to) to -= 1;
  const hop = editAt >= 0 && to === from && qorderEditAt(editAt, from, to, !after) !== editAt;
  return to === from && !hop ? null : {to, after: !after};
}

/** Whether chip `i` shows "Send next": it is not drawn first already. */
function qorderNextShown(i, editAt) {
  return qorderScreenAt(i, editAt) > 0;
}

/**
 * The opening tag of chip `i` of the `n` in S.queued: draggable, focusable,
 * named for a screen reader by its place on screen and its `label`.
 * deps: {esc, mac}.
 */
function qorderChipOpen(i, n, editAt, label, deps) {
  const esc = (deps && deps.esc) || String;
  const alt = deps && deps.mac ? 'Option' : 'Alt';
  const cls = 'qchip' + (QORDER.from === i ? ' is-dragging' : '')
    + (QORDER.over === i && QORDER.side ? ' is-drop-' + QORDER.side : '');
  const total = n + (editAt >= 0 ? 1 : 0);
  return '<div class="' + cls + '" draggable="true" tabindex="0" data-qchip="' + esc(String(i)) + '" role="group"'
    + ' title="Drag to change the order, or press ' + alt + ' and an arrow key"'
    + ' aria-label="' + esc('Queued message ' + (qorderScreenAt(i, editAt) + 1) + ' of ' + total + ': ' + String(label || '')) + '">';
}

/** "Send next" on chip `i`. deps: {esc, ic}. */
function qorderNextButtonHTML(i, deps) {
  const esc = (deps && deps.esc) || String;
  const icon = deps && deps.ic ? deps.ic('up') : 'Next';
  return '<button class="iconbtn sm qx qn" data-qnext="' + esc(String(i)) + '"'
    + ' title="Send next: run it right after the current turn" aria-label="Send next">' + icon + '</button>';
}

/* ---------- the renderer side (S, STEER, QEDIT and the queue helpers are renderer.js's) ---------- */

function qorderEditNow() {
  return typeof qeditOn === 'function' && qeditOn() ? QEDIT.at : -1;
}

/** The tray's hooks (renderer.js composer): chip `i`'s opening tag, and its "Send next". */
function qorderChip(i, text) {
  return qorderChipOpen(i, S.queued.length, qorderEditNow(), attQueueLabel(text),
    {esc, mac: typeof IS_MAC !== 'undefined' && IS_MAC});
}
function qorderNext(i) {
  return qorderNextShown(i, qorderEditNow()) ? qorderNextButtonHTML(i, {esc, ic}) : '';
}

/** Said by a screen reader, from a node that outlives the repaints. */
function qorderAnnounce(text) {
  if (typeof document === 'undefined' || !document.body) return;
  let el = document.getElementById('qorder-live');
  if (!el) {
    el = document.createElement('div');
    el.id = 'qorder-live'; el.className = 'qorder-sr';
    el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 30);   // a new text, even when it is the same words again
}

/**
 * Moves queued message `from` to `to` (S.queued indexes). `how`: 'next'
 * (Send next), 'key' (Alt+arrow; the chip keeps the focus) or 'drag'.
 */
function queueMoveMessage(from, to, after, how) {
  if (typeof S.queued[from] !== 'string') return false;
  const editAt = qorderEditNow();
  const held = typeof qeditHoldsDrain === 'function' && qeditHoldsDrain();
  const ahead = qorderMove(S.queued, from, to, STEER.ahead);
  if (ahead === null) return false;
  const dest = Math.max(0, Math.min(to, S.queued.length - 1));
  const at = qorderEditAt(editAt, from, dest, after);
  if (dest === from && at === editAt) return false;
  STEER.ahead = ahead;
  if (editAt >= 0) QEDIT.at = at;
  ANX.messageAction(how === 'next' ? 'send_next' : 'reorder_queued');
  QORDER.focus = how === 'key' ? dest : -1;
  render();
  const n = S.queued.length + (editAt >= 0 ? 1 : 0);
  const pos = qorderScreenAt(dest, at);
  qorderAnnounce(how === 'next' ? 'It will be sent next.' : 'Moved to place ' + (pos + 1) + ' of ' + n + '.');
  // The field at the front held the queue back (qeditHoldsDrain): a message put in front of it runs.
  if (held && !qeditHoldsDrain()) drainOwed();
  return true;
}

/** "Send next" on chip `i`: to the front of the queue. */
function queueSendNext(i) {
  return queueMoveMessage(i, 0, false, 'next');
}

/** Alt+Up / Alt+Down (Left / Right) on a focused chip. True when the key was ours. */
function qorderKeydown(e) {
  if (!e || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return false;
  const dir = (e.key === 'ArrowUp' || e.key === 'ArrowLeft') ? -1 : (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : 0;
  const chip = dir && e.target && e.target.closest ? e.target.closest('[data-qchip]') : null;
  if (!chip || (e.target.dataset && e.target.dataset.qeditField !== undefined)) return false;
  e.preventDefault(); e.stopPropagation();
  const i = +chip.dataset.qchip;
  const step = qorderStep(i, S.queued.length, dir, qorderEditNow());
  if (!step || !queueMoveMessage(i, step.to, step.after, 'key')) {
    qorderAnnounce(dir < 0 ? 'Already first.' : 'Already last.');
  }
  return true;
}

/** Before a render: the chip that has the focus, by its words. */
function qorderHold() {
  if (QORDER.focus >= 0) { const f = QORDER.focus; QORDER.focus = -1; return {i: f, text: S.queued[f]}; }
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  if (!a || !a.dataset || a.dataset.qchip === undefined) return null;
  return {i: +a.dataset.qchip, text: S.queued[+a.dataset.qchip]};
}

/** After a render: the focus back on that chip, wherever it went. */
function qorderRestore(held) {
  if (!held || typeof document === 'undefined') return;
  const i = S.queued[held.i] === held.text ? held.i : S.queued.indexOf(held.text);
  if (i < 0) return;
  const el = document.querySelector('[data-qchip="' + i + '"]');
  if (el && document.activeElement !== el) el.focus();
}

/** The drop bar, set on the chips without a repaint (and kept by the next one, qorderChipOpen). */
function qorderMark(over, side) {
  QORDER.over = over; QORDER.side = side;
  if (typeof document === 'undefined') return;
  document.querySelectorAll('.qtray [data-qchip]').forEach((n) => {
    const on = +n.dataset.qchip === over;
    n.classList.toggle('is-drop-before', on && side === 'before');
    n.classList.toggle('is-drop-after', on && side === 'after');
  });
}

function qorderReset() {
  const was = QORDER.from >= 0 || QORDER.over >= 0;
  QORDER.from = -1; QORDER.text = null;
  qorderMark(-1, '');
  if (was && typeof document !== 'undefined') document.querySelectorAll('.qtray .is-dragging').forEach((n) => n.classList.remove('is-dragging'));
}

if (typeof document !== 'undefined') {
  const ours = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(QORDER_TYPE));
  const chipAt = (el) => (el && el.closest ? el.closest('.qtray [data-qchip]') : null);
  // The queue may have moved under the drag (its head was sent): the dragged message is found by its words.
  const dragFrom = () => (S.queued[QORDER.from] === QORDER.text ? QORDER.from : S.queued.indexOf(QORDER.text));
  document.addEventListener('dragstart', (e) => {
    const chip = chipAt(e.target);
    if (!chip || !e.dataTransfer || e.target !== chip) return;
    const i = +chip.dataset.qchip;
    Object.assign(QORDER, {from: i, text: S.queued[i]});
    e.dataTransfer.setData(QORDER_TYPE, String(i));
    e.dataTransfer.effectAllowed = 'move';
    chip.classList.add('is-dragging');
  });
  document.addEventListener('dragover', (e) => {
    if (!ours(e)) return;
    const chip = chipAt(e.target);
    if (!chip) { qorderMark(-1, ''); return; }
    e.preventDefault();
    const r = chip.getBoundingClientRect();
    const side = e.clientX < r.left + r.width / 2 ? 'before' : 'after';
    const plan = qorderDropPlan(dragFrom(), +chip.dataset.qchip, side, qorderEditNow());
    e.dataTransfer.dropEffect = plan ? 'move' : 'none';
    if (plan) qorderMark(+chip.dataset.qchip, side); else qorderMark(-1, '');
  });
  document.addEventListener('dragleave', (e) => {
    if (ours(e) && !e.relatedTarget) qorderMark(-1, '');   // out of the window
  });
  document.addEventListener('drop', (e) => {
    if (!ours(e)) return;
    e.preventDefault();
    const chip = chipAt(e.target);
    const side = QORDER.side;
    const from = dragFrom();
    qorderReset();
    if (!chip || !side || from < 0) return;
    const plan = qorderDropPlan(from, +chip.dataset.qchip, side, qorderEditNow());
    if (plan) queueMoveMessage(from, plan.to, plan.after, 'drag');
  });
  document.addEventListener('dragend', qorderReset);
  // A repaint under the drag can take the chip that would get `dragend`: the next press clears what is left.
  document.addEventListener('pointerdown', () => { if (QORDER.from >= 0 || QORDER.over >= 0) qorderReset(); });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {QORDER, QORDER_TYPE, qorderMove, qorderEditAt, qorderScreenAt, qorderStep,
    qorderDropPlan, qorderNextShown, qorderChipOpen, qorderNextButtonHTML};
}
