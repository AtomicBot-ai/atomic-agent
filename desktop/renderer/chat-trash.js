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

   ATO-2747: the entry keeps where the chat sat (pinned, archived, its chat
   folder) and Restore puts it back there, as Finder's Put Back does; a folder
   deleted meanwhile is skipped, and an entry from before has none of it.
   "Moved to Trash" has Undo, which is Restore. Every failure toast is 'bad',
   and Empty Trash shows it is busy and says "Deleted 7 of 9" when the agent
   took only some.

   The pure half (trashedIdsOf, trashDaysLeft, trashSidebarHTML, trashPlaceOf,
   trashPutBack, trashEmptyToast) is checked in test/chat-trash.test.mjs. */

const TRASH_DAYS = 30;
const TRASH_DAY_MS = 24 * 60 * 60 * 1000;

/* `entries`: main's list ({id, title, deletedAt, pinned?, archived?, folder?}),
   newest first. `open`: the section is unfolded. `loaded`: main's list has
   been read once. `emptying`: Empty Trash is under way. */
const TRASH = {entries: [], open: false, loaded: false, emptying: false};

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
    + '<button class="iconbtn danger" data-act="trash:forgetask:' + h.esc(e.id) + '" title="Delete forever" aria-label="Delete ' + h.esc(title) + ' forever">' + h.ic('trash') + '</button>'
    + '</div>';
}

/** The folded "Trash" section; nothing while Trash is empty. `busy`: Empty Trash is under way. */
function trashSidebarHTML(entries, open, now, h, busy) {
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
        + (busy
          ? '<button class="btn btn-s sm" disabled aria-busy="true">Emptying…</button></div>'
          : '<button class="btn btn-s sm" data-act="trash:emptyask">Empty Trash</button></div>')
      : '')
    + '</div>';
}

/** Where chat `id` sits now, for its Trash entry: `prefs` = PREFS, `folders` = FOLDERS.state. */
function trashPlaceOf(id, prefs, folders) {
  const place = {};
  if (prefs && Array.isArray(prefs.pinned) && prefs.pinned.includes(id)) place.pinned = true;
  if (prefs && Array.isArray(prefs.archived) && prefs.archived.includes(id)) place.archived = true;
  const fid = folders && folders.chats && folders.chats[id];
  if (typeof fid === 'string' && fid) place.folder = fid;
  return place;
}

/**
 * Put restored chat `id` back where `place` says, in `prefs` and `folders`
 * (in place). The folder only if it still exists. `h` = {archiveSet,
 * folderById, folderPut}. Returns which of the two changed, to be saved.
 */
function trashPutBack(id, place, prefs, folders, h) {
  const out = {prefs: false, folders: false};
  if (!place) return out;
  if (place.pinned) {
    if (!Array.isArray(prefs.pinned)) prefs.pinned = [];
    if (!prefs.pinned.includes(id)) { prefs.pinned.unshift(id); out.prefs = true; }
  }
  if (place.archived) { prefs.archived = h.archiveSet(prefs.archived, id, true); out.prefs = true; }
  if (place.folder && h.folderById(folders, place.folder)) out.folders = h.folderPut(folders, id, place.folder);
  return out;
}

/** Empty Trash's answer as a toast: [title, line, kind]. */
function trashEmptyToast(res) {
  const n = (res && Array.isArray(res.purged)) ? res.purged.length : 0;
  const failed = (res && Number(res.failed)) || 0;
  const total = (res && Number(res.total)) || n + failed;
  const chats = (k) => (k === 1 ? '1 chat' : k + ' chats');
  if (res && res.ok) return ['Trash emptied', chats(n) + ' deleted forever', ''];
  if (n > 0 && failed > 0) {
    return ['Deleted ' + n + ' of ' + total + ' chats', chats(failed) + (failed === 1 ? ' is' : ' are')
      + ' still in Trash. The agent could not delete ' + (failed === 1 ? 'it' : 'them') + ' right now.', 'bad'];
  }
  return ['Could not empty Trash', (res && res.error) || 'Try again in a moment.', 'bad'];
}

/* ---- the renderer half ---- */

/** The sidebar's section (renderSidebar's hook). */
function chatTrashSidebarHTML() {
  return trashSidebarHTML(TRASH.entries, TRASH.open, Date.now(), {esc, ic}, TRASH.emptying);
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
  return BR.chatTrashPut(id, row.t || '', trashPlaceOf(id, PREFS, FOLDERS.state)).then((res) => {
    if (res && res.ok && res.entry) TRASH.entries = [res.entry].concat(TRASH.entries.filter((e) => e.id !== id));
    return res;
  });
}

async function chatTrashRestore(id) {
  const e = TRASH.entries.find((x) => x.id === id);
  if (!e || !BR || !BR.chatTrashRestore) return;
  let res = null;
  try { res = await BR.chatTrashRestore(id); } catch (err) { res = null; }
  if (!res || !res.ok) { toast('Could not restore the chat', (res && res.error) || 'Try again in a moment.', 'bad'); return; }
  TRASH.entries = TRASH.entries.filter((x) => x.id !== id);
  await refreshSessions();
  // The terminal may have deleted it meanwhile: then there is nothing to bring back.
  if (!SESSIONS.some((s) => s.id === id)) {
    toast('Could not restore the chat', 'It was deleted from this computer in the meantime.', 'bad');
    render(); nameVisibleSessions(); return;
  }
  const back = trashPutBack(id, res.entry || e, PREFS, FOLDERS.state, {archiveSet, folderById, folderPut});
  if (back.prefs) savePrefs();
  if (back.folders) saveFolders();
  toast('Chat restored', e.title || '');
  render(); nameVisibleSessions();
}

async function chatTrashForget(id) {
  if (!BR || !BR.chatTrashForget) return;
  let res = null;
  try { res = await BR.chatTrashForget(id); } catch (err) { res = null; }
  if (!res || !res.ok) { toast('Could not delete the chat', (res && res.error) || 'Try again in a moment.', 'bad'); return; }
  const e = TRASH.entries.find((x) => x.id === id);
  TRASH.entries = TRASH.entries.filter((x) => x.id !== id);
  render();
  toast('Chat deleted forever', (e && e.title) || '');
}

async function chatTrashEmpty() {
  if (!BR || !BR.chatTrashEmpty || TRASH.emptying) return;
  TRASH.emptying = true;
  render();
  let res = null;
  try { res = await BR.chatTrashEmpty(); } catch (err) { res = null; } finally { TRASH.emptying = false; }
  const purged = new Set((res && res.purged) || []);
  TRASH.entries = TRASH.entries.filter((x) => !purged.has(x.id));
  render();
  const [t, line, kind] = trashEmptyToast(res);
  toast(t, line, kind);
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
    if (!n || TRASH.emptying) return true;
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
    trashPlaceOf, trashPutBack, trashEmptyToast, chatTrashHide, chatTrashAct};
}
