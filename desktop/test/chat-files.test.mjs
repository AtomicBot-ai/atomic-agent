// ATO-1256: the files of a chat, listed in the preview panel (renderer/chat-files.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CF = require('../renderer/chat-files.js');
const FPV = require('../renderer/file-preview.js');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const icon = (n) => '<i data-ic="' + n + '"></i>';
const argsOf = (m) => (m.args && typeof m.args === 'object' ? m.args : JSON.parse(m.args || '{}'));
const split = (text) => {
  const at = String(text).indexOf('\n\n[attachments]\n');
  if (at < 0) return null;
  return {caption: '', items: String(text).slice(at + 16).split('\n').map((p) => ({path: p}))};
};

test('every source of a chat, newest first, once each', () => {
  const verdicts = new Map([['~/notes/plan.md', {ok: true, abs: '/Users/n/notes/plan.md', kind: 'file'}],
    ['/etc/hosts', {ok: false, abs: null}], ['~/Documents', {ok: true, abs: '/Users/n/Documents', kind: 'dir'}]]);
  const log = [
    {k: 'user', text: 'look\n\n[attachments]\n/Users/n/.atomic-agent/inbox/120000-photo.jpg'},
    {k: 'tool', name: 'os.fs.write', ok: true, args: JSON.stringify({path: 'out/report.csv'}), out: 'wrote'},
    {k: 'tool', name: 'os.fs.write', ok: false, args: JSON.stringify({path: 'failed.txt'}), out: 'error'},
    {k: 'tool', name: 'os.fs.write', ok: false, outcome: 'denied', args: JSON.stringify({path: 'denied.txt'})},
    {k: 'tool', name: 'image.generate', ok: true, out: 'Saved 2 pictures made with x on OpenRouter:\n- /w/img-1.png\n- /w/img-2.webp\nTo show them…'},
    {k: 'tool', name: 'os.screen.capture', ok: true, out: 'saved /var/folders/T/atomic-agent-screens/s/screen-1.jpg (1280x800 px) of the screen'},
    {k: 'tool', name: 'browser.screenshot', ok: true, out: 'saved /tmp/browser-1.jpg (800x600 px JPEG, 80 KB) of the page on https://x.'},
    {k: 'assistant', text: 'See ~/notes/plan.md and /etc/hosts and ~/Documents', replyFiles: ['/w/img-1.png'],
      attach: [{path: '/w/out/report.csv', kind: 'file'}, {path: '/w/dir', kind: 'dir'}]},
    {k: 'assistant', text: '(no reply)', placeholder: true, replyFiles: ['/never.png']},
  ];
  const files = CF.chatFilesOf(log, {workingDir: '/w', home: '/Users/n', argsOf, split, replyPath: (r) => verdicts.get(r) || null});
  assert.deepEqual(files.map((f) => [f.path, f.from, f.kind]), [
    ['/w/img-1.png', 'reply', 'image'],
    ['/w/out/report.csv', 'agent', 'file'],
    ['/Users/n/notes/plan.md', 'reply', 'file'],
    ['/tmp/browser-1.jpg', 'shot', 'image'],
    ['/var/folders/T/atomic-agent-screens/s/screen-1.jpg', 'shot', 'image'],
    ['/w/img-2.webp', 'image', 'image'],
    ['/Users/n/.atomic-agent/inbox/120000-photo.jpg', 'you', 'image'],
  ]);
});

test('a path main said is gone leaves the list; an empty chat has none', () => {
  const log = [{k: 'assistant', text: 'x', replyFiles: ['/a.txt', '/b.txt']}];
  assert.deepEqual(CF.chatFilesOf(log, {missing: new Set(['/a.txt'])}).map((f) => f.path), ['/b.txt']);
  assert.deepEqual(CF.chatFilesOf([], {}), []);
  assert.deepEqual(CF.chatFilesOf(null, {}), []);
});

test('tool paths: relative to the working folder, ~ to home, never a URL', () => {
  assert.equal(CF.cfAbsolute('a/b.txt', '/w/', '/h'), '/w/a/b.txt');
  assert.equal(CF.cfAbsolute('./c.txt', '/w', '/h'), '/w/c.txt');
  assert.equal(CF.cfAbsolute('~/d.txt', '/w', '/h'), '/h/d.txt');
  assert.equal(CF.cfAbsolute('/abs.txt', '/w', '/h'), '/abs.txt');
  assert.equal(CF.cfAbsolute('https://x/y.txt', '/w', '/h'), '');
  assert.equal(CF.cfAbsolute('rel.txt', '', '/h'), '');
  assert.equal(CF.cfShotPath('saved /tmp/a b/screen.jpg (10x10 px) of x'), '/tmp/a b/screen.jpg');
  assert.equal(CF.cfShotPath('screenshot failed: denied'), '');
});

test('names and paths are escaped in the tabs and the list', () => {
  const evil = '/tmp/<img src=x onerror=alert(1)>".png';
  const files = CF.chatFilesOf([{k: 'assistant', text: '', replyFiles: [evil]}], {});
  const tabs = CF.chatFilesTabsHTML(files, evil, {esc, icon});
  const list = CF.chatFilesListHTML(files, {esc, icon, home: '/Users/n'});
  for (const html of [tabs, list]) {
    assert.ok(!html.includes('<img'), 'no tag from a file name');
    assert.ok(!/data-fp-path="[^"]*"[^ >]/.test(html.replace(/data-fp-path="[^"]*" title/g, '')), 'attributes stay closed');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;.png'));
  }
  assert.match(tabs, /class="fp-tab on"/, 'the file on screen is the selected tab');
  assert.equal(CF.chatFilesTabsHTML([], '', {esc, icon}), '', 'no tabs for a chat with no files');
  assert.match(CF.chatFilesListHTML([], {esc, icon}), /No files in this chat yet/);
});

test('the panel starts closed and on no file', () => {
  assert.equal(FPV.FP.open, false);
  assert.equal(FPV.FP.path, '');
  assert.deepEqual(FPV.FP.files, []);
});
