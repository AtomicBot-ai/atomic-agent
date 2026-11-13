// ATO-563: a unified diff as coloured lines (renderer/diff-lines.js): which
// text is a diff, each line's kind, the HTML escaping, one file's section of
// a multi-file patch, and whether a write's result says a copy was saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../renderer/diff-lines.js');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The shape src/tools/os/fs/fs-edit-diff.ts renderUnifiedDiff emits: absolute path, no @@ line.
const EDIT = [
  '--- a//w/site/index.html',
  '+++ b//w/site/index.html',
  ' <head>',
  '-<title>Old</title>',
  '+<title>New & <b>bold</b></title>',
  ' </head>',
].join('\n');

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  '-const a = 1;',
  '+const a = 2;',
  ' export {a};',
  'diff --git a/x.ts b/x.ts',
  '--- a/x.ts',
  '+++ b/x.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

test('an edit diff and a git hunk are diffs; plain content is not', () => {
  assert.equal(D.looksLikeUnifiedDiff(EDIT), true);
  assert.equal(D.looksLikeUnifiedDiff(PATCH), true);
  assert.equal(D.looksLikeUnifiedDiff('@@ -3,1 +3,1 @@\n-a\n+b'), true);
  assert.equal(D.looksLikeUnifiedDiff(EDIT.replace(/\n/g, '\r\n')), true);
  // An os.fs.write preview of a Markdown list, a shell command, headers with no change.
  assert.equal(D.looksLikeUnifiedDiff('# List\n- milk\n- eggs\n+ bread'), false);
  assert.equal(D.looksLikeUnifiedDiff('rm -rf ./build'), false);
  assert.equal(D.looksLikeUnifiedDiff('--- a/x\n+++ b/x\n same'), false);
  assert.equal(D.looksLikeUnifiedDiff(''), false);
  assert.equal(D.looksLikeUnifiedDiff(null), false);
});

test('each line gets its kind', () => {
  assert.deepEqual(D.parseDiffLines(EDIT).map((l) => l.kind), ['file', 'file', 'ctx', 'del', 'add', 'ctx']);
  assert.deepEqual(D.parseDiffLines(PATCH).slice(0, 8).map((l) => l.kind),
    ['file', 'file', 'file', 'file', 'hunk', 'del', 'add', 'ctx']);
  // The agent's own lines around the diff (a replace note, the truncation marker) are notes.
  const withNotes = '⚠ shrank the user\'s file `a.txt` (40 → 2 lines); the previous content is saved\n' + EDIT + '\n… [diff truncated]';
  const kinds = D.parseDiffLines(withNotes).map((l) => l.kind);
  assert.equal(kinds[0], 'note');
  assert.equal(kinds[kinds.length - 1], 'note');
  // A removed line that starts with "-- " is still a removal, not a header.
  assert.equal(D.diffLineKind('--- a comment', ' next'), 'del');
  assert.equal(D.diffLineKind('', undefined), 'ctx');
  // CR is dropped and a trailing newline adds no empty line.
  assert.deepEqual(D.parseDiffLines('-a\r\n+b\r\n').map((l) => l.text), ['-a', '+b']);
});

test('counts added and removed lines, headers excluded', () => {
  assert.deepEqual(D.diffCounts(EDIT), {add: 1, del: 1});
  assert.deepEqual(D.diffCounts(PATCH), {add: 2, del: 2});
});

test('the HTML escapes every line and marks its kind', () => {
  const html = D.diffLinesHTML(EDIT, esc);
  assert.ok(html.startsWith('<span class="difflines">'));
  assert.ok(html.includes('<span class="dl dl-add">+&lt;title&gt;New &amp; &lt;b&gt;bold&lt;/b&gt;&lt;/title&gt;</span>'));
  assert.ok(html.includes('<span class="dl dl-del">-&lt;title&gt;Old&lt;/title&gt;</span>'));
  assert.ok(!html.includes('<b>'), 'no markup from the diff text reaches the page');
  // An empty context line still takes its row.
  assert.ok(D.diffLinesHTML('@@ -1 +1 @@\n-a\n\n+b', esc).includes('<span class="dl dl-ctx"> </span>'));
});

test('one file\'s section of a multi-file patch, by the patch root', () => {
  const a = D.diffSectionFor(PATCH, '/w/src/a.ts', '/w');
  assert.ok(a.startsWith('diff --git a/src/a.ts'));
  assert.ok(a.includes('+const a = 2;'));
  assert.ok(!a.includes('+new'));
  const x = D.diffSectionFor(PATCH, '/w/x.ts', '/w/');
  assert.ok(x.startsWith('diff --git a/x.ts'));
  assert.ok(x.endsWith('+new'));
  // With the root, a same-named file elsewhere is not that section.
  assert.equal(D.diffSectionFor(PATCH, '/w/lib/x.ts', '/w'), null);
  // Without it, the path's tail decides.
  assert.ok(D.diffSectionFor(PATCH, '/w/src/a.ts').includes('+const a = 2;'));
  // A plain ---/+++ patch with no git lines.
  const plain = '--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-1\n+one\n--- a/two.txt\n+++ b/two.txt\n@@ -1 +1 @@\n-2\n+two';
  assert.equal(D.diffSectionFor(plain, '/r/two.txt', '/r'), '--- a/two.txt\n+++ b/two.txt\n@@ -1 +1 @@\n-2\n+two');
  // A removed file is found by its --- path.
  assert.ok(D.diffSectionFor('--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye', '/r/gone.txt', '/r'));
  assert.equal(D.diffSectionFor(PATCH, '/w/none.ts', '/w'), null);
  assert.equal(D.diffSectionFor(PATCH, '', '/w'), null);
});
