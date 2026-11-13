// ATO-42: when the agent cut a project's instructions to fit the local
// prompt, the chat shows one line; uncut instructions show nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { projectInstructionsLine, projectInstructionsDraw } = createRequire(import.meta.url)('../renderer/project-instructions-line.js');
const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');

const CUT = { name: 'Site redesign', tokens: 4200, truncated: true, max_tokens: 1500 };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

test('a cut-instructions event renders the line before the reply', () => {
  const user = { id: 1, k: 'user', text: 'hi' };
  const item = { id: 2, k: 'assistant', text: '' };
  const log = [user, item];
  let n = 10;
  assert.equal(projectInstructionsDraw(CUT, log, item, () => ++n, esc), true);
  assert.equal(log.length, 3);
  assert.deepEqual(log[1], { id: 11, k: 'system', note: true, text: 'Project instructions loaded: Site redesign (4200 tokens, cut to 1500)' });
  assert.equal(log[2], item);
});

test('uncut -> no line', () => {
  const item = { id: 2, k: 'assistant' };
  const log = [item];
  assert.equal(projectInstructionsDraw({ ...CUT, truncated: false, tokens: 300 }, log, item, () => 1, esc), false);
  assert.equal(log.length, 1);
  assert.equal(projectInstructionsLine({ ...CUT, truncated: false }), '');
  assert.equal(projectInstructionsLine({}), '');
  assert.equal(projectInstructionsLine(null), '');
});

test('no name, odd numbers and a name with markup are handled', () => {
  assert.equal(projectInstructionsLine({ truncated: true, tokens: 2000.4, name: null }), 'Project instructions loaded: this project (2000 tokens, cut to 1500)');
  assert.equal(projectInstructionsLine({ truncated: true, name: 'P' }), 'Project instructions loaded: P (cut to 1500)');
  const item = { id: 2 };
  const log = [item];
  projectInstructionsDraw({ ...CUT, name: '<b>x</b>' }, log, item, () => 1, esc);
  assert.match(log[0].text, /&lt;b>x&lt;\/b>/);
});

test('without the reply row on screen nothing is drawn', () => {
  const log = [];
  assert.equal(projectInstructionsDraw(CUT, log, undefined, () => 1, esc), false);
  assert.equal(projectInstructionsDraw(CUT, log, { id: 9 }, () => 1, esc), false);
  assert.equal(log.length, 0);
});

test('the page loads the helper before renderer.js and the chat event router hands the frame to it', () => {
  assert.ok(html.indexOf('project-instructions-line.js') > 0 && html.indexOf('project-instructions-line.js') < html.indexOf('src="renderer.js"'));
  assert.match(renderer, /'tool_disabled', 'project_instructions',/);
  assert.match(renderer, /if \(ev\.kind === 'project_instructions'\) \{ if \(projectInstructionsDraw\(ev\.payload, S\.log, item, nid, esc\)\) render\(\); return; \}/);
});
