/* ---------------- ATO-2132: edit a queued message ----------------
   Loaded before renderer.js; declares only. The queue above the composer
   (.qtray / .qchip) let the person remove a message (×) or steer it in now
   (steer-now.js), but not fix a typo in it: the only way to change it was
   to remove it and type it again, and lose its place in the line.

   Now each chip has an Edit button, as Cursor's and Claude Code's queued
   messages do. Edit turns the chip into a field with the message's words:
   Enter (or Save) puts the edited message back where it stood, Escape (or
   the ×) puts the original back untouched.

   While it is being edited the message is OUT of the queue (S.queued), the
   way Claude Code pulls a queued message into the input box: a turn that
   ends meanwhile cannot send it half edited, nor send it and then let Save
   send it a second time. The messages behind it go on as usual. When it is
   put back into a chat that runs no turn any more (its turn ended while the
   field was open), it runs now, as a refused steer parked after its turn's
   end does (renderer.js steerOrQueueRun, ATO-183). While the FIRST message
   is in the field the drain waits for it (qeditHoldsDrain), so the second
   never runs ahead of it; a message that leaves the queue in front of the
   one being edited moves it up with the rest (qeditShift).

   Files: only the words are edited. A message with an `[attachments]` block
   (attachments.js) keeps that block as it was, byte for byte, so its files
   go with it; a message whose words are all deleted keeps its files under
   the same stand-in line attBuildMessage writes. A message left with neither
   words nor files is removed, as × removes it (unqueueMessage).

   Leaving the chat with the field open, or opening another chip, keeps what
   was typed (stashQueue, qeditLeave);
   deleting the chat drops it with the rest of its queue (forgetQueue).

   The pure part is exported for test/queue-edit.test.mjs. */

const QEDIT = {open: false, key: null, at: -1, original: '', value: '',
  parts: null, wasAhead: false, wantFocus: false};

const QEDIT_BLOCK = '\n\n[attachments]\n';

/**
 * A queued message taken apart for editing: `{caption, tail, files}`.
 * `split` is attSplitMessage(text). `tail` is the attachments block exactly
 * as it was ('' without one), `files` the number of its lines.
 */
function qeditParts(text, split) {
  const s = String(text == null ? '' : text);
  const at = s.lastIndexOf(QEDIT_BLOCK);
  if (!split || at < 0) return {caption: s, tail: '', files: 0};
  return {caption: String(split.caption || ''), tail: s.slice(at), files: split.items.length};
}

/** The message again, with `caption` for its words. '' when nothing is left. */
function qeditRebuild(parts, caption) {
  const c = String(caption == null ? '' : caption).trim();
  if (!parts || !parts.tail) return c;
  const head = c || ('The user sent ' + (parts.files === 1 ? 'a file' : parts.files + ' files') + ' without a message.');
  return head + parts.tail;
}

/**
 * Takes the message at `at` out of `queue` (in place). Returns
 * `{text, wasAhead, ahead}`: whether it stood among the refused steers parked
 * ahead of ordinary backlog (STEER.ahead), and the watermark without it.
 * Null when `at` is out of range.
 */
function qeditPull(queue, at, ahead) {
  if (!Array.isArray(queue) || !(at >= 0) || at >= queue.length) return null;
  const text = queue.splice(at, 1)[0];
  const was = at < ahead;
  return {text, wasAhead: was, ahead: was ? ahead - 1 : ahead};
}

/**
 * Where a message pulled from `at` goes back into `queue` now: its old
 * place, or the end when the queue got shorter meanwhile, and on its own
 * side of the watermark (a parked steer before ordinary backlog, backlog
 * after the parked steers).
 */
function qeditPutAt(queue, at, ahead, wasAhead) {
  const pos = Math.max(0, Math.min(at, queue.length));
  const mark = Math.max(0, Math.min(ahead, queue.length));
  return wasAhead ? Math.min(pos, mark) : Math.max(pos, mark);
}

/** `list` with `item` at `at` (clamped), for the tray's chips. */
function qeditInsert(list, at, item) {
  const out = list.slice();
  out.splice(Math.max(0, Math.min(at, out.length)), 0, item);
  return out;
}

/** The Edit button on chip `i`. deps: {esc, ic}. */
function qeditButtonHTML(i, deps) {
  const esc = (deps && deps.esc) || String;
  const icon = deps && deps.ic ? deps.ic('edit') : 'Edit';
  return '<button class="iconbtn sm qx qe" data-qedit="' + esc(String(i)) + '"'
    + ' title="Edit this message" aria-label="Edit">' + icon + '</button>';
}

/** The chip being edited: the field, the files it keeps, Save and ×. deps: {esc, ic}. */
function qeditChipHTML(state, deps) {
  const st = state || QEDIT;
  const esc = (deps && deps.esc) || String;
  const n = st.parts ? st.parts.files : 0;
  return '<div class="qchip qedit">'
    + '<span class="qlb">Editing</span>'
    + '<textarea id="qedit-field" class="qefield" data-qedit-field="1" rows="1" aria-label="Edit queued message">'
    + esc(st.value) + '</textarea>'
    + (n ? '<span class="qfiles">' + n + (n === 1 ? ' file' : ' files') + '</span>' : '')
    + '<button class="qsteer" data-qedit="save" title="Put the edited message back in the queue (Enter)">Save</button>'
    + '<button class="iconbtn sm qx" data-qedit="cancel" title="Keep the message as it was (Esc)" aria-label="Cancel edit">'
    + (deps && deps.ic ? deps.ic('x') : '×') + '</button></div>';
}

/* ---------- the renderer side (S, STEER, DRAIN_OWED and the queue helpers are renderer.js's) ---------- */

/** Whether the chip being edited belongs to the queue on screen. */
function qeditOn() {
  return QEDIT.open && (queueOwner(QEDIT.key) || null) === (queueKey() || null);
}

/** The tray's chips with the one being edited back in its place. */
function qeditTray(chips, deps) {
  return qeditOn() ? qeditInsert(chips, QEDIT.at, qeditChipHTML(QEDIT, deps)) : chips;
}

/** Edit on chip `at`: the message leaves the queue for the field. */
function qeditStart(at) {
  // One field at a time: the open one goes back as typed, before the indexes are read.
  let back = -1;
  if (QEDIT.open) { back = qeditLeave(); if (back >= 0 && back <= at) at += 1; }
  const text = S.queued[at];
  if (typeof text !== 'string') { render(); if (back >= 0) drainOwed(); return; }
  const got = qeditPull(S.queued, at, STEER.ahead);
  STEER.ahead = got.ahead;
  const parts = qeditParts(text, attSplitMessage(text));
  Object.assign(QEDIT, {open: true, key: queueKey(), at, original: text, value: parts.caption,
    parts, wasAhead: got.wasAhead, wantFocus: true});
  render();
  // The one put back may be owed to an idle chat: it runs now, as Save would have run it.
  if (back >= 0) drainOwed();
}

/**
 * Closes the field: `save` puts the edited message back, otherwise the
 * original. `quiet` (the chat is being left): no paint and no send now, the
 * message is owed to the chat instead. Returns the index it went back to on
 * screen, or -1.
 */
function qeditFinish(save, quiet) {
  if (!QEDIT.open) return -1;
  const e = Object.assign({}, QEDIT);
  Object.assign(QEDIT, {open: false, key: null, at: -1, original: '', value: '', parts: null,
    wasAhead: false, wantFocus: false});
  const text = save ? qeditRebuild(e.parts, e.value) : e.original;
  // ATO-2476: a saved change is a message action, as Steer now and × are (renderer.js clicks).
  if (save && text && text !== e.original && typeof ANX !== 'undefined') ANX.messageAction('edit_queued');
  const owner = queueOwner(e.key) || null;
  if (owner !== (queueKey() || null)) { parkIn(e.key, [text || e.original]); return -1; }
  const ahead = e.wasAhead && STEER.ahead > 0;
  const pos = qeditPutAt(S.queued, e.at, STEER.ahead, ahead);
  S.queued.splice(pos, 0, text || e.original);
  if (ahead) STEER.ahead += 1;
  // Everything deleted: the message goes, as × takes it (its files too).
  if (!text) { unqueueMessage(pos); return -1; }
  const own = queueKey();
  if (!queueChatRunning(own) && !S.busy && !S.pending) {
    STEER.ahead = 0;
    DRAIN_OWED = true;
    if (!quiet) drainOwed();
  }
  if (!quiet) render();
  return pos;
}

/** A message left the queue on screen at `removedAt` (drainQueued sent the
    head, unqueueMessage removed one): the one being edited behind it moves
    up with the rest, so Save puts it back between the same neighbours. */
function qeditShift(removedAt) {
  if (qeditOn() && removedAt < QEDIT.at) QEDIT.at -= 1;
}

/** `count` messages went into the queue on screen at `insertedAt` (late
    steers put at its front): the one being edited moves down with the rest. */
function qeditShiftInsert(insertedAt, count) {
  if (qeditOn() && insertedAt <= QEDIT.at && count > 0) QEDIT.at += count;
}

/** Whether the next drain must wait: the message at the head of the queue is
    in the field, and sending the one behind it would jump the line. Save or
    cancel puts it back and runs it (qeditFinish, through DRAIN_OWED). */
function qeditHoldsDrain() {
  return qeditOn() && QEDIT.at === 0;
}

/** The field closes without a paint (the chat is being left, or another chip
    is opened): the message goes back as typed, or as it was when everything
    in it was deleted (only Save removes a message). Returns its index. */
function qeditLeave() {
  if (!QEDIT.open) return -1;
  return qeditFinish(qeditRebuild(QEDIT.parts, QEDIT.value) !== '', true);
}

/** Chat `sid` was deleted: the message being edited goes with its queue. */
function qeditDrop(sid) {
  if (QEDIT.open && (queueOwner(QEDIT.key) || null) === sid) { QEDIT.open = false; QEDIT.key = null; QEDIT.parts = null; }
}

/** queuesSnapshot: the message in the field is still the chat's (ATO-135). */
function qeditSnapshot(out, here) {
  if (!qeditOn() || !here || here.startsWith('turn:')) return out;
  out[here] = qeditInsert(out[here] || [], QEDIT.at, QEDIT.original);
  return out;
}

/** A click on [data-qedit]: an index (Edit), 'save' or 'cancel'. */
function qeditClick(what) {
  if (what === 'save') { qeditFinish(true); return; }
  if (what === 'cancel') { qeditFinish(false); return; }
  qeditStart(+what);
}

/** Enter saves, Shift+Enter is a new line, Escape keeps the original. */
function qeditKeydown(e) {
  const f = e.target;
  if (!f || !f.dataset || f.dataset.qeditField === undefined) return false;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); qeditFinish(true); return true; }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); qeditFinish(false); return true; }
  return false;
}

/** The field's text, kept for the next repaint. */
function qeditInput(e) {
  if (!e.target || !e.target.dataset || e.target.dataset.qeditField === undefined) return false;
  QEDIT.value = e.target.value;
  return true;
}

/** Before a render: whether the field has the caret, and where. */
function qeditHold() {
  const f = typeof document !== 'undefined' ? document.getElementById('qedit-field') : null;
  if (!f || document.activeElement !== f) return null;
  return [f.selectionStart, f.selectionEnd];
}

/** After a render: the caret back in the field (a new node when the chips moved), or into a field just opened. */
function qeditRestore(held) {
  const f = typeof document !== 'undefined' ? document.getElementById('qedit-field') : null;
  if (!f || !QEDIT.open) return;
  if (f.value !== QEDIT.value) f.value = QEDIT.value;
  if (QEDIT.wantFocus) {
    QEDIT.wantFocus = false;
    f.focus(); try { f.setSelectionRange(f.value.length, f.value.length); } catch (err) { /* fine */ }
  } else if (held && document.activeElement !== f) {
    f.focus(); try { f.setSelectionRange(held[0], held[1]); } catch (err) { /* fine */ }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {QEDIT, qeditParts, qeditRebuild, qeditPull, qeditPutAt, qeditInsert,
    qeditButtonHTML, qeditChipHTML};
}
