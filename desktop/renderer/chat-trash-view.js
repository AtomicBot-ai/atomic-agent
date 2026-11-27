/* ---------------- ATO-2474: a chat in Trash, read only; Trash follows the agent ----------------
   Loaded after chat-trash.js, before renderer.js; declares only. Reads
   chat-trash.js (TRASH, trashedIdsOf, chatTrashLoad) and renderer.js globals
   (S, SESSIONS, esc, ic, openSession, refreshSessions, render, toast) at call
   time.

   Read only: as in macOS Finder's Recently Deleted and Claude.ai, a chat in
   Trash can be opened and read, not written in. Its title in the Trash
   section opens it (`trashview:<id>`); while it is open the composer is one
   line, "This chat is in Trash", with Restore, and submit() sends nothing.

   Follow: the agent owns the mark (`metadata.trashed`). Its list carries
   `trashed` on every row, so a chat moved to Trash or restored somewhere
   else (the terminal's `/sessions --restore`) is seen here on the next
   refresh: such a row is taken off the lists at once, and Trash is read
   again from main, which lines its file up with the agent
   (main/chat-trash-sync.ts).

   The pure half (chatTrashViewingOf, trashReadOnlyHTML, trashAgentMismatch)
   is checked in test/chat-trash-view.test.mjs. */

/* Chats opened from Trash in this window. A chat deleted for good while it is
   open stays read only (it has no list row to go back to); one restored is
   dropped from here once its row is back on the list. */
const TRASH_VIEWED = new Set();
const TRASH_FOLLOW = {busy: false, at: 0};
const TRASH_FOLLOW_GAP_MS = 15 * 1000;

/** Whether chat `id` is read only: in Trash, or opened from it and not back on the list. */
function chatTrashViewingOf(id, entries, viewed, listed) {
  if (!id) return false;
  if ((entries || []).some((e) => e && e.id === id)) return true;
  return !!(viewed && viewed.has(id)) && !(listed || []).some((s) => s && s.id === id);
}

/** The composer's place while a chat in Trash is open. `h` = {esc, ic}. */
function trashReadOnlyHTML(id, inTrash, h) {
  return '<div class="composerwrap"><div class="trash-ro" role="status">'
    + '<span class="trash-ro-ic">' + h.ic('trash') + '</span>'
    + '<span class="trash-ro-text">' + (inTrash
      ? 'This chat is in Trash. Restore it to keep chatting.'
      : 'This chat was deleted. You can still read what is on screen.') + '</span>'
    + (inTrash ? '<button class="btn btn-s sm" data-act="trash:restore:' + h.esc(id) + '">Restore</button>' : '')
    + '</div></div>';
}

/** Whether the agent's rows disagree with the window's Trash (rows from an older agent carry no `trashed`). */
function trashAgentMismatch(list, entries) {
  const mine = new Set((entries || []).filter((e) => e && typeof e.id === 'string').map((e) => e.id));
  return (list || []).some((s) => s && typeof s.trashed === 'boolean' && s.trashed !== mine.has(s.id));
}

/* ---- the renderer half ---- */

/** The open chat is read only (composer() and submit() ask). */
function chatTrashViewing() {
  const id = S.sessionId;
  if (id && TRASH_VIEWED.has(id) && SESSIONS.some((s) => s.id === id)) TRASH_VIEWED.delete(id);
  return chatTrashViewingOf(id, TRASH.entries, TRASH_VIEWED, SESSIONS);
}

/** composer()'s hook: the read-only line instead of the composer. */
function chatTrashComposerHTML() {
  const id = S.sessionId;
  return trashReadOnlyHTML(id, TRASH.entries.some((e) => e.id === id), {esc, ic});
}

/** submit()'s hook: true when nothing may be sent from here. */
function chatTrashHoldsSend() {
  if (!chatTrashViewing()) return false;
  toast('This chat is in Trash', 'Restore it to keep chatting.', 'bad');
  return true;
}

/* applySessions's hook, before chatTrashHide: a row the agent marks as in
   Trash leaves the list now; when the agent and the window disagree, Trash
   is read again (at most every 15 seconds), and a chat it no longer holds
   comes back with one more refresh. */
function chatTrashFollowAgent(list) {
  if (!Array.isArray(list)) return;
  const mismatch = TRASH.loaded && trashAgentMismatch(list, TRASH.entries);
  for (let i = list.length - 1; i >= 0; i--) if (list[i] && list[i].trashed === true) list.splice(i, 1);
  if (!mismatch || TRASH_FOLLOW.busy || Date.now() - TRASH_FOLLOW.at < TRASH_FOLLOW_GAP_MS) return;
  TRASH_FOLLOW.busy = true;
  TRASH_FOLLOW.at = Date.now();
  const before = trashedIdsOf(TRASH.entries);
  Promise.resolve(chatTrashLoad())
    .then(() => {
      const now = trashedIdsOf(TRASH.entries);
      if ([...before].some((id) => !now.has(id))) return refreshSessions();
    })
    .catch(() => undefined)
    .finally(() => { TRASH_FOLLOW.busy = false; });
}

/* The act() verb `trashview:<id>`: open a chat in Trash to read it. */
function chatTrashViewAct(k, v, close) {
  if (k !== 'trashview') return false;
  if (!v || !TRASH.entries.some((e) => e.id === v)) return true;
  TRASH_VIEWED.add(v);
  close();
  openSession(v);
  return true;
}

if (typeof module !== 'undefined') {
  module.exports = {chatTrashViewingOf, trashReadOnlyHTML, trashAgentMismatch, chatTrashViewAct, TRASH_VIEWED};
}
