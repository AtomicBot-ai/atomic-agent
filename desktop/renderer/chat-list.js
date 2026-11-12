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
    o.pinned ? {verb: 'unpin', label: 'Unpin', icon: 'pin'} : {verb: 'pin', label: 'Pin', icon: 'pin'},
    o.unread ? {verb: 'read', label: 'Mark as read', icon: 'check'} : {verb: 'unread', label: 'Mark as unread', icon: 'unread'},
    ...(o.renamable === false ? [] : [{verb: 'rename', label: 'Rename', icon: 'edit'}]),
    // ATO-1034: "Move to folder…" opens the folder list (chat-folders.js), for a stored chat.
    ...(o.folders === true ? [{verb: 'fpick', label: 'Move to folder…', icon: 'folder'}] : []),
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

/** Whatever the store sent, as {projects: [{id, name, folder}], chats: {sessionId: projectId}}. */
function projectsCoerce(raw) {
  const out = {projects: [], chats: {}};
  const r = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(raw) ? raw : Array.isArray(r.projects) ? r.projects : [];
  const ids = new Set();
  for (const p of list) {
    // Ids go into data-act attributes (and the remove question's button): plain characters only.
    if (!p || typeof p.id !== 'string' || !/^[\w.:-]{1,80}$/.test(p.id) || ids.has(p.id)) continue;
    const folder = typeof p.folder === 'string' ? p.folder : '';
    if (!projectPathKey(folder)) continue;
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : projectNameFromDir(folder);
    ids.add(p.id);
    out.projects.push({id: p.id, name, folder});
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
function projectOf(state, row) {
  if (!state || !row || !row.id) return null;
  const projects = state.projects || [];
  const put = state.chats && state.chats[row.id];
  if (put) { const p = projects.find((x) => x.id === put); if (p) return p; }
  const key = projectPathKey(row.workingDir);
  if (!key) return null;
  let best = null, bestLen = -1;
  for (const p of projects) {
    const pk = projectPathKey(p.folder);
    const inside = key === pk || key.startsWith(pk === '/' ? '/' : pk + '/');
    if (inside && pk.length > bestLen) { best = p; bestLen = pk.length; }
  }
  return best;
}

/** Each project with its rows (in `rows` order), and the rows left for the
    folders and Chats. `folders` is ATO-1034's state: a chat it files stays there. */
function projectGroups(state, rows, folders) {
  const projects = (state && state.projects) || [];
  const by = new Map(projects.map((p) => [p.id, []]));
  const folderIds = new Set(((folders && folders.folders) || []).map((f) => f.id));
  const filed = (folders && folders.chats) || {};
  const rest = [];
  for (const r of rows || []) {
    const fid = r && filed[r.id];
    const p = fid && folderIds.has(fid) ? null : projectOf(state, r);
    if (p && by.has(p.id)) by.get(p.id).push(r); else rest.push(r);
  }
  return {groups: projects.map((p) => ({project: p, rows: by.get(p.id)})), rest};
}

if (typeof module !== 'undefined') module.exports = {orderChats, chatUnread, chatFailedSinceRead, chatMenuItems, chatMenuPlace,
  projectPathKey, projectNameFromDir, projectsCoerce, projectForFolder, projectOf, projectGroups};
