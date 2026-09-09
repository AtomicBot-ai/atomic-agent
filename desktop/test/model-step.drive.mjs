/**
 * F6 — a model step after the key, always.
 *
 * "Я выбрала аимлапи и типо ввела ключ — а какая модель у меня выберется?"
 * had no answer anywhere on screen: the wizard took the kind's default model
 * silently and went straight to the completion screen.
 *
 * Everything below is clicked and typed. The provider is reached the way a
 * person reaches it — through the composer's provider chip — on a config that
 * has a provider and no key.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, sleep } from './drive.mjs';

const DIR = process.env.ATAG_F6_DIR || '/tmp/atag-drive-f6';
const PORT = Number(process.env.ATAG_F6_PORT || 9488);
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
};

const key = (() => {
  const env = process.env.ATAG_TEST_ENV
    || (process.env.ATOMIC_AGENT_STATE_DIR ? join(process.env.ATOMIC_AGENT_STATE_DIR, '.env') : '');
  if (!env) return null;
  try {
    const m = readFileSync(env, 'utf8').match(/^AIMLAPI_API_KEY=(.*)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
})();
if (!key) {
  console.log('SKIP the model step drive — no AIMLAPI_API_KEY to reach a real catalogue with.');
  process.exit(0);
}

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
    { id: 'aimlapi', kind: 'aimlapi', apiKeyEnvVar: 'AIMLAPI_API_KEY' },
  ];
  cfg.llm.activeTextProvider = 'aimlapi';
  cfg.llm.activeEmbeddingProvider = 'local-llama';
  cfg.tui = cfg.tui || {};
  cfg.tui.onboarding = { ...(cfg.tui.onboarding || {}), completedAt: new Date().toISOString() };
  writeFileSync(join(DIR, 'config.json'), JSON.stringify(cfg, null, 2));
}

const app = await launch({ port: PORT, stateDir: DIR, workspace: '/tmp/atag-drive-f6-ws' });
try {
  await app.waitFor(`!!document.querySelector('textarea')`, 'the window', { timeout: 40000 });
  await app.waitFor(
    `!/no provider/.test((document.querySelector('[data-sel-open="provider"]')||{}).textContent||'no provider')`,
    'the composer to know its provider', { timeout: 40000 });
  await app.clickSel('[data-sel-open="provider"]', { timeout: 20000 });
  await sleep(700);
  await app.waitFor(
    `!/checking keys/.test((document.querySelector('#overlays .modelrow')||{}).textContent||'checking keys')`,
    'the provider row to settle', { timeout: 30000 });
  await app.clickSel('#overlays .modelrow', { nth: 0, timeout: 12000 });
  await app.waitFor(`!!document.querySelector('#wiz-key')`, 'the key screen', { timeout: 30000 });

  await app.clickSel('#wiz-key', { scroll: false });
  await app.typeSecret(key, 'the AI/ML API key');
  await app.clickText('Next');

  await app.waitFor(`!!document.querySelector('[data-wizmodel]')`, 'the model step', { timeout: 120000 });

  const step = await app.eval(`(() => {
    const rows = [...document.querySelectorAll('[data-wizmodel]')];
    const on = document.querySelector('[data-wizmodel].on');
    const def = document.querySelector('[data-wizmodel] .ann');
    return {
      rows: rows.length,
      preselected: on ? on.getAttribute('data-wizmodel') : null,
      defaultMarked: def ? def.textContent.trim() : null,
      defaultIsPreselected: !!(on && on.querySelector('.ann')),
      buttons: [...document.querySelectorAll('.ob-foot .btn, #overlays .btn')].map(b => b.textContent.trim()),
    };
  })()`);

  check('a model step follows the key', step.rows > 0, `${step.rows} models offered`);
  check('our default is preselected and says so',
    !!step.preselected && step.defaultMarked === 'Default' && step.defaultIsPreselected,
    JSON.stringify({ preselected: step.preselected, marked: step.defaultMarked }));
  check('Use default is one button away',
    step.buttons.includes('Use default') && step.buttons.includes('Use this model'),
    JSON.stringify(step.buttons));

  /* Choosing a different model must be what gets written. */
  const other = await app.eval(
    `[...document.querySelectorAll('[data-wizmodel]')].map(n=>n.getAttribute('data-wizmodel')).find(id => id !== ${JSON.stringify(step.preselected)}) || null`);
  if (other) {
    await app.clickSel(`[data-wizmodel="${other}"]`, { timeout: 12000 });
    await sleep(300);
    const picked = await app.eval(`(document.querySelector('[data-wizmodel].on')||{}).dataset ? document.querySelector('[data-wizmodel].on').getAttribute('data-wizmodel') : null`);
    check('clicking a row selects it', picked === other, `${picked}`);
    await app.clickText('Use this model');
    await app.waitFor(`!document.querySelector('[data-wizmodel]')`, 'the step to close', { timeout: 60000 });
    let onDisk = null;
    for (let i = 0; i < 40; i++) {
      const cfg = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'));
      const p = (cfg.llm?.providers || []).find((x) => x.id === 'aimlapi');
      onDisk = p?.defaultChatModel || p?.model || null;
      if (onDisk === other) break;
      await sleep(500);
    }
    check('the model chosen is the model written', onDisk === other, `config says ${onDisk}, chose ${other}`);
  }
  await app.screenshot('/tmp/f6-model-step.png');
} finally {
  await app.close();
}
const failed = results.filter((r) => !r.pass).length;
console.log(`F6 DRIVE: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
