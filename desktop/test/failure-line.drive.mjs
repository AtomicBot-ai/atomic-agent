/**
 * F2 — a failure a person can act on.
 *
 * The tester's screen said `turn failed [transport]: fetch failed`. Neither
 * half of that is hers: `transport` is the agent's category enum, `fetch
 * failed` is undici's string, and between them they name no provider, no host
 * and no next move. She could not tell which endpoint had died, and neither
 * could we from the trace.
 *
 * The scenario is a provider whose host does not resolve, and a real turn
 * sent to it by typing into the composer and pressing Enter.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, sleep } from './drive.mjs';

const DIR = process.env.ATAG_F2_DIR || '/tmp/atag-drive-f2';
const PORT = Number(process.env.ATAG_F2_PORT || 9484);
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
};

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
{
  const seedDir = `${DIR}-seed`;
  rmSync(seedDir, { recursive: true, force: true });
  mkdirSync(seedDir, { recursive: true });
  const bin = process.env.ATAG_BIN || join(process.env.HOME || '', 'atag-agent', 'bin', 'atag');
  execFileSync(bin, ['config', 'get'], { env: { ...process.env, ATOMIC_AGENT_STATE_DIR: seedDir }, stdio: 'ignore' });
  const cfg = JSON.parse(readFileSync(join(seedDir, 'config.json'), 'utf8'));
  cfg.llm = cfg.llm || {};
  cfg.llm.providers = [
    ...(cfg.llm.providers || []).filter((p) => p.id !== 'aimlapi' && p.id !== 'local-llama'),
    { id: 'local-llama', kind: 'llama-server' },
    { id: 'aimlapi', kind: 'aimlapi', baseUrl: 'https://api.aimlapi.invalid', apiKeyEnvVar: 'AIMLAPI_API_KEY',
      defaultChatModel: 'gpt-4o-mini' },
  ];
  cfg.llm.activeTextProvider = 'aimlapi';
  cfg.llm.activeEmbeddingProvider = 'local-llama';
  cfg.tui = cfg.tui || {};
  cfg.tui.onboarding = { ...(cfg.tui.onboarding || {}), completedAt: new Date().toISOString() };
  writeFileSync(join(DIR, 'config.json'), JSON.stringify(cfg, null, 2));
  /* A key, so the turn is actually attempted rather than refused up front —
     the host is what fails here, not the absence of a credential. */
  writeFileSync(join(DIR, '.env'), 'AIMLAPI_API_KEY=sk-placeholder-for-an-unreachable-host\n', { mode: 0o600 });
}

const app = await launch({ port: PORT, stateDir: DIR, workspace: '/tmp/atag-drive-f2-ws' });
try {
  await app.waitFor(`!!document.querySelector('textarea')`, 'the composer', { timeout: 40000 });
  /* Wait for the AGENT, not just the window. `atag serve` takes its time to
     come up when the configured provider does not resolve, and a message sent
     before then is refused with "the agent is still starting" and handed back
     — so the turn under test never happens and the wait below times out
     against a transcript that was never going to fill. */
  await app.waitFor(`window.__live && window.__live() === 'connected'`,
    'the agent to connect', { timeout: 180000 });
  await app.clickSel('textarea', { scroll: false });
  await app.type('say hello');
  await app.press('Enter');

  await app.waitFor(
    `[...document.querySelectorAll('.sysrow')].some(n => /not answering|could not be completed/i.test(n.textContent||''))`,
    'the failure line', { timeout: 300000 });

  const line = await app.eval(
    `([...document.querySelectorAll('.sysrow')].find(n => /not answering|could not be completed/i.test(n.textContent||''))||{}).textContent || ''`);
  const all = await app.eval(`document.body.textContent || ''`);

  check('the failure names the provider', /aimlapi/i.test(line), JSON.stringify(line.slice(0, 160)));
  check('the failure names the host', /aimlapi\.invalid/.test(line), JSON.stringify(line.slice(0, 160)));
  check('it says how long the turn waited', /after \d+/.test(line), JSON.stringify(line.slice(0, 160)));
  check('no agent jargon reaches the transcript',
    !/\[transport\]|fetch failed|undici|ECONN/i.test(all),
    `transport=${/\[transport\]/.test(all)} fetchFailed=${/fetch failed/i.test(all)}`);
  check('the one useful action is offered on the row',
    await app.eval(`!!document.querySelector('.sysrow .sysact')`),
    await app.eval(`(document.querySelector('.sysrow .sysact')||{}).textContent || '(none)'`));

  await app.screenshot('/tmp/f2-failure.png');
} finally {
  await app.close();
}
const failed = results.filter((r) => !r.pass).length;
console.log(`F2 DRIVE: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
