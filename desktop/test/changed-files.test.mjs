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

test('a fusion.delegate frame lists every worker file; a broken row is skipped, the rest stay (ATO-1702)', () => {
  const frame = {tool: 'fusion.delegate', diffstats: [
    {path: '/w/a.ts', added: 5, removed: 3},
    {path: '', added: 1, removed: 0},
    {path: '/w/bad', added: -1, removed: 0},
    null,
    'x',
    {path: '/w/b.md', added: 10, removed: 0},
  ]};
  assert.deepEqual(C.changedFilesOfFrame(frame), [
    {path: '/w/a.ts', added: 5, removed: 3},
    {path: '/w/b.md', added: 10, removed: 0},
  ]);
  // A write/edit still gives its one file; a frame with neither gives none.
  assert.deepEqual(C.changedFilesOfFrame({diffstat: {path: '/w/c.ts', added: 1, removed: 0}}), [{path: '/w/c.ts', added: 1, removed: 0}]);
  assert.deepEqual(C.changedFilesOfFrame({}), []);
  assert.deepEqual(C.changedFilesOfFrame(null), []);
  assert.deepEqual(C.changedFilesOfFrame({diffstats: 'nope'}), []);
  // Into the card: two files, two rows; a file the chat already changed adds up.
  let list = C.changedFilesAdd([], {path: '/w/a.ts', added: 1, removed: 0});
  for (const f of C.changedFilesOfFrame(frame)) list = C.changedFilesAdd(list, f);
  assert.deepEqual(list, [
    {path: '/w/a.ts', added: 6, removed: 3, edits: 2},
    {path: '/w/b.md', added: 10, removed: 0, edits: 1},
  ]);
  assert.match(C.changedFilesCardHTML(list, deps), /Changed files \(2\)/);
  assert.match(C.resultsPaneHTML([{k: 'assistant', changed: list}], deps), /Changed files \(2\)/);
});

test('the renderer puts every change of a frame on the card, not only its single diffstat (ATO-1702)', () => {
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(src, /for \(const changedFile of changedFilesOfFrame\(p\)\) item\.changed = changedFilesAdd\(item\.changed, changedFile\)/);
});

// ATO-2409: a Word, Excel or PowerPoint file the turn made is on the card, with a badge instead of counts.
test('an Office writer\'s call is a "created" or "updated" row; the badge survives a later edit of the file', () => {
  const made = C.changedFileOfOfficeWrite({path: 'sales.docx', created: true}, '/w/Atomic Agent Marketer Kit/sales.docx');
  assert.deepEqual(made, {path: '/w/Atomic Agent Marketer Kit/sales.docx', added: 0, removed: 0, office: 'created'});
  const changed = C.changedFileOfOfficeWrite({path: '/w/sales.xlsx', created: false}, '');
  assert.deepEqual(changed, {path: '/w/sales.xlsx', added: 0, removed: 0, office: 'updated'}, 'the call\'s own path when none was made absolute');
  assert.equal(C.changedFileOfOfficeWrite({created: true}, ''), null);
  assert.equal(C.changedFileOfOfficeWrite(null, ''), null);
  let list = C.changedFilesAdd([], made);
  list = C.changedFilesAdd(list, changed);
  list = C.changedFilesAdd(list, C.changedFileOfOfficeWrite({path: 'sales.docx', created: false}, made.path));
  list = C.changedFilesAdd(list, {path: '/w/notes.md', added: 2, removed: 0});
  assert.deepEqual(list, [
    {path: made.path, added: 0, removed: 0, edits: 2, office: 'created'},
    {path: '/w/sales.xlsx', added: 0, removed: 0, edits: 1, office: 'updated'},
    {path: '/w/notes.md', added: 2, removed: 0, edits: 1},
  ]);
  const html = C.changedFilesCardHTML(list, deps);
  assert.match(html, /Changed files \(3\)/);
  assert.match(html, /data-file="\/w\/Atomic Agent Marketer Kit\/sales\.docx"[^>]*>.*?<span class="cf-name">sales\.docx<\/span><span class="cf-counts mono"><span class="cf-tag cf-created">created<\/span>/);
  assert.match(html, /<span class="cf-name">sales\.xlsx<\/span><span class="cf-counts mono"><span class="cf-tag cf-updated">updated<\/span>/);
  assert.match(html, /<span class="cf-name">notes\.md<\/span><span class="cf-counts mono"><span class="cf-add">\+2<\/span>/);
  assert.ok(!html.includes('no line changes'), 'an Office file never says "no line changes"');
  // The Results tab counts them as changed files too.
  assert.match(C.resultsPaneHTML([{k: 'assistant', changed: list}], deps), /Changed files \(3\)/);
});

test('the renderer puts an ok Office call on the card and under "Saved to", and chips a bare name the chat wrote (ATO-2409)', () => {
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  // tool_result: the row is made from the call's path, only for an ok call.
  assert.match(src, /const officeWrite = item && card\.ok === true && typeof cfOfficeWrite === 'function' \? cfOfficeWrite\(card\.name, toolArgsObj\(card\.args\)\) : null;/);
  assert.match(src, /if \(officeWrite\) item\.changed = changedFilesAdd\(item\.changed, changedFileOfOfficeWrite\(officeWrite, cfAbsolute\(officeWrite\.path, workingDir\(\), homeDir\(\)\)\)\);/);
  // "Saved to": the strip's path collector knows the Office writers.
  const written = src.slice(src.indexOf('\nfunction cardWrittenPaths('), src.indexOf('\nfunction cardTrashedPaths('));
  assert.match(written, /cfOfficeWrite\(m\.name, cardArgs\(m\) \|\| \{\}\)/);
  assert.match(written, /if \(office\) return \[resolveAgentPath\(office\.path, cwd\)\];/);
  // A code span with a bare name the chat wrote is that file's chip.
  const prose = src.slice(src.indexOf('\nfunction renderProseFresh('), src.indexOf('\nfunction codeBlockFrame('));
  assert.match(prose, /chatFilesByName\(raw\)/);
  assert.match(prose, /known \? chip\(known, h\)/);
  // The page loads chat-files.js (the writers' list) before renderer.js.
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('src="chat-files.js"') > 0 && html.indexOf('src="chat-files.js"') < html.indexOf('src="renderer.js"'));
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

// ATO-2753: two files of the same name from different folders look the same without their folder.
test('same-named files show the folder that tells them apart; a unique name shows none', () => {
  const dirs = C.changedFilesDirs(['/w/app/src/index.ts', '/w/app/test/index.ts', '/w/app/README.md']);
  assert.equal(dirs.get('/w/app/src/index.ts'), 'src');
  assert.equal(dirs.get('/w/app/test/index.ts'), 'test');
  assert.equal(dirs.has('/w/app/README.md'), false);
  // The same parent folder name: more of the path, until it differs.
  const deep = C.changedFilesDirs(['/w/a/src/index.ts', '/w/b/src/index.ts']);
  assert.equal(deep.get('/w/a/src/index.ts'), 'a/src');
  assert.equal(deep.get('/w/b/src/index.ts'), 'b/src');
  // A Windows path keeps its own separator.
  const win = C.changedFilesDirs(['C:\\w\\a\\src\\x.ts', 'C:\\w\\b\\src\\x.ts']);
  assert.equal(win.get('C:\\w\\a\\src\\x.ts'), 'a\\src');
  assert.equal(C.changedFilesDirs([]).size, 0);
  assert.equal(C.changedFilesDirs(undefined).size, 0);
});

test('the card and the Results tab draw the folder, dimmed, after a same-named file', () => {
  const list = [
    {path: '/w/app/src/index.ts', added: 2, removed: 0, edits: 1},
    {path: '/w/app/test/index.ts', added: 1, removed: 1, edits: 1},
    {path: '/w/app/notes.md', added: 1, removed: 0, edits: 1},
  ];
  const html = C.changedFilesCardHTML(list, deps);
  assert.match(html, /<span class="cf-name">index\.ts<\/span><span class="cf-dir">src<\/span>/);
  assert.match(html, /<span class="cf-name">index\.ts<\/span><span class="cf-dir">test<\/span>/);
  assert.match(html, /<span class="cf-name">notes\.md<\/span><span class="cf-counts/);
  const pane = C.resultsPaneHTML([{k: 'assistant', changed: list}], deps);
  assert.match(pane, /<span class="cf-dir">test<\/span>/);
  const css = readFileSync(new URL('../renderer/css/chat.css', import.meta.url), 'utf8');
  assert.match(css, /\.cf-row \.cf-dir\{[^}]*color:var\(--ink-3\)/);
});
