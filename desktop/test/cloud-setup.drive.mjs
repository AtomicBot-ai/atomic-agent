/**
 * cloud-setup.drive.mjs — the cloud providers, driven like a person.
 *
 * Every action below is a REAL mouse click or a REAL keystroke over CDP.
 * Nothing here calls a renderer function, and nothing here reads a
 * `window.__*` hook to make a step happen: the only script that runs in
 * the page reads text, classes and geometry back. A control that a hand
 * cannot reach fails this file, which is the whole point — the previous
 * suite drove `wizNext()` directly and so never noticed that the first-run
 * cloud wizard's `Next` BUTTON was wired to nothing.
 *
 * It talks to the real OpenRouter and AI/ML API, with the keys in the seed
 * directory's `.env`, and it is not finished until each provider has
 * answered a real message.
 *
 *   ATAG_DRIVE_STATE_SEED=/path/with/.env \
 *   ATAG_DRIVE_PORT=9402 \
 *   node test/cloud-setup.drive.mjs
 *
 * The seed directory is only read: the run gets its own fresh state
 * directory under the OS temp dir with a copy of the `.env` in it, so a
 * first run is genuinely a first run and no existing installation is
 * touched.
 */
import { mkdtempSync, copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, sleep, check, step, report } from './drive.mjs';

const SEED = process.env.ATAG_DRIVE_STATE_SEED;
const PORT = Number(process.env.ATAG_DRIVE_PORT || 9402);
const KEEP = process.env.ATAG_DRIVE_KEEP === '1';
if (!SEED || !existsSync(join(SEED, '.env'))) {
  console.error('ATAG_DRIVE_STATE_SEED must name a directory containing a .env with OPENROUTER_API_KEY and AIMLAPI_API_KEY');
  process.exit(2);
}

const stateDir = mkdtempSync(join(tmpdir(), 'atag-drive-'));
copyFileSync(join(SEED, '.env'), join(stateDir, '.env'));
console.log(`fresh state dir: ${stateDir}`);

/* The keys are TYPED into the wizard, not left to the ambient variable:
   the operator's complaint is about the configuring, and a run that only
   ever presses Next on an empty field never exercises it. They are read
   here and typed there; they are never logged, and no check ever prints a
   field's value — only its length. */
const ENV = Object.fromEntries(readFileSync(join(SEED, '.env'), 'utf8').split('\n')
  .map((l) => l.replace(/^\s*export\s+/, '').trim())
  .filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '')]));
for (const name of ['OPENROUTER_API_KEY', 'AIMLAPI_API_KEY']) {
  if (!ENV[name]) { console.error(`the seed .env has no ${name}`); process.exit(2); }
}

const app = await launch({ stateDir, port: PORT });
let failed = 0;

/** The composer's chips, left to right — what the app says is active. */
const chips = () => app.js(`[...document.querySelectorAll('.cfoot .cchip')].map((n) => (n.textContent||'').trim())`);
/** The transcript, flattened. Rows are `#scroller .col720 > .turn`; a
    user's own message is the one that carries `.usr`. */
const TURNS = `[...document.querySelectorAll('#scroller .col720 > .turn')]`;
/* Only what the MODELS said. Reading the whole column would let every
   "reply with exactly the word X" question satisfy a check about X — the
   answer would never have to arrive for the assertion to pass. */
const transcript = () => app.js(`${TURNS}.filter((n) => !n.classList.contains('usr'))
  .map((n) => n.querySelector(':scope > div > .prose'))
  .filter(Boolean)
  .map((n) => (n.textContent||'').replace(/\\s+/g,' ').trim()).join(' | ')`);
/** The onboarding screen's visible controls. */
const wizard = () => app.js(`(() => {
  const ob = document.querySelector('#onboarding');
  if (!ob) return null;
  const t = (n) => (n && n.textContent || '').replace(/\\s+/g,' ').trim();
  return { head: t(ob.querySelector('.ob-h')),
           rows: [...ob.querySelectorAll('.ob-row, .modelrow')].map((n) => t(n).slice(0, 52)),
           buttons: [...ob.querySelectorAll('button')].map((n) => t(n).slice(0, 30)),
           hints: [...ob.querySelectorAll('.ob-hints .hint, .ob-hints .hint-live')].map((n) => t(n)),
           key: !!ob.querySelector('#wiz-key'),
           error: t(ob.querySelector('.ob-err')) };
})()`);

/**
 * Activate a list row the way the flow asks a hand to: MouseListRow is
 * two-stage — the first click moves the cursor onto the row, the second
 * sends the same Enter the keyboard sends. Clicking once and calling the
 * row dead would be as wrong as calling the handler directly.
 */
const ROW_TAGS = '[data-obrow],[data-obwiz],.modelrow';
async function pickRow(text, opts = {}) {
  const o = { tags: ROW_TAGS, settleMs: 900, ...opts };
  await app.clickText(text, o);
  // The row under the cursor activates on the FIRST click, so the second
  // one only happens while the row is still on screen — otherwise it would
  // land on whatever the flow moved to.
  return app.clickText(text, { ...o, optional: true, settleMs: (opts.settleMs || 1500) });
}

/**
 * Walk whatever the flow puts up after a backend is configured — the
 * wait-or-jump screen, the second-backend offer, the import screen — by
 * clicking the row that means "take me to the agent", until the setup is
 * gone. Only rows that are actually on screen are clicked.
 */
async function finishOnboarding({ timeoutMs = 90000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const exits = ['Start using the agent now', 'Skip — take me to the agent', 'Skip adding data from other agents'];
  while (Date.now() < deadline) {
    if (!(await app.js(`!!document.querySelector('#onboarding')`))) return;
    let moved = false;
    for (const label of exits) {
      if (await app.js(`[...document.querySelectorAll('#onboarding [data-obrow]')].some((n) => (n.textContent||'').includes(${JSON.stringify(label)}))`)) {
        await pickRow(label, { settleMs: 2000 });
        moved = true;
        break;
      }
    }
    if (!moved) await sleep(1500);
  }
  throw new Error('finishOnboarding: the setup never closed');
}

/**
 * Type into the composer and wait for the assistant's answer to land.
 *
 * The user's own row is `.turn.usr`, and its text carries the message
 * plus the copy/resend affordances that sit beside it, so it is matched
 * by CONTAINS. The answer is the assistant PROSE that follows it.
 */
const AFTER_USER = (text) => `(() => {
  const turns = ${TURNS};
  let at = -1;
  for (let i = 0; i < turns.length; i += 1) {
    if (!turns[i].classList.contains('usr')) continue;
    if ((turns[i].textContent || '').replace(/\\s+/g,' ').includes(${JSON.stringify(text)})) at = i;
  }
  if (at < 0) return null;
  /* The ANSWER is an assistant prose block. A turn can open with a
     "Reasoning · N steps" card, and taking the first row after the
     question as the reply reads that card as the model's answer and
     declares a working model broken. */
  const said = turns.slice(at + 1)
    .map((n) => n.querySelector(':scope > div > .prose'))
    .filter((n) => n && (n.textContent || '').trim().length > 0)
    .map((n) => n.textContent.replace(/\\s+/g,' ').trim());
  return said.length ? said.join(' ') : null;
})()`;

/* The composer refuses to send while a provider switch is still landing —
   it keeps the draft and says so, and the send button wears a spinner
   until the new configuration is live. A person waits for that and presses
   Enter again, so this does too, rather than pressing once and calling a
   working app broken. */
const SEND_UNLOCKED = `!document.querySelector('.sendbtn.locked')`;

/* Whatever the app said OUTSIDE the prose — "turn failed [transport]: …"
   is a `.sysrow`, not a turn, so a reply check that reads only the prose
   reports "(no reply)" and hides the reason the app was showing all
   along. */
const systemRows = () => app.js(`[...document.querySelectorAll('#scroller .col720 .sysrow')]
  .map((n) => (n.textContent||'').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(-4).join(' | ')`);

async function askAndWait(text, { timeoutMs = 180000 } = {}) {
  await app.waitFor(SEND_UNLOCKED, { timeoutMs: 120000, label: 'the composer unlocks after a switch' });
  await app.type('#entry', text, { settleMs: 400 });
  for (let tries = 0; tries < 4; tries += 1) {
    await app.press('Enter', { settleMs: 1500 });
    if (!(await app.js(`((document.querySelector('#entry')||{}).value || '').trim().length`))) break;
    await app.waitFor(SEND_UNLOCKED, { timeoutMs: 120000, label: 'the composer unlocks after a switch' });
  }
  if (await app.js(`((document.querySelector('#entry')||{}).value || '').trim().length`)) {
    const why = await app.js(`JSON.stringify({
      swx: window.__swxState ? window.__swxState().pending : 'n/a',
      label: window.__swxState ? window.__swxState().label : 'n/a',
      bsw: window.__bsw ? window.__bsw() : null,
      sel: window.__sel ? window.__sel() : null,
      locked: !!document.querySelector('.sendbtn.locked'),
      active: (document.activeElement||{}).id || (document.activeElement||{}).tagName,
      toasts: window.__toasts ? window.__toasts() : null })`);
    throw new Error(`the composer would not send ${JSON.stringify(text)} — the draft is still in the box: ${why}`);
  }
  await app.waitFor(AFTER_USER(text), { timeoutMs, label: `reply to ${JSON.stringify(text)}` });
  return app.js(AFTER_USER(text));
}

try {
  /* ============================================================
     1. First run, the operator's own path: Local models FIRST, then a
        cloud provider from inside the setup.
     ============================================================ */
  step(1, 'first run opens on the intro');
  await app.waitFor(`!!document.querySelector('#onboarding')`, { timeoutMs: 40000 });
  check('the wizard opened by itself on a fresh state dir',
    await app.js(`document.querySelector('#onboarding').className.includes('ob-intro-layer')`));

  step(2, 'press on the intro to get to the backend choice');
  /* The intro takes two presses while the tagline is still typing — the
     first one finishes the type-on, the second moves on — so click the way
     a person does: again, until the screen changes. */
  for (let i = 0; i < 4 && await app.js(`/ob-intro-layer/.test((document.querySelector('#onboarding')||{}).className||'')`); i++) {
    await app.clickAt(500, 300, { settleMs: 1200 });
  }
  let w = await wizard();
  check('the three backends are offered', w.rows.length === 3, JSON.stringify(w.rows));

  step(3, 'choose "Local models" — the choice the complaint starts from');
  await pickRow('Local models', { settleMs: 2500 });
  w = await wizard();
  check('the local model list is up', /Recommended models/.test(w.head || ''), JSON.stringify(w.head));

  step(4, 'the local list must have a MOUSE way back (it advertises `esc back`)');
  check('the `esc back` hint is a live control', w.hints.some((h) => /esc/.test(h)), JSON.stringify(w.hints));
  await app.clickText('back', { within: '.ob-hints', tags: 'button', settleMs: 1500 });
  w = await wizard();
  check('clicking it lands back on the backend choice', w.rows.length === 3 && w.rows.some((r) => /Cloud models/.test(r)),
    JSON.stringify(w.rows));

  step(5, 'back into Local models and start a download, then cancel it at once');
  await pickRow('Local models', { settleMs: 2000 });
  /* The recommended picks arrive from `atag models list`, which on a cold
     state directory can take the better part of a minute — the list is
     just the Hugging Face row until it lands. Wait for a pick the way a
     person waits for a list to fill, rather than clicking into a gap. */
  await app.waitFor(`[...document.querySelectorAll('#onboarding .ob-row, #onboarding .modelrow')].some((n) => /qwen-3.5-4b/.test(n.textContent || ''))`,
    { timeoutMs: 120000, label: 'the recommended local models arrive' });
  await pickRow('qwen-3.5-4b', { settleMs: 3500 });
  w = await wizard();
  check('the download screen is up with the cloud offer on it',
    await app.js(`[...document.querySelectorAll('#onboarding .ob-offer')].some((n) => /Set up a cloud model in the meantime/.test(n.textContent || ''))`),
    JSON.stringify(w.buttons));
  // Cancel the pull straight away — this file has no business fetching
  // gigabytes, and the cloud offer stays on screen either way.
  await app.clickText('Cancel', { tags: 'button', settleMs: 1200, optional: true });

  step(6, 'take the wizard up on "set up a cloud model in the meantime"');
  await app.clickText('Set up a cloud', { settleMs: 1800 });
  w = await wizard();
  check('the provider list opened inside the setup', /add provider/.test(w.head || ''), JSON.stringify(w.head));
  check('OpenRouter and AI/ML API are both on it',
    w.rows.some((r) => /OpenRouter/.test(r)) && w.rows.some((r) => /AI\/ML API/.test(r)));

  step(7, 'pick OpenRouter and TYPE a key that is WRONG, the way a hand slips');
  await pickRow('OpenRouter', { settleMs: 1500 });
  w = await wizard();
  check('the API key screen is up', /API key/.test(w.head || '') && w.key, JSON.stringify(w.head));
  await app.type('#wiz-key', 'sk-or-v1-' + '0'.repeat(64), { settleMs: 400 });
  await app.clickText('Next', { settleMs: 2000 });
  await app.waitFor(`!/asking the provider/.test((document.querySelector('#onboarding')||{}).textContent || '')`,
    { timeoutMs: 90000, label: 'the bogus key is checked' });
  w = await wizard();
  /* The wizard used to say it was "checking the key against the
     provider's model list". For OpenRouter and AI/ML API that list is a
     catalogue BUNDLED IN THE BINARY, so it answered for any string at
     all: the screen said "Cloud model ready", the setup closed, and the
     first message was where the operator found out. A verification step
     that cannot fail is worse than none. */
  check('a wrong key is REFUSED, on the key screen, with a reason',
    !!w && w.key && !!w.error, JSON.stringify({ head: w && w.head, error: w && w.error }));

  step(8, 'correct the key and CLICK Next — the control the complaint is about');
  await app.clear('#wiz-key');
  await app.type('#wiz-key', ENV.OPENROUTER_API_KEY, { settleMs: 400 });
  check('the typing landed in the key field',
    await app.js(`(document.querySelector('#wiz-key')||{}).value.length`) === ENV.OPENROUTER_API_KEY.length);
  await app.clickText('Next', { settleMs: 2000 });
  const verifying = await app.js(`/Verifying|asking the provider/.test((document.querySelector('#onboarding')||{}).textContent || '')`);
  check('the click actually starts the verification (it used to do nothing at all)', !!verifying);
  await app.waitFor(`!/asking the provider/.test((document.querySelector('#onboarding')||{}).textContent || '')`,
    { timeoutMs: 120000, label: 'key verification' });
  w = await wizard();
  check('the real key is accepted and the key screen is left behind',
    !w || !w.key, JSON.stringify({ head: w && w.head, error: w && w.error }));

  step(9, 'finish the setup');
  await finishOnboarding();
  await app.clickText('Cancel', { tags: 'button', settleMs: 1000, optional: true });
  let c = await chips();
  check('the composer says a cloud route is active', c[0] === 'cloud' && c[1] === 'openrouter', JSON.stringify(c));

  /* ============================================================
     2. OpenRouter, end to end.
     ============================================================ */
  step(10, 'send a real message on OpenRouter');
  const reply1 = await askAndWait('Reply with exactly the word pineapple and nothing else.');
  check('OpenRouter answered', /pineapple/i.test(reply1),
    `${JSON.stringify(reply1).slice(0, 200)} · system rows: ${await systemRows()}`);

  /* ============================================================
     3. AI/ML API, added AFTER setup from the composer's own chip.
     ============================================================ */
  step(11, 'add AI/ML API from the composer provider chip');
  await app.clickText('openrouter', { tags: '.cfoot .cchip', settleMs: 1200 });
  await app.clickText('Add a new provider', { settleMs: 1500 });
  await app.clickText('AI/ML API', { settleMs: 1500 });
  check('the AI/ML API key screen is up',
    await app.js(`!!document.querySelector('#wiz-key') && /AI\\/ML API/.test(document.body.textContent)`));
  await app.type('#wiz-key', ENV.AIMLAPI_API_KEY, { settleMs: 400 });
  await app.clickText('Next', { settleMs: 2000 });
  await app.waitFor(`[...document.querySelectorAll('.cfoot .cchip')].some((n) => (n.textContent||'').trim() === 'aimlapi')`,
    { timeoutMs: 90000, label: 'aimlapi becomes the active provider' });
  c = await chips();
  check('the chips switched to aimlapi with a model of its own', c[1] === 'aimlapi' && !!c[2], JSON.stringify(c));

  step(12, 'send a real message on AI/ML API');
  const reply2 = await askAndWait('Reply with exactly the word banana and nothing else.');
  check('AI/ML API answered', /banana/i.test(reply2),
    `${JSON.stringify(reply2).slice(0, 200)} · system rows: ${await systemRows()}`);

  /* ============================================================
     4. Switching after setup: provider A → provider B, then model → model.
     ============================================================ */
  step(13, 'switch back to OpenRouter from Settings › LLM › Cloud');
  await app.press('Escape', { settleMs: 800 });
  // One click opens the settings window; a second would close it again.
  if (!(await app.js(`!!document.querySelector('#settings')`))) {
    await app.clickText('Settings', { tags: 'button', settleMs: 1500 });
  }
  await app.waitFor(`!!document.querySelector('#settings .setmenu')`, { timeoutMs: 20000, label: 'the settings window opens' });
  await app.clickText('LLM', { within: '#settings .setmenu', tags: 'button', settleMs: 2500 });
  await app.waitFor(`!!document.querySelector('[data-act="llm:mode:cloud"]')`, { timeoutMs: 20000, label: 'the LLM pane opens' });
  await app.clickSel('[data-act="llm:mode:cloud"]', { settleMs: 2500 });
  check('both providers are listed with a resolved key',
    await app.js(`/openrouter \\[openrouter\\] key ok/.test(document.body.textContent) && /aimlapi \\[aimlapi\\] key ok/.test(document.body.textContent)`));
  await app.clickText('switch cloud route to openrouter', { settleMs: 2000 });
  await app.waitFor(`[...document.querySelectorAll('.cfoot .cchip')].some((n) => (n.textContent||'').trim() === 'openrouter')`,
    { timeoutMs: 90000, label: 'the route moves to openrouter' });
  /* The pane repaints from the live config a beat after the route moves,
     so this waits for the row to say it rather than sampling once. */
  const settingsAgrees = await app.waitFor(
    `/openrouter \\[openrouter\\] key ok · Current provider: openrouter/.test(document.body.textContent)`,
    { timeoutMs: 30000, label: 'Settings names openrouter as current' }).catch(() => false);
  check('Settings agrees the current provider is openrouter', settingsAgrees,
    await app.js(`(document.body.textContent.match(/openrouter \\[openrouter\\][^\\n]{0,60}/) || [''])[0]`));

  step(14, 'switch to a different OpenRouter model by clicking its row');
  await app.waitFor(`[...document.querySelectorAll('[data-llm-row]')].some((n) => /claude-haiku/.test(n.dataset.llmRow || ''))`,
    { timeoutMs: 60000, label: 'the provider model list arrives' });
  await app.clickText('use openrouter/anthropic/claude-haiku-4.5', { settleMs: 2500 });
  await app.waitFor(`[...document.querySelectorAll('.cfoot .cchip')].some((n) => (n.textContent||'').trim() === 'anthropic/claude-haiku-4.5')`,
    { timeoutMs: 90000, label: 'the model chip follows the pick' });
  c = await chips();
  check('the composer chips and Settings agree on the new model',
    c[1] === 'openrouter' && c[2] === 'anthropic/claude-haiku-4.5', JSON.stringify(c));

  /* KNOWN RED, and deliberately left red — it names a defect, it is not a
     broken check. In 4 of 5 runs the FIRST turn after `selectCloudModel`
     fails, and the app says so honestly: "turn failed [transport]: fetch
     failed". The trace agrees — two `error` frames 14 ms apart and
     `turn_finished reason:failed` 816 ms after `turn_started`, with no
     `llm_completion` — while the two turns before it, on the same
     OpenRouter key and the same agent, completed normally. The same key
     and the same model id answer "mango" from a plain curl to
     https://openrouter.ai/api/v1/chat/completions, so the provider is
     reachable and the credentials are good: what fails is the agent's own
     request on the first turn after the model switch, inside
     src/agent/step-executor.ts (`toLlmFailure`), which is outside this
     desktop tree. Deleting the check would hide a turn the operator
     cannot run. */
  step(15, 'the newly picked model answers for real');
  await app.press('Escape', { settleMs: 1500 });
  const reply3 = await askAndWait('Reply with exactly the word mango and nothing else.');
  check('the model chosen after setup answered', /mango/i.test(reply3),
    `${JSON.stringify(reply3).slice(0, 200)} · system rows: ${await systemRows()}`);

  const tail = await transcript();
  check('the three answers are in the transcript, in the models\' own words',
    /pineapple/i.test(tail) && /banana/i.test(tail) && /mango/i.test(tail), tail.slice(0, 200));
} catch (err) {
  console.log(`\nDRIVER ERROR: ${err.message}`);
  try { await app.screenshot(join(tmpdir(), 'atag-cloud-drive-failure.png')); } catch { /* best effort */ }
  failed = 1;
} finally {
  failed += report('cloud-setup.drive');
  const errs = app.consoleLines.filter((l) => /^\[error\]|^\[exception\]/.test(l));
  if (errs.length) console.log(`renderer errors:\n  ${errs.slice(0, 10).join('\n  ')}`);
  await app.quit();
  if (!KEEP) { try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* leave it */ } }
}
process.exit(failed ? 1 : 0);
