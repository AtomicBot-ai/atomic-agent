// Agent 0.6.6 live routes, driven: MCP Restart and on/off, the MCP list and
// "Name chats automatically" written through PATCH /api/config, and the
// Diagnostics "Agent process" row from /health.
//
//   cd desktop && npm run build && (cd .. && npm run build)
//   node test/live-routes.drive.mjs [--port 9431] [--keep] [--shots <dir>]
//
// Needs the agent built from this checkout (`npm run build` at the repo
// root): the routes are 0.6.6, and drive.mjs points the app at dist/ when
// it is there. Runs on a throwaway state directory under the OS temp dir.
// The MCP servers are a tiny stdio fixture written with the SDK the agent
// already depends on, so nothing is downloaded.
//
// Navigation between Settings panes goes through the smoke hooks; every
// control this change added is pressed with a trusted click.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { launch, REPO_DIR, sleep } from './drive.mjs';

const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1]) || 9431;
const keep = argv.includes('--keep');
const shots = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : null;
const shot = async (name) => { if (shots) await app.screenshot(join(shots, name + '.png')); };

const cli = join(REPO_DIR, 'dist', 'cli', 'index.js');
const sdk = join(REPO_DIR, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'server');

const root = mkdtempSync(join(tmpdir(), 'atag-live-routes-'));
const stateDir = join(root, 'state');
const workspace = join(root, 'ws');
const configFile = join(stateDir, 'config.json');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const readConfig = () => JSON.parse(readFileSync(configFile, 'utf8'));

// --- the fixture MCP server: one tool, stdio ---------------------------------
const fixture = join(root, 'mcp-fixture.mjs');
writeFileSync(fixture, [
  `import { McpServer } from ${JSON.stringify(pathToFileURL(join(sdk, 'mcp.js')).href)};`,
  `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(join(sdk, 'stdio.js')).href)};`,
  `const s = new McpServer({ name: 'fixture', version: '1.0.0' });`,
  `s.tool('ping', 'Answers pong', async () => ({ content: [{ type: 'text', text: 'pong' }] }));`,
  `await s.connect(new StdioServerTransport());`,
].join('\n'));
const server = (name) => ({ name, transport: { kind: 'stdio', command: process.execPath, args: [fixture] } });

// --- a configured state dir: past the first-run wizard, one MCP server -------
execFileSync(process.execPath, [cli, 'config', 'get'], { env: { ...process.env, ATOMIC_AGENT_STATE_DIR: stateDir }, stdio: 'ignore' });
const seeded = readConfig();
seeded.tui = { ...(seeded.tui || {}), onboarding: { ...((seeded.tui || {}).onboarding || {}), skippedAt: new Date().toISOString() } };
seeded.mcp = { ...(seeded.mcp || {}), servers: [server('fixture')] };
writeFileSync(configFile, JSON.stringify(seeded, null, 2));

const app = await launch({ port, stateDir, workspace, verbose: false });
const text = (sel) => app.eval(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); return n ? n.textContent.trim() : null; })()`);
const rowChip = (name) => app.eval(`(() => { const r = document.querySelector('#settings [data-mcp-row=${JSON.stringify(name)}]');
  if (!r) return null; const c = r.querySelector('.sd-srvname .tk-chip'); return c ? c.textContent.trim() : null; })()`);
const notice = () => app.eval(`(() => [...document.querySelectorAll('#settings .sd-mcp .tk-notice')].map((n) => n.textContent.trim()).join(' | '))()`);

try {
  await app.waitFor(`window.atomic && window.atomic.health().then((r) => r.ok)`, 'agent answers /health', { timeout: 90000 });

  // ---- 1. MCP: Restart and on/off on the row ----
  await app.eval(`window.__settingsOpen('mcp')`);
  await app.waitFor(`!!document.querySelector('#settings [data-mcp-row="fixture"]')`, 'the fixture row');
  check('mcp: an untouched row keeps the unknown state chip', (await rowChip('fixture')) === 'state —', await rowChip('fixture'));

  await app.clickSel('#settings [data-act="mcp:restart:fixture"]');
  await app.waitFor(`(() => { const r = document.querySelector('#settings [data-mcp-row="fixture"] .sd-srvname .tk-chip'); return r && r.textContent.trim() === 'running'; })()`, 'fixture running', { timeout: 30000 });
  check('mcp: Restart reports the live state on the row', (await rowChip('fixture')) === 'running');
  await shot('mcp-running');
  check('mcp: and says what happened', /fixture is running with 1 tool\./.test(await notice()), await notice());

  await app.clickSel('#settings [data-act="mcp:toggle:fixture"]');
  await app.waitFor(`(() => { const r = document.querySelector('#settings [data-mcp-row="fixture"] .sd-srvname .tk-chip'); return r && r.textContent.trim() === 'disabled'; })()`, 'fixture disabled', { timeout: 30000 });
  const off = readConfig().mcp.servers.find((s) => s.name === 'fixture');
  check('mcp: the switch turns it off and persists enabled:false', off && off.enabled === false, JSON.stringify(off));
  await shot('mcp-disabled');
  check('mcp: a disabled row offers no Restart', !(await app.eval(`!!document.querySelector('#settings [data-act="mcp:restart:fixture"]')`)));

  await app.clickSel('#settings [data-act="mcp:toggle:fixture"]');
  await app.waitFor(`(() => { const r = document.querySelector('#settings [data-mcp-row="fixture"] .sd-srvname .tk-chip'); return r && r.textContent.trim() === 'running'; })()`, 'fixture back on', { timeout: 30000 });
  const on = readConfig().mcp.servers.find((s) => s.name === 'fixture');
  check('mcp: the switch turns it back on and running', on && on.enabled !== false && (await rowChip('fixture')) === 'running', JSON.stringify(on));

  // ---- 3. MCP add / remove through PATCH: the new server is live-connectable ----
  const added = await app.eval(`window.__mcpAddSubmit(${JSON.stringify(JSON.stringify(server('second')))})`);
  check('mcp add: written through PATCH (no app restart asked)', added.ok && /Press Restart on its row/.test(added.state.msg), added.state && added.state.msg);
  check('mcp add: the first server is untouched on disk', readConfig().mcp.servers.map((s) => s.name).join(',') === 'fixture,second');
  await app.waitFor(`!!document.querySelector('#settings [data-act="mcp:restart:second"]')`, 'second row');
  await app.clickSel('#settings [data-act="mcp:restart:second"]');
  await app.waitFor(`(() => { const r = document.querySelector('#settings [data-mcp-row="second"] .sd-srvname .tk-chip'); return r && r.textContent.trim() === 'running'; })()`, 'second running', { timeout: 30000 });
  check('mcp add: Restart connects the new server without restarting the app', (await rowChip('second')) === 'running');
  const removed = await app.eval(`window.__mcpRemove('second')`);
  check('mcp remove: disconnects and drops it, no restart asked', /removed "second".*\.$/.test(removed.msg) && !/restart/i.test(removed.msg), removed.msg);
  check('mcp remove: the other server stays', readConfig().mcp.servers.map((s) => s.name).join(',') === 'fixture');

  // ---- 2 + 3. Name chats automatically, through PATCH ----
  await app.eval(`window.__settingsOpen('general')`);
  await app.waitFor(`!!document.querySelector('#settings [data-act="names:toggle"]:not([disabled])')`, 'the naming switch');
  check('general: the switch reads On by default', (await text('#settings [data-act="names:toggle"]')) !== null
    && (await app.eval(`document.querySelector('#settings [data-act="names:toggle"]').getAttribute('aria-checked')`)) === 'true');
  await shot('general');
  const before = readConfig();
  await app.clickSel('#settings [data-act="names:toggle"]');
  await app.waitFor(`document.querySelector('#settings [data-act="names:toggle"]').getAttribute('aria-checked') === 'false'`, 'switch off');
  const after = readConfig();
  check('general: the switch writes agent.nameSessions:false', after.agent && after.agent.nameSessions === false);
  check('general: the deep merge kept every other block', JSON.stringify(after.mcp) === JSON.stringify(before.mcp)
    && JSON.stringify(after.tui) === JSON.stringify(before.tui) && JSON.stringify(after.llm) === JSON.stringify(before.llm)
    && Object.keys(after.agent).length === Object.keys(before.agent).length + (before.agent && 'nameSessions' in before.agent ? 0 : 1));
  const nc = await app.eval('window.__nameChats()');
  check('general: live, so no restart note', !nc.note && !nc.error, JSON.stringify(nc));
  await app.clickSel('#settings [data-act="names:toggle"]');
  await app.waitFor(`document.querySelector('#settings [data-act="names:toggle"]').getAttribute('aria-checked') === 'true'`, 'switch on');
  check('general: and back on', readConfig().agent.nameSessions === true);

  // ---- 4. Diagnostics: the agent process row ----
  await app.eval(`window.__settingsOpen('diagnostics')`);
  await app.waitFor(`/Agent process/.test(document.querySelector('#settings .setbody').innerText)`, 'agent process row', { timeout: 15000 });
  await shot('diagnostics');
  const diag = await app.eval(`document.querySelector('#settings .setbody').innerText`);
  check('diagnostics: pid and idle from /health', /Agent process\s+pid \d+ · idle/.test(diag), (diag.match(/Agent process[^\n]*\n?[^\n]*/) || [''])[0]);
} catch (err) {
  check('run finished', false, err instanceof Error ? err.message : String(err));
} finally {
  await app.close();
  await sleep(200);
  if (!keep) rmSync(root, { recursive: true, force: true });
  else console.log(`kept ${root}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
