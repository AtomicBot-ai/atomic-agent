// ATO-1131 / ATO-1133: the built-in MCP server catalog in the Add MCP server
// box. The data is a copy of src/mcp/mcp-catalog-data.ts; this file checks the
// copy's schema, that every entry goes through the box's own parser, and that
// the copy still matches the agent's data when src/ is in the checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../renderer/mcp-catalog.js');
const A = require('../renderer/mcp-smart-add.js');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
const https = (u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };

function fill(entry) {
  let json = C.mcpCatalogJson(entry.id);
  for (const i of entry.inputs) json = json.split(i.placeholder).join(i.secret ? 'test-key-123' : '/tmp/x');
  return json;
}

test('schema: required fields, unique ids, known shelves, https links', () => {
  const shelves = new Set(C.MCP_CATALOG.shelves.map((s) => s.id));
  assert.equal(shelves.size, C.MCP_CATALOG.shelves.length);
  const ids = new Set();
  for (const e of C.MCP_CATALOG.entries) {
    assert.ok(!ids.has(e.id), 'duplicate id ' + e.id);
    ids.add(e.id);
    assert.match(e.id, NAME_RE);
    for (const k of ['title', 'description', 'homepage']) assert.ok(typeof e[k] === 'string' && e[k].trim(), e.id + ' ' + k);
    assert.ok(shelves.has(e.shelf), e.id + ' shelf');
    assert.ok(https(e.homepage), e.id + ' homepage');
    assert.ok((typeof e.server.command === 'string') !== (typeof e.server.url === 'string'), e.id + ' command xor url');
    if (e.server.url) assert.ok(https(e.server.url) && !C.mcpCatalogPlaceholders(e.server.url).length, e.id + ' url');
    const used = C.mcpCatalogPlaceholders(JSON.stringify(e.server)).sort();
    assert.deepEqual(e.inputs.map((i) => i.placeholder).sort(), used, e.id + ' inputs match placeholders');
    for (const i of e.inputs) {
      assert.ok(i.label.trim(), e.id + ' input label');
      if (i.secret) assert.ok(https(i.getUrl), e.id + ' key link');
    }
  }
  assert.equal(C.mcpCatalogList().length, C.MCP_CATALOG.entries.length);
});

test('every entry, filled in, is read by the box as JSON under its id', () => {
  for (const e of C.MCP_CATALOG.entries) {
    const json = fill(e);
    assert.equal(C.mcpCatalogUnfilled(json), null, e.id);
    const r = A.mcpParseAddInput(json, {home:'/home/someone'});
    assert.equal(r.ok, true, e.id + ': ' + r.error);
    assert.equal(r.kind, 'json');
    assert.equal(r.server.name, e.id);
    assert.equal(r.server.transport.kind, e.server.command ? 'stdio' : 'streamable_http');
  }
});

test('an unfilled pick is refused with the placeholder named', () => {
  const json = C.mcpCatalogJson('firecrawl');
  assert.ok(json.includes('"FIRECRAWL_API_KEY": "<your Firecrawl API key>"'));
  assert.equal(C.mcpCatalogUnfilled(json), 'Replace <your Firecrawl API key> with your own value first.');
  assert.equal(C.mcpCatalogJson('no-such-server'), null);
});

test('the Web & growth shelf (ATO-1133)', () => {
  assert.deepEqual(C.mcpCatalogList().filter((e) => e.shelf === 'web-growth').map((e) => e.id),
    ['exa', 'firecrawl', 'apify', 'brightdata', 'tavily', 'brave-search']);
});

test('the catalog block: a chip per server, and the picked one says what to replace and where', () => {
  const plain = C.mcpCatalogHTML({catalogId:null}, {esc});
  for (const e of C.MCP_CATALOG.entries) assert.ok(plain.includes('data-act="mcp:catalog:' + e.id + '"'), e.id);
  assert.ok(!plain.includes('Replace'));
  const picked = C.mcpCatalogHTML({catalogId:'github'}, {esc});
  assert.ok(picked.includes('&lt;your GitHub token&gt;'));
  assert.ok(picked.includes('data-url="https://github.com/settings/personal-access-tokens/new"'));
});

test('new user-facing text has no em dashes', () => {
  const src = readFileSync(new URL('../renderer/mcp-catalog.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('—'));
});

test('the copy matches src/mcp/mcp-catalog-data.ts when src/ is in the checkout', (t) => {
  const core = new URL('../../src/mcp/mcp-catalog-data.ts', import.meta.url);
  if (!existsSync(core)) { t.skip('src/mcp/mcp-catalog-data.ts is not in this checkout yet'); return; }
  const src = readFileSync(core, 'utf8');
  const start = src.indexOf('/* catalog-json-start */');
  const end = src.indexOf('/* catalog-json-end */');
  assert.ok(start > 0 && end > start);
  assert.deepEqual(JSON.parse(src.slice(start + '/* catalog-json-start */'.length, end)), C.MCP_CATALOG);
});

test('renderer: the box shows the catalog, a chip fills it, a submit checks placeholders, index.html loads it first', () => {
  const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const helper = index.indexOf('<script src="mcp-catalog.js">');
  assert.ok(helper > 0 && helper < index.indexOf('<script src="renderer.js">'));
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.ok(src.includes('mcpCatalogHTML(m, {esc})'));
  assert.ok(src.includes("if (verb === 'catalog')"));
  assert.ok(src.includes('mcpCatalogUnfilled(json)'));
  const acts = readFileSync(new URL('../renderer/analytics-acts.js', import.meta.url), 'utf8');
  assert.ok(acts.includes('catalog:L'), 'mcp:catalog:<id> is reported as mcp:catalog');
});
