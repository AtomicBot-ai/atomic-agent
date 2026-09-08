/**
 * model-picks.drive.mjs — the local-model recommendation, driven.
 *
 * What is under test: the first-run picker and Settings › LLM › Local
 * both rank the curated catalogue against THIS machine's RAM, show each
 * model's own description, name one best fit, warn where a model is a
 * compromise, and refuse to offer a model that will not run here as
 * though it would.
 *
 * Everything is read off the rendered DOM after real clicks. The only
 * thing this file arranges is the size of the machine: the host has 68 GB
 * and every curated model fits it comfortably, so the interesting half of
 * the behaviour cannot be reached on this hardware. `--fake-ram=<gb>` is a
 * test-only Electron flag (main.ts FAKE_RAM_GB) that changes exactly one
 * number — what `app:hostRam` answers. THE 68 GB PASS RUNS WITHOUT IT, so
 * the production path (os.totalmem) is the one proved on the real figure.
 *
 *   ATOMIC_AGENT_STATE_DIR=/some/dir node test/model-picks.drive.mjs
 *
 * Options: --port=N (default 9410), --state=DIR (a CONFIGURED state dir,
 * for the Settings leg), --shots=DIR.
 */

import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sleep } from './drive.mjs';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const PORT = Number(arg('port', '9410'));
const SHOTS = arg('shots', null);
const CONFIGURED = arg('state', process.env.ATOMIC_AGENT_STATE_DIR || null);
if (!CONFIGURED) throw new Error('set ATOMIC_AGENT_STATE_DIR (or pass --state=DIR) — never the operator’s own');
/* The wizard legs need a state dir with no backend configured, and they
   must not disturb the configured one the Settings leg uses. */
const SCRATCH = join(CONFIGURED, 'drive-model-picks');
mkdirSync(SCRATCH, { recursive: true });

const failures = [];
let n = 0;
function check(name, ok, detail = '') {
  n += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}\n`);
  if (!ok) failures.push(name);
}
const say = (line) => process.stdout.write(`     ${line}\n`);

/** The picker's rows, as a person reads them. */
const PICKS = `[...document.querySelectorAll('#onboarding .ob-models .ob-row')].map((n) => ({
  name: (n.querySelector('.t').innerText || '').trim().replace(/\\s+/g, ' '),
  lines: [...n.querySelectorAll('.d > span')].map((s) => (s.innerText || '').trim()).filter(Boolean),
  best: !!n.querySelector('.ob-badge-best'),
}))`;
/** The models shown as out of reach — plain rows, never buttons. */
const OUT = `[...document.querySelectorAll('#onboarding .ob-out')].map((n) =>
  (n.innerText || '').trim().replace(/\\s+/g, ' '))`;

/** Open the wizard's local list on a machine of `ram` GB (null = the real one). */
async function pickListAt(ram, label) {
  const stateDir = mkdtempSync(join(SCRATCH, 'fresh-'));
  const app = await launch({
    port: PORT, stateDir, verbose: false,
    args: ram ? [`--fake-ram=${ram}`] : [],
  });
  try {
    await app.waitFor('!!document.querySelector("#onboarding")', 'the wizard', { timeout: 90000, quiet: true });
    // "press any key" is two-stage: the first input finishes the reveal.
    await app.clickSel('#onboarding', { scroll: false });
    await app.clickSel('#onboarding', { scroll: false });
    await app.clickText('Local models');
    await app.waitFor('!!document.querySelector("#onboarding .ob-explain")', 'the local step', { quiet: true });
    // The catalogue is a real `atag models list` — wait for it to land.
    for (let i = 0; i < 80; i += 1) {
      const rows = await app.eval("document.querySelectorAll('#onboarding .ob-row').length");
      const outs = await app.eval("document.querySelectorAll('#onboarding .ob-out').length");
      if (rows > 1 || outs > 0) break;
      await sleep(500);
    }
    const shown = {
      intro: await app.eval("(document.querySelector('#onboarding .ob-explain') || {}).innerText || ''"),
      heading: await app.eval("(document.querySelector('#onboarding .ob-h') || {}).innerText || ''"),
      picks: await app.eval(PICKS),
      empty: await app.eval("(document.querySelector('#onboarding .ob-models .ob-explain') || {}).innerText || ''"),
      out: await app.eval(OUT),
      outHeading: await app.eval("(document.querySelector('#onboarding .ob-out-h') || {}).innerText || ''"),
      lastRow: await app.eval(`(() => { const r = document.querySelectorAll('#onboarding .ob-row');
        return r.length ? (r[r.length - 1].querySelector('.t').innerText || '').trim() : ''; })()`),
      outAreButtons: await app.eval("[...document.querySelectorAll('#onboarding .ob-out')].some((n) => n.tagName === 'BUTTON' || n.querySelector('button'))"),
    };
    if (SHOTS) await app.screenshot(join(SHOTS, `picks-${label}.png`));
    return shown;
  } finally {
    await app.close();
  }
}

/** Print one pick list the way the screen reads. */
function transcribe(what, shown) {
  say(`--- ${what} ---`);
  say(`  ${shown.intro.replace(/\s+/g, ' ')}`);
  say(`  ${shown.heading}`);
  if (shown.empty) say(`       ${shown.empty.replace(/\s+/g, ' ')}`);
  for (const p of shown.picks) {
    say(`   ${p.best ? '★' : '·'} ${p.name}`);
    for (const l of p.lines) say(`       ${l}`);
  }
  if (shown.out.length) {
    say(`  ${shown.outHeading}`);
    for (const o of shown.out) say(`       ${o}`);
  }
  say(`  (last focusable row: ${JSON.stringify(shown.lastRow)})`);
}

try {
  /* ================================================================
     1 — THE REAL MACHINE. No flag: `app:hostRam` answers os.totalmem().
     ================================================================ */
  const big = await pickListAt(null, '68gb');
  transcribe('the wizard on this Mac (no flag — the real RAM figure)', big);
  const ram = Number((big.intro.match(/reports (\d+) GB/) || [])[1] || 0);
  check('the picker names the machine it is ranking for', ram > 0, `${ram} GB`);
  check('every curated model is offered on a machine this size',
    big.picks.length === 13 && big.out.length === 0, `${big.picks.length} offered, ${big.out.length} out of reach`);
  check('exactly one row is marked the best fit',
    big.picks.filter((p) => p.best).length === 1, big.picks.filter((p) => p.best).map((p) => p.name).join(', '));
  check('the best fit is the first row, and it is the biggest model that runs comfortably',
    big.picks[0].best && /qwen-3\.6-35b-a3b/.test(big.picks[0].name), big.picks[0].name);
  check('the recommendation is never a reduced-refusal model',
    !big.picks.filter((p) => p.best).some((p) => /uncensored/.test(p.name)), big.picks[0].name);
  check('every row carries the catalogue’s own description',
    big.picks.every((p) => p.lines.length >= 3), JSON.stringify(big.picks[0].lines));
  check('a vision model says so',
    big.picks.some((p) => p.lines.some((l) => /reads images/.test(l))),
    JSON.stringify((big.picks.find((p) => p.lines.some((l) => /reads images/.test(l))) || {}).lines));
  check('a model that needs no caution is given none',
    big.picks[0].lines.length === 3 && !big.picks[0].lines.some((l) => /small model|slow the rest/.test(l)),
    JSON.stringify(big.picks[0].lines));
  check('the small-model caution belongs to the model, not to the machine — it is on the 4B rows even here',
    big.picks.filter((p) => p.lines.some((l) => /A small model:/.test(l))).length === 2,
    big.picks.filter((p) => p.lines.some((l) => /A small model:/.test(l))).map((p) => p.name).join(', '));
  check('the Hugging Face row is still pinned last',
    big.lastRow === 'Add a model from Hugging Face…', JSON.stringify(big.lastRow));

  /* ================================================================
     2 — A SMALL MACHINE. 8 GB: two models run comfortably, one is a
     tight fit, ten will not run at all.
     ================================================================ */
  const small = await pickListAt(8, '8gb');
  transcribe('the wizard on a simulated 8 GB machine', small);
  check('an 8 GB machine is told it is an 8 GB machine', /reports 8 GB/.test(small.intro), small.intro.replace(/\s+/g, ' '));
  check('only what runs here is offered',
    small.picks.length === 3 && small.out.length === 10, `${small.picks.length} offered, ${small.out.length} out of reach`);
  check('the recommendation is the best model that runs comfortably',
    small.picks[0].best && /gemma-4-e4b/.test(small.picks[0].name), small.picks[0].name);
  check('a small model says plainly what it gives up',
    small.picks[0].lines.some((l) => /small model/i.test(l) && /correct it more often/.test(l)),
    JSON.stringify(small.picks[0].lines));
  check('a tight fit is named as one, with both RAM figures',
    small.picks.some((p) => p.lines.some((l) => /tight fit/.test(l) && /8 GB/.test(l))),
    JSON.stringify((small.picks.find((p) => p.lines.some((l) => /tight fit/.test(l))) || {}).lines));
  check('a model that will not run says how much RAM it wants',
    small.out.every((o) => /needs \d+ GB of RAM at minimum/.test(o)), small.out[0]);
  check('a model that will not run is not a control',
    small.outAreButtons === false, small.outAreButtons ? 'it renders as a button' : 'plain rows');
  check('the out-of-reach block says what it is',
    /Needs a bigger machine/.test(small.outHeading), JSON.stringify(small.outHeading));

  /* ================================================================
     3 — A MACHINE NOTHING RUNS ON. 4 GB is under every minimum; the
     step must say so instead of offering a download that cannot work.
     ================================================================ */
  const tiny = await pickListAt(4, '4gb');
  transcribe('the wizard on a simulated 4 GB machine', tiny);
  check('a machine under every minimum is told so, and offered the way out',
    tiny.picks.length === 0 && tiny.out.length === 13
      && /Nothing in this list runs in 4 GB of RAM/.test(tiny.empty)
      && /Hugging Face|cloud model/.test(tiny.empty)
      && tiny.lastRow === 'Add a model from Hugging Face…',
    `${tiny.picks.length} offered, ${tiny.out.length} out of reach, empty state ${JSON.stringify(tiny.empty.replace(/\s+/g, ' '))}`);

  /* ================================================================
     4 — SETTINGS › LLM › LOCAL, on the same simulated 8 GB machine.
     The two surfaces must not disagree.
     ================================================================ */
  const app = await launch({ port: PORT, stateDir: CONFIGURED, verbose: false, args: ['--fake-ram=8'] });
  try {
    await app.waitFor('!!document.querySelector(".sb-settings")', 'the app window', { timeout: 90000, quiet: true });
    /* The sidebar paints before `atag serve` has finished booting, and the
       window repaints out from under a Settings window opened in that gap —
       so open it, and open it again if it is gone. Clicking is still the
       only way anything here is made to happen. */
    let pane = '';
    for (let attempt = 1; attempt <= 4 && !/^local$/i.test(pane.trim()); attempt += 1) {
      if (!(await app.eval('!!document.querySelector("#settings")'))) {
        await app.clickSel('.sb-settings');
        await app.clickText('LLM', { scope: '#settings' });
        await sleep(2000);
      }
      pane = await app.eval("(document.querySelector('#settings .llmmode.on') || {}).innerText || ''");
      /* This state directory routes at a cloud provider, so the LLM tab
         opens on Cloud. The mode strip is the way across — clicked by
         selector, not by its text: the pane's footer hint also says the
         word "Local" ("←/→ switch Local/Cloud/External/Fallback") and it is
         clickable, and clicking THAT walks the mode on instead. */
      if (pane && !/^local$/i.test(pane.trim())) {
        await app.clickSel('#settings .llmmode', { nth: 0 });
        await sleep(1500);
        pane = await app.eval("(document.querySelector('#settings .llmmode.on') || {}).innerText || ''");
      }
      if (!/^local$/i.test(pane.trim())) await sleep(4000);
    }
    check('the mode strip reaches the Local pane', /^local$/i.test(pane.trim()), JSON.stringify(pane));
    for (let i = 0; i < 60; i += 1) {
      if (await app.eval("document.querySelectorAll('#settings [data-llm-row^=\"local-text:\"]').length")) break;
      await sleep(500);
    }
    const rows = await app.eval(`[...document.querySelectorAll('#settings [data-llm-row^="local-text:"]')]
      .map((n) => (n.innerText || '').trim().split('\\n').map((s) => s.trim()).filter(Boolean))`);
    const ramLine = await app.eval("(document.querySelector('#settings .llm-ram') || {}).innerText || ''");
    if (SHOTS) await app.screenshot(join(SHOTS, 'settings-local-8gb.png'));
    say('--- Settings › LLM › Local on the same simulated 8 GB machine ---');
    say(`  ${ramLine.trim()}`);
    for (const r of rows) { say(`   ${r[0]}`); for (const l of r.slice(1)) say(`       ${l}`); }
    check('the Local pane names the machine it is ranking for', /reports 8 GB of RAM/.test(ramLine), ramLine.trim());
    check('the Local pane is ordered best fit first, and marks it',
      rows.length > 0 && /★ best fit for this machine/.test(rows[0][0]) && /gemma-4-e4b/.test(rows[0][0]),
      rows.length ? rows[0][0] : 'no rows');
    check('the Local pane shows each model’s description',
      rows.some((r) => r.some((l) => /Compact multimodal reasoning/.test(l))), JSON.stringify(rows[0]));
    check('the Local pane agrees with the wizard about what will not run',
      rows.filter((r) => r.some((l) => /needs \d+ GB of RAM at minimum/.test(l))).length === 10,
      `${rows.filter((r) => r.some((l) => /needs \d+ GB of RAM at minimum/.test(l))).length} rows say a model will not run here`);
    check('the small-model caution is on the recommended row here too',
      rows.length > 0 && rows[0].some((l) => /small model/i.test(l)), JSON.stringify(rows[0] || 'no rows'));
    check('a model that fits is not warned about here either',
      !rows.some((r) => /qwen-3\.5-9b/.test(r[0]) && r.some((l) => /small model/i.test(l))),
      JSON.stringify((rows.find((r) => /qwen-3\.5-9b/.test(r[0])) || [])[0] || 'no such row'));
  } finally {
    await app.close();
  }
} finally {
  process.stdout.write(`\n${n - failures.length}/${n} checks passed\n`);
  if (failures.length) {
    process.stdout.write(`FAILURES:\n${failures.map((f) => '  - ' + f).join('\n')}\n`);
    process.exitCode = 1;
  }
}
