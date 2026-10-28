// ATO-1257: a failed call the agent went on from is quiet; the one that ended the turn stays red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { quietToolFailures, toolFailNeedsPerson, failRunHTML } = require('../renderer/tool-failures.js');

const fail = (id, out) => ({id, k: 'tool', name: 'os.shell.run', ok: false, out: out || 'exit: 1'});
const okc = (id) => ({id, k: 'tool', name: 'os.shell.run', ok: true});
const user = (id) => ({id, k: 'user', text: 'x'});
const reply = (id) => ({id, k: 'assistant', text: 'done'});

test('«закрой хром»: five failures then a call that worked are all quiet', () => {
  const log = [user('u'), fail('a'), fail('b'), fail('c'), fail('d'), fail('e'), okc('f'), reply('r')];
  assert.deepEqual([...quietToolFailures(log)].sort(), ['a', 'b', 'c', 'd', 'e']);
});

test('the failure that ended a finished turn stays loud; one in a running turn is quiet', () => {
  const log = [user('u'), fail('a'), okc('b'), fail('c'), reply('r')];
  assert.deepEqual([...quietToolFailures(log)], ['a']);
  const live = [user('u'), fail('a'), fail('b')];
  assert.deepEqual([...quietToolFailures(live, {running: true})].sort(), ['a', 'b']);
  assert.deepEqual([...quietToolFailures(live, {running: false})], []);
});

test('a later turn does not quiet an earlier turn\'s last failure; a steer does not split a turn', () => {
  const log = [user('u1'), fail('a'), reply('r1'), user('u2'), okc('b'), reply('r2')];
  assert.deepEqual([...quietToolFailures(log)], []);
  const steered = [user('u1'), fail('a'), {id: 's', k: 'user', steered: true, text: 'go'}, okc('b'), reply('r')];
  assert.deepEqual([...quietToolFailures(steered)], ['a']);
});

test('a denied or not-run call is not a failure, nor a call that worked', () => {
  const denied = {id: 'd', k: 'tool', ok: false, outcome: 'denied'};
  const log = [user('u'), fail('a'), denied, reply('r')];
  assert.deepEqual([...quietToolFailures(log)], [], 'a deny after it is not the agent getting past it');
});

test('a failure that needs the person stays loud wherever it is', () => {
  assert.ok(toolFailNeedsPerson({keyReq: {x: 1}}));
  assert.ok(toolFailNeedsPerson({out: 'Screen Recording permission is missing'}));
  assert.ok(!toolFailNeedsPerson({out: 'exit: 1\nno such process'}));
  const log = [user('u'), fail('a', 'grant Accessibility in System Settings'), okc('b'), reply('r')];
  assert.deepEqual([...quietToolFailures(log)], []);
});

test('the folded line counts the attempts and escapes the tool id', () => {
  const html = failRunHTML([fail('a'), fail('b'), {id: 'c', name: '<x>', k: 'tool'}], {esc: (s) => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'), ic: () => ''});
  assert.match(html, /3 attempts failed/);
  assert.match(html, /data-failrun="a"/);
  assert.ok(!html.includes(' err'), 'no red class on the line');
});
