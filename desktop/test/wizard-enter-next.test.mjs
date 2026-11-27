import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ATO-2010: Enter in the small provider window (composer chip, Settings › Models › Add provider)
// did nothing: the keydown handler's catch-all for an open popover or Settings swallowed it.

const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const handlerAt = src.indexOf("document.addEventListener('keydown', (e) => {\n  /* ATO-822");
const handler = src.slice(handlerAt, handlerAt + 80000);

test('Enter in #wiz-url or #wiz-key runs the same wiz:next as the Next button', () => {
  assert.ok(handlerAt !== -1, 'the main keydown handler is where it was');
  const line = handler.split('\n').find((l) => l.includes("e.target.id === 'wiz-url'") && l.includes("e.target.id === 'wiz-key'"));
  assert.ok(line, 'a branch for the two wizard fields');
  assert.match(line, /k === 'Enter'/);
  assert.match(line, /act\('wiz:next'\)/);
  assert.match(line, /!WIZ\.stepping/, 'a second Enter while the check runs starts nothing');
  assert.match(line, /WIZ\.phase === 'configure'/);
  assert.match(line, /!OB\.open/, 'first run keeps its own Enter (obCloudKey)');
  assert.match(line, /!mod/);
});

test('the branch sits before the catch-all that returns for a popover or Settings', () => {
  const branch = handler.indexOf("(e.target.id === 'wiz-url' || e.target.id === 'wiz-key')");
  const catchAll = handler.indexOf('if (S.overlay || S.settings || S.menuOpen !== null) {');
  assert.ok(branch !== -1 && catchAll !== -1);
  assert.ok(branch < catchAll);
  const settings = handler.indexOf('if (settingsKey(e, k, inText)) return;');
  assert.ok(branch < settings, 'and before Settings takes its keys');
});
