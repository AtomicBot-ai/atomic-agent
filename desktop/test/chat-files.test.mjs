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

// ATO-1258: a screenshot the agent took is shown.
test('«сделай скриншот на маке»: a picture the reply names is shown under it', () => {
  const log = [{id: 'u', k: 'user', text: 'сделай скриншот'},
    {id: 't', k: 'tool', name: 'os.shell.run', ok: true, out: '$ screencapture /tmp/mac-screen.png\nexit: 0'},
    {id: 'r', k: 'assistant', text: 'Done. (attached: /tmp/mac-screen.png)'}];
  assert.deepEqual(CF.turnPictures(log).get('r'), ['/tmp/mac-screen.png']);
  assert.deepEqual(CF.chatFilesOf(log, {}).map((f) => f.path), ['/tmp/mac-screen.png']);
});

test('the turn\'s last screenshot goes under a reply with no picture of its own, once', () => {
  const shot = (id, p) => ({id, k: 'tool', name: 'os.screen.capture', ok: true, out: 'saved ' + p + ' (10x10 px) of the screen'});
  const log = [{id: 'u', k: 'user', text: 'x'}, shot('a', '/T/s1.jpg'), shot('b', '/T/s2.jpg'),
    {id: 'r', k: 'assistant', text: 'Here it is.'},
    {id: 'u2', k: 'user', text: 'again'}, {id: 'c', k: 'tool', name: 'browser.screenshot', ok: true, out: 'saved /T/b.jpg (1x1 px JPEG, 1 KB) of the page'},
    {id: 'r2', k: 'assistant', text: 'Attached.', replyFiles: ['/T/b.jpg']},
    {id: 'u3', k: 'user', text: 'and'}, {id: 'r3', k: 'assistant', text: 'Nothing new.'},
    {id: 'u4', k: 'user', text: 'fail'}, {id: 'd', k: 'tool', name: 'os.screen.capture', ok: false, out: 'saved /T/x.jpg (1x1 px)'},
    {id: 'r4', k: 'assistant', text: 'Could not.'}];
  const pics = CF.turnPictures(log);
  assert.deepEqual(pics.get('r'), ['/T/s2.jpg']);
  assert.equal(pics.has('r2'), false, 'a reply that delivers the screenshot shows it once');
  assert.equal(pics.has('r3'), false, 'a later turn does not repeat an earlier screenshot');
  assert.equal(pics.has('r4'), false, 'a failed capture shows nothing');
  assert.deepEqual(CF.cfTextPictures('see ~/a.png, /b/c.JPG and /d.txt and ~/a.png'), ['~/a.png', '/b/c.JPG']);
});

// ATO-2409: the Word, Excel and PowerPoint files the agent makes are the chat's files too.
test('Office files the agent made are listed as written by it; a workbook read and a failed write are not', () => {
  const log = [
    {k: 'user', text: 'make sales.docx, sales.xlsx and sales.pptx'},
    {k: 'tool', name: 'os.fs.docx', ok: true, args: JSON.stringify({path: 'Atomic Agent Marketer Kit/sales.docx', op: 'create', blocks: ['# Sales']}), out: 'created'},
    {k: 'tool', name: 'os.fs.xlsx', ok: true, args: JSON.stringify({path: 'Atomic Agent Marketer Kit/sales.xlsx', op: 'write', rows: [['a']]}), out: 'wrote'},
    {k: 'tool', name: 'os.fs.xlsx', ok: true, args: JSON.stringify({path: 'Atomic Agent Marketer Kit/prices.xlsx', op: 'read'}), out: 'A1: 1'},
    {k: 'tool', name: 'os.fs.write_pptx', ok: true, args: JSON.stringify({path: '~/Decks/sales.pptx', slides: [{title: 'Q1'}]}), out: 'created'},
    {k: 'tool', name: 'os.fs.docx', ok: false, args: JSON.stringify({path: 'failed.docx', op: 'create'}), out: 'error'},
    {k: 'tool', name: 'os.fs.write_pptx', ok: false, outcome: 'denied', args: JSON.stringify({path: 'denied.pptx', slides: []})},
    {k: 'assistant', text: 'Done: `sales.docx`, `sales.xlsx`, `sales.pptx`.'},
  ];
  const files = CF.chatFilesOf(log, {workingDir: '/Users/n/Documents', home: '/Users/n', argsOf});
  assert.deepEqual(files.map((f) => [f.path, f.from, f.kind]), [
    ['/Users/n/Decks/sales.pptx', 'agent', 'file'],
    ['/Users/n/Documents/Atomic Agent Marketer Kit/sales.xlsx', 'agent', 'file'],
    ['/Users/n/Documents/Atomic Agent Marketer Kit/sales.docx', 'agent', 'file'],
  ]);
  assert.ok(files.every((f) => !/prices|failed|denied/.test(f.path)), 'a read, a failed and a denied call list nothing');
  // The writers themselves, and what each call wrote.
  assert.deepEqual([...CF.CF_OFFICE].sort(), ['os.fs.docx', 'os.fs.write_pptx', 'os.fs.xlsx']);
  assert.deepEqual(CF.cfOfficeWrite('os.fs.docx', {path: 'a.docx', op: 'create'}), {path: 'a.docx', created: true});
  assert.deepEqual(CF.cfOfficeWrite('os.fs.docx', {path: 'a.docx', op: 'append'}), {path: 'a.docx', created: false});
  assert.deepEqual(CF.cfOfficeWrite('os.fs.xlsx', {path: ' b.xlsx ', op: 'chart'}), {path: 'b.xlsx', created: false});
  assert.deepEqual(CF.cfOfficeWrite('os.fs.write_pptx', {path: 'c.pptx', slides: []}), {path: 'c.pptx', created: true});
  assert.equal(CF.cfOfficeWrite('os.fs.xlsx', {path: 'b.xlsx', op: 'read'}), null);
  assert.equal(CF.cfOfficeWrite('os.fs.docx', {op: 'create'}), null);
  assert.equal(CF.cfOfficeWrite('os.fs.docx', 'not an object'), null);
  assert.equal(CF.cfOfficeWrite('os.fs.write', {path: 'a.txt'}), null);
});

// ATO-2409: a reply that says `sales.docx` and nothing more about where it is.
test('a bare file name in a reply is the chat\'s file of that name, the newest one; a path or an unknown name is not', () => {
  const files = [
    {path: '/w/new/sales.docx', name: 'sales.docx', kind: 'file', from: 'agent'},
    {path: '/w/old/sales.docx', name: 'sales.docx', kind: 'file', from: 'agent'},
    {path: '/w/sales.xlsx', name: 'sales.xlsx', kind: 'file', from: 'reply'},
  ];
  assert.equal(CF.chatFilesByName('sales.docx', files), '/w/new/sales.docx');
  assert.equal(CF.chatFilesByName(' sales.xlsx ', files), '/w/sales.xlsx');
  assert.equal(CF.chatFilesByName('sales.pptx', files), '', 'a name the chat has no file for');
  assert.equal(CF.chatFilesByName('Sales.docx', files), '', 'the name as written, case and all');
  assert.equal(CF.chatFilesByName('/w/new/sales.docx', files), '', 'a path is the path pass\'s business');
  assert.equal(CF.chatFilesByName('new/sales.docx', files), '');
  assert.equal(CF.chatFilesByName('sales', files), '', 'no extension, no chip');
  assert.equal(CF.chatFilesByName('.docx', files), '');
  assert.equal(CF.chatFilesByName('', files), '');
  assert.equal(CF.chatFilesByName(null, files), '');
  assert.equal(CF.chatFilesByName('sales.docx', []), '', 'nothing written yet');
  assert.equal(CF.chatFilesByName('sales.docx'), '', 'the renderer\'s list starts empty');
});

test('image.generate paths written with ~ are listed expanded, as main stats them', () => {
  const log = [{k: 'tool', name: 'image.generate', ok: true, out: 'Saved 1 picture:\n- ~/Pictures/a.png'}];
  assert.deepEqual(CF.chatFilesOf(log, {home: '/Users/n'}).map((f) => f.path), ['/Users/n/Pictures/a.png']);
  assert.deepEqual(CF.chatFilesOf(log, {home: '/Users/n', missing: new Set(['/Users/n/Pictures/a.png'])}), []);
});
