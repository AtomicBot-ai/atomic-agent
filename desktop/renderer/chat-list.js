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
    // ATO-1034, W2 QA: "Move to project…" opens the projects list (chat-folders.js), for a stored chat.
    ...(o.folders === true ? [{verb: 'fpick', label: 'Move to project…', icon: 'folder'}] : []),
    // ATO-1150: Archive hides a stored chat from the lists; Unarchive brings it back.
    ...(o.archivable === true ? [o.archived ? {verb: 'unarchive', label: 'Unarchive', icon: 'archive'} : {verb: 'archive', label: 'Archive', icon: 'archive'}] : []),
    // ATO-1054: "Export…" saves the chat as Markdown / PDF / Word (chat-export.js), for a stored chat.
    ...(o.exportable === true ? [{verb: 'export', label: 'Export…', icon: 'download'}] : []),
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

/* ATO-1146: chats grouped by project (ATO-42's projects store, main side).
   A project is a work folder plus a name. A chat belongs to the project it was
   put in (the store's chat → project map), else to the project whose folder it
   ran in (the session's `workingDir`; the deepest project folder that holds
   it). Coexistence with ATO-1034's chat folders: a chat filed in a chat folder
   stays in that folder, so folders keep every chat they hold and projects only
   gather the chats no folder has. */

/** A folder path as a comparable key: either slash, no trailing one, a
    Windows drive path compared without case. '' for nothing usable. */
function projectPathKey(dir) {
  let s = String(dir == null ? '' : dir).trim().replace(/[\\/]+/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return /^[a-z]:(\/|$)/i.test(s) ? s.toLowerCase() : s;
}

/** The last segment of a folder path, the name a new project gets. */
function projectNameFromDir(dir) {
  const parts = String(dir == null ? '' : dir).split(/[\\/]+/).filter(Boolean);
  return (parts[parts.length - 1] || String(dir || '').trim() || 'Project').slice(0, 80);
}

/** Whatever the store sent, as {projects: [{id, name, folder, instructions}], chats: {sessionId: projectId}},
    in the store's order (newest first). Ids are main's (`p` + 6..24 of [a-z0-9]). */
function projectsCoerce(raw) {
  const out = {projects: [], chats: {}};
  const r = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(raw) ? raw : Array.isArray(r.projects) ? r.projects : [];
  const ids = new Set();
  for (const p of list) {
    // Ids go into data-act attributes (and the remove question's button): main's shape only.
    if (!p || typeof p.id !== 'string' || !/^p[a-z0-9]{6,24}$/.test(p.id) || ids.has(p.id)) continue;
    const folder = typeof p.folder === 'string' ? p.folder : '';
    if (!projectPathKey(folder)) continue;
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : projectNameFromDir(folder);
    ids.add(p.id);
    out.projects.push({id: p.id, name, folder, instructions: typeof p.instructions === 'string' ? p.instructions : '',
      createdAt: typeof p.createdAt === 'number' && p.createdAt > 0 ? p.createdAt : 0});
  }
  const chats = r.chats && typeof r.chats === 'object' && !Array.isArray(r.chats) ? r.chats : {};
  for (const sid of Object.keys(chats)) if (typeof chats[sid] === 'string' && ids.has(chats[sid])) out.chats[sid] = chats[sid];
  return out;
}

/** The project kept for this exact folder, or null. */
function projectForFolder(state, dir) {
  const key = projectPathKey(dir);
  if (!key) return null;
  return ((state && state.projects) || []).find((p) => projectPathKey(p.folder) === key) || null;
}

/** The project a chat row belongs to, or null (see above). */
function projectOf(state, row, home) {
  if (!state || !row || !row.id) return null;
  const homeKey = home ? projectPathKey(home) : '';
  const projects = state.projects || [];
  const put = state.chats && state.chats[row.id];
  if (put) { const p = projects.find((x) => x.id === put); if (p) return p; }
  const key = projectPathKey(row.workingDir);
  if (!key) return null;
  let best = null, bestLen = -1;
  for (const p of projects) {
    const pk = projectPathKey(p.folder);
    /* W2 QA: a project on the home folder took in every new chat under it,
       so Chats stayed empty. A project on the home folder (or the root) holds
       only chats that ran in that very folder. */
    const broad = pk === '/' || (!!homeKey && pk === homeKey);
    const inside = key === pk || (!broad && key.startsWith(pk + '/'));
    if (inside && pk.length > bestLen) { best = p; bestLen = pk.length; }
  }
  return best;
}

/** Each project with its rows (in `rows` order), and the rows left for the
    folders and Chats. `folders` is ATO-1034's state: a chat it files stays there. */
function projectGroups(state, rows, folders, home) {
  const projects = (state && state.projects) || [];
  const by = new Map(projects.map((p) => [p.id, []]));
  const folderIds = new Set(((folders && folders.folders) || []).map((f) => f.id));
  const filed = (folders && folders.chats) || {};
  const rest = [];
  for (const r of rows || []) {
    const fid = r && filed[r.id];
    const p = fid && folderIds.has(fid) ? null : projectOf(state, r, home);
    if (p && by.has(p.id)) by.get(p.id).push(r); else rest.push(r);
  }
  return {groups: projects.map((p) => ({project: p, rows: by.get(p.id)})), rest};
}

/* W2 QA (16.11): one kind of group in the sidebar, Projects. A project with
   a disk folder is the projects store's (`groups`, projectGroups above); one
   without is a chat folder (`folders`, chat-folders.js folderGroups), which
   import and the sorting make too. Both are listed together, the one with
   the latest chat first (the way Claude orders its projects), a new empty
   one by when it was made. Each item: {kind: 'project'|'folder', id, name,
   rows, item} (item is the project or the folder itself). */
function projectItems(groups, folders) {
  const latest = (rows, made) => (rows || []).reduce((m, r) => Math.max(m, (r && r.updatedAt) || 0), made || 0);
  const items = [];
  for (const g of groups || []) items.push({kind: 'project', id: g.project.id, name: g.project.name, rows: g.rows, item: g.project, at: latest(g.rows, g.project.createdAt)});
  for (const g of folders || []) items.push({kind: 'folder', id: g.folder.id, name: g.folder.name, rows: g.rows, item: g.folder, at: latest(g.rows, g.folder.createdAt)});
  return items.map((it, i) => ({it, i})).sort((a, b) => (b.it.at - a.it.at) || (a.i - b.i)).map((x) => x.it);
}

if (typeof module !== 'undefined') module.exports = {orderChats, projectItems, chatUnread, chatFailedSinceRead, chatMenuItems, chatMenuPlace,
  archiveSet, splitArchived, chatSearchQuery, chatSearch, CHAT_SEARCH_MAX, archivedIdsOf, agentKeepsArchive, archiveMigrationStep,
  projectPathKey, projectNameFromDir, projectsCoerce, projectForFolder, projectOf, projectGroups};
