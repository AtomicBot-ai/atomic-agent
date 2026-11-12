import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {memEditKey, memEditCheckText, memEditActiveValue, memEditOp, memEditOutcome} =
  createRequire(import.meta.url)('../renderer/memory-edit.js');

// ATO-582: Edit and Delete on a note's and a fact's page in the Memory tab.

test('only a note or a fact page can be edited', () => {
  assert.equal(memEditKey({channel: 'notes', id: 5}), 'note:5');
  assert.equal(memEditKey({channel: 'profile', key: 'name'}), 'profile:name');
  assert.equal(memEditKey({channel: 'lessons', id: 5}), null);
  assert.equal(memEditKey(null), null);
});

test('the box refuses empty text and closes on unchanged text', () => {
  assert.equal(memEditCheckText('   ', 'old').ok, false);
  assert.match(memEditCheckText('', 'old', 'fact').error, /fact cannot be empty/);
  assert.deepEqual(memEditCheckText(' old ', 'old'), {ok: true, same: true, text: ' old '});
  assert.deepEqual(memEditCheckText('new', 'old'), {ok: true, text: 'new'});
});

test('a fact edits its active value, not an older version', () => {
  const rows = [{id: 1, value: 'Moscow', superseded_by: 2}, {id: 2, value: 'Tallinn', superseded_by: null}];
  assert.equal(memEditActiveValue(rows), 'Tallinn');
  assert.equal(memEditActiveValue([{id: 1, value: 'x', superseded_by: 2}]), null);
  assert.equal(memEditActiveValue([]), null);
});

test('the page names the op main sends', () => {
  assert.deepEqual(memEditOp({channel: 'notes', id: 3}, 'delete'), {op: 'note.delete', id: 3});
  assert.deepEqual(memEditOp({channel: 'notes', id: 3}, 'edit', 'hi'), {op: 'note.edit', id: 3, text: 'hi'});
  assert.deepEqual(memEditOp({channel: 'profile', key: 'k'}, 'delete'), {op: 'profile.delete', key: 'k'});
  assert.deepEqual(memEditOp({channel: 'profile', key: 'k'}, 'edit', 'v'), {op: 'profile.edit', key: 'k', value: 'v'});
  assert.equal(memEditOp({channel: 'votes'}, 'delete'), null);
});

test('after a write: a delete goes back to the list, an edit reopens the page', () => {
  assert.deepEqual(memEditOutcome({op: 'note.delete', id: 1}, {ok: true}), {next: 'list', toast: 'Note deleted'});
  assert.deepEqual(memEditOutcome({op: 'profile.delete', key: 'k'}, {ok: true}), {next: 'list', toast: 'Fact deleted'});
  assert.deepEqual(memEditOutcome({op: 'note.edit', id: 1, text: 'x'}, {ok: true}), {next: 'reopen', toast: 'Note saved'});
  assert.deepEqual(memEditOutcome({op: 'profile.edit', key: 'k', value: 'v'}, {ok: true}), {next: 'reopen', toast: 'Fact saved'});
});

test('an older agent says to update it; a removed item shows the list; an error stays on the page', () => {
  assert.deepEqual(memEditOutcome({op: 'note.delete', id: 1}, {ok: false, reason: 'unsupported'}), {next: 'stay', error: 'Update the agent to edit memory here'});
  assert.equal(memEditOutcome({op: 'note.delete', id: 1}, {ok: false, reason: 'gone'}).next, 'list');
  const e = memEditOutcome({op: 'note.edit', id: 1, text: 'x'}, {ok: false, reason: 'error', error: 'content: too long'});
  assert.deepEqual(e, {next: 'stay', error: 'Could not save the note: content: too long'});
});
