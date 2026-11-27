/* ---------------- ATO-2332: the chat Trash ----------------
   Loaded before renderer.js, after chat-search.js; declares only. It reads
   renderer.js globals (BR, S, SESSIONS, ic, esc, render, nameVisibleSessions,
   refreshSessions, toast) at call time, as chat-search.js does. Main keeps
   the list (main/chat-trash.ts, userData/chat-trash.json).

   As macOS Finder, Claude.ai and Slack's "recently deleted": Delete… on a chat
   row moves the chat to Trash instead of removing it from this machine. A
   chat in Trash is on none of the lists (Pinned, projects, Chats, Archived,
   the palette); a folded "Trash" section at the bottom of the sidebar lists
   them, newest first, each with the days it has left, Restore and Delete
   forever, and the section has Empty Trash. Main deletes for good a chat that
   has been in Trash for 30 days; nothing younger is deleted unless the person
   presses Delete forever or Empty Trash, which ask first.

   The pure half (trashedIdsOf, trashDaysLeft, trashSidebarHTML) is checked in
   test/chat-trash.test.mjs. */

const TRASH_DAYS = 30;
const TRASH_DAY_MS = 24 * 60 * 60 * 1000;

/* `entries`: main's list ({id, title, deletedAt}), newest first. `open`: the
   section is unfolded. `loaded`: main's list has been read once. */
const TRASH = {entries: [], open: false, loaded: false};

/** The ids in Trash, as a Set. */
function trashedIdsOf(entries) {
  return new Set((entries || []).filter((e) => e && typeof e.id === 'string').map((e) => e.id));
}

/** Whole days left before chat `deletedAt` is deleted for good, never below 0. */
function trashDaysLeft(deletedAt, now) {
  const left = TRASH_DAYS * TRASH_DAY_MS - (now - (Number(deletedAt) || 0));
  return left <= 0 ? 0 : Math.ceil(left / TRASH_DAY_MS);
}

function trashLeftText(days) {
  if (days <= 0) return 'Deleted soon';
  return days === 1 ? '1 day left' : days + ' days left';
}

/** One row: the title it showed, its days left, Restore and Delete forever. `h` = {esc, ic}. */
function trashRowHTML(e, now, h) {
  const title = e.title || e.id;
  const left = trashLeftText(trashDaysLeft(e.deletedAt, now));
  return '<div class="sb-trashrow" data-trash="' + h.esc(e.id) + '" title="' + h.esc(title + ' · ' + left) + '">'
    + '<span class="t1">' + h.esc(title) + '</span>'
    + '<span class="sb-trashleft micro">' + h.esc(left) + '</span>'
    + '<button class="iconbtn" data-act="trash:restore:' + h.esc(e.id) + '" title="Restore" aria-label="Restore ' + h.esc(title) + '">' + h.ic('undo') + '</button>'
    + '<button class="iconbtn danger" data-act="trash:forgetask:' + h.esc(e.id) + '" title="Delete forever" aria-label="Delete ' + h.esc(title) + ' forever">' + h.ic('x') + '</button>'
    + '</div>';
}

/** The folded "Trash" section; nothing while Trash is empty. */
function trashSidebarHTML(entries, open, now, h) {
  if (!entries || !entries.length) return '';
  return '<div class="sb-list sb-trash' + (open ? '' : ' collapsed') + '" data-list="trash">'
    + '<button class="sb-fhead sb-trashhead" data-act="trash:toggle" aria-expanded="' + !!open + '"'
      + ' title="' + h.esc((open ? 'Hide' : 'Show') + ' chats in Trash') + '">'
      + '<span class="sb-fchev">' + h.ic(open ? 'chevD' : 'chevR') + '</span>'
      + '<span class="sb-fic">' + h.ic('trash') + '</span>'
      + '<span class="sb-fname">Trash</span>'
      + '<span class="ct tnum">' + entries.length + '</span>'
    + '</button>'
    + (open
      ? entries.map((e) => trashRowHTML(e, now, h)).join('')
        + '<div class="sb-trashfoot micro"><span>Chats are deleted for good after ' + TRASH_DAYS + ' days.</span>'
        + '<button class="btn btn-s sm" data-act="trash:emptyask">Empty Trash</button></div>'
      : '')
    + '</div>';
}

/* ---- the renderer half ---- */

/** The sidebar's section (renderSidebar's hook). */
function chatTrashSidebarHTML() {
  return trashSidebarHTML(TRASH.entries, TRASH.open, Date.now(), {esc, ic});
}

/** Take every chat in Trash out of `list` (SESSIONS, in place): applySessions's hook. */
function chatTrashHide(list) {
  if (!TRASH.entries.length || !Array.isArray(list)) return;
  const ids = trashedIdsOf(TRASH.entries);
  for (let i = list.length - 1; i >= 0; i--) if (list[i] && ids.has(list[i].id)) list.splice(i, 1);
}

/** Read main's list (main purges what is past 30 days first); boot calls it. */
async function chatTrashLoad() {
  if (!BR || !BR.chatTrashList) return;
  const res = await BR.chatTrashList();
  TRASH.entries = res && Array.isArray(res.entries) ? res.entries.slice() : [];
  TRASH.loaded = true;
  chatTrashHide(SESSIONS);   // a list read before this one still drew them
  render(); nameVisibleSessions();
}

/* Delete…'s confirm (`del:` in act()) lands here instead of the agent's
   DELETE: the chat goes to Trash. The answer has the delete's shape
   ({ok, error}), so act()'s own cleanup (the row, its pin, the open chat) runs
   as before. A chat this window does not list is not touched. */
function chatTrashPut(id) {
  const row = SESSIONS.find((s) => s.id === id);
  if (!row) return Promise.resolve({ok: false, error: 'This chat is not on the list'});
  if (!BR || !BR.chatTrashPut) return Promise.resolve({ok: false, error: 'Trash is not available'});
  return BR.chatTrashPut(id, row.t || '').then((res) => {
    if (res && res.ok && res.entry) TRASH.entries = [res.entry].concat(TRASH.entries.filter((e) => e.id !== id));
    return res;
  });
}

async function chatTrashRestore(id) {
  const e = TRASH.entries.find((x) => x.id === id);
  if (!e || !BR || !BR.chatTrashRestore) return;
  const res = await BR.chatTrashRestore(id);
  if (!res || !res.ok) { toast('Could not restore the chat', (res && res.error) || ''); return; }
  TRASH.entries = TRASH.entries.filter((x) => x.id !== id);
  await refreshSessions();
  // The terminal may have deleted it meanwhile: then there is nothing to bring back.
  if (SESSIONS.some((s) => s.id === id)) toast('Chat restored', e.title || '');
  else toast('Chat restored', 'It is no longer on this machine');
  render(); nameVisibleSessions();
}

async function chatTrashForget(id) {
  if (!BR || !BR.chatTrashForget) return;
  const res = await BR.chatTrashForget(id);
  if (!res || !res.ok) { toast('Could not delete the chat', (res && res.error) || ''); return; }
  const e = TRASH.entries.find((x) => x.id === id);
  TRASH.entries = TRASH.entries.filter((x) => x.id !== id);
  render();
  toast('Chat deleted forever', (e && e.title) || '');
}

async function chatTrashEmpty() {
  if (!BR || !BR.chatTrashEmpty) return;
  const res = await BR.chatTrashEmpty();
  const purged = new Set((res && res.purged) || []);
  TRASH.entries = TRASH.entries.filter((x) => !purged.has(x.id));
  render();
  if (!res || !res.ok) toast('Could not empty Trash', (res && res.error) || '');
  else toast('Trash emptied', purged.size === 1 ? '1 chat deleted forever' : purged.size + ' chats deleted forever');
}

/* The act() verbs: trash:toggle, trash:restore:<id>, trash:forgetask:<id>,
   trash:forget:<id>, trash:emptyask, trash:empty. Returns true when the verb was one of these. */
function chatTrashAct(k, v, close) {
  if (k !== 'trash') return false;
  const colon = (v || '').indexOf(':');
  const verb = colon < 0 ? (v || '') : v.slice(0, colon);
  const id = colon < 0 ? '' : v.slice(colon + 1);
  if (verb === 'toggle') { TRASH.open = !TRASH.open; render(); return true; }
  if (verb === 'restore') { close(); render(); chatTrashRestore(id); return true; }
  if (verb === 'forgetask') {
    const e = TRASH.entries.find((x) => x.id === id);
    if (!e) return true;
    close();
    S.alert = {title: 'Delete “' + (e.title || e.id) + '” forever?', msg: 'The transcript, its tool calls and its work log are removed from this machine. This cannot be undone.',
      ok: 'Delete forever', act: 'trash:forget:' + id};
    render(); return true;
  }
  if (verb === 'forget') { close(); render(); chatTrashForget(id); return true; }
  if (verb === 'emptyask') {
    const n = TRASH.entries.length;
    if (!n) return true;
    close();
    S.alert = {title: 'Empty Trash?', msg: (n === 1 ? 'The chat' : 'All ' + n + ' chats') + ' in Trash will be removed from this machine. This cannot be undone.',
      ok: 'Empty Trash', act: 'trash:empty'};
    render(); return true;
  }
  if (verb === 'empty') { close(); render(); chatTrashEmpty(); return true; }
  return true;
}

if (typeof module !== 'undefined') {
  module.exports = {TRASH, TRASH_DAYS, trashedIdsOf, trashDaysLeft, trashSidebarHTML, trashRowHTML,
    chatTrashHide, chatTrashAct};
}
