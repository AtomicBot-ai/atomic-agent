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

/* The row menu's items, top to bottom. Each is the act verb it runs, its
   label, its icon name and whether it is the destructive one. Rename is not
   here: nothing in the desktop or the agent's session routes renames a chat. */
function chatMenuItems(opts) {
  const o = opts || {};
  return [
    o.pinned ? {verb: 'unpin', label: 'Unpin', icon: 'pin'} : {verb: 'pin', label: 'Pin', icon: 'pin'},
    o.unread ? {verb: 'read', label: 'Mark as read', icon: 'check'} : {verb: 'unread', label: 'Mark as unread', icon: 'unread'},
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

if (typeof module !== 'undefined') module.exports = {orderChats, chatUnread, chatMenuItems, chatMenuPlace};
