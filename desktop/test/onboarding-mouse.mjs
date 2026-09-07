/**
 * onboarding-mouse.mjs — the first-run wizard, driven the way a person
 * drives it: real mouse presses and real keystrokes over CDP.
 *
 * Why this exists as a file of its own rather than as more checks inside
 * `--smoke`: the smoke suite drives the flow through `window.__ob*`
 * hooks, and those hooks CALL the activation function. That is the right
 * tool for asserting what the reducer computes and the wrong one for
 * asserting that a control works — which is how a wizard whose rows
 * needed TWO clicks to do anything shipped alongside 490 green checks.
 *
 * Everything asserted below is asserted about a real
 * `Input.dispatchMouseEvent` at the control's own centre.
 *
 * The one concession: five screens sit behind a multi-gigabyte download
 * or a write to another agent's data (`local_download`, `wait_or_jump`,
 * `propose_second`, `import_preview`, `import_done`). Those are STAGED
 * with `__obOpen`/`__obSeed` — a fixture, exactly as a fixture stages a
 * database row — and then every control on them is clicked for real.
 * Staging is never the thing under test; the click always is.
 *
 *   ATOMIC_AGENT_STATE_DIR=/some/empty/dir node test/onboarding-mouse.mjs
 *
 * Options: --port=N (default 9411), --state=DIR, --keep (leave the app up),
 * --shots=DIR (write a PNG per screen).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, sleep } from './drive.mjs';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const PORT = Number(arg('port', '9411'));
const SHOTS = arg('shots', null);
const STATE = arg('state', process.env.ATOMIC_AGENT_STATE_DIR
  || mkdtempSync(join(tmpdir(), 'atag-drive-')));

const failures = [];
let n = 0;
function check(name, ok, detail = '') {
  n += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}\n`);
  if (!ok) failures.push(name);
}
const say = (line) => process.stdout.write(`     ${line}\n`);

const app = await launch({ port: PORT, stateDir: STATE });
let shot = 0;
const snapshot = async (name) => { if (SHOTS) await app.screenshot(join(SHOTS, `${String(++shot).padStart(2, '0')}-${name}.png`)); };

/** The onboarding step, read (never set) through the flow's own reporter. */
const step = () => app.js('window.__ob().step');
/**
 * Stage a screen.
 *
 * Finishing the flow leaves an async settle in flight — it can move the
 * step (to the import offer, or shut) a second or two later, ON TOP of
 * whatever was staged in the meantime. So: put the flow away, open the
 * screen, and then WAIT and check it is still the screen. This is
 * harness bookkeeping, not a claim about the app: no person can reach
 * these screens twice in one run either.
 */
async function stage(step_, opts = '') {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await app.js('window.__obClose()');
    await sleep(1500);
    await app.js(`window.__obOpen(${JSON.stringify(step_)}${opts ? ', ' + opts : ''})`);
    await sleep(1200);
    if ((await step()) === step_) return;
    say(`staging ${step_} drifted to ${await step()}; retrying (${attempt}/4)`);
  }
  throw new Error(`could not stage ${step_}`);
}
/** The rendered action bar, as a person reads it. */
const foot = () => app.js(`[...document.querySelectorAll('#onboarding .ob-foot button')]
  .map((b) => (b.textContent || '').trim() + (b.disabled ? ' (disabled)' : ''))`);

try {
  /* ================================================================
     PART 1 — the real first run. Mouse only, no fixtures at all.
     ================================================================ */
  await app.waitFor('#onboarding', { timeout: 90000 });
  check('the wizard opens itself on a fresh state directory', (await step()) === 'intro');
  await snapshot('intro');

  // "press any key" is two-stage: the first input finishes the reveal.
  await app.clickSel('#onboarding');
  await app.clickSel('#onboarding');
  check('a click gets past the intro', (await step()) === 'choose', await step());
  await snapshot('choose');

  /* --- THE ROOT DEFECT: one click on a row must activate it. --- */
  {
    const before = await app.snap();
    const rowIsUnderCursor = before.rows.findIndex((r) => r.startsWith('> '));
    say(await app.clickText('Cloud models'));
    const now = await step();
    check(
      'ONE click on a row that is not under the cursor activates it',
      now === 'cloud',
      `cursor was on row ${rowIsUnderCursor}, clicked row 1, step=${now}`,
    );
  }
  await snapshot('cloud-list');

  {
    const rows = (await app.snap()).wizRows;
    check('the provider list has a Back control, not only an esc hint',
      (await foot()).some((b) => b.startsWith('Back')), JSON.stringify(await foot()));
    say(await app.clickText('Back', { selector: '#onboarding .ob-foot button' }));
    check('Back returns to the choice', (await step()) === 'choose', await step());
    check('the choice list still has three rows', (await app.snap()).rows.length === 3);
    say(`provider list carried ${rows.length} rows`);
  }

  /* --- the custom-endpoint branch: two screens that had NO control --- */
  say(await app.clickText('Custom endpoint'));
  check('ONE click reaches the custom endpoint step', (await step()) === 'custom_chat_url', await step());
  check('the URL step offers Back and a primary action',
    JSON.stringify(await foot()) === JSON.stringify(['Back', 'Test and continue']), JSON.stringify(await foot()));
  await snapshot('custom-url');

  /* The field opens on whatever `localModels.url` holds, so emptying it
     is itself a mouse-and-keyboard job: click into it and hold Backspace,
     exactly as a person would. */
  say(await app.clearField('#ob-url'));
  say(await app.clickText('Test and continue', { selector: '#onboarding .ob-foot button' }));
  {
    const err = await app.boxOf('#onboarding .ob-err-field');
    const field = await app.boxOf('#ob-url');
    check('an empty URL is refused with the error under the field',
      !!err && !!field && err.y > field.y && err.label.includes('base URL'),
      err ? `"${err.label}" at y=${err.y}, field at y=${field.y}` : 'no inline error');
  }

  say(await app.clickSel('#ob-url'));
  say(await app.type('http://127.0.0.1:9/'));
  say(await app.clickText('Test and continue', { selector: '#onboarding .ob-foot button' }));
  await sleep(1200);
  {
    // The probe carries its own timeout; wait for it to answer.
    let err = null;
    for (let i = 0; i < 60 && !err; i += 1) { await sleep(500); err = await app.boxOf('#onboarding .ob-err-field'); }
    check('a URL that does not answer /health reports it under the field',
      !!err && !!(await app.boxOf('#ob-url')) && err.label.length > 0,
      err ? `"${err.label}"` : 'no inline error after the probe');
  }
  await snapshot('custom-url-error');
  say(await app.clickText('Back', { selector: '#onboarding .ob-foot button' }));
  check('Back leaves the URL step', (await step()) === 'choose', await step());

  /* --- the local branch, and the row pinned past the catalogue --- */
  say(await app.clickText('Local models'));
  check('ONE click reaches the local model list', (await step()) === 'local_pick', await step());
  await app.waitFor('#onboarding .ob-row', { timeout: 40000 });
  for (let i = 0; i < 60; i += 1) {
    if ((await app.snap()).rows.length > 1) break;
    await sleep(500);
  }
  await snapshot('local-pick');
  {
    const rows = (await app.snap()).rows;
    check('the local list has a Back control', (await foot()).includes('Back'), JSON.stringify(await foot()));
    check('the Hugging Face row is last', /Hugging Face/.test(rows[rows.length - 1] || ''), rows[rows.length - 1]);
    const target = await app.boxOf('#onboarding .ob-row', { index: rows.length - 1 });
    check('a row is a comfortable target', !!target && target.h >= 32, target ? `${target.w}x${target.h}px` : 'no row');

    /* The catalogue is longer than the box. The TUI painted six rows and
       a `↓ 7 more` line, which is a DEAD END for a pointer: no gesture
       reaches the seventh model. The list scrolls now — so every model is
       there, and the wheel brings the last one under the pointer.
       (Deliberately not clicked: a model row starts a multi-gigabyte
       download. What is asserted is that a click would land on it.) */
    const painted = await app.js("document.querySelectorAll('#onboarding .ob-models .ob-row').length");
    const catalogue = await app.js('window.__obPickCounts().models');
    check('every model in the catalogue is in the list, not the first six',
      painted === catalogue && catalogue > 6, `painted=${painted} catalogue=${catalogue}`);
    say(await app.wheel('#onboarding .ob-models', 900));
    const box = await app.boxOf('#onboarding .ob-models');
    const last = await app.boxOf('#onboarding .ob-models .ob-row', { index: painted - 1 });
    check('the wheel brings the last model under the pointer',
      !!box && !!last && last.y > box.y - box.h / 2 && last.y < box.y + box.h / 2,
      `list ${box ? box.y - box.h / 2 : '?'}..${box ? box.y + box.h / 2 : '?'}, last row at ${last ? last.y : '?'}`);
    say(await app.wheel('#onboarding .ob-models', -900));
    say(await app.clickText('Add a model from Hugging Face'));
    check('ONE click on the pinned last row opens the Hugging Face step',
      (await step()) === 'local_hf_ref', await step());
  }
  await snapshot('hf-ref');

  {
    check('the Hugging Face step has a primary action, disabled while the field is empty',
      JSON.stringify(await foot()) === JSON.stringify(['Back', 'Look it up (disabled)']),
      JSON.stringify(await foot()));
    say(await app.clickSel('#ob-hf-ref'));
    say(await app.type('atag-drive-no-such-owner/nope'));
    check('typing enables the primary action',
      JSON.stringify(await foot()) === JSON.stringify(['Back', 'Look it up']), JSON.stringify(await foot()));
    say(await app.clickText('Look it up', { selector: '#onboarding .ob-foot button' }));
    let err = null;
    for (let i = 0; i < 60 && !err; i += 1) { await sleep(500); err = await app.boxOf('#onboarding .ob-err-field'); }
    check('a lookup that fails says so under the field',
      !!err && err.y > (await app.boxOf('#ob-hf-ref')).y, err ? `"${err.label}"` : 'no inline error');
    say(await app.clickText('Clear', { selector: '#onboarding [data-obact="hf:clear"]' }));
    const value = await app.js("document.getElementById('ob-hf-ref').value");
    check('the clear control empties the field and disables the action again',
      value === '' && (await foot()).includes('Look it up (disabled)'), `value=${JSON.stringify(value)}`);
    say(await app.clickText('Back', { selector: '#onboarding .ob-foot button' }));
    check('Back leaves the Hugging Face step', (await step()) === 'local_pick', await step());
    say(await app.clickText('Back', { selector: '#onboarding .ob-foot button' }));
    check('Back leaves the local list', (await step()) === 'choose', await step());
  }

  /* --- Enter presses the button under the ring, not the step's chord ---
     On this screen the ambient Enter starts a multi-gigabyte download, so
     a keyboard user who tabbed to `Back` and pressed Enter had a great
     deal to lose by the flow answering with its own verb instead. */
  {
    say(await app.clickText('Local models'));
    await app.waitFor('#onboarding .ob-foot button', { timeout: 40000 });
    let on = null;
    for (let i = 0; i < 6 && !(on && /Back/.test(on.label)); i += 1) {
      await app.press('Tab', { settle: 150 });
      on = await app.focusInfo();
    }
    check('Tab reaches the action bar from the list', !!on && /Back/.test(on.label), JSON.stringify(on));
    say(await app.press('Enter'));
    check('Enter on the focused Back button goes back, instead of starting a download',
      (await step()) === 'choose', await step());
  }

  /* --- the cloud wizard: the list, then the key screen --- */
  say(await app.clickText('Cloud models'));
  {
    const before = (await app.snap()).wizRows.findIndex((r) => r.startsWith('> '));
    say(await app.clickText('Groq'));
    const head = (await app.snap()).heads[0] || '';
    check('ONE click on a provider row that is not under the cursor opens its key screen',
      /^API key — Groq/.test(head), `cursor was on row ${before}; head=${JSON.stringify(head)}`);
    say(await app.clickText('Back', { selector: '#onboarding .ob-foot button' }));
    check('Back returns to the provider list',
      (await app.snap()).wizRows.length > 0, JSON.stringify((await app.snap()).heads));
    say(await app.clickText('OpenRouter'));
    check('the first row also opens on one click',
      /^API key — OpenRouter/.test((await app.snap()).heads[0] || ''), JSON.stringify((await app.snap()).heads));
    say(await app.clickText('Back', { selector: '#onboarding .ob-foot button' }));
    /* Groq for the button test rather than OpenRouter: its model list
       needs the key, so a made-up one is refused instead of quietly
       verifying against a public catalogue and activating a dead
       provider halfway through the pass. */
    say(await app.clickText('Groq'));
  }
  await snapshot('cloud-key');

  /* THE OPERATOR'S OWN REPORT: "when I click on next, nothing happens.
     But when I click on enter, it works." */
  {
    say(await app.clickSel('#wiz-key'));
    say(await app.type('gsk-not-a-real-key-0000'));
    const next = await app.boxOf('#onboarding .ob-foot .btn-p');
    check('the primary action is bottom right and big enough to hit',
      !!next && next.h >= 30 && next.w >= 100, next ? `${next.label} ${next.w}x${next.h}px` : 'no primary button');
    say(await app.clickText('Next', { selector: '#onboarding .ob-foot button' }));
    await sleep(400);
    const verifying = await foot();
    check('CLICKING Next starts the verification, exactly as Enter does',
      verifying.some((b) => b.startsWith('Verifying…')), JSON.stringify(verifying));
    let settled = null;
    for (let i = 0; i < 120 && !settled; i += 1) {
      await sleep(500);
      const f = await foot();
      if (!f.some((b) => b.startsWith('Verifying…'))) settled = f;
    }
    const err = (await app.snap()).error;
    check('a key the provider rejects comes back as an error on the key screen',
      !!settled && err.length > 0 && settled.includes('Next'),
      `${JSON.stringify(settled)} err=${JSON.stringify(err.slice(0, 70))}`);
  }
  await snapshot('cloud-key-error');

  /* --- the keyboard is untouched --- */
  {
    say(await app.clickText('Back', { selector: '#onboarding .ob-foot button' }));
    say(await app.clickText('Back', { selector: '#onboarding .ob-foot button' }));
    check('back on the choice screen', (await step()) === 'choose', await step());
    say(await app.press('ArrowDown'));
    say(await app.press('ArrowDown'));
    const rows = (await app.snap()).rows;
    check('the arrows still move the cursor', (rows[2] || '').startsWith('> '), JSON.stringify(rows));
    say(await app.press('Enter'));
    check('Enter still activates the row under the cursor', (await step()) === 'custom_chat_url', await step());
    say(await app.press('Escape'));
    check('Escape still goes back', (await step()) === 'choose', await step());
  }

  /* --- a keyboard user can see where they are --- */
  {
    const roving = await app.js(`(() => {
      const rows = [...document.querySelectorAll('#onboarding .ob-row')];
      return { total: rows.length, stops: rows.filter((r) => r.tabIndex === 0).length,
               stopIsOn: rows.filter((r) => r.tabIndex === 0).every((r) => r.classList.contains('on')) };
    })()`);
    check('the list has exactly one tab stop, and it is the row under the cursor',
      roving.total > 1 && roving.stops === 1 && roving.stopIsOn === true, JSON.stringify(roving));

    // Walk the whole surface with Tab. It must stay inside the modal —
    // the app's chrome behind it cannot be clicked, so it must not be
    // reachable by keyboard either — and every stop must draw a ring.
    const seen = [];
    let escaped = false;
    let ringless = null;
    for (let i = 0; i < roving.total + 3; i += 1) {
      await app.press('Tab', { settle: 120 });
      const f = await app.js(`(() => {
        const a = document.activeElement;
        const cs = a ? getComputedStyle(a) : null;
        return { inside: !!(a && a.closest && a.closest('#onboarding')),
                 label: (a && (a.innerText || a.value) || '').replace(/\s+/g,' ').trim().slice(0, 28),
                 ring: !!cs && cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 };
      })()`);
      seen.push(f.label);
      if (!f.inside) escaped = true;
      if (!f.ring && ringless === null) ringless = f.label;
    }
    check('Tab stays inside the modal wizard and rings every stop it lands on',
      !escaped && ringless === null, `escaped=${escaped} ringless=${JSON.stringify(ringless)} walk=${JSON.stringify(seen)}`);

    const before = await app.focusInfo();
    say(await app.press('ArrowDown'));
    const g = await app.focusInfo();
    check('an arrow press carries the ring to the new row',
      g.tag === 'BUTTON' && /ob-row/.test(g.cls || '') && /on/.test(g.cls || '') && g.label !== before.label,
      `${JSON.stringify(before.label)} → ${JSON.stringify(g)}`);
  }

  /* --- hover answers the pointer --- */
  {
    const plain = await app.js(`getComputedStyle(document.querySelector('#onboarding .ob-row:not(.on)')).backgroundColor`);
    say(await app.hover('#onboarding .ob-row:not(.on)'));
    const hovered = await app.js(`(() => { const n = document.querySelector('#onboarding .ob-row:not(.on)');
      return n ? getComputedStyle(n).backgroundColor : null; })()`);
    check('a row answers the pointer before it is clicked', plain !== hovered, `${plain} → ${hovered}`);
  }

  /* --- and now finish it. Mouse only, all the way out of the flow. ---
     The state directory's own .env carries a real OPENROUTER_API_KEY, so
     leaving the key box empty is the case the field's placeholder
     promises: the provider is saved against its environment variable,
     verified against the live model list, and the flow moves on. This is
     the whole wizard completed with a pointer and nothing else. */
  {
    say(await app.clickText('Cloud models'));
    say(await app.clickText('OpenRouter'));
    const placeholder = await app.js("(document.getElementById('wiz-key')||{}).placeholder");
    check('the key field is labelled and says what an empty one means',
      /OPENROUTER_API_KEY/.test(placeholder || '')
        && (await app.text('#onboarding label[for="wiz-key"]')) === 'API key',
      JSON.stringify(placeholder));
    const focused = await app.focusInfo();
    check('the key screen arrives with the caret already in the field',
      focused.tag === 'INPUT' && focused.id === 'wiz-key', JSON.stringify(focused));
    say(await app.clickText('Next', { selector: '#onboarding .ob-foot button' }));
    let landed = null;
    for (let i = 0; i < 180 && !landed; i += 1) {
      await sleep(500);
      const now = await step();
      const open = await app.js('window.__ob().open');
      if (now !== 'cloud' || open === false) landed = { step: now, open };
    }
    check('an empty key on a provider whose variable is in .env verifies and moves the flow on',
      !!landed && landed.step !== 'cloud',
      landed ? JSON.stringify(landed) : `still on the key screen: ${JSON.stringify((await app.snap()).error)}`);
    await snapshot('cloud-verified');
  }

  /* ================================================================
     PART 2 — the screens behind a download or someone else's data.
     Staged with the flow's fixture, then CLICKED for real.
     ================================================================ */

  // The download screen: its two offer cards are its only way out.
  await stage('local_download');
  /* `cloudReady:false` is part of the staging, not a claim: the screen
     hides its cloud offer once a provider is configured, and the pass
     above deliberately configured one. */
  await app.js("window.__obSeed({localModelId:'qwen3-4b', outcome:null, cloudReady:false})");
  await app.js("window.__dlSeed([{kind:'model', id:'qwen3-4b'}])");
  await sleep(300);
  await snapshot('download');
  {
    const cloud = await app.boxOf('#onboarding .ob-offer.cloud');
    check('the download screen draws its offers as controls, not as prose',
      !!cloud && cloud.h >= 40 && cloud.tag === 'BUTTON', cloud ? `${cloud.w}x${cloud.h}px` : 'no cloud offer');
    say(await app.clickSel('#onboarding .ob-offer.cloud'));
    check('ONE click on "set up a cloud model meanwhile" opens the wizard',
      (await step()) === 'cloud', await step());
    say(await app.press('Escape'));
    check('escape from that wizard comes back to the download',
      (await step()) === 'local_download', await step());
    say(await app.clickSel('#onboarding .ob-offer:not(.cloud)'));
    const after = await step();
    check('ONE click on "skip the wait" ends the flow', after === 'finished' || after === 'propose_second', after);
  }
  await app.js('window.__dlClear()');

  // Almost there.
  await stage('wait_or_jump');
  await app.js("window.__obSeed({outcome:'cloud', localModelId:'qwen3-4b'})");
  await sleep(300);
  await snapshot('wait-or-jump');
  {
    const rows = (await app.snap()).rows;
    check('the almost-there screen lists both ways on', rows.length >= 2, JSON.stringify(rows));
    say(await app.clickText('Add another cloud provider'));
    check('ONE click on the second row opens the wizard', (await step()) === 'cloud', await step());
  }

  // One more thing.
  await stage('propose_second');
  await app.js("window.__obSeed({offer:'local', outcome:'cloud'})");
  await sleep(300);
  await snapshot('propose');
  {
    say(await app.clickText('Set up local models too'));
    check('ONE click accepts the second backend', (await step()) === 'local_pick', await step());
  }
  await stage('propose_second');
  await app.js("window.__obSeed({offer:'local', outcome:'cloud'})");
  await sleep(300);
  {
    say(await app.clickText('Skip — take me to the agent'));
    const after = await step();
    check('ONE click on the skip row ends the flow', after === 'finished' || after === 'import_pick', after);
  }

  // Bring your data.
  await stage('import_pick', "{stamped:['importOfferedAt']}");
  await app.js(`window.__obSeed({importAgents:[
    {id:'claude-code', label:'Claude Code', dir:'/tmp/fixture/claude', enabled:false},
    {id:'codex', label:'Codex', dir:'/tmp/fixture/codex', enabled:false}]})`);
  await sleep(300);
  await snapshot('import-pick');
  {
    say(await app.clickText('Claude Code'));
    const rows = (await app.snap()).rows;
    const ticked = await app.js(`[...document.querySelectorAll('#onboarding [role=checkbox]')].map((n) => n.getAttribute('aria-checked'))`);
    check('ONE click ticks an agent and reveals the import row',
      JSON.stringify(ticked) === JSON.stringify(['true', 'false']) && rows.some((r) => /Import from 1 agent/.test(r)),
      JSON.stringify(ticked) + ' ' + JSON.stringify(rows));
    say(await app.clickText('Claude Code'));
    const off = (await app.snap()).rows;
    const unticked = await app.js(`[...document.querySelectorAll('#onboarding [role=checkbox]')].map((n) => n.getAttribute('aria-checked'))`);
    check('a second click unticks it again',
      JSON.stringify(unticked) === JSON.stringify(['false', 'false']) && !off.some((r) => /Import from/.test(r)),
      JSON.stringify(unticked) + ' ' + JSON.stringify(off));
    say(await app.clickText('Skip adding data from other agents'));
    check('ONE click on the skip row ends the flow', (await step()) === 'finished', await step());
  }

  // The preview and the result, both of which had no control at all.
  const report = JSON.stringify({
    executed: false,
    summary: { migrated: 3, skipped: 1, conflict: 0, error: 0 },
    items: [{ kind: 'skills', status: 'migrated' }, { kind: 'skills', status: 'migrated' },
      { kind: 'sessions', status: 'migrated' }, { kind: 'sessions', status: 'skipped' }],
  });
  await stage('import_preview', "{stamped:['importOfferedAt']}");
  await app.js(`window.__obSeed({importAgents:[{id:'codex', label:'Codex', dir:'/tmp/fixture', enabled:true}], importReport:${report}})`);
  await sleep(300);
  await snapshot('import-preview');
  {
    check('the preview offers a way back and a way on',
      JSON.stringify(await foot()) === JSON.stringify(['Back to the list', 'Import']), JSON.stringify(await foot()));
    say(await app.clickText('Back to the list', { selector: '#onboarding .ob-foot button' }));
    check('ONE click goes back to the list', (await step()) === 'import_pick', await step());
  }

  await stage('import_done', "{stamped:['importOfferedAt']}");
  await app.js(`window.__obSeed({importReport:${report.replace('"executed":false', '"executed":true')}})`);
  await sleep(300);
  await snapshot('import-done');
  {
    check('the result screen offers a button rather than "any key to start"',
      JSON.stringify(await foot()) === JSON.stringify(['Start using the agent']), JSON.stringify(await foot()));
    say(await app.clickText('Start using the agent', { selector: '#onboarding .ob-foot button' }));
    check('ONE click hands over to the agent', (await step()) === 'finished', await step());
  }

  const errs = await app.js('window.__errCount ? window.__errCount() : 0');
  check('no renderer faults during the whole driven pass', errs === 0, `__errCount=${errs}`);
} catch (e) {
  check('the driven pass ran to the end', false, e && e.message);
  try { await app.screenshot(join(SHOTS || tmpdir(), 'drive-failure.png')); } catch { /* nothing to see */ }
}

process.stdout.write(`\n${n - failures.length}/${n} passed${failures.length ? ' — FAILED: ' + failures.join('; ') : ''}\n`);
if (!process.argv.includes('--keep')) await app.close();
process.exit(failures.length ? 1 : 0);
