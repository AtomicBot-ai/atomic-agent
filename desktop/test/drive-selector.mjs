/**
 * drive-selector.mjs — the composer's parameter controls, driven by hand.
 *
 * The user's complaint, in their words: "when the user is switching between
 * local and cloud models, the list of the parameters that he can trigger
 * should change. For cloud models that should be cloud, provider, and model.
 * For local it should be local and model. Just like it works in the TUI."
 *
 * The TUI's rule is one function — `composerSwitchKindsFor` in
 * src/tui/composer-switch/composer-switch-state.ts:
 *
 *     backend === "local" ? ["backend","model"] : ["backend","provider","model"]
 *
 * so `local` — the managed llama.cpp this app downloads and runs — is the ONE
 * route without a provider control, and `cloud` AND `custom` both carry all
 * three. `custom` is the operator's own llama-server; the TUI names its
 * provider `llama.cpp` (`selectPromptLlmMeta`, llm-panel-selectors.ts:183).
 *
 * Everything below is a REAL click through the CDP Input domain — the same
 * path a hand takes. `snap()` only ever LOOKS. If a step here could only be
 * performed by calling an internal function, that would be a bug in the app,
 * not a reason to call the function.
 *
 *   node desktop/test/drive-selector.mjs --port 9403 --state /path/to/state
 *
 * Two notes on driving this particular screen:
 *
 *  - **Never press Escape to close a popup.** Escape in this app opens the
 *    Manage menu ("Escape button should open the menu" — the user's words,
 *    renderer.js:4018), and the settings window it raises then covers the
 *    composer, so the next click lands on the overlay. A person closes a
 *    switch with its own `Done` button; so does this script.
 *  - **The `custom` route cannot be entered by clicking.** Its backend row
 *    deep-links to Settings › LLM › External, which only saves a base URL
 *    after a `/health` probe answers as llama.cpp — there is no such server
 *    on a test machine. Part 3 therefore ARRANGES that one route with the
 *    sanctioned `atag config set localModels.mode external` between two app
 *    runs, and drives everything else.
 */
import { execFileSync } from 'node:child_process';

import { launch, tape } from './drive.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : fallback;
};

const PORT = Number(arg('port', 9403));
const STATE = arg('state', process.env.ATOMIC_AGENT_STATE_DIR);
const SHOTS = arg('shots', null);
const ATAG = arg('atag', 'atag');

/* ---- what the screen says, read the way a person reads it ---- */

/** The composer's control strip: which controls are on it, left to right. */
const CHIPS = `[...document.querySelectorAll('#composer .cfoot [data-sel-open]')]
  .map((b) => ({ kind: b.dataset.selOpen, text: (b.textContent||'').replace(/\\s+/g,' ').trim() }))`;

/** The open switch popup: its title and the rows under it. */
const POPUP = `(() => {
  const pop = document.querySelector('.selpop');
  if (!pop) return null;
  return {
    title: (pop.querySelector('.selhead')||{textContent:''}).textContent.replace(/\\s+/g,' ').trim(),
    rows: [...pop.querySelectorAll('.modelrow')].slice(0,14).map((r) => ({
      label: (r.querySelector('.nm')||{textContent:''}).textContent.trim(),
      on: r.classList.contains('on'),
    })),
  };
})()`;

/** Which pane Settings › LLM is showing. */
const LLM_MODE = `(() => {
  const on = document.querySelector('#settings .llmmode.on');
  return on ? on.textContent.trim() : null;
})()`;

/** The route, as the window itself paints it on the backend control. */
const BACKEND = `(() => {
  const b = document.querySelector('#composer .cfoot [data-sel-open="backend"]');
  return b ? (b.textContent||'').replace(/\\s+/g,' ').trim() : null;
})()`;

/** Anything the app is complaining about right now — toasts and switch errors. */
const TROUBLE = `[
  ...[...document.querySelectorAll('#toasts .toast')].map((n)=>'toast: '+(n.textContent||'').replace(/\\s+/g,' ').trim()),
  ...[...document.querySelectorAll('.selpop .cap')].filter((n)=>/danger/.test(n.getAttribute('style')||'')).map((n)=>'switch: '+n.textContent.trim()),
]`;

const kinds = (chips) => chips.map((c) => c.kind);
/** composerSwitchKindsFor, restated here so the test owns the expectation. */
const expectedKinds = (backend) =>
  backend === 'local' ? ['backend', 'model'] : ['backend', 'provider', 'model'];

async function open(app) {
  const ready = await app.waitFor(
    `document.querySelector('#composer .cfoot [data-sel-open="backend"]')`,
    { timeoutMs: 60000 },
  );
  if (!ready) return false;
  // A window paints its chips from defaults until the agent is up and the
  // first config read lands — the app says so itself, in the transcript, and
  // reading the strip before that line appears means reading `cloud · no
  // provider · claude-opus-5` off a config that says nothing of the sort.
  await app.waitFor(`/connected to atomic-agent/.test(document.body.innerText)`, { timeoutMs: 90000 });
  await settled(app);
  return true;
}

/**
 * Wait until the window has stopped moving, which is what a person does
 * before deciding what they are looking at.
 *
 * Three things lie if you read too early. The composer paints the route the
 * operator CLICKED before the write lands (`SWX.want`, renderer.js swxRun), so
 * the backend word is right while the provider and model beside it are still
 * the old route's. The send button carries `.locked` for the whole switch. And
 * a freshly opened window draws its chips from defaults until the first
 * `/api/config` answer arrives — which is how a run can read `cloud ·
 * no provider · claude-opus-5` off an app whose config says something else.
 * So: no lock, no `switching…` in an open switch, and the strip unchanged
 * across THREE reads — two was not enough on a machine where switching to
 * the local route starts a daemon: the strip holds still for a second while
 * the local-models snapshot is still in flight, and the model slot changes
 * again when it lands (before it, `selectPromptLlmMeta` shows the catalogue
 * id; after it, `download model` if there is nothing on disk — both are the
 * TUI's own answers, at different moments).
 */
async function settled(app, { timeoutMs = 120000 } = {}) {
  const READ = `JSON.stringify({
    chips: ${CHIPS},
    locked: !!document.querySelector('.sendbtn.locked'),
    busy: /switching|saving|starting/.test((document.querySelector('.selhead')||{textContent:''}).textContent),
  })`;
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  while (Date.now() < deadline) {
    const now = await app.snap(READ);
    const state = JSON.parse(now);
    seen.push(now);
    if (seen.length > 3) seen.shift();
    if (!state.locked && !state.busy && seen.length === 3 && seen[0] === seen[1] && seen[1] === seen[2]) return true;
    await app.sleep(900);
  }
  return false;
}

/**
 * A person clicks the route they want and then WAITS for the window to say it
 * is on it. Switching to the local route restarts the agent against a
 * llama-server, which on a cold machine is tens of seconds; reading the strip
 * before the word changes reads the route the operator just left.
 */
async function onRoute(app, word, { timeoutMs = 180000 } = {}) {
  const ok = await app.waitFor(
    `/${word}/.test((document.querySelector('#composer .cfoot [data-sel-open="backend"]')||{textContent:''}).textContent||'')`,
    { timeoutMs },
  );
  if (!ok) return false;
  return settled(app);
}

/** Wait for a freshly opened switch to have listed something. */
async function popupRows(app, { timeoutMs = 30000 } = {}) {
  await app.waitFor(`document.querySelectorAll('.selpop .modelrow').length > 0`, { timeoutMs });
  return app.snap(POPUP);
}

/** A person's way out of a switch: its own Done button. NOT Escape. */
async function done(app) {
  const r = await app.clickSel('.selpop .popfoot [data-act="close"]', { settle: 500 });
  if (!r.ok) await app.clickSel('.selpop [data-act="close"]', { settle: 500 });
}

/** A person's way out of the settings window: its close button. */
async function closeSettings(app) {
  await app.clickSel('#settings .iconbtn[data-act="settings:close"]', { settle: 600 });
}

async function main() {
  if (!STATE) throw new Error('pass --state <dir>; never the operator’s own');
  const t = tape('composer parameter controls');
  const shotAt = (app) => async (name) => { if (SHOTS) await app.screenshot(`${SHOTS}/${name}.png`); };

  /* ================= PART 1+2 — local ⇄ cloud, driven ================= */
  let app = await launch({ port: PORT, stateDir: STATE });
  let shot = shotAt(app);
  try {
    t.check('the composer is on screen', await open(app));
    t.say(`opened on: ${await app.snap(BACKEND)}`);
    await shot('00-opened');

    /* ---------- the LOCAL route: backend + model, NO provider ---------- */
    t.say('\n--- clicking the backend control, then the "local" row ---');
    let r = await app.clickSel('#composer .cfoot [data-sel-open="backend"]', { settle: 700 });
    t.check('the backend control opens its switch', r.ok, r.why || `clicked "${r.clicked}"`);
    let pop = await popupRows(app);
    t.check('the switch is titled "Where it runs"', !!pop && pop.title.startsWith('Where it runs'), JSON.stringify(pop && pop.title));
    t.say(`  rows: ${JSON.stringify((pop ? pop.rows : []).map((x) => x.label))}`);
    await shot('01-backend-switch');

    r = await app.clickText('.selpop .modelrow', 'local', { settle: 4000 });
    t.check('clicking the "local" row switches the route', r.ok, r.why || `clicked "${r.clicked}"`);
    t.check('the window arrives on the local route and stops moving', await onRoute(app, 'local'));
    t.say(`  the app says: ${JSON.stringify(await app.snap(TROUBLE))}`);
    // activateLocal with nothing on disk leaves the model switch open; close it
    // the way a person does.
    await done(app);
    t.check('the switch closed', !(await app.snap(`!!document.querySelector('.selpop')`)));
    const localBackend = await app.snap(BACKEND);
    t.check('the backend control now reads "local"', /local/.test(localBackend || ''), JSON.stringify(localBackend));
    const localChips = await app.snap(CHIPS);
    t.say(`  controls on the local route: ${JSON.stringify(localChips)}`);
    await shot('02-local-composer');
    t.check('local offers exactly backend + model',
      JSON.stringify(kinds(localChips)) === JSON.stringify(expectedKinds('local')),
      `saw ${JSON.stringify(kinds(localChips))}`);

    t.say('\n--- Settings › LLM, on the local route ---');
    r = await app.clickSel('.sb-settings', { settle: 900 });
    t.check('the Settings button opens Settings', r.ok, r.why || '');
    r = await app.clickText('#settings .settab', 'LLM', { settle: 2500 });
    t.check('the LLM tab opens', r.ok, r.why || `clicked "${r.clicked}"`);
    const localPane = await app.snap(LLM_MODE);
    t.say(`  Settings › LLM opened on: ${JSON.stringify(localPane)}`);
    await shot('03-llm-local');
    t.check('a local route opens Settings › LLM on Local', /local/i.test(localPane || ''), JSON.stringify(localPane));
    await closeSettings(app);

    /* ---------- the CLOUD route: backend + provider + model ---------- */
    t.say('\n--- clicking the backend control, then the "cloud" row ---');
    r = await app.clickSel('#composer .cfoot [data-sel-open="backend"]', { settle: 700 });
    t.check('the backend control opens again', r.ok, r.why || '');
    r = await app.clickText('.selpop .modelrow', 'cloud', { settle: 6000 });
    t.check('clicking the "cloud" row switches the route', r.ok, r.why || `clicked "${r.clicked}"`);
    t.check('the window arrives on the cloud route and stops moving', await onRoute(app, 'cloud'));
    t.say(`  the app says: ${JSON.stringify(await app.snap(TROUBLE))}`);
    if (await app.snap(`!!document.querySelector('.selpop')`)) await done(app);
    const cloudBackend = await app.snap(BACKEND);
    t.check('the backend control now reads "cloud"', /cloud/.test(cloudBackend || ''), JSON.stringify(cloudBackend));
    const cloudChips = await app.snap(CHIPS);
    t.say(`  controls on the cloud route: ${JSON.stringify(cloudChips)}`);
    await shot('04-cloud-composer');
    t.check('cloud offers exactly backend + provider + model',
      JSON.stringify(kinds(cloudChips)) === JSON.stringify(expectedKinds('cloud')),
      `saw ${JSON.stringify(kinds(cloudChips))}`);

    /* ---------- each control opens the pane it names ---------- */
    t.say('\n--- each control opens its own switch ---');
    r = await app.clickSel('#composer .cfoot [data-sel-open="provider"]', { settle: 900 });
    t.check('the provider control takes a real click', r.ok, r.why || `clicked "${r.clicked}"`);
    pop = await popupRows(app);
    t.check('the provider control opens the Provider switch', !!pop && pop.title.startsWith('Provider'), JSON.stringify(pop && pop.title));
    t.say(`  provider rows: ${JSON.stringify((pop ? pop.rows : []).map((x) => x.label))}`);
    await shot('05-provider-switch');
    await done(app);

    r = await app.clickSel('#composer .cfoot [data-sel-open="model"]', { settle: 1500 });
    t.check('the model control takes a real click', r.ok, r.why || `clicked "${r.clicked}"`);
    pop = await popupRows(app);
    t.check('the model control opens the Model switch', !!pop && pop.title.startsWith('Model'), JSON.stringify(pop && pop.title));
    t.say(`  model rows (first 5): ${JSON.stringify((pop ? pop.rows : []).slice(0, 5).map((x) => x.label))}`);
    await shot('06-model-switch');
    await done(app);

    r = await app.clickSel('#composer .cfoot [data-sel-open="backend"]', { settle: 900 });
    pop = await app.snap(POPUP);
    t.check('the backend control opens the "Where it runs" switch', !!pop && pop.title.startsWith('Where it runs'), JSON.stringify(pop && pop.title));
    await done(app);

    t.say('\n--- Settings › LLM, on the cloud route ---');
    r = await app.clickSel('.sb-settings', { settle: 900 });
    t.check('Settings opens', r.ok, r.why || '');
    r = await app.clickText('#settings .settab', 'LLM', { settle: 2500 });
    t.check('the LLM tab opens', r.ok, r.why || `clicked "${r.clicked}"`);
    const cloudPane = await app.snap(LLM_MODE);
    t.say(`  Settings › LLM opened on: ${JSON.stringify(cloudPane)}`);
    await shot('07-llm-cloud');
    t.check('a cloud route opens Settings › LLM on Cloud', /cloud/i.test(cloudPane || ''), JSON.stringify(cloudPane));
    await closeSettings(app);

    /* ---------- and back, so the strip is proved to follow both ways ---- */
    t.say('\n--- back to local ---');
    r = await app.clickSel('#composer .cfoot [data-sel-open="backend"]', { settle: 700 });
    t.check('the backend control opens from the cloud route', r.ok, r.why || '');
    r = await app.clickText('.selpop .modelrow', 'local', { settle: 5000 });
    t.check('clicking "local" switches back', r.ok, r.why || `clicked "${r.clicked}"`);
    t.check('the window arrives back on the local route', await onRoute(app, 'local'));
    if (await app.snap(`!!document.querySelector('.selpop')`)) await done(app);
    const backChips = await app.snap(CHIPS);
    t.say(`  controls after switching back: ${JSON.stringify(backChips)}`);
    await shot('08-local-again');
    t.check('the provider control is gone again',
      JSON.stringify(kinds(backChips)) === JSON.stringify(expectedKinds('local')),
      `saw ${JSON.stringify(kinds(backChips))}`);

    /* ---- the model slot with nothing on disk is a deep link, not a switch ----
       composer-meta-controls.tsx renders a DownloadModelControl there, and its
       click calls openLocalModelsPane: "the model switch popup would only list
       the empty catalog and its own deep link to the same pane". */
    t.say('\n--- the local route’s model control ---');
    const modelChip = backChips.find((c) => c.kind === 'model');
    const isCta = !!modelChip && /download model/.test(modelChip.text);
    t.say(`  the model control reads: ${JSON.stringify(modelChip && modelChip.text)}`
      + (isCta ? ' — the download call to action' : ' — a model label'));
    r = await app.clickSel('#composer .cfoot [data-sel-open="model"]', { settle: 2500 });
    t.check('the model control takes a real click on the local route', r.ok, r.why || `clicked "${r.clicked}"`);
    const popped = await app.snap(`!!document.querySelector('.selpop')`);
    await shot('08b-local-model-control');
    if (isCta) {
      // DownloadModelControl: no popup, straight to the pane that downloads.
      t.check('the download call to action opens no switch popup', !popped);
      const dlPane = await app.snap(LLM_MODE);
      t.say(`  it landed on: ${JSON.stringify(dlPane)}`);
      t.check('it opens Settings › LLM › Local, where the download happens',
        /local/i.test(dlPane || ''), JSON.stringify(dlPane));
      await closeSettings(app);
    } else {
      // A labelled model slot is an ordinary Control: it opens the switch.
      const mpop = popped ? await popupRows(app) : null;
      t.check('a labelled model slot opens the Model switch',
        !!mpop && mpop.title.startsWith('Model'), JSON.stringify(mpop && mpop.title));
      t.say(`  local model rows (first 5): ${JSON.stringify((mpop ? mpop.rows : []).slice(0, 5).map((x) => x.label))}`);
      await done(app);
    }
  } finally {
    await app.close();
  }

  /* ================= PART 3 — the custom route ================= */
  // Arrangement, not driving: one leaf through the sanctioned CLI. The app
  // itself can only reach this route through a /health probe of a real
  // llama-server, which a test machine does not have; the route the leaf
  // produces is the same one (`localModels.mode: external` with local-llama
  // active — which PART 1 left active by clicking "local").
  t.say('\n--- arranging the custom route: atag config set localModels.mode external ---');
  t.say(execFileSync(ATAG, ['config', 'set', 'localModels.mode', 'external'], {
    env: { ...process.env, ATOMIC_AGENT_STATE_DIR: STATE },
    encoding: 'utf8',
  }).trim());

  app = await launch({ port: PORT, stateDir: STATE });
  shot = shotAt(app);
  try {
    t.check('the composer is on screen again', await open(app));
    const customBackend = await app.snap(BACKEND);
    t.check('the app opens on the custom route', /custom/.test(customBackend || ''), JSON.stringify(customBackend));
    const customChips = await app.snap(CHIPS);
    t.say(`  controls on the custom route: ${JSON.stringify(customChips)}`);
    await shot('09-custom-composer');
    t.check('custom offers exactly backend + provider + model',
      JSON.stringify(kinds(customChips)) === JSON.stringify(expectedKinds('custom')),
      `saw ${JSON.stringify(kinds(customChips))}`);
    const providerChip = customChips.find((c) => c.kind === 'provider');
    t.check('the custom provider control reads "llama.cpp" (selectPromptLlmMeta)',
      !!providerChip && /llama\.cpp/.test(providerChip.text), JSON.stringify(providerChip));

    const r2 = await app.clickSel('#composer .cfoot [data-sel-open="provider"]', { settle: 900 });
    t.check('the custom provider control takes a real click', r2.ok, r2.why || `clicked "${r2.clicked}"`);
    const pop2 = await popupRows(app);
    t.check('it opens the Provider switch', !!pop2 && pop2.title.startsWith('Provider'), JSON.stringify(pop2 && pop2.title));
    await shot('10-custom-provider-switch');
    await done(app);

    const r3 = await app.clickSel('#composer .cfoot [data-sel-open="model"]', { settle: 1500 });
    t.check('the custom model control takes a real click', r3.ok, r3.why || `clicked "${r3.clicked}"`);
    const pop3 = await popupRows(app);
    t.check('it opens the Model switch', !!pop3 && pop3.title.startsWith('Model'), JSON.stringify(pop3 && pop3.title));
    t.say(`  custom model rows (first 5): ${JSON.stringify((pop3 ? pop3.rows : []).slice(0, 5).map((x) => x.label))}`);
    await shot('11-custom-model-switch');
    await done(app);

    t.say('\n--- Settings › LLM, on the custom route ---');
    const rs = await app.clickSel('.sb-settings', { settle: 900 });
    t.check('Settings opens', rs.ok, rs.why || '');
    const r4 = await app.clickText('#settings .settab', 'LLM', { settle: 2500 });
    t.check('the LLM tab opens', r4.ok, r4.why || '');
    const customPane = await app.snap(LLM_MODE);
    t.say(`  Settings › LLM opened on: ${JSON.stringify(customPane)}`);
    await shot('12-llm-custom');
    t.check('a custom route opens Settings › LLM on External', /external/i.test(customPane || ''), JSON.stringify(customPane));
    await closeSettings(app);
  } finally {
    await app.close();
  }

  return t.finish();
}

main().then((failures) => process.exit(failures ? 1 : 0), (err) => {
  console.error(err);
  process.exit(2);
});
