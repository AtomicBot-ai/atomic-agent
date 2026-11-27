// ATO-2745: Save report for support (renderer/support-report.js) is one function for Settings ›
// Diagnostics, Help › Save report for support and Help › Report an Issue: one report at a time, a
// "Saving the report…" line while it is written, and the file shown in its folder, not opened in an
// editor. Every bridge here is a stand-in. Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const R = createRequire(import.meta.url)('../renderer/support-report.js');
const read = (f) => readFileSync(new URL('../renderer/' + f, import.meta.url), 'utf8');

function harness(over = {}) {
  const calls = [], toasts = [];
  let paints = 0, finish;
  const br = Object.assign({
    debugBundle: (kind) => { calls.push(['bundle', kind]); return new Promise((r) => { finish = r; }); },
    filePreviewAction: async (p, action) => { calls.push(['preview', p, action]); return {ok: true}; },
    openPath: async (p) => { calls.push(['open', p]); return {ok: true}; },
  }, over);
  const sr = R.createSupportReport({bridge: () => br, toast: (...a) => toasts.push(a), repaint: () => { paints++; }});
  return {sr, calls, toasts, done: (res) => finish(res), paints: () => paints};
}

test('a double click writes one report, and the button is busy while it is written', async () => {
  const h = harness();
  const first = h.sr.save('dump');
  assert.equal(h.sr.busy(), true);
  assert.equal(await h.sr.save('dump'), null, 'the second click is ignored');
  assert.deepEqual(h.toasts[0].slice(0, 1), ['Saving the report…']);
  assert.equal(h.toasts[0][2], 'info');
  h.done({ok: true, path: '/Users/me/Downloads/atomic-agent-debug-1.txt'});
  assert.deepEqual(await first, {ok: true, path: '/Users/me/Downloads/atomic-agent-debug-1.txt'});
  assert.equal(h.sr.busy(), false);
  assert.equal(h.calls.filter((c) => c[0] === 'bundle').length, 1);
  assert.ok(h.paints() >= 2, 'repainted into and out of the busy state');
});

test('the saved report is revealed in its folder, never opened in an editor', async () => {
  const h = harness();
  const p = h.sr.save('dump');
  h.done({ok: true, path: '/Users/me/Downloads/atomic-agent-debug-1.txt'});
  await p;
  assert.deepEqual(h.calls.slice(1), [['preview', '/Users/me/Downloads/atomic-agent-debug-1.txt', 'reveal']]);
  assert.ok(!h.calls.some((c) => c[0] === 'open' && c[1].endsWith('.txt')), 'the .txt is not opened');
  assert.deepEqual(h.toasts[1], ['Report saved', 'In your Downloads folder as atomic-agent-debug-1.txt.']);
});

test('a reveal the preview refuses opens the folder instead; Report an Issue asks to attach it', async () => {
  const h = harness({filePreviewAction: async () => ({ok: false, reason: 'outside'})});
  const p = h.sr.save('report');
  h.done({ok: true, path: 'D:\\Downloads\\atomic-agent-debug-2.txt'});
  await p;
  assert.deepEqual(h.calls.find((c) => c[0] === 'open'), ['open', 'D:\\Downloads']);
  assert.deepEqual(h.calls[0], ['bundle', 'report']);
  assert.match(h.toasts[1][1], /atomic-agent-debug-2\.txt\. Attach it to the issue if you want to\.$/);
});

test('a failure says what to check, without the raw error; no bridge says so plainly', async () => {
  const h = harness();
  const p = h.sr.save('dump');
  h.done({ok: false, error: 'EACCES: permission denied, open /Users/me/Downloads/x.txt'});
  assert.deepEqual(await p, {ok: false});
  assert.equal(h.toasts[1][0], 'Could not save the report');
  assert.ok(!h.toasts[1][1].includes('EACCES'));
  assert.equal(h.toasts[1][2], 'bad');
  const none = R.createSupportReport({bridge: () => null, toast: () => {}, repaint: () => {}});
  assert.deepEqual(await none.save('dump'), {ok: false});
});

test('the wiring: every place calls saveSupportReport, and the old ways are gone', () => {
  const renderer = read('renderer.js'), bug = read('bug-report.js'), index = read('index.html');
  assert.ok(renderer.includes("saveSupportReport('dump');"));
  assert.ok(renderer.includes("saveSupportReport('report');"));
  assert.ok(bug.includes("saveSupportReport('report')"));
  assert.ok(!renderer.includes("if (BR.openPath) BR.openPath(res.path)"), 'the report is no longer opened in an editor');
  for (const src of [renderer, bug]) assert.ok(!src.includes("BR.debugBundle('"), 'no second way to save it');
  assert.equal(renderer.split('data-act="dump"\' + supportReportBusyAttr()').length - 1, 2, 'both Save buttons go busy');
  const at = (f) => index.indexOf('<script src="' + f + '"></script>');
  assert.ok(at('support-report.js') > 0 && at('support-report.js') < at('bug-report.js') && at('support-report.js') < at('renderer.js'));
});
