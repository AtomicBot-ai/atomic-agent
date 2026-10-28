// ATO-449 (U-12): a reduced-refusal model stays in the first-run list, with a
// plain note on what it is instead of the bare "Use at your own risk" tag.
// renderer.js is read as text and the note functions run in a vm with their
// neighbours stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
function fn(start) {
  const i = renderer.indexOf(start);
  assert.ok(i >= 0, start);
  const j = renderer.indexOf('\n}\n', i);
  assert.ok(j > i, start);
  return renderer.slice(i, j + 2);
}
function line(start) {
  const i = renderer.indexOf(start);
  assert.ok(i >= 0, start);
  return renderer.slice(i, renderer.indexOf('\n', i) + 1);
}

function load() {
  const ctx = createContext({
    OB: { ram: 64 },
    THIS_MACHINE_CAP: 'This Mac',
    fitFor: () => ({ v: 'ok', rank: 0 }),
    isSmallModel: (m) => Number(m.recommendedRamGb) <= 8,
  });
  runInContext(line('const SMALL_MODEL_CAUTION =') + line('const UNCENSORED_NOTE =') + line('const UNCENSORED_WORD =')
    + fn('function modelPickNote(model, ram)') + fn('function obModelNote(model)')
    + ';this.pick = modelPickNote; this.ob = obModelNote; this.NOTE = UNCENSORED_NOTE;', ctx);
  return ctx;
}

const unc = { id: 'qwen-3.8-27b-uncensored', name: 'Qwen 3.8 27B Uncensored GGUF', recommendedRamGb: 32, uncensored: true, tag: 'Use at your own risk' };

test('a reduced-refusal model says what it is, not just the catalogue tag', () => {
  const { pick, NOTE } = load();
  const note = pick(unc, 64);
  assert.equal(note.v, 'caution');
  assert.equal(note.text, NOTE);
  assert.match(note.text, /fewer safety refusals/i);
  assert.doesNotMatch(note.text, /own risk/i);
  assert.doesNotMatch(note.text, /—/, 'no em dash in user-facing text');
});

test('the first-run row badge is the short word, the sentence is its tooltip, and it stays warm-toned', () => {
  const { ob, NOTE } = load();
  const note = ob(unc);
  assert.equal(note.word, 'Fewer refusals');
  assert.equal(note.text, NOTE);
  assert.equal(note.warn, true);
});

test('the note does not depend on the catalogue carrying a tag', () => {
  const { pick, NOTE } = load();
  const { tag, ...untagged } = unc;
  assert.equal(pick(untagged, 64).text, NOTE);
});

test('a standard model gets no note', () => {
  const { pick } = load();
  assert.equal(pick({ id: 'qwen-3.8-27b', recommendedRamGb: 32 }, 64), null);
});

test('Settings › Models labels a reduced-refusal row with the same word and sentence, not the bare tag', () => {
  assert.match(renderer, /chat && m\.uncensored && !best \? [^\n]*title="' \+ esc\(UNCENSORED_NOTE\) \+ '">' \+ esc\(UNCENSORED_WORD\)/);
});
