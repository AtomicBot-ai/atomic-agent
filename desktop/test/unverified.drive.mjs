/**
 * F1 — an unchecked key never becomes "Cloud model ready".
 *
 * `verifyProviderKey` answers three ways, not two: ok, rejected, and "the
 * request could not leave this machine, so nothing was checked". The wizard
 * used to treat the third as a pass — it saved the provider, activated it,
 * dropped the reason into a four-second toast and showed the completion
 * screen. The tester typed random characters as an AI/ML API key, read
 * "Cloud model ready", and every turn afterwards died.
 *
 * The scenario is a provider whose host does not resolve. That is a real
 * configuration a person can be in (a typo'd base URL, a VPN, an endpoint
 * that moved), and it is the only honest way to reach the third answer
 * without pretending to be offline: `aimlapi` takes a baseUrl, and its model
 * catalogue is bundled in the binary, so the lookup before verification
 * still succeeds and verification is genuinely what fails.
 *
 * Everything below is clicked and typed. The one thing set up beforehand is
 * the config file itself — the same thing a person has after configuring a
 * provider and then having its endpoint go away.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sleep } from './drive.mjs';

const DIR = process.env.ATAG_F1_DIR || '/tmp/atag-drive-f1';
const PORT = Number(process.env.ATAG_F1_PORT || 9470);
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
};

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
/* Seed from the agent's OWN defaults rather than a hand-written object. A
   config written by hand is rejected for things that have nothing to do with
   the scenario — the first attempt at this file set only llm.providers and
   came back `llm.activeEmbeddingProvider: unknown provider id "local-llama"`,
   because the schema fills that in and then validates it against a list the
   hand-written file did not have. Ask for the defaults, change the one thing
   this scenario is about, write it back. */
{
  const seedDir = `${DIR}-seed`;
  rmSync(seedDir, { recursive: true, force: true });
  mkdirSync(seedDir, { recursive: true });
  const { execFileSync } = await import('node:child_process');
  const bin = process.env.ATAG_BIN || join(process.env.HOME || '', 'atag-agent', 'bin', 'atag');
  execFileSync(bin, ['config', 'get'], { env: { ...process.env, ATOMIC_AGENT_STATE_DIR: seedDir }, stdio: 'ignore' });
  const cfg = JSON.parse(readFileSync(join(seedDir, 'config.json'), 'utf8'));
  cfg.llm = cfg.llm || {};
  /* `local-llama` has to be here even though this scenario never touches it:
     the schema fills activeEmbeddingProvider with that id and then validates
     it against the providers list, so a config that omits it is rejected
     before anything in this test runs. */
  cfg.llm.providers = [
    ...(cfg.llm.providers || []).filter((p) => p.id !== 'aimlapi' && p.id !== 'local-llama'),
    { id: 'local-llama', kind: 'llama-server' },
    /* The host that does not resolve. Everything else about this entry is
       ordinary: the model catalogue for `aimlapi` is bundled, so the lookup
       before verification still succeeds and verification is what fails. */
    { id: 'aimlapi', kind: 'aimlapi', baseUrl: 'https://api.aimlapi.invalid', apiKeyEnvVar: 'AIMLAPI_API_KEY' },
  ];
  cfg.llm.activeTextProvider = 'aimlapi';
  cfg.llm.activeEmbeddingProvider = 'local-llama';
  /* Someone who has already been through setup, whose provider's endpoint
     later stopped resolving. Without this the first-run flow opens over the
     chat and the composer cannot be reached at all — and this scenario is
     about the app AFTER setup, not during it. */
  cfg.tui = cfg.tui || {};
  cfg.tui.onboarding = { ...(cfg.tui.onboarding || {}), completedAt: new Date().toISOString() };
  writeFileSync(join(DIR, 'config.json'), JSON.stringify(cfg, null, 2));
}

const app = await launch({ port: PORT, stateDir: DIR, workspace: '/tmp/atag-drive-f1-ws' });
try {
  await app.waitFor(`!!document.querySelector('#composer, .composer, textarea')`, 'the window', { timeout: 40000 });
  /* Wait for the composer to have READ the config before clicking it. The
     provider chip says "no provider" until providersReady answers, and a
     click at that moment opens a selector with nothing in it — which is a
     driver reading a screen mid-load, not a defect. */
  await app.waitFor(
    `!/no provider/.test((document.querySelector('[data-sel-open="provider"]')||{}).textContent||'no provider')`,
    'the composer to know its provider', { timeout: 40000 });
  /* Open the key screen the way a person does: through the provider chip. */
  await app.clickSel('[data-sel-open="provider"]', { timeout: 20000 });
  await sleep(700);
  /* The row's detail says "checking keys…" until providersReady answers.
     Clicking it in that state activates a provider whose readiness is not
     known yet, so wait for the row to have made its mind up, then click the
     row itself rather than a word inside it. */
  await app.waitFor(
    `!/checking keys/.test((document.querySelector('#overlays .modelrow')||{}).textContent||'checking keys')`,
    'the provider row to settle', { timeout: 30000 });
  await app.clickSel('#overlays .modelrow', { nth: 0, timeout: 12000 });
  /* Activating a provider with no key tries the switch first and only asks
     for the key once that comes back — about four seconds on this machine.
     Wait for the screen, not for a guess at how long it takes. */
  await app.waitFor(`!!document.querySelector('#wiz-key')`, 'the key screen', { timeout: 30000 }).catch(() => {});

  const onKey = await app.eval(`!!document.querySelector('#wiz-key')`);
  check('the provider with no key opens the key screen', onKey, `#wiz-key present=${onKey}`);
  if (!onKey) throw new Error('never reached the key screen');

  await app.clickSel('#wiz-key', { scroll: false });
  await app.type('sk-0000000000000000000000000000');
  await app.clickText('Next');

  // Verification is a real network attempt; wait for it to come back.
  for (let i = 0; i < 120; i++) {
    if (await app.eval(`!!document.querySelector('.ob-err')`)) break;
    await sleep(500);
  }
  await sleep(300);

  const err = await app.eval(`(document.querySelector('.ob-err')||{}).textContent || ''`);
  /* Both key screens are in scope: the wizard renders its footer as
     `.ob-foot`, the composer's popover through selShell. A person does not
     know which one they are looking at, so neither does this. */
  const buttons = await app.eval(`[...document.querySelectorAll('.ob-foot .btn, #overlays .btn')].map(b=>b.textContent.trim())`);
  const stillHere = await app.eval(`!!document.querySelector('#wiz-key')`);
  const claimsReady = await app.eval(`/cloud model ready|ready to use/i.test(document.body.textContent||'')`);

  check('the reason is shown verbatim, and names the host',
    /aimlapi\.invalid/.test(err) && !/fetch failed|undici|ECONN/i.test(err),
    JSON.stringify(err.slice(0, 140)));
  check('the two decisions are offered as buttons',
    buttons.includes('Try again') && buttons.includes('Save unchecked'), JSON.stringify(buttons));
  check('the flow stays on the key screen', stillHere, `#wiz-key present=${stillHere}`);
  check('nothing claims the provider is ready', !claimsReady, `claims=${claimsReady}`);

  /* The error clears on the first keystroke in the field it belongs to. */
  await app.clickSel('#wiz-key', { scroll: false });
  await app.type('x');
  await sleep(250);
  const cleared = await app.eval(`!document.querySelector('.ob-err')`);
  check('the error clears on the first keystroke', cleared, `error gone=${cleared}`);

  /* Saving unchecked is a decision, and it is remembered as unverified. */
  await app.clickText('Next');
  for (let i = 0; i < 120; i++) {
    if (await app.eval(`[...document.querySelectorAll('.ob-foot .btn, #overlays .btn')].some(b=>/Save unchecked/.test(b.textContent))`)) break;
    await sleep(500);
  }
  console.log('   [diag] buttons before the second decision:',
    await app.eval(`[...document.querySelectorAll('.ob-foot .btn, #overlays .btn')].map(b=>b.textContent.trim()).join(' | ')`),
    '| err:', (await app.eval(`(document.querySelector('.ob-err')||{}).textContent||''`)).slice(0, 60));
  await app.clickText('Save unchecked');
  for (let i = 0; i < 90; i++) {
    if (!(await app.eval(`!!document.querySelector('#wiz-key')`))) break;
    await sleep(500);
  }
  const unverified = await app.eval(`window.__unverified ? window.__unverified() : null`);
  check('a provider saved unchecked is remembered as unverified',
    Array.isArray(unverified) && unverified.includes('aimlapi'), JSON.stringify(unverified));

  await app.screenshot('/tmp/f1-final.png');
} finally {
  await app.close();
}
const failed = results.filter((r) => !r.pass).length;
console.log(`F1 DRIVE: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
