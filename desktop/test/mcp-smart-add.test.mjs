// ATO-510 (U-74): the Add MCP server box takes JSON, a command or a URL and
// writes the same `mcp.servers` entry the JSON path always wrote. The helpers
// come from renderer/mcp-smart-add.js; the renderer wiring is checked by
// source shape (the box's review block, the name field, the script order).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../renderer/mcp-smart-add.js');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const HOME = '/home/someone';

/* ---------------- detection ---------------- */

test('detects JSON, an address and a command', () => {
  assert.equal(M.mcpDetectAddInput(''), '');
  assert.equal(M.mcpDetectAddInput('   \n'), '');
  assert.equal(M.mcpDetectAddInput(' {"name":"x"}'), 'json');
  assert.equal(M.mcpDetectAddInput('https://mcp.linear.app/sse'), 'url');
  assert.equal(M.mcpDetectAddInput('http://localhost:3000/mcp'), 'url');
  assert.equal(M.mcpDetectAddInput('npx -y @modelcontextprotocol/server-filesystem ~/Docs'), 'command');
  assert.equal(M.mcpDetectAddInput('https://a.example/x and more'), 'command');
});

/* ---------------- JSON keeps working ---------------- */

test('JSON: the envelope, a bare object and the url shortcut give the same entries as before', () => {
  const env = M.mcpParseAddInput('{"mcpServers":{"github":{"command":"npx","args":["-y","@github/mcp-server"],"env":{"GITHUB_TOKEN":"t"}}}}');
  assert.equal(env.ok, true);
  assert.equal(env.kind, 'json');
  assert.deepEqual(env.server, {name:'github', env:{GITHUB_TOKEN:'t'}, transport:{kind:'stdio', command:'npx', args:['-y', '@github/mcp-server']}});
  const bare = M.mcpParseAddInput('{"name":"files","command":"node","args":["s.js"]}');
  assert.deepEqual(bare.server, {name:'files', transport:{kind:'stdio', command:'node', args:['s.js']}});
  const remote = M.mcpParseAddInput('{"mcpServers":{"linear":{"type":"sse","url":"https://mcp.linear.app/sse"}}}');
  assert.deepEqual(remote.server, {name:'linear', transport:{kind:'sse', url:'https://mcp.linear.app/sse'}});
  // The JSON path and the old parser agree.
  assert.deepEqual(M.mcpParseAddJson('{"name":"files","command":"node"}').server, M.mcpParseAddInput('{"name":"files","command":"node"}').server);
});

test('JSON: errors stay as they were, and a name typed in the box does not rename a JSON server', () => {
  assert.match(M.mcpParseAddInput('{"mcpServers":{}}').error, /empty/);
  assert.match(M.mcpParseAddInput('{"mcpServers":{"a":{},"b":{}}}').error, /exactly one server/);
  assert.match(M.mcpParseAddInput('{"command":"x"').error, /valid JSON/);
  assert.match(M.mcpParseAddInput('{"command":"x"}').error, /name/);
  assert.equal(M.mcpParseAddInput('{"name":"keep","command":"x"}', {name:'other'}).server.name, 'keep');
});

/* ---------------- commands ---------------- */

test('command: the README line from the issue becomes a stdio server named after the package', () => {
  const r = M.mcpParseAddInput('npx -y @modelcontextprotocol/server-filesystem ~/Docs', {home:HOME});
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'command');
  assert.deepEqual(r.server, {name:'filesystem', transport:{kind:'stdio', command:'npx', args:['-y', '@modelcontextprotocol/server-filesystem', HOME + '/Docs']}});
});

test('command: ~ is left as typed when the home folder is unknown', () => {
  const r = M.mcpParseAddInput('npx -y @modelcontextprotocol/server-filesystem ~/Docs');
  assert.equal(r.server.transport.args[2], '~/Docs');
});

test('command: quotes, escapes, line continuations and a leading $ prompt', () => {
  const r = M.mcpParseAddInput('$ npx -y @scope/server-notes \\\n  --root "My Notes/2026" \'a b\' c\\ d "say \\"hi\\""');
  assert.equal(r.ok, true);
  assert.deepEqual(r.server.transport.args, ['-y', '@scope/server-notes', '--root', 'My Notes/2026', 'a b', 'c d', 'say "hi"']);
  assert.equal(r.server.name, 'notes');
  assert.match(M.mcpParseAddInput('npx "unclosed').error, /not closed/);
});

test('command: KEY=value prefixes become env, and env values never reach the review block', () => {
  const r = M.mcpParseAddInput('GITHUB_TOKEN=ghp_secret123 env_two=2 docker run -i --rm -e GITHUB_TOKEN ghcr.io/github/github-mcp-server');
  assert.equal(r.ok, true);
  assert.deepEqual(r.server.env, {GITHUB_TOKEN:'ghp_secret123', env_two:'2'});
  assert.equal(r.server.transport.command, 'docker');
  assert.equal(r.server.name, 'github');
  const html = M.mcpAddPreviewHTML(r, null, {esc});
  assert.ok(html.includes('GITHUB_TOKEN, env_two (values hidden)'));
  assert.ok(!html.includes('ghp_secret123'));
  // A leading `env` word is the shell's env command, not the server.
  assert.equal(M.mcpParseAddInput('env A=1 uvx mcp-server-git').server.transport.command, 'uvx');
});

test('command: names come from the package, module or file', () => {
  const name = (line) => M.mcpParseAddInput(line).server.name;
  assert.equal(name('uvx mcp-server-git --repository .'), 'git');
  assert.equal(name('python -m mcp_server_time --local-timezone=UTC'), 'time');
  assert.equal(name('npx -y @github/mcp-server'), 'github');
  assert.equal(name('npx -y @playwright/mcp@latest'), 'playwright');
  assert.equal(name('npx -y firecrawl-mcp'), 'firecrawl');
  assert.equal(name('pnpm dlx @upstash/context7-mcp'), 'context7');
  assert.equal(name('node /opt/tools/weather-server.js'), 'weather');
  assert.equal(name('/usr/local/bin/my-tool --stdio'), 'my-tool');
});

test('command: a typed name replaces the made-up one and is checked against the agent rule', () => {
  const r = M.mcpParseAddInput('uvx mcp-server-git', {name:'repo-tools'});
  assert.equal(r.server.name, 'repo-tools');
  assert.equal(r.auto, 'git');
  const bad = M.mcpParseAddInput('uvx mcp-server-git', {name:'Repo Tools'});
  assert.equal(bad.ok, false);
  assert.equal(bad.auto, 'git');
  assert.match(bad.error, /lowercase letters, digits and dashes/);
  // Nothing usable to make a name from: the box asks for one.
  const none = M.mcpParseAddInput('x');
  assert.equal(none.ok, false);
  assert.equal(none.auto, '');
  assert.match(none.error, /Type a name/);
  assert.equal(M.mcpParseAddInput('x', {name:'xx'}).server.name, 'xx');
});

test('command: `claude mcp add` lines keep their name, env and transport', () => {
  const stdio = M.mcpParseAddInput('claude mcp add airtable --env AIRTABLE_API_KEY=key -- npx -y airtable-mcp-server');
  assert.deepEqual(stdio.server, {name:'airtable', env:{AIRTABLE_API_KEY:'key'}, transport:{kind:'stdio', command:'npx', args:['-y', 'airtable-mcp-server']}});
  const http = M.mcpParseAddInput('claude mcp add --transport http notion https://mcp.notion.com/mcp');
  assert.deepEqual(http.server, {name:'notion', transport:{kind:'streamable_http', url:'https://mcp.notion.com/mcp'}});
  const sse = M.mcpParseAddInput('claude mcp add -t sse -H "Authorization: Bearer abc" linear https://mcp.linear.app/events');
  assert.deepEqual(sse.server, {name:'linear', transport:{kind:'sse', url:'https://mcp.linear.app/events', headers:{Authorization:'Bearer abc'}}});
  assert.ok(!M.mcpAddPreviewHTML(sse, null, {esc}).includes('Bearer abc'));
});

test('command: the splitter on its own', () => {
  assert.deepEqual(M.mcpSplitCommand('  a   b\t"c d"  \'\' ').tokens, ['a', 'b', 'c d', '']);
  assert.deepEqual(M.mcpSplitCommand('a \\\r\n b').tokens, ['a', 'b']);
});

/* ---------------- addresses ---------------- */

test('address: https becomes streamable HTTP, a path ending in /sse becomes SSE, the name comes from the host', () => {
  assert.deepEqual(M.mcpParseAddInput('https://mcp.deepwiki.com/mcp').server, {name:'deepwiki', transport:{kind:'streamable_http', url:'https://mcp.deepwiki.com/mcp'}});
  assert.deepEqual(M.mcpParseAddInput('https://mcp.linear.app/sse').server, {name:'linear', transport:{kind:'sse', url:'https://mcp.linear.app/sse'}});
  assert.equal(M.mcpParseAddInput('https://huggingface.co/mcp').server.name, 'huggingface');
  assert.equal(M.mcpParseAddInput('http://localhost:8931/mcp').server.name, 'local');
  assert.equal(M.mcpParseAddInput('http://127.0.0.1:8931/sse').server.transport.kind, 'sse');
  assert.equal(M.mcpParseAddInput('https://api.example.com/mcp', {name:'mine'}).server.name, 'mine');
});

test('names are always ones the agent accepts', () => {
  for (const s of ['@a/b', 'UPPER_case', 'x'.repeat(60), '--', 'mcp-server']) {
    const n = M.mcpSlug(M.mcpNameFromPackage(s));
    if (n) assert.match(n, /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/);
  }
  assert.equal(M.mcpSlug('x'.repeat(60)).length, 32);
});

/* ---------------- the review block ---------------- */

test('review block: says what was detected, with an editable name for a command or address only', () => {
  const cmd = M.mcpAddPreviewHTML(M.mcpParseAddInput('uvx mcp-server-git'), null, {esc});
  assert.ok(cmd.includes('Command (runs on this computer)'));
  assert.ok(cmd.includes('id="mcp-name"') && cmd.includes('value="git"'));
  assert.ok(cmd.includes('mcp-server-git'));
  // The typed name is kept while the user edits it.
  assert.ok(M.mcpAddPreviewHTML(M.mcpParseAddInput('uvx mcp-server-git', {name:'g'}), 'g', {esc}).includes('value="g"'));
  const url = M.mcpAddPreviewHTML(M.mcpParseAddInput('https://mcp.linear.app/sse'), null, {esc});
  assert.ok(url.includes('Remote server (address)') && url.includes('SSE'));
  const json = M.mcpAddPreviewHTML(M.mcpParseAddInput('{"name":"files","command":"node"}'), null, {esc});
  assert.ok(json.includes('JSON config') && !json.includes('id="mcp-name"') && json.includes('files'));
  assert.equal(M.mcpAddPreviewHTML(M.mcpParseAddInput(''), null, {esc}), '');
  // A bad JSON paste still says what it was taken for.
  assert.ok(M.mcpAddPreviewHTML(M.mcpParseAddInput('{"a":'), null, {esc}).includes('JSON config'));
});

test('new user-facing text has no em dashes', () => {
  const src = readFileSync(new URL('../renderer/mcp-smart-add.js', import.meta.url), 'utf8');
  for (const m of src.matchAll(/'[^'\n]*'/g)) assert.ok(!m[0].includes('—'), m[0]);
});

/* ---------------- wiring ---------------- */

test('renderer: the box reads through mcp-smart-add.js and index.html loads it first', () => {
  const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const helper = index.indexOf('<script src="mcp-smart-add.js">');
  assert.ok(helper > 0 && helper < index.indexOf('<script src="renderer.js">'));
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.ok(src.includes('<div id="mcp-detect">'));
  assert.ok(src.includes('mcpParseAddInput(m.json'));
  assert.ok(!/^function mcpParseAddJson/m.test(src), 'the JSON parser lives in mcp-smart-add.js only');
  assert.ok(src.includes("e.target.id === 'mcp-name'"));
});
