/* ATO-165: the sidebar's chat list, as pure functions — no DOM, no renderer
 * state — so the order and the row menu can be unit-tested (test/chat-list.test.mjs).
 *
 * Pinned chats come first, in the order PREFS.pinned holds them: `pin:`
 * unshifts, so the chat pinned last is at the top. A pinned id with no chat
 * behind it (deleted elsewhere, or a stale prefs.json) draws nothing. The rest
 * follow in the agent's own order, with the new chats whose first turn is still
 * running (item 27) at the top of them; a pinned chat is never drawn twice. */
function orderChats(sessions, pending, pinnedIds) {
  const byId = new Map();
  for (const p of pending || []) if (p && p.id) byId.set(p.id, p);
  for (const s of sessions || []) if (s && s.id) byId.set(s.id, s);   // a stored row wins over its stand-in
  const pinned = [];
  const taken = new Set();
  for (const id of pinnedIds || []) {
    const row = byId.get(id);
    if (!row || taken.has(id)) continue;
    taken.add(id);
    pinned.push(row);
  }
  const stored = new Set((sessions || []).map((s) => s && s.id));
  const rest = (pending || []).filter((p) => p && p.id && !stored.has(p.id) && !taken.has(p.id))
    .concat((sessions || []).filter((s) => s && s.id && !taken.has(s.id)));
  return {pinned, rest};
}

/* Whether a chat reads unread: no read stamp, or a turn stored after it.
   The same rule chatDot draws the filled dot from (minus the states that
   outrank it — running, waiting for approval). */
function chatUnread(row, seenAt) {
  const seen = typeof seenAt === 'number' ? seenAt : NaN;
  return !(seen >= 0) || ((row && row.updatedAt) || 0) > seen;
}

/* Whether an unread chat's dot takes the failed (red) tone from the status
   the agent stored: only when the chat has a real read stamp and a turn was
   stored after it, so the failure is news since the chat was last read. A
   chat with no stamp is unread because it was never opened here, or because
   the operator picked Mark as unread; that is the plain unread dot (brand
   blue), whatever its last turn did. A turn that failed while this window
   watched is ATTN's (renderer.js chatDot), not this. */
function chatFailedSinceRead(row, seenAt) {
  if (!row || row.status !== 'failed') return false;
  return typeof seenAt === 'number' && seenAt >= 0 && (row.updatedAt || 0) > seenAt;
}

/* The row menu's items, top to bottom. Each is the act verb it runs, its
   label, its icon name and whether it is the destructive one. ATO-455:
   Rename sits above the rule, for a chat the agent has stored; a new chat's
   stand-in (item 27) has no session to rename yet (`renamable: false`). */
function chatMenuItems(opts) {
  const o = opts || {};
  return [
    // ATO-1150: an archived chat is out of the main list, so it offers no pin (Unarchive first).
    ...(o.archived === true ? [] : [o.pinned ? {verb: 'unpin', label: 'Unpin', icon: 'pin'} : {verb: 'pin', label: 'Pin', icon: 'pin'}]),
    o.unread ? {verb: 'read', label: 'Mark as read', icon: 'check'} : {verb: 'unread', label: 'Mark as unread', icon: 'unread'},
    ...(o.renamable === false ? [] : [{verb: 'rename', label: 'Rename', icon: 'edit'}]),
    // ATO-1034: "Move to folder…" opens the folder list (chat-folders.js), for a stored chat.
    ...(o.folders === true ? [{verb: 'fpick', label: 'Move to folder…', icon: 'folder'}] : []),
    // ATO-1150: Archive hides a stored chat from the lists; Unarchive brings it back.
    ...(o.archivable === true ? [o.archived ? {verb: 'unarchive', label: 'Unarchive', icon: 'archive'} : {verb: 'archive', label: 'Archive', icon: 'archive'}] : []),
    {verb: 'delask', label: 'Delete…', icon: 'trash', danger: true},
  ];
}

/* Where the menu goes: below-left of the point it was opened from, kept
   inside the window with an 8px margin. */
function chatMenuPlace(x, y, w, h, winW, winH) {
  const m = 8;
  const left = Math.max(m, Math.min(Math.round(x), winW - w - m));
  const top = y + h + m > winH ? Math.max(m, Math.round(y - h)) : Math.round(y);
  return {left, top};
}

/* ---------------- ATO-1150: archive and search in the chat list ----------------
   The archive flag is the agent's: `archived: true` in the session's metadata
   (POST /api/sessions/{id}/archived), listed on every GET /api/sessions row,
   so the terminal leaves the same chats out of its rail. Against an agent
   from before that route the window keeps a list of archived ids beside the
   pins (userData/prefs.json `archived`), and moves them to the agent once the
   route is there. An archived chat is left out of Pinned, the folders and
   Chats, and drawn only under the "Archived" toggle; its transcript, folder
   and title stay as they were. */

/* The archived chat ids: the rows the agent lists as archived, and the ids
   the window still keeps itself (an agent without the route, or ones not
   moved to the agent yet). */
function archivedIdsOf(sessions, prefsIds) {
  const out = new Set();
  for (const s of sessions || []) if (s && s.id && s.archived === true) out.add(s.id);
  for (const id of prefsIds || []) if (typeof id === 'string' && id) out.add(id);
  return [...out];
}

/* Whether the agent keeps the archive flag, from its list: a row with an
   `archived` field (`archivedKnown`, set from a boolean in GET /api/sessions)
   says yes, rows without one say no (an older agent), no rows say nothing yet. */
function agentKeepsArchive(sessions) {
  const rows = (sessions || []).filter((s) => s && s.id);
  if (!rows.length) return null;
  return rows.some((s) => s.archivedKnown === true);
}

/* What one answer of the archive route means for an id kept in prefs.json
   while it is being moved to the agent: 'moved' (the agent holds it now, or
   does not hold the chat at all), 'keep' (try again later), 'stop' (the
   agent has no route after all: keep every id here). */
function archiveMigrationStep(res) {
  if (!res || typeof res !== 'object') return 'keep';
  if (res.supported === false) return 'stop';
  if (res.ok === true || res.notFound === true) return 'moved';
  return 'keep';
}

/** The ids list with `id` in it (`on`) or out of it; a new array, newest archived first. */
function archiveSet(list, id, on) {
  const rest = (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x && x !== id);
  return on && id ? [id].concat(rest) : rest;
}

/** `rows` split into the ones on the main list and the archived ones, each in the order given. */
function splitArchived(rows, archivedIds) {
  const arch = new Set(archivedIds || []);
  const live = [], archived = [];
  for (const r of rows || []) if (r && r.id) (arch.has(r.id) ? archived : live).push(r);
  return {live, archived};
}

/* The search field's query as the matcher takes it: trimmed, lowercased,
   inner runs of spaces made one. '' means "no search": the lists as usual. */
function chatSearchQuery(raw) {
  return String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ').toLowerCase();
}

const CHAT_SEARCH_MAX = 50;
/* fuzzy-match.js loads after this file (index.html), so its matcher is looked
   up at call time; in Node (the tests) it is required. */
function chatFuzzyFilter() {
  if (typeof fuzzyFilter === 'function') return fuzzyFilter;
  if (typeof require === 'function') { try { return require('./fuzzy-match.js').fuzzyFilter; } catch (e) { /* substring below */ } }
  return null;
}

/* The chats whose title matches the query, best first (fuzzy-match.js, the
   ⌘K palette's ranking: exact, prefix, word, substring, then one typo), split
   into the ones on the main list and the archived ones, at most
   CHAT_SEARCH_MAX in all. A chat is matched once, by its stored row when it
   has one. Only titles are searched: the agent has no route to search the
   text of past chats yet (ATO-1013 item 1). */
function chatSearch(rawQuery, rows, archivedIds) {
  const q = chatSearchQuery(rawQuery);
  if (!q) return {q, live: [], archived: [], total: 0};
  const seen = new Set(), uniq = [];
  for (const r of rows || []) if (r && r.id && !seen.has(r.id)) { seen.add(r.id); uniq.push(r); }
  const title = (r) => String(r.t || '');
  const fz = chatFuzzyFilter();
  const hits = fz ? fz(q, uniq, title)
    : uniq.filter((r) => title(r).toLowerCase().includes(q));
  const top = hits.slice(0, CHAT_SEARCH_MAX);
  const out = splitArchived(top, archivedIds);
  return {q, live: out.live, archived: out.archived, total: hits.length};
}

if (typeof module !== 'undefined') module.exports = {orderChats, chatUnread, chatFailedSinceRead, chatMenuItems, chatMenuPlace,
  archiveSet, splitArchived, chatSearchQuery, chatSearch, CHAT_SEARCH_MAX, archivedIdsOf, agentKeepsArchive, archiveMigrationStep};
