import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { FZB_MAX_CHARS, FZB_MAX_NOTE_CHARS, fzbFromPayload, fzbHTML } = createRequire(import.meta.url)('../renderer/fusion-brief.js');

// ATO-1754: what a Fusion worker was told, under its started line.

const line = (over = {}) => ({id: 'n1', fzBrief: 'TASK t1: api\n\nWrite <routes> & "tests"', fzModel: 'qwen-3.8-27b', fzNote: null, fzbOpen: false, ...over});

test('the frame gives the brief and the model note; blank or missing fields are null', () => {
  assert.deepEqual(fzbFromPayload({brief: 'TASK t1', model_note: ' role review has no model configured '}),
    {brief: 'TASK t1', modelNote: 'role review has no model configured'});
  assert.deepEqual(fzbFromPayload({}), {brief: null, modelNote: null});
  assert.deepEqual(fzbFromPayload({brief: '  ', model_note: ''}), {brief: null, modelNote: null});
  assert.deepEqual(fzbFromPayload({brief: 42, model_note: {}}), {brief: null, modelNote: null});
  assert.deepEqual(fzbFromPayload(null), {brief: null, modelNote: null});
});

test('an oversized brief or note is kept only up to its cap', () => {
  const big = fzbFromPayload({brief: 'x'.repeat(FZB_MAX_CHARS + 10), model_note: 'y'.repeat(FZB_MAX_NOTE_CHARS + 10)});
  assert.equal(big.brief.length, FZB_MAX_CHARS);
  assert.equal(big.modelNote.length, FZB_MAX_NOTE_CHARS);
});

test('closed by default: a toggle and no brief text in the page', () => {
  const html = fzbHTML(line(), (open) => (open ? '[v]' : '[>]'));
  assert.match(html, /<button type="button" class="fzb-t" data-fzbrief="n1" aria-expanded="false">\[>\]<span>What it was told<\/span><\/button>/);
  assert.doesNotMatch(html, /Write/);
  assert.doesNotMatch(html, /fzb-x/);
});

test('open: the model, the note when there is one, and the brief, all escaped', () => {
  const html = fzbHTML(line({fzbOpen: true, fzNote: 'ran on the <workers> model'}), (open) => (open ? '[v]' : '[>]'));
  assert.match(html, /aria-expanded="true">\[v\]/);
  assert.match(html, /<span class="fzb-k">Model: qwen-3\.8-27b<\/span>/);
  assert.match(html, /<span class="fzb-k fzb-note">ran on the &lt;workers&gt; model<\/span>/);
  assert.match(html, /<span class="fzb-pre">TASK t1: api\n\nWrite &lt;routes&gt; &amp; &quot;tests&quot;<\/span>/);
  // No note, no note line.
  assert.doesNotMatch(fzbHTML(line({fzbOpen: true}), () => ''), /fzb-note/);
});

test('a line with no brief (an older agent) draws nothing', () => {
  assert.equal(fzbHTML(line({fzBrief: undefined}), () => ''), '');
  assert.equal(fzbHTML(line({fzBrief: ''}), () => ''), '');
  assert.equal(fzbHTML(null, () => ''), '');
});

test('the renderer wires it: loaded before renderer.js, stored on the started line, toggled by its button', () => {
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('fusion-brief.js') > 0 && html.indexOf('fusion-brief.js') < html.indexOf('renderer.js'));
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(src, /fzBrief: fzb\.brief, fzNote: fzb\.modelNote/);
  assert.match(src, /t\.closest\('\[data-fzbrief\]'\)/);
  assert.match(src, /fzbHTML\(m, /);
  // Two started lines that read the same but carry different briefs are not folded into one.
  assert.match(src, /items\[j \+ 1\]\.fzBrief === m\.fzBrief\) j\+\+;/);
});
