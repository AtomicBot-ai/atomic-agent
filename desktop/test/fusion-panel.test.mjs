import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {
  FZP_REPROBE_MS, fzpKey, fzpNeedsProbe, fzpActionsFromList, fzpSpendText, fzpIsStuck,
  fzpRowExtrasHTML, fzpSteerFieldHTML, fzpNoteHTML, fzpSteerOutcome, fzpStopOutcome,
} = createRequire(import.meta.url)('../renderer/fusion-panel.js');

// ATO-568: one running Fusion worker's own Stop and Steer, under the composer.

const fresh = (over = {}) => ({support: {}, probing: {}, open: null, draft: '', busy: {}, stopped: {}, note: {}, wantFocus: false, ...over});
const both = (sid) => ({[sid]: {actions: ['stop', 'steer'], at: 0}});
const row = (over = {}) => ({taskId: 'ui', title: 'build the form', sessionId: 's-1', done: false, phase: 'tool', startedAt: 1_000, ...over});

test('a running row gets Stop and Steer when the agent lists them, each a labelled button', () => {
  const html = fzpRowExtrasHTML(row(), [row()], fresh({support: both('s-1')}), 2_000);
  assert.match(html, /<button type="button" class="fzbtn" data-act="fzp:stop:ui" aria-label="Stop worker build the form">Stop<\/button>/);
  assert.match(html, /<button type="button" class="fzbtn" data-act="fzp:steer:ui" aria-expanded="false" aria-label="Steer worker build the form">Steer<\/button>/);
});

test('an agent without the routes, or before it answered, draws no control: the rows stay read-only', () => {
  assert.doesNotMatch(fzpRowExtrasHTML(row(), [], fresh(), 0), /<button/);
  assert.doesNotMatch(fzpRowExtrasHTML(row(), [], fresh({support: {'s-1': {actions: [], at: 0}}}), 0), /<button/);
  // Only what is listed is drawn.
  const stopOnly = fzpRowExtrasHTML(row(), [], fresh({support: {'s-1': {actions: ['stop'], at: 0}}}), 0);
  assert.match(stopOnly, /fzp:stop:ui/);
  assert.doesNotMatch(stopOnly, /fzp:steer:/);
});

test('a finished row, or one with no chat to address, has nothing to act on', () => {
  const st = fresh({support: both('s-1')});
  assert.doesNotMatch(fzpRowExtrasHTML(row({done: true}), [], st, 0), /<button/);
  assert.doesNotMatch(fzpRowExtrasHTML(row({sessionId: null}), [], st, 0), /<button/);
});

test('Stop is disabled while it is sent and for good once it went through', () => {
  const key = fzpKey('s-1', 'ui');
  const sending = fzpRowExtrasHTML(row(), [], fresh({support: both('s-1'), busy: {[key]: 'stop'}}), 0);
  assert.match(sending, /data-act="fzp:stop:ui"[^>]* disabled>Stopping…</);
  const stopped = fzpRowExtrasHTML(row(), [], fresh({support: both('s-1'), stopped: {[key]: true}}), 0);
  assert.match(stopped, /data-act="fzp:stop:ui"[^>]* disabled>Stopped</);
  assert.match(stopped, /data-act="fzp:steer:ui"[^>]* disabled>Steer</);
});

test('the Steer field opens under its own row only, labelled, with the draft kept', () => {
  const key = fzpKey('s-1', 'ui');
  const st = fresh({support: both('s-1'), open: key, draft: 'use "Button"'});
  const field = fzpSteerFieldHTML(row(), st);
  assert.match(field, /<label class="fzsteer-lb" for="fzp-steer-field">Note for build the form<\/label>/);
  assert.match(field, /id="fzp-steer-field"[^>]*data-fzp-steer="ui"/);
  assert.match(field, /value="use &quot;Button&quot;"/);
  assert.equal(fzpSteerFieldHTML(row({taskId: 'api'}), st), '');
  assert.equal(fzpSteerFieldHTML(row({sessionId: 's-2'}), st), '');
  assert.match(fzpRowExtrasHTML(row(), [], st, 0), /aria-expanded="true"/);
  // Disabled while the note is on its way.
  assert.match(fzpSteerFieldHTML(row(), {...st, busy: {[key]: 'steer'}}), / disabled>/);
});

test('task ids and titles are escaped and encoded, never injected', () => {
  const nasty = row({taskId: 'a:b/"c"', title: '<img src=x onerror=1>'});
  const html = fzpRowExtrasHTML(nasty, [], fresh({support: both('s-1')}), 0);
  assert.match(html, /data-act="fzp:stop:a%3Ab%2F%22c%22"/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=1&gt;/);
});

test('tokens and $ are shown when the agent sent them, as the TUI row shows them', () => {
  assert.equal(fzpSpendText({tokens: 41_200, spentUsd: 0.031}), ' · 41.2k tok · $0.03');
  assert.equal(fzpSpendText({tokens: 900, spentUsd: null}), ' · 900 tok');
  assert.equal(fzpSpendText({spentUsd: 0.0018}), ' · $0.0018');
  assert.equal(fzpSpendText({}), '');
  assert.match(fzpRowExtrasHTML(row({tokens: 41_200, spentUsd: 0.031}), [], fresh(), 0), /<span class="fzspend">41\.2k tok · \$0\.03<\/span>/);
});

test('stuck follows the TUI rule: twice the expected time and at least three minutes', () => {
  const min = 60_000;
  const w = row({startedAt: 0, etaSeconds: 60});
  assert.equal(fzpIsStuck(w, [w], 2 * min), false, 'twice a 1 min estimate, but under three minutes');
  assert.equal(fzpIsStuck(w, [w], 3 * min), true);
  // No estimate: the median of at least two finished siblings.
  const a = row({taskId: 'a', done: true, startedAt: 0, finishedAt: 2 * min});
  const b = row({taskId: 'b', done: true, startedAt: 0, finishedAt: 2 * min});
  const c = row({taskId: 'c', startedAt: 0});
  assert.equal(fzpIsStuck(c, [a, c], 10 * min), false, 'one sibling is not a measurement');
  assert.equal(fzpIsStuck(c, [a, b, c], 3.9 * min), false);
  assert.equal(fzpIsStuck(c, [a, b, c], 4 * min), true);
  // The agent escalated it for a stall: stuck by its own measure; a done row never is.
  assert.equal(fzpIsStuck(row({stalled: true}), [], 0), true);
  assert.equal(fzpIsStuck(row({stalled: true, done: true}), [], 0), false);
  assert.match(fzpRowExtrasHTML(row({stalled: true}), [], fresh(), 0), /class="fzstuck"[^>]*>stuck</);
});

test('the support probe runs once per chat, and again only after a refusal has aged', () => {
  assert.equal(fzpNeedsProbe(fresh(), 's-1', 0), true);
  assert.equal(fzpNeedsProbe(fresh(), null, 0), false);
  assert.equal(fzpNeedsProbe(fresh({probing: {'s-1': true}}), 's-1', 0), false);
  assert.equal(fzpNeedsProbe(fresh({support: both('s-1')}), 's-1', 10 * FZP_REPROBE_MS), false);
  const refused = fresh({support: {'s-1': {actions: [], at: 0}}});
  assert.equal(fzpNeedsProbe(refused, 's-1', FZP_REPROBE_MS - 1), false);
  assert.equal(fzpNeedsProbe(refused, 's-1', FZP_REPROBE_MS), true);
});

test('the list answer becomes the actions drawn; an older agent (404) is none', () => {
  assert.deepEqual(fzpActionsFromList({ok: true, running: [], actions: ['stop', 'steer', 'escalate']}), ['stop', 'steer']);
  assert.deepEqual(fzpActionsFromList({ok: false, error: '/api/sessions/s-1/fusion/workers → HTTP 404'}), []);
  assert.deepEqual(fzpActionsFromList({ok: true, running: []}), []);
  assert.deepEqual(fzpActionsFromList(null), []);
});

test("the agent's answers are said plainly on the row", () => {
  assert.equal(fzpSteerOutcome({ok: true, steered: true}).ok, true);
  assert.equal(fzpSteerOutcome({ok: false, error: 'no fusion worker ui is running in session s-1'}).gone, true);
  assert.match(fzpSteerOutcome({ok: false, error: 'fusion worker ui is not taking notes right now — its turn is ending or its inbox is full'}).text, /Try again/);
  assert.equal(fzpSteerOutcome({ok: false, error: 'No route for POST /api/sessions/s-1/fusion/workers/ui/steer'}).unsupported, true);
  assert.equal(fzpStopOutcome({ok: true, stopped: true}).ok, true);
  assert.equal(fzpStopOutcome({ok: false, error: 'no fusion worker ui is running in session s-1'}).gone, true);
  assert.match(fzpStopOutcome({ok: false, error: 'socket hang up'}).text, /Could not stop the worker: socket hang up/);
});

test("a row's outcome line shows for a few seconds, then goes", () => {
  const key = fzpKey('s-1', 'ui');
  const st = fresh({note: {[key]: {text: 'Note sent.', bad: false, at: 0}}});
  assert.match(fzpNoteHTML(row(), st, 1_000), /<div class="fznote" role="status">Note sent\.<\/div>/);
  assert.equal(fzpNoteHTML(row(), st, 60_000), '');
  assert.equal(fzpNoteHTML(row({taskId: 'api'}), st, 1_000), '');
});
