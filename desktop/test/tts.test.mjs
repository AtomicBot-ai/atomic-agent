import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ttsPlain } = require('../renderer/tts.js');

/** ATO-1046: what is read aloud — the words, not the markdown around them. */
test('code, links and markdown marks are not read out', () => {
  assert.equal(ttsPlain('# Done\n\nI **fixed** the `parser`.'), 'Done I fixed the parser.');
  assert.equal(ttsPlain('See [the docs](https://example.com/x) or https://example.com/y now'), 'See the docs or now');
  assert.equal(ttsPlain('Run this:\n```bash\nnpm test\n```\nthen check.'), 'Run this: (code) then check.');
  assert.equal(ttsPlain('- one\n- two'), 'one two');
  assert.equal(ttsPlain(''), '');
  assert.equal(ttsPlain('Set my_var when a > b, *really*.'), 'Set my_var when a > b, really.');
});

/** ATO-494: a reply is read by a voice of its own language. */
const { ttsLangOf, ttsPickVoice } = require('../renderer/tts.js');

test('the reply language: Cyrillic over Latin is Russian, everything else English', () => {
  assert.equal(ttsLangOf('Готово, я поправила парсер.'), 'ru');
  assert.equal(ttsLangOf('Готово: запусти npm test и проверь src/index.ts'), 'ru');
  assert.equal(ttsLangOf('Done, the parser is fixed.'), 'en');
  assert.equal(ttsLangOf('Use the `ru` locale'), 'en');
  assert.equal(ttsLangOf(''), 'en');
});

const voices = [
  { name: 'Samantha', lang: 'en-US', localService: true, default: true },
  { name: 'Daniel', lang: 'en_GB', localService: true },
  { name: 'Google русский', lang: 'ru-RU', localService: false },
  { name: 'Milena', lang: 'ru-RU', localService: true },
];

test('the picked voice wins only when it speaks the reply language', () => {
  assert.equal(ttsPickVoice(voices, 'en', 'Daniel').name, 'Daniel');
  assert.equal(ttsPickVoice(voices, 'ru', 'Daniel').name, 'Milena');
  assert.equal(ttsPickVoice(voices, 'ru', 'Google русский').name, 'Google русский');
});

test('without a pick: a local voice, the default first; none for a language with no voice', () => {
  assert.equal(ttsPickVoice(voices, 'en', '').name, 'Samantha');
  assert.equal(ttsPickVoice(voices, 'ru', '').name, 'Milena');
  assert.equal(ttsPickVoice([{ name: 'Google русский', lang: 'ru-RU', localService: false }], 'ru', '').name, 'Google русский');
  assert.equal(ttsPickVoice(voices.slice(0, 2), 'ru', ''), null);
  assert.equal(ttsPickVoice([], 'en', ''), null);
});
