import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {
  PERF_POLL_MS, perfEsc, perfSummary, perfFormatRate, perfFormatMs, perfFormatContext,
  perfChartSVG, perfPaneHTML, perfPoller,
} = createRequire(import.meta.url)('../renderer/perf-panel.js');

// Issue #996: Settings › Performance, the local model's speed over its recent requests.

// The agent's sample for the probed llama.cpp `/completion` stop event.
const sample = (over = {}) => ({
  at: 1794329429000,
  modelId: 'Qwen3.6-35B-A3B-MXFP4_MOE.gguf',
  streamed: true,
  promptTokens: 2,
  cacheTokens: 0,
  promptMs: 32.969,
  promptPerSecond: 60.663047104856076,
  predictedTokens: 40,
  predictedMs: 1158.29,
  generationPerSecond: 33.67032435745798,
  ttftMs: 412.0,
  contextTokens: 42,
  concurrent: 1,
  ...over,
});
const body = (over = {}) => ({
  local: true, url: 'http://127.0.0.1:9931', capacity: 300,
  samples: [sample()], slots: {total: 1, busy: 0, contextPerSlot: 262144}, ...over,
});
const HOSTILE = '</title></svg><img src=x onerror=alert(1)>&\'"';

const allFinite = (o) => Object.values(o).every((v) => v === null || (typeof v === 'object' ? allFinite(v) : Number.isFinite(v)));

/* ---------------- summary ---------------- */

test('the summary takes the newest value as last and averages the rest, skipping nulls', () => {
  const s = perfSummary([
    sample({generationPerSecond: 30, promptPerSecond: 100, ttftMs: 400, concurrent: 1, contextTokens: 50}),
    sample({generationPerSecond: null, promptPerSecond: 200, ttftMs: null, concurrent: 3, contextTokens: 90}),
    sample({generationPerSecond: 40, promptPerSecond: 300, ttftMs: 600, concurrent: 2, contextTokens: 146}),
  ], {total: 4, busy: 1, contextPerSlot: 262144});
  assert.equal(s.count, 3);
  assert.deepEqual(s.generation, {last: 40, mean: 35});
  assert.deepEqual(s.prompt, {last: 300, mean: 200});
  assert.deepEqual(s.ttft, {last: 600, mean: 500});
  assert.deepEqual(s.context, {lastTokens: 146, perSlot: 262144});
  assert.deepEqual(s.concurrent, {last: 2, max: 3});
});

test('a fully cached newest prompt shows no prompt speed, not an older one', () => {
  const s = perfSummary([sample({promptPerSecond: 120}), sample({promptPerSecond: null, promptTokens: 0})], null);
  assert.equal(s.prompt.last, null);
  assert.equal(s.prompt.mean, 120);
});

test('no samples: count 0 and every number null; no slots: perSlot null', () => {
  const s = perfSummary([], null);
  assert.equal(s.count, 0);
  assert.deepEqual(s.generation, {last: null, mean: null});
  assert.deepEqual(s.prompt, {last: null, mean: null});
  assert.deepEqual(s.ttft, {last: null, mean: null});
  assert.deepEqual(s.context, {lastTokens: null, perSlot: null});
  assert.deepEqual(s.concurrent, {last: null, max: null});
  assert.equal(perfSummary(undefined, undefined).count, 0);
});

test('the summary never holds NaN or Infinity, whatever the samples carry', () => {
  const s = perfSummary([
    sample({generationPerSecond: NaN, promptPerSecond: Infinity, ttftMs: -Infinity, concurrent: NaN, contextTokens: 'x'}),
    sample({generationPerSecond: null, promptPerSecond: null, ttftMs: null, concurrent: null, contextTokens: null}),
  ], {total: 1, busy: 0, contextPerSlot: NaN});
  assert.ok(allFinite(s), JSON.stringify(s));
  assert.equal(s.generation.mean, null);
  assert.equal(s.context.perSlot, null);
});

/* ---------------- formatters ---------------- */

test('rates read as tok/s with thousands separators, or a dash', () => {
  assert.equal(perfFormatRate(54.2), '54 tok/s');
  assert.equal(perfFormatRate(1450.4), '1,450 tok/s');
  assert.equal(perfFormatRate(33.67032435745798), '34 tok/s');
  assert.equal(perfFormatRate(3.42), '3.4 tok/s');
  assert.equal(perfFormatRate(null), '—');
  assert.equal(perfFormatRate(NaN), '—');
  assert.equal(perfFormatRate(Infinity), '—');
});

test('times read in ms under a second and in seconds above', () => {
  assert.equal(perfFormatMs(412), '412 ms');
  assert.equal(perfFormatMs(411.6), '412 ms');
  assert.equal(perfFormatMs(2400), '2.4 s');
  assert.equal(perfFormatMs(12_345), '12.3 s');
  assert.equal(perfFormatMs(null), '—');
  assert.equal(perfFormatMs(NaN), '—');
});

test('context reads used / size, bare when the size is unknown, a dash when nothing is known', () => {
  assert.equal(perfFormatContext(146, 262144), '146 / 262,144');
  assert.equal(perfFormatContext(14_600, 32768), '14,600 / 32,768');
  assert.equal(perfFormatContext(146, null), '146');
  assert.equal(perfFormatContext(null, 262144), '—');
  assert.equal(perfFormatContext(NaN, null), '—');
});

/* ---------------- chart ---------------- */

const polylines = (svg) => [...svg.matchAll(/<polyline[^>]*points="([^"]*)"/g)].map((m) => m[1].trim().split(/\s+/));

test('the chart is one line through finite points', () => {
  const svg = perfChartSVG([sample({generationPerSecond: 30}), sample({generationPerSecond: 40}), sample({generationPerSecond: 35})], 'generationPerSecond', {width: 300, height: 80});
  assert.match(svg, /^<svg[^>]*viewBox="0 0 300 80"/);
  assert.equal(polylines(svg).length, 1);
  assert.equal(polylines(svg)[0].length, 3);
  assert.doesNotMatch(svg, /NaN|Infinity/);
  assert.doesNotMatch(svg, /#[0-9a-f]{3,6}\b/i, 'colours come from classes, not hex');
});

test('a null splits the line in two, with no dip to zero', () => {
  const svg = perfChartSVG([sample({generationPerSecond: 30}), sample({generationPerSecond: 32}), sample({generationPerSecond: null}),
    sample({generationPerSecond: 40}), sample({generationPerSecond: 38})], 'generationPerSecond', {width: 300, height: 80});
  const lines = polylines(svg);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].length, 2);
  assert.equal(lines[1].length, 2);
  assert.doesNotMatch(svg, /NaN|Infinity/);
});

test('a non-finite value splits the line the same way', () => {
  const svg = perfChartSVG([sample({promptPerSecond: 100}), sample({promptPerSecond: 110}), sample({promptPerSecond: Infinity}),
    sample({promptPerSecond: NaN}), sample({promptPerSecond: 90}), sample({promptPerSecond: 95})], 'promptPerSecond', {width: 300, height: 80});
  assert.equal(polylines(svg).length, 2);
  assert.doesNotMatch(svg, /NaN|Infinity/);
});

test('each point names its time, value and how many requests shared the GPU', () => {
  const svg = perfChartSVG([sample({generationPerSecond: 33.6, concurrent: 2})], 'generationPerSecond', {width: 300, height: 80});
  assert.match(svg, /<title>\d\d:\d\d:\d\d · 34 tok\/s · 2 requests at once<\/title>/);
  const one = perfChartSVG([sample({concurrent: 1})], 'generationPerSecond', {width: 300, height: 80});
  assert.match(one, /<title>[^<]* · 1 request at once<\/title>/);
});

test('a model change draws a tick naming the new model', () => {
  const svg = perfChartSVG([sample({modelId: 'a.gguf'}), sample({modelId: 'a.gguf'}), sample({modelId: 'b-Q4_K_M.gguf'})], 'generationPerSecond', {width: 300, height: 80});
  const ticks = [...svg.matchAll(/<g class="perf-tick">(.*?)<\/g>/g)];
  assert.equal(ticks.length, 1);
  assert.match(ticks[0][1], /<line [^>]*\/>/);
  assert.match(ticks[0][1], /<title>Model changed to b-Q4_K_M\.gguf<\/title>/);
  assert.equal([...perfChartSVG([sample(), sample()], 'generationPerSecond', {width: 300, height: 80}).matchAll(/perf-tick/g)].length, 0);
});

test('a hostile model id is escaped in the chart', () => {
  const svg = perfChartSVG([sample({modelId: 'a.gguf'}), sample({modelId: HOSTILE})], 'generationPerSecond', {width: 300, height: 80});
  assert.doesNotMatch(svg, /<img/);
  assert.match(svg, /&lt;\/title&gt;&lt;\/svg&gt;&lt;img src=x onerror=alert\(1\)&gt;&amp;&#39;&quot;/);
});

test('perfEsc covers & < > " and \'', () => {
  assert.equal(perfEsc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(perfEsc(null), '');
});

/* ---------------- pane ---------------- */

const SAY = {
  loading: "Reading the local model's numbers…",
  unsupported: 'This agent is older than the performance view. Update the agent to see it.',
  unreachable: 'The agent is not answering right now. The numbers come back when it does.',
  cloud: 'The chat is on a cloud model. These numbers are for the local model server.',
  empty: 'No local requests yet. Send a message and the numbers appear here.',
};
const NOW = 1794329429000 + 5_000;
// The pane is HTML: a sentence is found as it is written there (its ' escaped).

test('loading, before any answer, says so and draws nothing else', () => {
  const html = perfPaneHTML({phase: 'loading', data: null, error: null}, NOW);
  assert.ok(html.includes(perfEsc(SAY.loading)));
  assert.doesNotMatch(html, /<svg/);
});

test('an older agent says to update it, with no charts', () => {
  const html = perfPaneHTML({phase: 'unsupported', data: null, error: null}, NOW);
  assert.ok(html.includes(perfEsc(SAY.unsupported)));
  assert.doesNotMatch(html, /<svg/);
});

test('an agent that stopped answering says so, over the last good numbers', () => {
  const html = perfPaneHTML({phase: 'unreachable', data: body(), error: 'fetch failed'}, NOW);
  assert.ok(html.includes(perfEsc(SAY.unreachable)));
  assert.match(html, /<svg/);
  assert.match(html, /34 tok\/s/);
  const bare = perfPaneHTML({phase: 'unreachable', data: null, error: 'fetch failed'}, NOW);
  assert.ok(bare.includes(perfEsc(SAY.unreachable)));
  assert.doesNotMatch(bare, /<svg/);
});

test('a cloud chat says the numbers are the local server\'s and still draws earlier samples', () => {
  const html = perfPaneHTML({phase: 'ok', data: body({local: false, slots: null}), error: null}, NOW);
  assert.ok(html.includes(perfEsc(SAY.cloud)));
  assert.match(html, /<svg/);
});

test('cloud with no samples shows only the cloud sentence, not the empty one', () => {
  const html = perfPaneHTML({phase: 'ok', data: body({local: false, samples: [], slots: null}), error: null}, NOW);
  assert.ok(html.includes(perfEsc(SAY.cloud)));
  assert.ok(!html.includes(perfEsc(SAY.empty)));
  assert.doesNotMatch(html, /<svg/);
});

test('local with no requests yet says how to get numbers', () => {
  const html = perfPaneHTML({phase: 'ok', data: body({samples: []}), error: null}, NOW);
  assert.ok(html.includes(perfEsc(SAY.empty)));
  assert.ok(!html.includes(perfEsc(SAY.cloud)));
  assert.doesNotMatch(html, /<svg/);
});

test('the rows: generation, prompt, first token, workers and context', () => {
  const html = perfPaneHTML({phase: 'ok', data: body({slots: {total: 4, busy: 1, contextPerSlot: 262144},
    samples: [sample({concurrent: 3}), sample({concurrent: 2})]}), error: null}, NOW);
  for (const label of ['Generation', 'Prompt', 'Time to first token', 'Workers sharing the GPU', 'Context']) {
    assert.ok(html.includes('>' + label + '<'), label);
  }
  assert.match(html, /34 tok\/s/);
  assert.match(html, /61 tok\/s/);
  assert.match(html, /412 ms/);
  assert.match(html, /1 \/ 4 busy now/);
  assert.match(html, /most at once in recent requests: 3/);
  assert.match(html, /42 \/ 262,144/);
  assert.equal([...html.matchAll(/<svg/g)].length, 2, 'generation and prompt each have their own chart');
  for (const s of Object.values(SAY)) assert.ok(!html.includes(perfEsc(s)), s);
});

test('without slots the workers row shows only the recent most-at-once, so labelled, and context is bare', () => {
  const html = perfPaneHTML({phase: 'ok', data: body({slots: null, samples: [sample({concurrent: 2})]}), error: null}, NOW);
  assert.match(html, /Most at once in recent requests: 2/);
  assert.doesNotMatch(html, /busy now/);
  assert.match(html, />42</);
});

test('a hostile model id is escaped in the pane', () => {
  const html = perfPaneHTML({phase: 'ok', data: body({samples: [sample({modelId: 'a.gguf'}), sample({modelId: HOSTILE})]}), error: null}, NOW);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('a malformed body draws without throwing or printing NaN', () => {
  for (const data of [{}, {samples: 'x'}, {samples: [null, 7, sample({generationPerSecond: 'fast'})], slots: 'x'}]) {
    const html = perfPaneHTML({phase: 'ok', data, error: null}, NOW);
    assert.doesNotMatch(html, /NaN|Infinity|undefined/);
  }
});

/* ---------------- poll lifecycle ---------------- */

function rig({visible = true} = {}) {
  const clock = {timers: new Map(), next: 1};
  const calls = [];
  const changes = [];
  const view = {visible};
  const ctl = perfPoller({
    request: () => new Promise((resolve, reject) => calls.push({resolve, reject})),
    setInterval: (fn, ms) => { const id = clock.next++; clock.timers.set(id, {fn, ms}); return id; },
    clearInterval: (id) => { clock.timers.delete(id); },
    isVisible: () => view.visible,
    onChange: (st) => changes.push(st.phase),
  });
  const tick = () => { for (const t of [...clock.timers.values()]) t.fn(); };
  const settle = () => new Promise((r) => setImmediate(r));
  return {ctl, calls, changes, clock, view, tick, settle};
}

test('entering polls at once and then every 2 s', async () => {
  const r = rig();
  r.ctl.enter();
  assert.equal(r.calls.length, 1);
  assert.equal(r.ctl.state.phase, 'loading');
  assert.equal(r.clock.timers.size, 1);
  assert.equal([...r.clock.timers.values()][0].ms, PERF_POLL_MS);
  assert.equal(PERF_POLL_MS, 2000);
  r.calls[0].resolve({ok: true, data: body()});
  await r.settle();
  assert.equal(r.ctl.state.phase, 'ok');
  r.tick();
  assert.equal(r.calls.length, 2);
});

test('no second request while one is outstanding', async () => {
  const r = rig();
  r.ctl.enter();
  r.tick(); r.tick();
  assert.equal(r.calls.length, 1);
  r.calls[0].resolve({ok: true, data: body()});
  await r.settle();
  r.tick();
  assert.equal(r.calls.length, 2);
});

test('an answer that arrives after leaving is dropped, and leaving clears the timer', async () => {
  const r = rig();
  r.ctl.enter();
  r.ctl.leave();
  assert.equal(r.clock.timers.size, 0);
  const before = r.changes.length;
  r.calls[0].resolve({ok: true, data: body()});
  await r.settle();
  assert.equal(r.ctl.state.phase, 'loading');
  assert.equal(r.ctl.state.data, null);
  assert.equal(r.changes.length, before, 'no repaint for a stale answer');
});

test('leave then re-enter: the stale first answer is dropped and the fresh one used', async () => {
  const r = rig();
  r.ctl.enter();
  r.ctl.leave();
  r.ctl.enter();
  assert.equal(r.calls.length, 2, 're-entry asks again at once');
  r.calls[0].resolve({ok: true, data: body({url: 'stale'})});
  await r.settle();
  assert.equal(r.ctl.state.phase, 'loading');
  r.calls[1].resolve({ok: true, data: body({url: 'fresh'})});
  await r.settle();
  assert.equal(r.ctl.state.phase, 'ok');
  assert.equal(r.ctl.state.data.url, 'fresh');
});

test('an agent restart makes an answer already on its way stale', async () => {
  const r = rig();
  r.ctl.enter();
  r.ctl.agentRestarted();
  assert.equal(r.calls.length, 2);
  r.calls[0].resolve({ok: true, data: body({url: 'old agent'})});
  await r.settle();
  assert.equal(r.ctl.state.phase, 'loading');
  r.calls[1].resolve({ok: true, data: body({url: 'new agent'})});
  await r.settle();
  assert.equal(r.ctl.state.data.url, 'new agent');
});

test('a rejected request is unreachable, keeps the last numbers, and polling goes on', async () => {
  const r = rig();
  r.ctl.enter();
  r.calls[0].resolve({ok: true, data: body()});
  await r.settle();
  r.tick();
  r.calls[1].reject(new Error('fetch failed'));
  await r.settle();
  assert.equal(r.ctl.state.phase, 'unreachable');
  assert.equal(r.ctl.state.error, 'fetch failed');
  assert.equal(r.ctl.state.data.url, 'http://127.0.0.1:9931');
  assert.equal(r.clock.timers.size, 1);
  r.tick();
  assert.equal(r.calls.length, 3);
  r.calls[2].resolve({ok: false, kind: 'unreachable', error: 'HTTP 500'});
  await r.settle();
  assert.equal(r.ctl.state.phase, 'unreachable');
  assert.equal(r.ctl.state.error, 'HTTP 500');
});

test('404 is unsupported and polling stops; re-entering probes again', async () => {
  const r = rig();
  r.ctl.enter();
  r.calls[0].resolve({ok: false, kind: 'unsupported'});
  await r.settle();
  assert.equal(r.ctl.state.phase, 'unsupported');
  assert.equal(r.clock.timers.size, 0);
  r.tick();
  assert.equal(r.calls.length, 1);
  r.ctl.leave();
  r.ctl.enter();
  assert.equal(r.calls.length, 2);
  r.calls[1].resolve({ok: true, data: body()});
  await r.settle();
  assert.equal(r.ctl.state.phase, 'ok');
  assert.equal(r.clock.timers.size, 1);
});

test('a tick with the pane off screen leaves instead of asking', () => {
  const r = rig();
  r.ctl.enter();
  r.calls[0].resolve({ok: true, data: body()});
  r.view.visible = false;
  return r.settle().then(() => {
    r.tick();
    assert.equal(r.calls.length, 1);
    assert.equal(r.clock.timers.size, 0);
    assert.equal(r.ctl.active, false);
  });
});
