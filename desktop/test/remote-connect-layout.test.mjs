import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* ATO-1240: "Connect to another computer" scrolls its body; the buttons stay reachable. */
const html = readFileSync(new URL('../renderer/remote-connect.html', import.meta.url), 'utf8');

test('the buttons are outside the scrolling body, so an error line cannot push them off', () => {
  const body = html.indexOf('<div class="body">');
  const acts = html.indexOf('<div class="acts">');
  const msg = html.indexOf('id="msg"');
  assert.ok(body > 0 && msg > body && acts > msg, 'body holds the form and the message; the buttons come after it');
  assert.match(html, /\.body\{[^}]*overflow-y:auto/);
  assert.match(html, /\.acts\{[^}]*flex:none/);
  for (const id of ['local', 'cancel', 'connect']) assert.ok(html.indexOf(`id="${id}"`) > acts);
});

test('the window is not a fixed 380 px and can be resized', () => {
  const main = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8');
  const i = main.indexOf('function openRemoteConnect');
  const block = main.slice(i, i + 1400);
  assert.doesNotMatch(block, /height: 380/);
  assert.match(block, /resizable: true/);
  assert.match(block, /workArea\.height/);
});
