/**
 * turn-order.drive.mjs — the agent's reply is the last row of its turn, live
 * and after the chat is reopened, and each approval sits where it was asked.
 *
 * The report (2026-09-15 DMG): "end agent results should be the last message
 * within the turn. At this moment approvals are the last ones even though it
 * makes no sense."
 *
 * No real model is involved: a local OpenAI-compatible server stands in for
 * the provider and answers the agent's turn with one `os.fs.write` call and,
 * once the tool result is in the prompt, a plain reply. Everything a person
 * does is a trusted CDP click or keystroke through drive.mjs; Runtime.evaluate
 * only looks. The state directory is a scratch one built from the seed
 * fixture's config with every provider replaced by the fake — no `.env`, no
 * keys, nothing that could reach a real service.
 *
 *   node test/turn-order.drive.mjs [--port 9781] [--bin <atomic-agent>] [--receipts]
 *
 * `--bin` is the agent to run (default: $ATOMIC_AGENT_BIN, else the bundled
 * one). `--receipts` also requires the reopened chat to show the approval
 * receipt, which needs an agent that stores `approvals` on tool_result rows
 * (desktop/turn-fixes); the bundled 0.6.1 does not, and without the flag a
 * reopened chat is only required to end on the reply.
 */

import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launch, sleep, DESKTOP_DIR } from './drive.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const PORT = Number(arg('--port', 9781));
const WANT_RECEIPTS = argv.includes('--receipts');
const BIN = arg('--bin', process.env.ATOMIC_AGENT_BIN || join(DESKTOP_DIR, '..', 'bundle', 'darwin-arm64', 'atomic-agent'));
const SEED_CONFIG = process.env.ATAG_SEED_CONFIG
  || '/private/tmp/claude-501/-Users-valerii-claudecode1/f54533b6-fc7f-408a-a975-1c3fffb17832/scratchpad/seed-configured/config.json';
const REPLY = 'Done — approved.txt is written.';

let passed = 0;
const failed = [];
function check(ok, what, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (ok) passed += 1; else failed.push(what);
}

/* ---------------- the stand-in provider ---------------- */
const wire = { requests: 0, toolCalls: 0, replies: 0 };
function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
}
function chunk(delta, finish = null) {
  return { id: 'fake-1', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake-model',
    choices: [{ index: 0, delta, finish_reason: finish }] };
}
function startFakeProvider(workspace) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (b) => { body += b; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
        return;
      }
      wire.requests += 1;
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch { /* keep {} */ }
      const text = JSON.stringify(json.messages || []);
      const tools = Array.isArray(json.tools) ? json.tools : [];
      // The wire name is the agent's own encoding of `os.fs.write` (dots are
      // not allowed in a function name), so match loosely and say what matched.
      const names = tools.map((t) => t && t.function && t.function.name).filter(Boolean);
      const write = names.find((n) => /(^|[^a-z])fs[^a-z0-9]*write$/i.test(n));
      if (tools.length && !wire.toolName) wire.toolName = write || `none of ${names.length} matched`;
      let message;
      if (write && !/tool_result\[os\.fs\.write/.test(text)) {
        wire.toolCalls += 1;
        const args = JSON.stringify({ path: join(workspace, 'approved.txt'), content: 'moray-firth-2026\n' });
        message = { tool: { name: write, args } };
      } else if (tools.length) {
        wire.replies += 1;
        message = { content: REPLY };
      } else {
        message = { content: 'none' };   // reflection / rewriter sub-calls
      }
      if (json.stream) {
        if (message.tool) {
          sse(res, [
            chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: message.tool.name, arguments: '' } }] }),
            chunk({ tool_calls: [{ index: 0, function: { arguments: message.tool.args } }] }),
            chunk({}, 'tool_calls'),
            { ...chunk({}), choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
          ]);
        } else {
          sse(res, [
            chunk({ role: 'assistant', content: message.content.slice(0, 6) }),
            chunk({ content: message.content.slice(6) }),
            chunk({}, 'stop'),
            { ...chunk({}), choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
          ]);
        }
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'fake-1', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'fake-model',
        choices: [{ index: 0, finish_reason: message.tool ? 'tool_calls' : 'stop',
          message: message.tool
            ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: message.tool.name, arguments: message.tool.args } }] }
            : { role: 'assistant', content: message.content } }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ---------------- the scratch state ---------------- */
function buildState(base, providerPort) {
  const stateDir = join(base, 'state');
  const workspace = join(base, 'workspace');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const cfg = JSON.parse(readFileSync(SEED_CONFIG, 'utf8'));
  // Every cloud entry goes (keys, and a way out to a real service); the local
  // llama-server entries stay because other config leaves name them
  // (`activeEmbeddingProvider`), and they carry no key and are never called.
  cfg.llm.providers = [
    ...(cfg.llm.providers || []).filter((p) => p && p.kind === 'llama-server'),
    { id: 'fake', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      apiKey: 'not-a-real-key', defaultChatModel: 'fake-model' },
  ];
  cfg.llm.activeTextProvider = 'fake';
  delete cfg.llm.fallback;
  cfg.agent.approvalLevel = 1;
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify(cfg, null, 2));
  let bin = BIN;
  if (BIN.endsWith('.js')) {   // a dist/cli/index.js: run it with this node
    bin = join(base, 'atomic-agent-shim');
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
    chmodSync(bin, 0o755);
  }
  return { stateDir, workspace, bin };
}

/* ---------------- looking at the transcript ---------------- */
const ROWS = `[...document.querySelectorAll('#content .turn, #content .sysrow')].map((t) => {
  if (t.classList.contains('sysrow')) return { k: 'system', text: t.innerText.trim().slice(0, 80) };
  if (t.classList.contains('usr')) return { k: 'user', text: t.innerText.trim().slice(0, 80) };
  if (t.querySelector('.appr')) {
    const done = t.querySelector('.appr.done');
    return { k: 'approval', done: !!done, label: ((t.querySelector('.apprlbl b') || {}).textContent || '').trim(),
             badge: ((t.querySelector('.badge') || {}).textContent || '').trim() };
  }
  if (t.querySelector('.card')) return { k: 'tool', name: ((t.querySelector('.cardhead .nm') || {}).textContent || '').trim() };
  if (t.querySelector('.tk-asst')) return { k: 'assistant', text: ((t.querySelector('.prose') || {}).innerText || '').trim() };
  if (t.querySelector('.disc')) return { k: 'reason' };
  if (t.querySelector('.ubub, .user, .tk-user')) return { k: 'user', text: t.innerText.trim().slice(0, 80) };
  return { k: 'other', cls: t.className, text: t.innerText.trim().slice(0, 80) };
})`;
const shape = (rows) => rows.map((r) => r.k === 'tool' ? `tool:${r.name}` : r.k === 'approval' ? `approval${r.done ? ':' + r.label : ':open'}` : r.k).join(' → ');

async function main() {
  const base = join(tmpdir(), `atag-turn-order-${Date.now()}`);
  const provider = await startFakeProvider(join(base, 'workspace'));
  const providerPort = provider.address().port;
  const { stateDir, workspace, bin } = buildState(base, providerPort);
  console.log(`state ${stateDir}\nagent ${BIN}\nprovider http://127.0.0.1:${providerPort}\ncdp ${PORT}`);
  let app = null;
  try {
    app = await launch({ port: PORT, stateDir, workspace, env: { ATOMIC_AGENT_BIN: bin } });
    await app.waitFor(`!!document.querySelector('#entry') && !document.querySelector('#onboarding')`, 'the chat composer', { timeout: 90000 });
    // Sending before the agent is attached is refused with "the agent is
    // still starting" (submit checks S.live.state) — wait for the attach.
    await app.waitFor(`window.__live && window.__live() === 'connected'`, 'the agent attached', { timeout: 90000 });

    await app.clickSel('#entry');
    await app.type('Please write approved.txt in the workspace.', { perChar: 1 });
    await app.clickSel('.sendbtn');

    await app.waitFor(`!!document.querySelector('#apprcard')`, 'the approval card', { timeout: 90000 });
    await sleep(400);
    const pendingRows = await app.eval(ROWS);
    console.log(`while asking: ${shape(pendingRows)}`);
    check(!existsSync(join(workspace, 'approved.txt')), 'the write waits for the verdict');

    await app.clickSel('#apprcard [data-appr="y"]');
    await app.waitFor(`[...document.querySelectorAll('#content .tk-asst .prose')].some((p) => p.innerText.includes(${JSON.stringify(REPLY)}))`
      + ` && !document.querySelector('.statusstrip') && !document.querySelector('.sendbtn.stop')`, 'the reply, turn over', { timeout: 90000 });
    await sleep(2500);   // reconcileToolCards and the trace merge settle
    const liveRows = await app.eval(ROWS);
    console.log(`live, turn over: ${shape(liveRows)}`);
    check(existsSync(join(workspace, 'approved.txt')), 'Approve released the write (the file exists)');
    const liveLast = liveRows[liveRows.length - 1] || {};
    check(liveLast.k === 'assistant' && liveLast.text.includes(REPLY), 'live: the reply is the last row of the turn', shape(liveRows));
    const lt = liveRows.findIndex((r) => r.k === 'tool' && r.name === 'os.fs.write');
    const la = liveRows.findIndex((r) => r.k === 'approval');
    check(lt >= 0 && la === lt + 1 && liveRows[la].label === 'Approved', 'live: the approval sits directly under the call that asked for it', shape(liveRows));
    const sid = await app.eval(`S.agentSession`);
    check(typeof sid === 'string' && sid.length > 0, 'the turn has a stored session', String(sid));

    // Reopen: quit, launch again on the same state, click the chat row.
    await app.close();
    app = null;
    await sleep(1500);
    app = await launch({ port: PORT, stateDir, workspace, env: { ATOMIC_AGENT_BIN: bin } });
    await app.waitFor(`!!document.querySelector('[data-ses="${sid}"]')`, 'the chat row in the sidebar', { timeout: 90000 });
    await app.clickSel(`[data-ses="${sid}"]`);
    await app.waitFor(`[...document.querySelectorAll('#content .tk-asst .prose')].some((p) => p.innerText.includes(${JSON.stringify(REPLY)}))`, 'the reopened transcript', { timeout: 30000 });
    await sleep(1500);
    const storedRows = await app.eval(ROWS);
    console.log(`reopened: ${shape(storedRows)}`);
    const storedLast = storedRows[storedRows.length - 1] || {};
    check(storedLast.k === 'assistant' && storedLast.text.includes(REPLY), 'reopened: the reply is the last row of the turn', shape(storedRows));
    const st = storedRows.findIndex((r) => r.k === 'tool' && r.name === 'os.fs.write');
    const sa = storedRows.findIndex((r) => r.k === 'approval');
    if (WANT_RECEIPTS) {
      check(st >= 0 && sa === st + 1 && storedRows[sa].label === 'Approved' && storedRows[sa].badge === 'file write · workspace',
        'reopened: the stored approval sits directly under its call, as it did live', shape(storedRows));
      check(JSON.stringify(shape(storedRows)) === JSON.stringify(shape(liveRows)), 'reopened and live transcripts have the same shape',
        `live ${shape(liveRows)} | reopened ${shape(storedRows)}`);
    } else {
      check(sa === -1 || sa === st + 1, 'reopened: no approval row out of place', shape(storedRows));
    }
    console.log(`wire: ${JSON.stringify(wire)}`);
  } catch (e) {
    failed.push(`driver: ${e.message}`);
    console.log(`FAIL driver — ${e.message}`);
    if (app) { try { await app.screenshot(join(base, 'failure.png')); console.log(`screenshot ${join(base, 'failure.png')}`); } catch { /* ignore */ } }
  } finally {
    if (app) await app.close().catch(() => {});
    provider.close();
  }
  console.log(`\n${passed} passed, ${failed.length} failed${failed.length ? ': ' + failed.join('; ') : ''}`);
  process.exit(failed.length ? 1 : 0);
}

main();
