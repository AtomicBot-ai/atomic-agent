// ATO-1726: the T165a smoke knows every optional row of the chat's "…" menu.
// Run: npm run build && npm run test:unit (the smoke task is read from the built output).
// The smoke keeps its own list of the rows between Rename and Delete… (MENU_MIDDLE in
// main/smoke-tasks/t165.ts); the window draws them from chatMenuItems in
// renderer/chat-list.js. The two drifted apart five rows ago (ATO-1715), so this
// test holds them together: a row added to the menu fails here until the smoke
// learns it, and a row the smoke lists that the menu no longer draws fails too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MENU_MIDDLE, middleRowsInOrder } = require('../out/main/smoke-tasks/t165.js');
const { chatMenuItems } = require('../renderer/chat-list.js');

/* A stored chat with everything on offer: renderer.js chatMenuHTML passes these for a chat the agent holds. */
const FULL = { pinned: false, unread: false, renamable: true, folders: true, archivable: true, archived: false,
  workers: true, exportable: true, windowable: true };
const middle = (items) => items.slice(3, -1);

test('the smoke lists every optional row the menu draws for a stored chat, in the menu\'s order', () => {
  const items = middle(chatMenuItems(FULL));
  assert.deepEqual(items.map((i) => [i.verb, i.label]), MENU_MIDDLE.map((r) => [r[0], r[1]]));
  assert.equal(middleRowsInOrder(items.map((i) => i.verb), items.map((i) => i.label)), true);
});

test('a chat with fewer offers still passes: the rows drawn keep the order, none is unknown', () => {
  for (const opts of [
    { ...FULL, workers: false, windowable: false },           // no project folder, pop-out not offered
    { ...FULL, folders: false, archivable: false },
    { ...FULL, exportable: false },                             // drops Export…, Hand off, Share, Save as recipe
    { pinned: false, unread: false, renamable: true },          // the bare menu of the first T165 run
  ]) {
    const items = middle(chatMenuItems(opts));
    assert.equal(middleRowsInOrder(items.map((i) => i.verb), items.map((i) => i.label)), true, JSON.stringify(opts));
  }
});

test('a row the smoke does not know, a wrong label or a swapped order fails the check', () => {
  assert.equal(middleRowsInOrder(['fpick', 'mystery'], ['Move to project…', 'Mystery…']), false);
  assert.equal(middleRowsInOrder(['share'], ['Share…']), false);
  assert.equal(middleRowsInOrder(['export', 'archive'], ['Export…', 'Archive']), false);
  assert.equal(middleRowsInOrder([], []), true);
});
