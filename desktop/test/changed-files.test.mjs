// ATO-1187: "Changed files (N)" with +/- under a reply, and the side panel's Results tab (renderer/changed-files.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const C = require('../renderer/changed-files.js');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const deps = {esc, ic: (n) => '<svg data-ic="' + n + '"></svg>'};

test('a frame diffstat is read only when its shape is whole; an older agent sends none', () => {
  assert.deepEqual(C.changedFileOfFrame({diffstat: {path: '/w/a.ts', added: 3, removed: 1}}), {path: '/w/a.ts', added: 3, removed: 1});
  assert.equal(C.changedFileOfFrame({}), null);
  assert.equal(C.changedFileOfFrame(null), null);
  assert.equal(C.changedFileOfFrame({diffstat: {path: '', added: 1, removed: 0}}), null);
  assert.equal(C.changedFileOfFrame({diffstat: {path: '/a', added: -1, removed: 0}}), null);
  assert.equal(C.changedFileOfFrame({diffstat: {path: '/a', added: 1.5, removed: 0}}), null);
  assert.equal(C.changedFileOfFrame({diffstat: {path: '/a', added: '1', removed: 0}}), null);
});

test('changes to one file add up on one row, files keep the order they were first touched', () => {
  let list = C.changedFilesAdd(undefined, {path: '/w/a.ts', added: 3, removed: 1});
  list = C.changedFilesAdd(list, {path: '/w/b.md', added: 10, removed: 0});
  const before = list;
  list = C.changedFilesAdd(list, {path: '/w/a.ts', added: 2, removed: 2});
  assert.deepEqual(list, [
    {path: '/w/a.ts', added: 5, removed: 3, edits: 2},
    {path: '/w/b.md', added: 10, removed: 0, edits: 1},
  ]);
  // Not changed in place: the previous list is what it was.
  assert.deepEqual(before[0], {path: '/w/a.ts', added: 3, removed: 1, edits: 1});
  assert.deepEqual(C.changedFilesAdd(list, null), list);
});

test('the list stops growing at its cap', () => {
  let list = [];
  for (let i = 0; i < C.CHANGED_FILES_MAX + 5; i++) list = C.changedFilesAdd(list, {path: '/w/f' + i, added: 1, removed: 0});
  assert.equal(list.length, C.CHANGED_FILES_MAX);
});

test('the card says how many files and draws +/- per file, and nothing when there are none', () => {
  assert.equal(C.changedFilesCardHTML(undefined, deps), '');
  assert.equal(C.changedFilesCardHTML([], deps), '');
  const html = C.changedFilesCardHTML([
    {path: '/w/src/a.ts', added: 12, removed: 3, edits: 2},
    {path: '/w/new.md', added: 4, removed: 0, edits: 1},
    {path: '/w/same.txt', added: 0, removed: 0, edits: 1},
  ], deps);
  assert.match(html, /Changed files \(3\)/);
  assert.match(html, /data-file="\/w\/src\/a\.ts"/);
  assert.match(html, /class="cf-name">a\.ts</);
  assert.match(html, /<span class="cf-add">\+12<\/span> <span class="cf-del">−3<\/span>/);
  // A side that is zero is left out.
  assert.match(html, /<span class="cf-add">\+4<\/span><\/span>/);
  assert.match(html, /no line changes/);
  // Rows are file chips, so the window's own click and context menu open them.
  assert.equal((html.match(/class="filechip cf-row"/g) || []).length, 3);
});

test('paths are escaped', () => {
  const html = C.changedFilesCardHTML([{path: '/w/<x>"y.ts', added: 1, removed: 0, edits: 1}], deps);
  assert.ok(!html.includes('<x>'));
  assert.match(html, /&lt;x&gt;&quot;y\.ts/);
});

test('Results lists the latest turn: changed files first, then delivered and saved ones, once each', () => {
  const log = [
    {k: 'assistant', id: 'old', changed: [{path: '/w/old.ts', added: 1, removed: 0, edits: 1}]},
    {k: 'user', text: 'again'},
    {k: 'assistant', id: 'new',
      changed: [{path: '/w/a.ts', added: 2, removed: 1, edits: 1}],
      replyFiles: ['/w/report.pdf', '/w/a.ts'],
      attach: [{path: '/w/out.csv', kind: 'file'}, {path: '/w/dir', kind: 'dir'}, {path: '/w/report.pdf', kind: 'file'}]},
  ];
  assert.equal(C.latestReply(log).id, 'new');
  assert.deepEqual(C.turnResultFiles(C.latestReply(log)).map((f) => f.path), ['/w/a.ts', '/w/report.pdf', '/w/out.csv']);
  const html = C.resultsPaneHTML(log, deps);
  assert.match(html, /Changed files \(1\) · 2 more/);
  assert.ok(!html.includes('/w/old.ts'));
  assert.ok(!html.includes('/w/dir'));
  // A file without counts has no counts cell.
  assert.equal((html.match(/class="cf-counts/g) || []).length, 1);
});

test('Results without counts (older agent) and with nothing at all', () => {
  assert.match(C.resultsPaneHTML([{k: 'assistant', replyFiles: ['/w/a.png']}], deps), /<div class="insp-lbl">Files<\/div>/);
  assert.match(C.resultsPaneHTML([], deps), /appear here/);
  assert.match(C.resultsPaneHTML([{k: 'assistant', text: 'hi'}], deps), /appear here/);
  assert.equal(C.latestReply(null), null);
});

test('the page loads changed-files.js before renderer.js, and the renderer draws with it', () => {
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = html.indexOf('src="changed-files.js"');
  assert.ok(at > 0 && at < html.indexOf('src="renderer.js"'));
  const r = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(r, /replyFilesStrip\(m\) \+ changedFilesCardHTML\(m\.changed, \{esc, ic\}\) \+ attachStrip\(m\)/);
  assert.match(r, /item\.changed = changedFilesAdd\(item\.changed, changedFile\)/);
  assert.match(r, /\['results','Results'\]/);
  assert.match(r, /body = resultsPaneHTML\(S\.log, \{esc, ic\}\)/);
  assert.match(r, /concat\(changedFilesPaths\(m\.changed\)\)/);
});
