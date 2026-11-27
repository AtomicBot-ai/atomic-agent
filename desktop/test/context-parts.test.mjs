// ATO-2453: the context popover's part rows, per-tool rows and small-window
// tip (renderer/context-parts.js), ported from src/tui/context/context-panel-body.ts
// and src/tui/context/context-hint.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../renderer/context-parts.js');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const h = {esc, fmt: (n) => String(n)};

const TOOLS = Array.from({length: 11}, (_, i) => ({label: 'tool' + i, tokens: 1100 - i * 100}));
const PARTS = [
  {parent: 'prompt scaffold', label: 'persona', tokens: 800},
  {parent: 'prompt scaffold', label: 'built-in tools', tokens: 1200},
  {parent: 'prompt scaffold', label: 'mcp github', tokens: TOOLS.reduce((a, t) => a + t.tokens, 0), mcpServer: 'github', tools: TOOLS},
  {parent: 'tool schemas', label: 'mcp github', tokens: 900, mcpServer: 'github'},
];

test('lists a row\'s parts under it, and only that row\'s', () => {
  const html = P.ctxPartRowsHTML(PARTS, 'prompt scaffold', h);
  assert.match(html, /class="ter ctxpart">persona</);
  assert.match(html, /built-in tools/);
  assert.match(html, /data-ctx-expand="github"/);
  assert.equal(P.ctxPartsOf(PARTS, 'tool schemas').length, 1);
  assert.equal(P.ctxPartRowsHTML(PARTS, 'conversation', h), '');
});

test('a server lists its tools only once it is opened, and folds the long tail', () => {
  P.CTX_OPEN_SERVERS.clear();
  assert.doesNotMatch(P.ctxPartRowsHTML(PARTS, 'prompt scaffold', h), /ctxtool/);
  assert.equal(P.ctxToggleServer('github'), true);
  const html = P.ctxPartRowsHTML(PARTS, 'prompt scaffold', h);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, />tool0</);
  assert.match(html, />tool7</);
  assert.doesNotMatch(html, />tool8</);
  assert.match(html, />\+3 more</);
  const rows = P.ctxToolRows(PARTS[2]);
  assert.equal(rows.reduce((a, r) => a + r.tokens, 0), PARTS[2].tokens);
  assert.equal(P.ctxToggleServer('github'), false);
  assert.doesNotMatch(P.ctxPartRowsHTML(PARTS, 'prompt scaffold', h), /ctxtool/);
});

test('one tool past the limit is listed, not folded', () => {
  const part = {tools: TOOLS.slice(0, P.CTX_TOOLS_SHOWN + 1)};
  assert.equal(P.ctxToolRows(part).some((r) => r.more), false);
});

test('a server name is escaped', () => {
  P.CTX_OPEN_SERVERS.clear();
  const html = P.ctxPartRowsHTML([{parent: 'x', label: 'mcp <b>', tokens: 5, mcpServer: '<b>', tools: [{label: '<i>', tokens: 5}]}], 'x', h);
  assert.doesNotMatch(html, /<b>|<i>/);
});

test('the tip names the biggest server on a small window, summed across rows', () => {
  const tip = P.ctxHint(PARTS, 32768, true);
  assert.ok(tip);
  assert.match(tip[0], /MCP server github takes 23% of the window/);
  assert.match(tip[1], /Settings › Connections › MCP servers/);
  assert.doesNotMatch(tip.join(' '), /agent\.tools|\/mcp/);
});

test('no tip on a big or unknown window, or when nothing is over a tenth', () => {
  assert.equal(P.ctxHint(PARTS, 131072, true), null);
  assert.equal(P.ctxHint(PARTS, null, true), null);
  assert.equal(P.ctxHint([{label: 'persona', tokens: 100}], 32768, false), null);
});

test('built-in tools get the tip only while tool search is off', () => {
  const parts = [{parent: 'prompt scaffold', label: 'built-in tools', tokens: 6000}];
  assert.match(P.ctxHint(parts, 32768, false)[0], /built-in tools take 18%/);
  assert.equal(P.ctxHint(parts, 32768, true), null);
  assert.equal(P.ctxHintHTML(parts, 32768, true, esc), '');
  assert.match(P.ctxHintHTML(parts, 32768, false, esc), /class="cap ctxtip"/);
});
