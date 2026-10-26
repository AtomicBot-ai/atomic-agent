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
});
