import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {orderChats, chatUnread, chatFailedSinceRead, chatMenuItems, chatMenuPlace} = createRequire(import.meta.url)('../renderer/chat-list.js');

const ses = (id, updatedAt = 1) => ({id, t: id, updatedAt});
const ids = (rows) => rows.map((r) => r.id);

test('pinned chats come first, in pin order (the last pinned on top), and are not repeated below', () => {
  const sessions = [ses('a'), ses('b'), ses('c'), ses('d')];
  const out = orderChats(sessions, [], ['c', 'a']);
  assert.deepEqual(ids(out.pinned), ['c', 'a']);
  assert.deepEqual(ids(out.rest), ['b', 'd']);
});

test('nothing pinned: no pinned section, the agent order unchanged', () => {
  const out = orderChats([ses('a'), ses('b')], [], []);
  assert.deepEqual(out.pinned, []);
  assert.deepEqual(ids(out.rest), ['a', 'b']);
});

test('a pinned id with no chat behind it draws nothing, and a duplicate pin draws once', () => {
  const out = orderChats([ses('a'), ses('b')], [], ['gone', 'b', 'b']);
  assert.deepEqual(ids(out.pinned), ['b']);
  assert.deepEqual(ids(out.rest), ['a']);
});

test('a new chat still starting stands at the top of the unpinned ones, and its stored row replaces it', () => {
  const pending = [{id: 'p1', t: 'new'}, {id: 'b', t: 'stand-in'}];
  const out = orderChats([ses('a'), ses('b')], pending, []);
  assert.deepEqual(ids(out.rest), ['p1', 'a', 'b']);
  assert.equal(out.rest[2].t, 'b');   // the stored row, not the stand-in
});

test('a pinned stand-in is pinned, and is not drawn again among the rest', () => {
  const out = orderChats([ses('a')], [{id: 'p1', t: 'new'}], ['p1']);
  assert.deepEqual(ids(out.pinned), ['p1']);
  assert.deepEqual(ids(out.rest), ['a']);
});

test('ids with colons (hermes:…) are whole ids', () => {
  const out = orderChats([ses('hermes:20260511_1'), ses('x')], [], ['hermes:20260511_1']);
  assert.deepEqual(ids(out.pinned), ['hermes:20260511_1']);
});

test('unread: no stamp, or a turn stored after the stamp', () => {
  assert.equal(chatUnread(ses('a', 10), undefined), true);
  assert.equal(chatUnread(ses('a', 10), 5), true);
  assert.equal(chatUnread(ses('a', 10), 10), false);
  assert.equal(chatUnread(ses('a', 10), 20), false);
  assert.equal(chatUnread(null, 0), false);
});

test('red from the stored status only for a failed turn stored after a real read stamp', () => {
  const failed = {id: 'a', t: 'a', updatedAt: 10, status: 'failed'};
  // Mark as unread drops the stamp: the plain unread dot, not red (QA 0.0.2).
  assert.equal(chatFailedSinceRead(failed, undefined), false);
  assert.equal(chatUnread(failed, undefined), true);
  // A failed turn stored after the chat was read is news: red.
  assert.equal(chatFailedSinceRead(failed, 5), true);
  // Read after the failure: no dot at all, so no tone either.
  assert.equal(chatFailedSinceRead(failed, 10), false);
  assert.equal(chatFailedSinceRead({...failed, status: 'completed'}, 5), false);
  assert.equal(chatFailedSinceRead(null, 5), false);
});

test('the row menu: Pin or Unpin, Mark as read or unread, Rename, then Delete…', () => {
  assert.deepEqual(chatMenuItems({pinned: false, unread: false}).map((i) => i.verb), ['pin', 'unread', 'rename', 'delask']);
  assert.deepEqual(chatMenuItems({pinned: true, unread: true}).map((i) => i.verb), ['unpin', 'read', 'rename', 'delask']);
  const items = chatMenuItems({pinned: true, unread: false});
  assert.deepEqual(items.map((i) => i.label), ['Unpin', 'Mark as unread', 'Rename', 'Delete…']);
  assert.deepEqual(items.filter((i) => i.danger).map((i) => i.verb), ['delask']);
});

test('ATO-455: a chat still starting (no stored session) has no Rename', () => {
  assert.deepEqual(chatMenuItems({pinned: false, unread: false, renamable: false}).map((i) => i.verb), ['pin', 'unread', 'delask']);
  assert.deepEqual(chatMenuItems({renamable: true}).map((i) => i.verb), ['pin', 'unread', 'rename', 'delask']);
});

test('the menu stays inside the window', () => {
  assert.deepEqual(chatMenuPlace(100, 100, 220, 120, 1280, 820), {left: 100, top: 100});
  assert.deepEqual(chatMenuPlace(1200, 100, 220, 120, 1280, 820), {left: 1052, top: 100});
  assert.deepEqual(chatMenuPlace(100, 780, 220, 120, 1280, 820), {left: 100, top: 660});
  assert.deepEqual(chatMenuPlace(-20, 10, 220, 120, 1280, 820), {left: 8, top: 10});
});
