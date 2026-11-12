// ATO-563: the Changes / Revert row under a reply's "Saved to" lines
// (renderer/diff-review.js), run in a vm with the renderer globals it reads
// stubbed: which file gets which diff, when Revert is offered, the two-step
// confirmation, and the refusal when a later turn wrote the file again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function load() {
  const calls = [], toasts = [];
  const c = {
    S: {log: [], live: {workingDir: '/w'}, agentSession: 'sess-1'},
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    ic: (n) => '<svg data-ic="' + n + '"></svg>',
    pathBase: (p) => String(p).split('/').pop(),
    homeDir: () => '/Users/me',
    // The renderer's own: only ok cards of the write tools name a path.
    cardWrittenPaths: (m) => (m.k === 'tool' && m.ok === true && m.writes) ? m.writes : [],
    cardArgs: (m) => m.args || null,
    resolveAgentPath: (p, cwd) => (p ? (p.startsWith('/') ? p : cwd + '/' + p) : null),
    render: () => {},
    repaintTranscript: () => true,
    toast: (t, s, kind) => toasts.push({t, s, kind}),
    BR: {fsRestore: async (sid, path) => { calls.push({sid, path}); return {ok: true, supported: true}; }},
    Date,
  };
  vm.createContext(c);
  for (const f of ['diff-lines.js', 'diff-review.js']) {
    vm.runInContext(readFileSync(new URL('../renderer/' + f, import.meta.url), 'utf8'), c);
  }
  // A top-level const of a script is not a property of the context.
  c.DIFF_REVIEW = vm.runInContext('DIFF_REVIEW', c);
  return {c, calls, toasts};
}

const EDIT_OUT = '--- a//w/a.txt\n+++ b//w/a.txt\n-one\n+two';
const fakeEl = (attrs, parent) => ({dataset: attrs, parentElement: parent || null, closest() { return this; }});

test('each file gets the diffs of the cards that wrote it, and Revert only where a copy was saved', () => {
  const {c} = load();
  const user = {id: 'u', k: 'user'};
  const edit = {id: 't1', k: 'tool', ok: true, name: 'os.fs.edit', writes: ['/w/a.txt'], out: EDIT_OUT};
  const write = {id: 't2', k: 'tool', ok: true, name: 'os.fs.write', writes: ['/w/b.txt'],
    out: "wrote 4 bytes to /w/b.txt (replace)\nreplaced the user's file `b.txt` (9 → 1 lines); previous content saved"};
  const patch = {id: 't3', k: 'tool', ok: true, name: 'os.fs.patch', writes: ['/w/c.txt'],
    args: {apply: true, patch: '--- a/c.txt\n+++ b/c.txt\n@@ -1 +1 @@\n-x\n+y'}, out: 'patch applied: 1 file\n  ✓ c.txt  +1/-1'};
  const m = {id: 'a1', k: 'assistant', attach: [
    {path: '/w/a.txt', name: 'a.txt'}, {path: '/w/b.txt', name: 'b.txt'}, {path: '/w/c.txt', name: 'c.txt'}]};
  c.S.log.push(user, edit, write, patch, m);
  c.diffReviewAnnotate(m, '/w');
  const [a, b, cc] = m.attach;
  assert.equal(a.diffs.length, 1);
  assert.equal(a.restorable, false, 'an ordinary edit saves no copy');
  assert.equal(b.diffs.length, 0, 'a whole-file write has no diff');
  assert.equal(b.restorable, true);
  assert.equal(cc.diffs.length, 1);
  assert.ok(cc.diffs[0].includes('+y'));

  const rowA = c.diffReviewRowHTML(m, a);
  assert.ok(rowA.includes('Changes'));
  assert.ok(rowA.includes('dl-add'));
  assert.ok(!rowA.includes('data-diffrev="revert"'));
  const rowB = c.diffReviewRowHTML(m, b);
  assert.ok(rowB.includes('data-diffrev="revert"'));
  assert.ok(!rowB.includes('Changes'));
  assert.equal(c.diffReviewRowHTML(m, {path: '/w/d.txt', diffs: [], restorable: false}), '');
});

test('Revert asks first, and only the confirmation calls the agent', async () => {
  const {c, calls, toasts} = load();
  const write = {id: 't1', k: 'tool', ok: true, name: 'os.fs.write', writes: ['/w/b.txt'], out: 'previous content saved'};
  const m = {id: 'a1', k: 'assistant', attach: [{path: '/w/b.txt', name: 'b.txt'}]};
  c.S.log.push({id: 'u', k: 'user'}, write, m);
  c.diffReviewAnnotate(m, '/w');
  const ids = {item: 'a1', path: '/w/b.txt'};
  assert.equal(c.diffReviewClick(fakeEl({diffrev: 'revert', ...ids})), true);
  assert.ok(c.diffReviewRowHTML(m, m.attach[0]).includes('data-diffrev="confirm"'));
  // Too soon after arming: a double-click does not revert.
  c.diffReviewClick(fakeEl({diffrev: 'confirm', ...ids}));
  assert.equal(calls.length, 0);
  c.DIFF_REVIEW.armed.at -= 1000;
  c.diffReviewClick(fakeEl({diffrev: 'confirm', ...ids}));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, [{sid: 'sess-1', path: '/w/b.txt'}]);
  assert.equal(toasts[0].t, 'Reverted b.txt');
  assert.ok(c.diffReviewRowHTML(m, m.attach[0]).includes('Reverted'));
});

test('Cancel disarms, and a file written again later is not reverted from the older reply', async () => {
  const {c, calls, toasts} = load();
  const w1 = {id: 't1', k: 'tool', ok: true, name: 'os.fs.write', writes: ['/w/b.txt'], out: 'previous content saved'};
  const m = {id: 'a1', k: 'assistant', attach: [{path: '/w/b.txt', name: 'b.txt'}]};
  const w2 = {id: 't2', k: 'tool', ok: true, name: 'os.fs.write', writes: ['/w/b.txt'], out: 'previous content saved'};
  c.S.log.push({id: 'u1', k: 'user'}, w1, m, {id: 'u2', k: 'user'}, w2, {id: 'a2', k: 'assistant'});
  c.diffReviewAnnotate(m, '/w');
  const ids = {item: 'a1', path: '/w/b.txt'};
  c.diffReviewClick(fakeEl({diffrev: 'revert', ...ids}));
  c.diffReviewClick(fakeEl({diffrev: 'cancel', ...ids}));
  assert.equal(c.DIFF_REVIEW.armed, null);
  c.diffReviewClick(fakeEl({diffrev: 'revert', ...ids}));
  c.DIFF_REVIEW.armed.at -= 1000;
  c.diffReviewClick(fakeEl({diffrev: 'confirm', ...ids}));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 0);
  assert.equal(toasts[0].t, 'Not reverted');
  assert.match(toasts[0].s, /again later/);
});

test('Changes keeps its open state across repaints', () => {
  const {c} = load();
  const ids = {item: 'a1', path: '/w/a.txt'};
  c.diffReviewClick(fakeEl({diffrev: 'toggle', ...ids}, {open: false}));
  assert.ok(c.DIFF_REVIEW.open.has(c.diffReviewKey('a1', '/w/a.txt')));
  c.diffReviewClick(fakeEl({diffrev: 'toggle', ...ids}, {open: true}));
  assert.equal(c.DIFF_REVIEW.open.size, 0);
  assert.equal(c.diffReviewClick({closest: () => null}), false);
});
