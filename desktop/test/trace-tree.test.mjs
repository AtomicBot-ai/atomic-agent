import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parseTraceTree, readTraceTree } = require('../out/main/trace-tree.js');
const { wireTraceTreeIpc } = require('../out/main/trace-tree-ipc.js');
const V = require('../renderer/trace-view.js');

const here = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(here, p), 'utf8');

/* ATO-639: Diagnostics' Timeline. Records shaped as the agent's TraceEvent union writes them. */
const T0 = 1_700_000_000_000;
const rec = (o) => JSON.stringify({ sessionId: 's1', ...o });
const SAMPLE = [
  rec({ seq: 0, ts: T0 - 50, type: 'session_started', workingDir: '/w' }),
  rec({ seq: 1, ts: T0, type: 'turn_started', turnIndex: 0, userMessage: 'list the files', route: { mode: 'default', main: { providerId: 'openrouter', model: 'qwen-4' }, worker: null } }),
  rec({ seq: 2, ts: T0 + 10, type: 'step_started', turnIndex: 0, stepIndex: 0 }),
  rec({ seq: 3, ts: T0 + 20, type: 'prompt_captured', turnIndex: 0, stepIndex: 0, tokens: { total: 900, stablePrefix: 800, tail: 100 } }),
  rec({ seq: 4, ts: T0 + 1010, type: 'llm_completion', turnIndex: 0, stepIndex: 0, attempt: 1, content: 'x', cacheHitTokens: 800,
    modelId: 'qwen-4', stop: true, truncated: false, costUsd: 0.002, timing: { promptMs: 300, predictedMs: 500, promptTokens: 900, predictedTokens: 40 } }),
  rec({ seq: 5, ts: T0 + 1210, type: 'tool_invocation', turnIndex: 0, stepIndex: 0, tool: 'fs.list', args: { path: '.' }, status: 'ok', summary: '3 files', batchIndex: 0, batchSize: 2 }),
  rec({ seq: 6, ts: T0 + 1510, type: 'tool_invocation', turnIndex: 0, stepIndex: 0, tool: 'fs.read', args: { path: 'a' }, status: 'error', summary: 'ENOENT', batchIndex: 1, batchSize: 2 }),
  rec({ seq: 7, ts: T0 + 1520, type: 'step_finished', turnIndex: 0, stepIndex: 0, summary: 'listed', durationMs: 1510 }),
  rec({ seq: 8, ts: T0 + 1530, type: 'step_started', turnIndex: 0, stepIndex: 1 }),
  rec({ seq: 9, ts: T0 + 1600, type: 'parse_retry', turnIndex: 0, stepIndex: 1, attempt: 2, reason: 'no tool call' }),
  rec({ seq: 10, ts: T0 + 2600, type: 'llm_completion', turnIndex: 0, stepIndex: 1, attempt: 2, content: 'y', cacheHitTokens: 0, modelId: 'qwen-4', stop: true, truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 950, predictedTokens: 20 }, costUsd: 0.001 }),
  rec({ seq: 11, ts: T0 + 2700, type: 'tool_invocation', turnIndex: 0, stepIndex: 1, tool: 'reply', args: {}, status: 'ok', summary: 'done' }),
  rec({ seq: 12, ts: T0 + 2710, type: 'step_finished', turnIndex: 0, stepIndex: 1, summary: 'replied', durationMs: 1180 }),
  rec({ seq: 13, ts: T0 + 2720, type: 'turn_finished', turnIndex: 0, reason: 'finished', stepCount: 2, durationMs: 2720 }),
  'not json',
  '',
  // A later `serve` appended: seq and turnIndex restart.
  rec({ seq: 0, ts: T0 + 90_000, type: 'turn_started', turnIndex: 0, userMessage: 'again' }),
  rec({ seq: 1, ts: T0 + 90_100, type: 'llm_completion', turnIndex: 0, stepIndex: 0, attempt: 1, content: '', cacheHitTokens: 0, modelId: 'm2', stop: true, truncated: true }),
  rec({ seq: 2, ts: T0 + 90_200, type: 'error', turnIndex: 0, stepIndex: 0, message: 'provider said 500' }),
].join('\n');

test('a trace becomes turns → steps → model and tool calls, in file order', () => {
  const { turns, omittedTurns } = parseTraceTree(SAMPLE);
  assert.equal(omittedTurns, 0);
  assert.equal(turns.length, 2, 'the appended run with the same turnIndex is its own turn');
  const [t] = turns;
  assert.equal(t.kind, 'turn');
  assert.equal(t.userMessage, 'list the files');
  assert.equal(t.model, 'openrouter/qwen-4');
  assert.equal(t.durationMs, 2720);
  assert.equal(t.reason, 'finished');
  assert.deepEqual(t.children.map((s) => [s.kind, s.name, s.startMs, s.durationMs]), [['step', 'Step 1', 10, 1510], ['step', 'Step 2', 1530, 1180]]);
  const s1 = t.children[0];
  assert.deepEqual(s1.children.map((c) => c.kind + ':' + c.name), ['llm:Model call', 'tool:fs.list', 'tool:fs.read']);
  const llm = s1.children[0];
  // The server's prefill + decode, ending at the completion.
  assert.equal(llm.durationMs, 800);
  assert.equal(llm.startMs, 210);
  assert.deepEqual([llm.tokensIn, llm.tokensOut, llm.cachedTokens, llm.costUsd], [900, 40, 800, 0.002]);
  // Tools run from the step's completion to their own row, as traceTools measures.
  assert.deepEqual(s1.children.slice(1).map((c) => [c.startMs, c.durationMs, c.error]), [[1010, 200, false], [1010, 500, true]]);
  assert.equal(s1.error, true);
  assert.equal(t.error, true);
});

test('a model call without server timing lasts from the step\'s previous mark; marks have no duration', () => {
  const s2 = parseTraceTree(SAMPLE).turns[0].children[1];
  assert.deepEqual(s2.children.map((c) => c.kind + ':' + c.name), ['event:Parse retry', 'llm:Model call (retry)', 'tool:reply']);
  assert.equal(s2.children[0].warn, true);
  assert.equal(s2.children[0].durationMs, null);
  assert.equal(s2.children[0].detail, 'no tool call');
  assert.equal(s2.children[1].durationMs, 1000, 'from the parse retry at +1600 to the completion at +2600');
  assert.equal(s2.warn, true);
});

test('tokens and cost roll up; a turn without turn_finished ends at its last row', () => {
  const [t, u] = parseTraceTree(SAMPLE).turns;
  assert.equal(t.tokensIn, 1850);
  assert.equal(t.tokensOut, 60);
  assert.ok(Math.abs(t.costUsd - 0.003) < 1e-9);
  assert.equal(u.costUsd, null, 'never 0 when the provider said nothing');
  assert.equal(u.model, 'm2', 'the completion names the model when the route did not');
  const step = u.children[0];
  assert.equal(step.children[0].warn, true, 'a truncated completion is marked');
  assert.equal(step.children[1].kind, 'event');
  assert.equal(step.children[1].error, true);
  assert.equal(step.children[1].detail, 'provider said 500');
  assert.equal(u.error, true);
  assert.equal(u.durationMs, 200, 'its error mark at +200 is its last row');
});

test('only the newest turns are kept', () => {
  const lines = [];
  for (let i = 0; i < 5; i++) {
    lines.push(rec({ seq: i * 2, ts: T0 + i * 1000, type: 'turn_started', turnIndex: i }));
    lines.push(rec({ seq: i * 2 + 1, ts: T0 + i * 1000 + 5, type: 'turn_finished', turnIndex: i, reason: 'finished', stepCount: 0, durationMs: 5 }));
  }
  const tree = parseTraceTree(lines.join('\n'), 2);
  assert.equal(tree.omittedTurns, 3);
  assert.deepEqual(tree.turns.map((t) => t.turnIndex), [3, 4]);
  assert.deepEqual(parseTraceTree('').turns, []);
});

test('readTraceTree reads <stateDir>/traces/<id>.ndjson and refuses odd ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trv-'));
  mkdirSync(join(dir, 'traces'));
  writeFileSync(join(dir, 'traces', 's1.ndjson'), SAMPLE);
  const r = await readTraceTree(dir, 's1');
  assert.equal(r.ok, true);
  assert.equal(r.tree.turns.length, 2);
  assert.equal((await readTraceTree(dir, '../x')).ok, false);
  assert.equal((await readTraceTree(dir, 'missing')).ok, false);
});

test('cli:traceTree refuses a folder outside the desktop state', async () => {
  const handlers = {};
  wireTraceTreeIpc({ ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, ownDir: (p) => p.startsWith('/own') });
  const r = await handlers['cli:traceTree'](null, { stateDir: '/elsewhere', sessionId: 's1' });
  assert.equal(r.ok, false);
  assert.equal((await handlers['cli:traceTree'](null, {})).ok, false);
});

test('formatters say nothing for a missing number', () => {
  assert.equal(V.traceFmtMs(null), '—');
  assert.equal(V.traceFmtMs(250), '250 ms');
  assert.equal(V.traceFmtMs(1510), '1.51 s');
  assert.equal(V.traceFmtMs(125000), '2m 05s');
  assert.equal(V.traceFmtTokens(null), '');
  assert.equal(V.traceFmtTokens(950), '950');
  assert.equal(V.traceFmtTokens(1850), '1.9k');
  assert.equal(V.traceFmtCost(null), '');
  assert.equal(V.traceFmtCost(0.003), '$0.0030');
  assert.equal(V.traceFmtCost(1.5), '$1.50');
});

test('rows are depth-first with bars placed against the whole turn', () => {
  const turn = parseTraceTree(SAMPLE).turns[0];
  const { rows, more } = V.traceViewRows(turn);
  assert.equal(more, 0);
  assert.deepEqual(rows.slice(0, 5).map((r) => [r.depth, r.node.name]),
    [[0, 'Turn 1'], [1, 'Step 1'], [2, 'Model call'], [2, 'fs.list'], [2, 'fs.read']]);
  assert.deepEqual([rows[0].left, rows[0].width], [0, 100]);
  const tool = rows[3];
  assert.equal(tool.left, +((1010 / 2720) * 100).toFixed(2));
  assert.equal(tool.width, +((200 / 2720) * 100).toFixed(2));
  const mark = rows.find((r) => r.node.kind === 'event');
  assert.equal(mark.width, 0);
  assert.equal(V.traceViewRows(turn, 3).more, rows.length - 3);
});

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const h = { esc, ic: () => '', sessionId: 's1' };

test('the pane offers Show timeline until a tree for this chat is read', () => {
  const st = { busy: false, err: '', tree: null, sid: '', turn: -1 };
  assert.match(V.traceViewHTML(st, h), /data-act="trace:load"(?![^>]*disabled)/);
  assert.match(V.traceViewHTML(st, { ...h, sessionId: '' }), /data-act="trace:load" disabled/);
  // A tree read for another chat is not drawn.
  const other = { ...st, tree: parseTraceTree(SAMPLE), sid: 'other' };
  assert.doesNotMatch(V.traceViewHTML(other, h), /class="trv"/);
});

test('the waterfall shows the newest turn with its badges, and escapes what the model wrote', () => {
  const tree = parseTraceTree(SAMPLE.replace('fs.list', '<b>fs.list</b>'));
  const html = V.traceViewHTML({ busy: false, err: '', tree, sid: 's1', turn: -1 }, h);
  assert.match(html, /Turn 2 of 2/);
  assert.match(html, /data-act="trace:next" disabled/);
  const first = V.traceViewHTML({ busy: false, err: '', tree, sid: 's1', turn: 0 }, h);
  assert.match(first, /Turn 1 of 2 · 2\.72 s · openrouter\/qwen-4 · 1\.9k in \/ 60 out · \$0\.0030/);
  assert.match(first, /trv-badge--err">error</);
  assert.match(first, /&lt;b&gt;fs\.list&lt;\/b&gt;/);
  assert.doesNotMatch(first, /<b>fs\.list/);
});

test('Earlier / Later walk the turns; load reads the open chat through the bridge', async () => {
  let painted = 0;
  const ctx = { stateDir: '/own', sessionId: 's1', repaint: () => { painted++; } };
  const br = { traceTree: async (dir, sid) => { assert.deepEqual([dir, sid], ['/own', 's1']); return { ok: true, tree: parseTraceTree(SAMPLE) }; } };
  await V.traceViewAct('load', br, ctx);
  assert.equal(V.TRV.sid, 's1');
  assert.equal(V.TRV.tree.turns.length, 2);
  assert.ok(painted >= 2);
  await V.traceViewAct('prev', br, ctx);
  assert.equal(V.TRV.turn, 0);
  await V.traceViewAct('prev', br, ctx);
  assert.equal(V.TRV.turn, 0);
  await V.traceViewAct('next', br, ctx);
  assert.equal(V.TRV.turn, 1);
  await V.traceViewAct('load', { traceTree: async () => ({ ok: false, error: 'ENOENT: no such file' }) }, ctx);
  assert.match(V.TRV.err, /no trace yet/);
  await V.traceViewAct('hide', br, ctx);
  assert.equal(V.TRV.tree, null);
});

test('wiring: preload, main, index.html and the Diagnostics pane', () => {
  assert.ok(src('../preload/preload.ts').includes('ipcRenderer.invoke("cli:traceTree", { stateDir, sessionId })'));
  assert.match(src('../main/main.ts'), /wireTraceTreeIpc\(\{ ipcMain \}\)/);
  const html = src('../renderer/index.html');
  const at = (f) => html.indexOf('<script src="' + f + '"');
  assert.ok(at('trace-view.js') > 0 && at('trace-view.js') < at('renderer.js'));
  assert.ok(html.includes('href="css/trace-view.css"'));
  const r = src('../renderer/renderer.js');
  assert.ok(r.includes("traceViewHTML(TRV, {esc, ic, sessionId: S.agentSession || ''})"));
  assert.ok(r.includes("if (k === 'trace') { traceViewAct(v, BR,"));
});
