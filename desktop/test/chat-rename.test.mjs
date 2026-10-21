import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {RENAME_MAX_CHARS, renameTitleCheck, renameApply, renameRevert, renameErrorText} =
  createRequire(import.meta.url)('../renderer/chat-rename.js');

// ATO-455: renaming a chat from the sidebar or the toolbar title.

test('the box trims the name and sends it, as the agent stores it', () => {
  assert.deepEqual(renameTitleCheck('  Login bug  ', 'Write a long, numbered list…'), {ok: true, title: 'Login bug'});
});

test('an unchanged name closes the box without a request', () => {
  assert.deepEqual(renameTitleCheck(' Login bug ', 'Login bug'), {ok: true, same: true, title: 'Login bug'});
});

test('an empty, multi-line or too long name is refused, as the agent refuses it', () => {
  assert.equal(renameTitleCheck('', 'x').ok, false);
  assert.equal(renameTitleCheck('   ', 'x').ok, false);
  assert.equal(renameTitleCheck(null, 'x').ok, false);
  assert.equal(renameTitleCheck('one\ntwo', 'x').ok, false);
  assert.equal(RENAME_MAX_CHARS, 120);
  assert.equal(renameTitleCheck('я'.repeat(120), 'x').ok, true);
  assert.equal(renameTitleCheck('я'.repeat(121), 'x').ok, false);
});

test('the row takes the new name at once, and keeps it over its first prompt (titled)', () => {
  const rows = [{id: 'a', t: 'Write a long, numbered…', titled: false, named: true}, {id: 'b', t: 'B', titled: true, named: true}];
  const was = renameApply(rows, 'a', 'Lists');
  assert.deepEqual(was, {t: 'Write a long, numbered…', titled: false, named: true});
  assert.deepEqual(rows[0], {id: 'a', t: 'Lists', titled: true, named: true});
  assert.equal(rows[1].t, 'B');
  assert.equal(renameApply(rows, 'gone', 'X'), null);
});

test('a refused rename puts the old name back, unless a newer name is already showing', () => {
  const rows = [{id: 'a', t: 'Old', titled: false, named: true}];
  const was = renameApply(rows, 'a', 'New');
  assert.equal(renameRevert(rows, 'a', 'New', was), true);
  assert.deepEqual(rows[0], {id: 'a', t: 'Old', titled: false, named: true});

  const was2 = renameApply(rows, 'a', 'First');
  renameApply(rows, 'a', 'Second');
  assert.equal(renameRevert(rows, 'a', 'First', was2), false);
  assert.equal(rows[0].t, 'Second');
});

test('an agent without the route is named for what it means', () => {
  assert.match(renameErrorText('Error: no route for PATCH /api/sessions/x'), /cannot rename chats/);
  assert.equal(renameErrorText('Error: session not found: x'), 'session not found: x');
  assert.equal(renameErrorText(undefined), '');
});
