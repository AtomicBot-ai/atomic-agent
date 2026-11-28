// ATO-2443: when a path-scoped project rule joins the prompt, the chat shows
// one line naming the rule file, like the terminal's "rule attached: <file>".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { pathRuleLine, pathRuleDraw } = createRequire(import.meta.url)('../renderer/path-rule-line.js');
const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');

const FRAME = { path: '.atomic-agent/rules/sql.md', patterns: ['*.sql'], step_index: 2 };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

test('a path_rule_attached frame renders the line before the reply', () => {
  const user = { id: 1, k: 'user', text: 'fix the schema' };
  const item = { id: 2, k: 'assistant', text: '' };
  const log = [user, item];
  let n = 10;
  assert.equal(pathRuleDraw(FRAME, log, item, () => ++n, esc), true);
  assert.equal(log.length, 3);
  assert.deepEqual(log[1], { id: 11, k: 'system', note: true, text: 'Rule attached: .atomic-agent/rules/sql.md' });
  assert.equal(log[2], item);
});

test('a global rule is named by its ~ path', () => {
  assert.equal(pathRuleLine({ path: '~/.atomic-agent/rules/css.md' }), 'Rule attached: ~/.atomic-agent/rules/css.md');
});

test('a frame without a rule file draws nothing', () => {
  const item = { id: 2 };
  const log = [item];
  assert.equal(pathRuleDraw({ path: '  ' }, log, item, () => 1, esc), false);
  assert.equal(pathRuleLine({}), '');
  assert.equal(pathRuleLine(null), '');
  assert.equal(pathRuleLine({ path: 42 }), '');
  assert.equal(log.length, 1);
});

test('markup in the path is escaped, and without the reply row on screen nothing is drawn', () => {
  const item = { id: 2 };
  const log = [item];
  pathRuleDraw({ path: '<b>x</b>.md' }, log, item, () => 1, esc);
  assert.match(log[0].text, /&lt;b>x&lt;\/b>/);
  const empty = [];
  assert.equal(pathRuleDraw(FRAME, empty, undefined, () => 1, esc), false);
  assert.equal(pathRuleDraw(FRAME, empty, { id: 9 }, () => 1, esc), false);
  assert.equal(empty.length, 0);
});

test('the page loads the helper before renderer.js and the chat event router hands the frame to it', () => {
  assert.ok(html.indexOf('path-rule-line.js') > 0 && html.indexOf('path-rule-line.js') < html.indexOf('src="renderer.js"'));
  assert.match(renderer, /const LIVE_DRAWS = new Set\(\[[^\]]*'path_rule_attached'/);
  assert.match(renderer, /if \(ev\.kind === 'path_rule_attached'\) \{ if \(pathRuleDraw\(ev\.payload, S\.log, item, nid, esc\)\) render\(\); return; \}/);
});
