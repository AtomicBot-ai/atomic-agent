import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {PLANS, PLAN_FOLD, planRead, planSet, planRestore, planOf, planProgress, planFolded, planToggle, planChipLabel, planBarRows, planBarHTML} =
  createRequire(import.meta.url)('../renderer/plan-bar.js');

// ATO-486: the agent's live plan above the composer.

const deps = {esc: (s) => String(s), ic: (name) => '<svg data-ic="' + name + '"></svg>'};
const plan = (...statuses) => ({items: statuses.map((status, i) => ({step: 'step ' + (i + 1), status})), updatedAt: 10});
const reset = () => { PLANS.clear(); PLAN_FOLD.clear(); };

test('a frame sets the chat\'s plan, and an identical one changes nothing', () => {
  reset();
  assert.equal(planSet('s1', plan('done', 'in_progress', 'pending')), true);
  assert.deepEqual(planProgress(planOf('s1')), {done: 1, total: 3, current: 'step 2'});
  assert.equal(planSet('s1', Object.assign(plan('done', 'in_progress', 'pending'), {updatedAt: 99})), false);
  assert.equal(planChipLabel(planOf('s1')), 'Plan 1/3');
});

test('an empty plan clears the bar', () => {
  reset();
  planSet('s1', plan('pending'));
  assert.equal(planSet('s1', {items: [], updatedAt: 11}), true);
  assert.equal(planOf('s1'), null);
  assert.equal(planBarHTML('s1', deps), '');
});

test('steps with an unknown status or no text are dropped', () => {
  assert.deepEqual(planRead({items: [{step: 'a', status: 'done'}, {step: '', status: 'done'}, {step: 'b', status: 'blocked'}, 3]}),
    {items: [{step: 'a', status: 'done'}], updatedAt: 0});
  assert.equal(planRead({items: 'x'}), null);
  assert.equal(planRead(null), null);
});

test('the open bar lists every step with ticks on finished ones', () => {
  reset();
  planSet('s1', plan('done', 'in_progress', 'pending'));
  const html = planBarHTML('s1', deps);
  assert.match(html, /Plan 1\/3/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /pl-done[\s\S]*data-ic="check"[\s\S]*step 1/);
  assert.match(html, /pl-in-progress[\s\S]*step 2/);
  assert.match(html, /pl-pending[\s\S]*step 3/);
  assert.match(html, /data-plan-toggle="s1"/);
});

test('a click folds the bar to its chip and back', () => {
  reset();
  planSet('s1', plan('done', 'in_progress'));
  planToggle('s1');
  const folded = planBarHTML('s1', deps);
  assert.match(folded, /is-folded/);
  assert.doesNotMatch(folded, /pl-list/);
  assert.match(folded, /Plan 1\/2/);
  planToggle('s1');
  assert.match(planBarHTML('s1', deps), /pl-list/);
});

test('a finished plan starts folded', () => {
  reset();
  planSet('s1', plan('done', 'done'));
  assert.equal(planFolded('s1'), true);
  assert.match(planBarHTML('s1', deps), /is-done/);
});

test('reopening a chat restores the stored plan', () => {
  reset();
  assert.equal(planRestore('s2', plan('done', 'pending'), false), true);
  assert.equal(planChipLabel(planOf('s2')), 'Plan 1/2');
  // No stored plan and no running turn: the bar goes.
  assert.equal(planRestore('s2', undefined, false), true);
  assert.equal(planOf('s2'), null);
});

test('while its turn runs, the stream\'s plan outranks an older stored one', () => {
  reset();
  planSet('s3', Object.assign(plan('done', 'done', 'in_progress'), {updatedAt: 50}));
  assert.equal(planRestore('s3', Object.assign(plan('in_progress', 'pending', 'pending'), {updatedAt: 20}), true), false);
  assert.equal(planProgress(planOf('s3')).done, 2);
  assert.equal(planRestore('s3', undefined, true), false);
  assert.ok(planOf('s3'));
});

test('a long plan keeps the step in progress in view', () => {
  const long = plan(...Array(10).fill('done'), 'in_progress', ...Array(9).fill('pending'));
  const {rows, above, below} = planBarRows(long, 8);
  assert.equal(rows.length, 8);
  assert.equal(rows[1].it.step, 'step 11');
  assert.equal(above, 9);
  assert.equal(below, 3);
});

test('frames without a chat id are ignored', () => {
  reset();
  assert.equal(planSet(null, plan('pending')), false);
  assert.equal(PLANS.size, 0);
});
