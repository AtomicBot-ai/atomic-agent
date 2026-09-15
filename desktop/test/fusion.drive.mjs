#!/usr/bin/env node
/**
 * fusion.drive.mjs — Run mode · Fusion, with trusted input.
 *
 *   env -u OPENROUTER_API_KEY -u AIMLAPI_API_KEY \
 *     ATOMIC_AGENT_BIN=<agent> node test/fusion.drive.mjs <state-dir COPY> <workspace> [shots-dir]
 *
 * The state dir must be a throwaway COPY of a configured fixture: a cloud
 * provider with a key (aimlapi), a second one without (openrouter), the
 * managed local route with nothing on disk. Unset the two key variables in
 * the shell so the copy's .env decides, as it does for the app.
 *
 * Every step is a CDP mouse click or key press; `eval` only looks — at the
 * DOM, and at the copy's config.json, which is where a switch either
 * happened or did not. One exception, named as such: the live worker list
 * needs a real fan-out to appear, so its screenshot (J) is taken on frames
 * fed to the renderer's own onChatEvent; the smoke and the agent's unit test
 * own that path's assertions.
 *
 * Before launch the driver empties every value in the COPY's .env (names
 * kept), so only a provider with an inline key in config.json is keyed.
 * Midway it writes a placeholder OPENROUTER_API_KEY there — the one thing
 * that turns "needs a second provider" into a second provider. No message is
 * ever sent, so no key is ever used.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sleep } from './drive.mjs';

const [stateDir, workspace, shotsArg] = process.argv.slice(2);
if (!stateDir || !workspace) {
  console.error('usage: node test/fusion.drive.mjs <state-dir copy> <workspace> [shots-dir]');
  process.exit(2);
}
const shots = shotsArg || join(stateDir, 'shots');
const port = Number(process.env.FUSION_DRIVE_PORT || 9761);

const results = [];
const check = (name, ok, detail = '') => {
  results.push([name, !!ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
/* The fields a switch writes. Never the whole file: it carries an inline key. */
const cfg = () => {
  const c = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'));
  return {
    active: c.llm && c.llm.activeTextProvider,
    runMode: (c.llm && c.llm.runMode) || null,
    parallel: c.localModels && c.localModels.managed && c.localModels.managed.parallel,
  };
};

/* Fixture prep, before the window exists: the COPY's .env loses every key
   value (names kept, values emptied). A cloud provider keyed only through
   the environment then has no key — which is the "needs a second provider"
   state step A needs — and this driver never holds a real key in memory.
   A provider with an inline key in config.json stays keyed. */
const envPath = join(stateDir, '.env');
if (existsSync(envPath)) {
  writeFileSync(envPath, readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=).*$/, '$1'))
    .join('\n'));
}
const env0 = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';

const app = await launch({ port, stateDir, workspace, env: process.env.ATOMIC_AGENT_BIN ? { ATOMIC_AGENT_BIN: process.env.ATOMIC_AGENT_BIN } : {} });

const until = async (fn, label, timeout = 90000) => {
  const end = Date.now() + timeout;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) throw new Error(`gave up after ${timeout}ms waiting for ${label}`);
    await sleep(300);
  }
};
const chip = (kind) => app.eval(`(() => { const b = document.querySelector('#composer .cfoot [data-sel-open="${kind}"]'); return b ? b.textContent.trim() : null; })()`);
const chips = () => app.eval(`[...document.querySelectorAll('#composer .cfoot [data-sel-open]')].map((b) => [b.dataset.selOpen, b.textContent.trim()])`);
const popRows = () => app.eval(`[...document.querySelectorAll('.selpop .modelrow')].map((r) => [
  (r.querySelector('.nm') || {}).textContent || '', (r.querySelector('.cap') || {}).textContent || '', r.classList.contains('on')])`);
const popTitle = () => app.eval(`(document.querySelector('.selpop .selttl') || {}).textContent || null`);
const fusionRowCap = () => app.eval(`(() => { const r = [...document.querySelectorAll('.selpop .modelrow')].find((n) => (n.querySelector('.nm') || {}).textContent === 'fusion'); return r ? r.querySelector('.cap').textContent : null; })()`);
/* A switch has landed when the file says so AND the composer lock is released on a connected agent. */
const landed = (pred, label) => until(async () => pred(cfg())
  && await app.eval(`window.__swxState().pending === 0 && window.__live() === 'connected'`), label);
const theme = (scheme) => app.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
const shot = async (name) => {
  for (const scheme of ['light', 'dark']) {
    await theme(scheme);
    await sleep(450);
    await app.screenshot(join(shots, `${name}-${scheme}.png`));
  }
  await theme('light');
  await sleep(200);
};
const closePopover = async () => {
  await app.press('Escape');
  await until(() => app.eval(`!document.querySelector('.selpop')`), 'the popover closed', 8000);
};
const slash = async (line) => {
  await app.clickSel('#entry', { scroll: false });
  await app.type(line);
  await app.press('Enter');
  if (await app.eval(`document.querySelector('#entry').value !== ''`)) await app.press('Enter');
};
const lastSystemLine = () => app.eval(`(() => { const r = [...document.querySelectorAll('#scroller .sysrow')].pop(); return r ? r.textContent.trim() : null; })()`);

try {
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1470, height: 923, deviceScaleFactor: 1, mobile: false });
  await app.waitFor(`window.__live && window.__live() === 'connected'`, 'agent connected', { timeout: 90000 });
  await app.waitFor(`!!document.querySelector('#composer .cfoot [data-sel-open="backend"]')`, 'the composer controls');
  check('boots on the cloud route', await chip('backend') === 'cloud', JSON.stringify(await chips()));

  /* A — one provider with a key, nothing on disk: Fusion says why not. */
  await app.clickSel('#composer .cfoot [data-sel-open="backend"]');
  const blocked = 'needs a second provider for the workers — Manage › LLM';
  await until(async () => (await fusionRowCap()) === blocked, 'the fusion row with its pre-flight line', 30000);
  const rowsA = await popRows();
  check('A: Where it runs lists cloud · local · custom · fusion, fusion carrying the pre-flight line',
    JSON.stringify(rowsA.map((r) => r[0])) === '["cloud","local","custom","fusion"]' && rowsA[3][1] === blocked, JSON.stringify(rowsA));
  await shot('A-where-it-runs-blocked');
  const beforeA = JSON.stringify(cfg());
  await app.clickSel('.selpop .modelrow', { nth: 3 });
  const errA = await until(() => app.eval(`(() => { const e = document.querySelector('.selpop .selerr'); return e ? e.textContent.trim() : null; })()`), 'the refusal in the popover', 10000);
  check('A: clicking it refuses in the TUI words and writes nothing', errA === 'fusion: ' + blocked && JSON.stringify(cfg()) === beforeA, errA);
  await closePopover();

  /* B — a second provider has a key: the row unblocks, one click enters Fusion. */
  writeFileSync(envPath, /^OPENROUTER_API_KEY=/m.test(env0)
    ? env0.replace(/^OPENROUTER_API_KEY=.*$/m, 'OPENROUTER_API_KEY=placeholder-not-a-key')
    : env0 + '\nOPENROUTER_API_KEY=placeholder-not-a-key\n');
  await app.clickSel('#composer .cfoot [data-sel-open="backend"]');
  await until(async () => (await fusionRowCap()) === 'cloud plans · 2 local workers', 'the fusion row unblocked', 30000);
  await shot('B-where-it-runs');
  await app.clickSel('.selpop .modelrow', { nth: 3 });
  const painted = await until(async () => (await chip('backend')) === 'fusion', 'the chip paints fusion on the click', 15000);
  await landed((c) => c.runMode && c.runMode.mode === 'fusion', 'Fusion written and the agent back');
  const c1 = cfg();
  check('B: one write — mode fusion, the orchestrator active, both legs pinned',
    painted && c1.active === 'aimlapi' && c1.runMode.fusion && c1.runMode.fusion.orchestratorProvider === 'aimlapi' && c1.runMode.fusion.workerProvider === 'local-llama',
    JSON.stringify({ active: c1.active, runMode: c1.runMode }));
  const ch1 = await chips();
  const has = (list, kind, re) => list.some(([k, t]) => k === kind && re.test(t));
  check('B: the chips are fusion · aimlapi · its model ⇄ workers',
    has(ch1, 'backend', /^fusion$/) && has(ch1, 'provider', /^aimlapi$/) && has(ch1, 'model', /grok-4-6/) && has(ch1, 'workers', /qwen-3\.5-4b/)
      && await app.eval(`!!document.querySelector('#composer .cfoot .fzswap')`), JSON.stringify(ch1));
  const intro = await app.eval(`[...document.querySelectorAll('.sysrow .fz-intro')].map((n) => n.textContent)`);
  check('B: the intro is in the transcript once, naming both legs',
    intro.length === 1 && intro[0].includes('orchestrator') && intro[0].includes('x-ai/grok-4-6 plans') && intro[0].includes('qwen-3.5-4b executes'),
    intro.length + ' intro(s)');
  await shot('B-fusion-chips-intro');

  /* C — the Workers control: pin the workers to the other cloud provider. */
  await app.clickSel('#composer .cfoot [data-sel-open="workers"]');
  await until(async () => (await popTitle()) === 'Workers', 'the Workers popover', 10000);
  await until(async () => (await popRows()).length === 2, 'the workers rows', 15000);
  const rowsC = await popRows();
  check('C: workers rows — openrouter in the cloud, then Download more models…',
    JSON.stringify(rowsC.map((r) => [r[0], r[1]])) === '[["openrouter","workers · in the cloud"],["Download more models…","opens the local models pane"]]', JSON.stringify(rowsC));
  await shot('C-workers-popover');
  await app.clickText('openrouter', { scope: '.selpop' });
  await landed((c) => c.runMode && c.runMode.fusion && c.runMode.fusion.workerProvider === 'openrouter', 'the workers pinned to openrouter');
  const c2 = cfg();
  await until(async () => /qwen3\.7-flash/.test((await chip('workers')) || ''), 'the workers chip names the cloud model', 15000);
  check('C: the workers pin moved, the orchestrator and the mode stayed',
    c2.active === 'aimlapi' && c2.runMode.mode === 'fusion' && c2.runMode.fusion.orchestratorProvider === 'aimlapi', `${JSON.stringify(c2.runMode)} · workers chip ${await chip('workers')}`);

  /* D — the Provider control under Fusion is the orchestrator seat. */
  await app.clickSel('#composer .cfoot [data-sel-open="provider"]');
  await until(async () => (await popTitle()) === 'Provider' && (await popRows()).length >= 3, 'the Provider popover', 10000);
  await until(async () => (await popRows()).every((r) => r[1] !== 'checking keys…'), 'the key facts', 15000);
  const rowsD = await popRows();
  check('D: provider rows read orchestrator, the current one marked',
    JSON.stringify(rowsD) === '[["aimlapi","orchestrator",true],["openrouter","orchestrator",false],["Add a new provider","opens the wizard",false]]', JSON.stringify(rowsD));
  await shot('D-provider-popover');
  await closePopover();

  /* E — ⇄ trades the seats. */
  await app.clickSel('#composer .cfoot .fzswap');
  await landed((c) => c.active === 'openrouter' && c.runMode.fusion.orchestratorProvider === 'openrouter', 'the legs swapped');
  const c3 = cfg();
  await until(async () => (await chip('provider')) === 'openrouter', 'the provider chip follows the swap', 15000);
  check('E: ⇄ trades both pins and the active provider in one write, with no second intro',
    c3.runMode.mode === 'fusion' && c3.runMode.fusion.workerProvider === 'aimlapi'
      && (await app.eval(`document.querySelectorAll('.sysrow .fz-intro').length`)) === 1,
    `${JSON.stringify({ active: c3.active, runMode: c3.runMode })} · ${JSON.stringify(await chips())}`);

  /* F — /runmode status and /runmode workers N, typed. */
  await slash('/runmode status');
  const statusF = await until(async () => { const t = await lastSystemLine(); return t && t.startsWith('Fusion —') ? t : null; }, 'the status line', 10000);
  check('F: /runmode status states both legs', statusF === 'Fusion — orchestrator openrouter (qwen/qwen3.7-flash), 2 workers on aimlapi (x-ai/grok-4-6)', statusF);
  await slash('/runmode workers 3');
  await landed((c) => c.runMode.fusion.workers === 3, 'three workers written');
  const toastF = await until(() => app.eval(`(() => { const t = window.__lastToast(); return t && /^fusion: 3 workers/.test(t.t) ? t.t : null; })()`), 'the workers notice', 20000);
  check('F: /runmode workers 3 writes the count and the llama-server slots together, with the TUI notice',
    cfg().parallel === 3 && toastF === 'fusion: 3 workers — restart the local daemon (Manage › LLM › Local, `s`) to apply --parallel 3', toastF);

  /* G — Settings › LLM: the same state, the same write path. */
  await app.clickSel('.sb-settings');
  await app.clickText('LLM', { scope: '#settings' });
  await until(() => app.eval(`!!document.querySelector('#settings .llm-rm.on')`), 'the Run mode cards', 20000);
  const card = await app.eval(`({on: document.querySelector('#settings .llm-rm.on').dataset.act,
    workers: (document.querySelector('#settings .llm-workerseg .on') || {}).textContent,
    n: document.querySelectorAll('#settings .llm-workerseg button').length,
    status: (document.querySelector('#settings .llm-rm-status') || {}).textContent})`);
  check('G: Settings › LLM — Fusion active, 3 of workers 1–8, the resolved status',
    card.on === 'runmode:fusion' && card.workers === '3' && card.n === 8 && /^Fusion — orchestrator openrouter/.test(card.status), JSON.stringify(card));
  await app.eval(`(() => { const n = document.querySelector('#settings .llm-runmode'); if (n) n.scrollIntoView({block:'start'}); return true; })()`);
  await shot('G-settings-llm-run-mode');
  await app.clickSel('#settings .llm-workerseg button', { nth: 1 });
  await landed((c) => c.runMode.fusion.workers === 2 && c.parallel === 2, 'two workers written from the card');
  const msgG = await until(() => app.eval(`(() => { const t = document.querySelector('#settings') ? document.querySelector('#settings').textContent : ''; return /fusion: 2 workers/.test(t) ? 'shown' : null; })()`), 'the notice on the pane', 20000);
  check('G: the card writes through the composer\'s path and says so on the pane', msgG === 'shown');
  await app.clickSel('#settings .iconbtn[data-act="settings:close"]');

  /* H — Backend › cloud leaves Fusion in the file, not only on the chip. */
  await app.clickSel('#composer .cfoot [data-sel-open="backend"]');
  await until(async () => (await popRows()).length === 4, 'the backend rows', 10000);
  await app.clickSel('.selpop .modelrow', { nth: 0 });
  await landed((c) => c.runMode && c.runMode.mode !== 'fusion', 'Fusion left in the file');
  const c5 = cfg();
  await until(async () => (await chip('backend')) === 'cloud', 'the chip reads cloud', 15000);
  check('H: Backend › cloud writes mode cloud with the provider — the chip and the file agree',
    c5.runMode.mode === 'cloud' && c5.active === 'openrouter' && (await chip('workers')) === null, JSON.stringify({ active: c5.active, mode: c5.runMode.mode }));

  /* I — /runmode fusion from the composer comes back in. */
  await slash('/runmode fusion');
  await landed((c) => c.runMode.mode === 'fusion' && c.active === 'openrouter', 'Fusion re-entered');
  await until(async () => (await chip('backend')) === 'fusion', 'the chip reads fusion', 15000);
  check('I: /runmode fusion re-enters on the pins it had', cfg().runMode.fusion.orchestratorProvider === 'openrouter', JSON.stringify(cfg().runMode));

  /* J — the live worker list. SYNTHETIC: frames fed to the renderer's own
     handler on a stand-in turn, for the screenshot only (see the header). */
  await app.eval(`(() => {
    S.turnId = 'drive-synthetic'; S.busy = true; S.phase = 'fusion.delegate';
    const item = {id: nid(), k: 'assistant', text: ''}; S.streamId = item.id; S.log.push(item);
    const f = (task_id, title, phase, extra) => onChatEvent({turnId: 'drive-synthetic', kind: 'fusion_worker',
      payload: Object.assign({object: 'atomic.fusion_worker', task_id, title, phase, role: 'worker', model: 'qwen/qwen3.7-flash'}, extra || {})});
    onChatEvent({turnId: 'drive-synthetic', kind: 'fusion_worker', payload: {object: 'atomic.fusion_worker', task_id: 'fusion.delegate', title: '3 tasks', phase: 'tool', role: 'orchestrator', model: 'qwen/qwen3.7-flash', tool: 'fusion.delegate'}});
    f('t1', 'write the parser', 'started'); f('t1', 'write the parser', 'tool', {tool: 'os.fs.write'});
    f('t2', 'unit tests', 'started'); f('t2', 'unit tests', 'tool', {tool: 'os.shell.run'});
    f('t3', 'README section', 'started'); f('t3', 'README section', 'finished', {step_count: 4, summary: 'wrote README.md'});
    return true; })()`);
  await sleep(300);
  const strip = await app.eval(`[...document.querySelectorAll('.composerwrap .fzlive .fzt')].map((n) => n.textContent)`);
  await shot('J-live-workers-SYNTHETIC');
  check('J (synthetic frames): the list sits under the composer, three lines, no control of its own',
    strip.length === 3 && (await app.eval(`document.querySelectorAll('.composerwrap .fzlive button, .composerwrap .fzlive [data-act]').length`)) === 0,
    JSON.stringify(strip));
  await app.eval(`(() => { S.log = S.log.filter((m) => !m.fusion && m.id !== S.streamId); S.busy = false; S.turnId = null; FZ.live = []; render(); return true; })()`);
} catch (err) {
  check('the driven pass ran to the end', false, err && err.message ? err.message : String(err));
  try { await app.screenshot(join(shots, 'failure.png')); } catch { /* the window is gone */ }
} finally {
  writeFileSync(envPath, env0);
  await app.close();
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed · screenshots in ${shots}`);
process.exit(failed ? 1 : 0);
