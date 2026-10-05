/**
 * integration.drive.mjs — the whole app, once, the way a new user meets it.
 *
 * The four r6 lanes each drove their own corner: the wizard's screens, the
 * composer's parameter controls, the cloud providers, five human errands.
 * This is the pass that has to hold once they are all in one tree — the
 * ordinary arc of a first afternoon, in one window, on a state directory
 * that has never been used:
 *
 *   first run with the mouse only  →  a cloud provider with a real key  →
 *   a message and a reply  →  switch to local  →  switch back to cloud  →
 *   add and switch provider  →  switch model  →  a reply from the model
 *   that was chosen last.
 *
 * Every action is a trusted CDP input event through `drive.mjs`. Nothing
 * here calls into the app: no `window.__*`, no config write, no seeded
 * state beyond the `.env` a person would already have. `Runtime.evaluate`
 * is used only to LOOK. If a step cannot be reached with the pointer, that
 * is the finding.
 *
 *   ATAG_TEST_ENV=/dir/.env ATAG_TEST_PORT=9410 \
 *     node desktop/test/integration.drive.mjs
 *
 * `--shots DIR` writes a PNG per stage. `--keep` leaves the app up.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sleep } from './drive.mjs';
import { CDP_PORT, PROVIDER, activeModel, ask, firstRun, freshDirs, waitTurn } from './harness.mjs';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const SHOTS = argOf('--shots', null);
const KEEP = argv.includes('--keep');

/* The other provider, so "switch provider" has somewhere to go. */
const OTHER = PROVIDER === 'aimlapi'
  ? { id: 'openrouter', row: 'OpenRouter', env: 'OPENROUTER_API_KEY' }
  : { id: 'aimlapi', row: 'AI/ML API', env: 'AIMLAPI_API_KEY' };

let passed = 0;
const failures = [];
function ok(what, detail = '') {
  passed += 1;
  console.log(`   ✓ ${what}${detail ? ` — ${detail}` : ''}`);
}
function bad(what, detail = '') {
  failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
  console.log(`   ✘ ${what}${detail ? ` — ${detail}` : ''}`);
}
function want(cond, what, detail = '') { (cond ? ok : bad)(what, detail); return !!cond; }
const stage = (n, t) => console.log(`\n${n}. ${t}`);

/* ------------------------------------------------------------ looking -- */

/** The composer's parameter chips, left to right: the id each stands for
    (`data-id`) and the words a person reads on it (Calm S2). */
const chips = (app) => app.eval(`[...document.querySelectorAll('#composer .cfoot [data-sel-open]')]
  .map((n) => ({kind: n.dataset.selOpen, id: n.dataset.id || '', text: (n.textContent || '').trim()}))`);

/** The rows of whatever selector popover is open. */
const selRows = (app) => app.eval(`[...document.querySelectorAll('.selpop .modelrow')]
  .map((n) => ({label: (n.querySelector('.nm') || n).textContent.trim(), id: n.dataset.id || '',
                detail: (n.querySelector('.cap') || {textContent: ''}).textContent.trim(),
                active: n.classList.contains('on')}))`);

const selTitle = (app) => app.eval(`((document.querySelector('.selpop .selhead') || {}).textContent || '').trim()`);

/**
 * Wait until the composer has stopped moving.
 *
 * The chips paint the route the operator CLICKED before the write lands
 * (SWX.want), so a strip read while a switch is in flight is a screen
 * nobody will ever see. Two identical reads with the send button unlocked
 * is the same settling rule drive-selector.mjs learned the hard way.
 */
async function settled(app, timeout = 120000) {
  const until = Date.now() + timeout;
  let last = null;
  for (;;) {
    const locked = await app.eval(`!!document.querySelector('.sendbtn[disabled], .sendbtn.locked')`);
    const now = JSON.stringify(await chips(app));
    if (!locked && now === last) return JSON.parse(now);
    last = locked ? null : now;
    if (Date.now() > until) throw new Error(`the composer never settled: ${now}`);
    await sleep(500);
  }
}

/* ------------------------------------------------------------- acting -- */

/**
 * Open one of the composer's parameter controls by clicking its chip.
 *
 * The model pane is FETCHED (selLoadModels → `atag models` over IPC), and
 * while it is in flight the pane draws "Loading models…" over an
 * empty list. Reading the rows the instant the popover appears therefore
 * reports "0 rows" about a pane that is working perfectly — which is what
 * this driver did on its first pass, and it is the same too-early read the
 * selector lane wrote up in test/README.md. So: wait for the catalogue
 * line to go, the way a person waits for a list to arrive. If it never
 * goes, or the pane ends up empty with an error, that is the finding and
 * `selError` is what puts the app's own words in the transcript.
 */
async function openSel(app, kind) {
  await app.clickSel(`#composer .cfoot [data-sel-open="${kind}"]`);
  await app.waitFor(`!!document.querySelector('.selpop')`, `the ${kind} popover`, { quiet: true });
  await app.waitFor(`!/Loading models…/.test((document.querySelector('.selpop')||{}).textContent || '')`,
    `the ${kind} pane finished reading its catalogue`, { timeout: 90000, quiet: true }).catch(() => {});
  return selTitle(app);
}

/** Whatever the open pane is saying went wrong, in its own words. */
const selError = (app) => app.eval(`[...document.querySelectorAll('.selpop .cap')]
  .map((n) => (n.textContent || '').trim()).filter(Boolean).join(' | ')`);

/** The last few system lines in the transcript, verbatim — the app's own
    account of a turn, which is the only account a person gets. */
const systemSays = (app) => app.eval(`[...document.querySelectorAll('#scroller .col720 .sysrow')]
  .map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(-3).join(' | ')`);

/** Close a popover the way a person does — a click outside it (ATO-167 took
    its Done away). NEVER Escape: Escape opens the Manage menu in this app (the
    user asked for that), and the settings window it raises then covers the composer. */
async function closeSel(app) {
  if (await app.eval(`!!document.querySelector('.selpop')`)) {
    /* A trusted press on the scrim beside the popover (drive.mjs clickAway),
       not a `.click()` from Runtime.evaluate: the page must not be able to
       tell this from a hand. */
    await app.clickAway();
    await app.waitFor(`!document.querySelector('.selpop')`, 'the popover closed', { quiet: true });
  }
}

/** Click a row of the open selector, then let the switch finish. Calm (S7):
    rows show human names, so a row is found by the id it stands for
    (`data-id`), the same hook the composer chips carry. */
async function pickRow(app, id) {
  await app.clickSel(`.selpop .modelrow[data-id="${id}"]`);
  await sleep(400);
  await closeSel(app);
  return settled(app);
}

async function shot(app, name) {
  if (SHOTS) await app.screenshot(join(SHOTS, `${name}.png`));
}

/* --------------------------------------------------------------- run --- */

async function main() {
  const { base, stateDir, workspace } = freshDirs('integration');
  if (!existsSync(join(stateDir, '.env'))) {
    throw new Error('the fresh state dir has no .env — set ATAG_TEST_ENV to one holding the provider keys');
  }
  console.log(`atag desktop — the whole thing, driven`);
  console.log(`state ${stateDir}`);
  console.log(`port  ${CDP_PORT}   provider ${PROVIDER} → then ${OTHER.id}`);

  const app = await launch({ port: CDP_PORT, stateDir, workspace, verbose: true, launchTimeout: 90000 });
  try {
    stage(1, 'First run, with the mouse');
    await firstRun(app);
    await shot(app, '01-set-up');
    ok('the first-run wizard was finished by clicking', activeModel(stateDir) || 'no config');
    const first = await settled(app);
    want(first.some((c) => c.kind === 'backend' && /cloud/.test(c.id)),
      'the composer says a cloud route is live', JSON.stringify(first));
    want(first.some((c) => c.kind === 'provider' && c.id.includes(PROVIDER === 'aimlapi' ? 'aimlapi' : 'openrouter')),
      'the provider chip names the provider that was set up', JSON.stringify(first));

    stage(2, 'Ask it something, and get an answer');
    await ask(app, 'Reply with exactly the word pineapple and nothing else.');
    const { reply } = await waitTurn(app);
    await shot(app, '02-first-reply');
    want(/pineapple/i.test(reply), 'the cloud provider answered', JSON.stringify(String(reply).slice(0, 80)));

    stage(3, 'Switch to local, by clicking the backend chip');
    const title = await openSel(app, 'backend');
    want(title === 'Where it runs', 'the backend chip opens "Where it runs"', title);
    const backends = (await selRows(app)).map((r) => r.id);
    want(backends.length === 4, 'four backends are offered (cloud, local, custom, fusion)', backends.join(', '));
    const onLocal = await pickRow(app, 'local');
    await shot(app, '03-local');
    want(onLocal.some((c) => c.kind === 'backend' && /local/.test(c.id)),
      'the backend chip reads local', JSON.stringify(onLocal));
    want(!onLocal.some((c) => c.kind === 'provider'),
      'the managed-local route draws NO provider control, as composerSwitchKindsFor says',
      JSON.stringify(onLocal.map((c) => c.kind)));

    stage(4, 'Switch back to cloud');
    await openSel(app, 'backend');
    const onCloud = await pickRow(app, 'cloud');
    await shot(app, '04-cloud-again');
    want(onCloud.some((c) => c.kind === 'backend' && /cloud/.test(c.id)),
      'the backend chip reads cloud again', JSON.stringify(onCloud));
    want(onCloud.some((c) => c.kind === 'provider'),
      'the provider control is back', JSON.stringify(onCloud.map((c) => c.kind)));

    stage(5, `Add ${OTHER.row} from the provider chip, and switch to it`);
    await openSel(app, 'provider');
    const before = (await selRows(app)).map((r) => r.label);
    want(before.some((l) => /Add a new provider/i.test(l)),
      'the provider pane ends in the TUI\'s own action row', before.join(' | '));
    await app.clickText('Add a new provider', { scope: '.selpop' });
    await sleep(600);
    await app.clickText(OTHER.row, { scope: '.popover' });
    await sleep(600);
    const keyField = await app.eval(`!!document.querySelector('#wiz-key')`);
    if (want(keyField, `the ${OTHER.row} key screen opened from the composer chip`)) {
      await app.clickSel('#wiz-key');
      await app.typeSecret(readKey(stateDir, OTHER.env), `the ${OTHER.row} key`);
      await app.clickText('Next');
      /* ATO-161: a verified key opens the MODEL STEP in the popover (the
         catalogue, our default preselected, Use default / Use this model).
         The key field leaving is not the wizard closing any more — the
         provider is only written as active once a model is chosen, and
         closing the popover on the model step drops the unfinished entry. */
      await app.waitFor(`!!document.querySelector('.popover [data-wizmodel]') || !!document.querySelector('.popover .ob-err')`,
        'the key accepted — the model step', { timeout: 120000 });
      if (!(await app.eval(`!!document.querySelector('.popover [data-wizmodel]')`))) {
        throw new Error(`the ${OTHER.row} key was not accepted: `
          + JSON.stringify(await app.eval(`((document.querySelector('.popover .ob-err')||{}).textContent||'').trim()`)));
      }
      await app.clickText('Use default', { scope: '.popover' });
      await app.waitFor(`!document.querySelector('#wiz-key') && !document.querySelector('.popover [data-wizmodel]')`,
        'the default model taken and the wizard closing', { timeout: 120000 });
    }
    await closeSel(app);
    const onOther = await settled(app);
    await shot(app, '05-provider-switched');
    want(onOther.some((c) => c.kind === 'provider' && c.id.includes(OTHER.id)),
      `the provider chip followed to ${OTHER.id}`, JSON.stringify(onOther));

    stage(6, 'Switch model, by clicking the model chip');
    await openSel(app, 'model');
    const models = await selRows(app);
    want(models.length > 1, 'the model pane lists models',
      models.length > 1 ? `${models.length} rows` : `${models.length} rows — the pane says: ${await selError(app)}`);
    const current = (onOther.find((c) => c.kind === 'model') || {}).id || '';
    /* Pick a SMALL model, the way a person picks one to try a switch out.
       Taking the first row that is not the active one landed on
       `anthropic/claude-opus-5-fast`, and this key could afford 18 tokens
       of it — a true answer about the operator's credit, and a useless one
       about the desktop. The small names are tried in order and the first
       row that is not already active wins; if the catalogue has none of
       them the old rule stands, and stage 7 still holds either way. */
    const SMALL = /(mini|flash|lite|haiku|small|nano|8b|4b|turbo)/i;
    const usable = models.filter((m) => !m.active && m.id && !current.includes(m.id));
    const target = usable.find((m) => SMALL.test(m.id)) || usable[0];
    if (want(!!target, 'there is another model to move to', target ? target.id : 'none')) {
      const onModel = await pickRow(app, target.id);
      await shot(app, '06-model-switched');
      want(onModel.some((c) => c.kind === 'model' && c.id.includes(target.id)),
        'the model chip followed the click', JSON.stringify(onModel));
    } else {
      /* The pane stays OPEN when there is nothing to pick, and it covers the
         composer — the next stage then types into the popover's footer and
         the run dies on "nothing editable has focus", which says nothing
         about the app. Leave the screen the way a person would: closed. */
      await closeSel(app);
    }

    stage(7, 'The model chosen last has to answer — or say why it will not');
    await ask(app, 'Reply with exactly the word mango and nothing else.');
    const { reply: second } = await waitTurn(app);
    await shot(app, '07-second-reply');
    /* The contract this stage holds is the CLOUD lane's, and it is the
       honest one: the turn either answers, or it tells the operator which
       provider refused and what the provider said. What it may never be
       again is a bare `fetch failed` from a llama-server nobody started —
       the old known red, fixed in src/llm/ (resolveFallbackChain no longer
       appends an undownloaded local tail, runWithFallback no longer
       rethrows the last failure over the first informative one).
       A key with no credit left is a fact about the operator's account,
       not a defect in this window, and a run must be able to say which of
       the two it met. Driven here on 2026-09-08 the account had 18 tokens
       of headroom, and the app said so, on screen, with the remedy. */
    const said = await systemSays(app);
    const answered = /mango/i.test(second);
    const refused = /rejected the request|\(4\d\d\)|requires more credits|insufficient|quota/i.test(said);
    const bare = /\[transport\][^\n]*fetch failed/i.test(said) || /ECONNREFUSED/i.test(said);
    want(answered || refused, 'the turn either answered or named the refusal',
      answered ? JSON.stringify(String(second).slice(0, 120)) : said.slice(0, 300));
    want(!bare, 'no bare transport error — the refusal names the provider and the reason',
      bare ? said.slice(0, 300) : 'nothing anonymous on screen');
    if (!answered && refused) {
      console.log('   · the provider refused for credit, not for a fault in the app — that is a fact about the key.');
    }

    stage(8, 'Both answers are still in the transcript');
    const all = await app.replies();
    want(all.length >= 2, 'the conversation kept both turns', `${all.length} agent turns`);
  } finally {
    if (!KEEP) await app.close();
    else console.log('\n--keep: the app is still up.');
  }

  console.log('\n──────────────────────────────────────────────');
  console.log(`${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  ✘ ${f}`);
  console.log(`state kept at ${base}`);
  process.exit(failures.length ? 1 : 0);
}

/** Read one key out of the run's own copied .env. Never printed. */
function readKey(stateDir, name) {
  const m = readFileSync(join(stateDir, '.env'), 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
  if (!m) throw new Error(`the seeded .env has no ${name}`);
  return m[1].trim();
}

main().catch((e) => { console.error(`\n✘ ${e && e.stack ? e.stack : e}`); process.exit(1); });
