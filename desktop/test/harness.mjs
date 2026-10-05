/**
 * harness.mjs — the parts every human scenario repeats.
 *
 * A scenario's job is to be a PERSON: open the app on a state directory
 * that has never been used, get through first run by clicking, ask the
 * agent for something a person would want, and then check the WORLD —
 * the file on disk, the words in the reply — not an internal flag.
 *
 * Nothing here calls into the app. Every step is a click or a keystroke
 * dispatched by drive.mjs over CDP. The only shortcut taken is fixture
 * setup BEFORE the window opens — making a folder, dropping files into it,
 * seeding a `.env` — the same things a person does in Finder before they
 * double-click the app. Even the model is not planted: it is whatever the
 * wizard writes when the provider is chosen by clicking, and `activeModel`
 * reads it back off disk afterwards so the run can name it.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, homedir, loadavg, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { launch, sleep, MOD_KEY } from './drive.mjs';

/* ------------------------------------------------------------------ env --
   Where the scenarios put their throwaway state, and where they get a
   provider key from. Both are overridable so a lane can point them
   somewhere of its own; neither ever defaults to real app data. */
export const RUN_ROOT = process.env.ATAG_TEST_DIR || join(tmpdir(), 'atag-desktop-scenarios');
export const CDP_PORT = Number(process.env.ATAG_TEST_PORT || 9404);
/** A `.env` holding OPENROUTER_API_KEY / AIMLAPI_API_KEY. Never printed. */
export const SEED_ENV = process.env.ATAG_TEST_ENV
  || (process.env.ATOMIC_AGENT_STATE_DIR ? join(process.env.ATOMIC_AGENT_STATE_DIR, '.env') : '');

const PROVIDERS = {
  openrouter: { row: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', label: 'OpenRouter' },
  aimlapi:    { row: 'AI/ML API',  envKey: 'AIMLAPI_API_KEY',    label: 'AI/ML API' },
};
/**
 * Which cloud provider the scenarios set up in the wizard.
 *
 * `aimlapi` is the default on purpose. Its wizard default model is one
 * NAMED model, so when a scenario fails we can say which model failed.
 * OpenRouter's wizard default is `openrouter/auto`, which routes to
 * whatever is cheapest at that minute — a failure there is unattributable,
 * which is exactly what a test must never be. `ATAG_TEST_PROVIDER=openrouter`
 * still works and the run prints the model it ended up on either way.
 *
 * There is no ATAG_TEST_MODEL knob: the agent has no `llm.chatModel`
 * config leaf (the model lives on the provider entry the wizard writes),
 * and reaching past the wizard to plant one would be exactly the kind of
 * internals shortcut this whole layer exists to avoid.
 */
export const PROVIDER = process.env.ATAG_TEST_PROVIDER || 'aimlapi';

export function providerKey() {
  if (!SEED_ENV || !existsSync(SEED_ENV)) {
    throw new Error(`no seed .env — set ATAG_TEST_ENV to a file holding ${PROVIDERS[PROVIDER].envKey}`);
  }
  const m = readFileSync(SEED_ENV, 'utf8').match(new RegExp(`^${PROVIDERS[PROVIDER].envKey}=(.*)$`, 'm'));
  if (!m) throw new Error(`${SEED_ENV} has no ${PROVIDERS[PROVIDER].envKey}`);
  return m[1].trim();
}

/* --------------------------------------------------------------- assert -- */
export class Failure extends Error {}
/** A human assertion: the thing a person would have looked at. */
export function check(ok, what, detail = '') {
  if (ok) { console.log(`   ✓ ${what}`); return; }
  throw new Failure(`${what}${detail ? `\n     ${detail}` : ''}`);
}
/** The model, not the app, let us down — reported separately so a flaky
    model never gets logged as a desktop defect. */
export class ModelShortfall extends Error {}
export function modelDidNot(what, detail = '') {
  throw new ModelShortfall(`${what}${detail ? `\n     ${detail}` : ''}`);
}

/* ---------------------------------------------------------------- setup -- */
/** A state dir and a workspace that have never been used, per scenario. */
export function freshDirs(name) {
  const base = join(RUN_ROOT, name);
  rmSync(base, { recursive: true, force: true });
  const stateDir = join(base, 'state');
  const workspace = join(base, 'workspace');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  for (const real of ['.atomic-agent', '.atomic-agent-desktop']) {
    if (resolve(stateDir).startsWith(resolve(homedir(), real))) throw new Error('refusing to use real app data');
  }
  if (SEED_ENV && existsSync(SEED_ENV)) cpSync(SEED_ENV, join(stateDir, '.env'));
  return { base, stateDir, workspace };
}

/**
 * What the app is actually talking to, read off the config the WIZARD
 * wrote — the world, not an internal. Called after first run so a
 * scenario's log names the model that produced (or failed to produce)
 * the result, which is what makes "the model fell short" a claim rather
 * than an excuse.
 */
export function activeModel(stateDir) {
  const raw = readIf(join(stateDir, 'config.json'));
  if (!raw) return null;
  let cfg; try { cfg = JSON.parse(raw); } catch { return null; }
  const list = cfg?.llm?.providers ?? [];
  const active = cfg?.llm?.activeTextProvider;
  const e = list.find((p) => p.id === active) ?? list[0];
  return e ? `${e.id} · ${e.defaultChatModel ?? e.model ?? 'default model'}` : null;
}

/* ------------------------------------------------------------ first run -- */
/** Calm (S6): the steps are read by id; their old subtitles are no longer
    drawn. Read-only: `window.__ob()` reports the flow's state, it changes
    nothing. */
export const obStep = (id) => `(window.__ob && window.__ob().open && window.__ob().step === '${id}')`;
/** The model step that follows a verified key (ATO-161): its rows. */
const MODEL_STEP = `!!document.querySelector('#onboarding [data-wizmodel]')`;
/** The reason under the key box, when there is one: a failure (`.ob-err`) or,
    since ATO-161, the calm request for a key ("Paste your … API key to
    continue.", `.wiz-ask`). */
const KEY_ERR = `((document.querySelector('#onboarding .ob-err, #onboarding .wiz-ask')||{textContent:''}).textContent||'').trim()`;

/**
 * Get through the first-run wizard by clicking, exactly as a person does:
 * dismiss the intro, choose Cloud models, choose the provider, type the key,
 * click Next, take the default on the model step ("Use default"), decline
 * the local model, decline importing other agents' data.
 *
 * r6 INTEGRATION: the row lists used to be two-stage — the first click only
 * moved the cursor and the second activated — which is the operator's own
 * complaint ("I click on the row and nothing happens"). The UX lane fixed it:
 * obRowClick now sets the cursor AND activates, so one click is one action.
 * `pick` still clicks until the screen actually changes, because that is also
 * what a hand does when a click lands during a repaint, and because it is the
 * check that would catch the two-stage behaviour coming back.
 */
export async function firstRun(app, { provider = PROVIDER, key } = {}) {
  const P = PROVIDERS[provider];
  if (!P) throw new Error(`unknown provider "${provider}"`);
  const wizText = `((document.querySelector('#onboarding')||{innerText:''}).innerText)`;

  await app.waitFor(`!!document.querySelector('#onboarding')`, 'the first-run wizard', { timeout: 90000 });
  /* r6 INTEGRATION: the intro is CLICKED, not typed at.
     It used to press Enter here, which made the very first screen of the
     app the one screen the whole scenario suite never proved with a
     pointer — and "press any key" is a promise the desktop keeps on four
     channels, not one (renderer.js:7591-7597 answers keydown, pointerdown,
     a wheel notch and a non-empty paste, mirroring intro-input.ts). If the
     pointerdown listener were dropped tomorrow, a mouse-only user would be
     stuck on the splash forever and every scenario would still have passed.

     The click used to land on #ob-sky, the intro's star-field canvas, with
     the loop gated on that canvas being present. Neither exists now: the
     visual system rules star fields out, and the card is dismissed by a
     `click` on the layer rather than a `pointerdown` anywhere — a press that
     dismissed the card used to hand the release to whatever was behind it.
     The loop is gated on the STEP instead, which is the fact it was really
     about, and clicking `#onboarding` at its centre is safe precisely
     because the card takes the whole gesture: the screen behind it is never
     pressed.

     `scroll: false` is not a detail either. The driver scrolls a target
     into view with a real wheel notch before pressing, and the intro
     answers a wheel notch as an input in its own right — so an ordinary
     `clickSel` was TWO inputs on a two-stage screen, and one call walked
     the wizard from the splash to the provider list. The app is right on
     both counts; the driver was spending a scroll the operator never made.

     The intro is two-stage on purpose (obIntroAdvance: the first input
     finishes the typewriter, the second dismisses), so two clicks are
     expected here and the loop looks at the screen between them, which is
     what a hand does. It is worth saying what was checked and is NOT a
     defect: on the dismissing click, the row that lands under the cursor
     is not activated by the release. Chromium dispatches `click` on the
     common ancestor of the press and release targets, and the press target
     — the splash — is gone by then, so no `[data-obrow]` ever sees it.
     Driven at 24 ms and at 120 ms with the cursor parked exactly on "Cloud
     models": the flow stops on the choose screen both times. If that ever
     changes, the UX lane's one-click rows would start choosing a backend
     nobody looked at, so the check below — that the three choices are
     really on screen after the splash — is the tripwire for it. */
  /* One click leaves the title card, and the thing to click is the card.
     This used to click `#ob-sky` — the star field's canvas — in a loop that
     ran while the canvas existed. The canvas is gone, so the loop's guard was
     true on the first pass, it broke immediately, nothing was ever clicked,
     and every caller sat on the intro until it timed out "waiting for the
     three backend choices". Clicking the layer itself is what a person does. */
  for (let i = 0; i < 8; i += 1) {
    if ((await app.eval(`window.__ob ? window.__ob().step : ''`)) !== 'intro') break;
    await app.clickSel('#onboarding', { scroll: false });
    await sleep(400);
  }
  await app.waitFor(`/Cloud models/.test(${wizText})`, 'the three backend choices');
  await pick(app, 'Cloud models', `${obStep('cloud')} && !document.querySelector('#wiz-key')`, 'the provider list');
  await pick(app, P.row, `!!document.querySelector('#wiz-key')`, `the ${P.label} key field`);
  await app.clickSel('#wiz-key');
  const secret = key ?? providerKey();
  await app.typeSecret(secret, `the ${P.label} key`);
  /* Every character has to still be in the box. A repaint that lands
     mid-typing (the wizard polls whether the cloud is ready) used to blow the
     focus away to <body>, and the rest of the key went to the key ROUTER
     instead of the field — no error, nothing on screen, just a key too short
     to work. Counted, never printed. */
  const got = await app.eval(`((document.querySelector('#wiz-key')||{}).value || '').length`);
  if (got !== secret.length) {
    throw new Failure('the key field lost characters while they were being typed',
      `typed ${secret.length}, the box holds ${got} — a repaint took the caret`);
  }
  await app.clickText('Next');
  await app.waitFor(`${MODEL_STEP} || /Verifying/.test(${wizText}) || ${KEY_ERR}.length > 0`,
    'the key going off to be verified', { timeout: 30000 });
  /* ATO-161: a verified key lands on the MODEL STEP — "Model · <provider>",
     the provider's catalogue with our default preselected and marked Default,
     and Back / Use default / Use this model. It is still the `cloud` step of
     the flow; "Cloud model ready" only comes AFTER a model is chosen, on the
     second-backend offer. Waiting for that straight after Next is what timed
     out at 90 s once the step was added. A key that is refused (or could not
     be checked) stays on the key screen with its reason under the box: say
     that reason instead of timing out. */
  await app.waitFor(`${MODEL_STEP} || (!!document.querySelector('#wiz-key') && !/Verifying/.test(${wizText}) && ${KEY_ERR}.length > 0)`,
    'the key accepted — the model step', { timeout: 90000 });
  if (!(await app.eval(MODEL_STEP))) {
    throw new Failure(`the ${P.label} key was not accepted`, `the key screen says: ${JSON.stringify(await app.eval(KEY_ERR))}`);
  }
  const offered = await app.eval(`(() => {
    const on = document.querySelector('#onboarding [data-wizmodel].on');
    return { rows: document.querySelectorAll('#onboarding [data-wizmodel]').length,
             picked: on ? on.getAttribute('data-wizmodel') : null,
             help: ((document.querySelector('#onboarding .ob-help')||{}).textContent||'').trim() };
  })()`);
  app.log(`the model step offers ${offered.rows} models; preselected ${offered.picked} — ${JSON.stringify(offered.help)}`);
  /* Take the default with the button that says so. One click is one action:
     the step goes the instant the click is taken (the save re-enters with the
     choice made), so a second click is only spent if the first landed during
     a repaint and the step is still sitting there. */
  for (let i = 0; i < 3 && (await app.eval(MODEL_STEP)); i++) {
    await app.clickText('Use default', { scope: '#onboarding', timeout: 5000 });
    await sleep(1500);
  }
  /* The choice is saved, the route switched and the agent restarted, then the
     flow settles on whichever offer is owed — the second backend (which
     opens on "Cloud model ready"), the import, or none — or the wizard
     closes. An activation that fails drops back to the key screen with a
     reason; report it. */
  await app.waitFor(`${obStep('propose_second')} || ${obStep('import_pick')} || !document.querySelector('#onboarding')`
    + ` || (!!document.querySelector('#wiz-key') && !/Verifying/.test(${wizText}) && ${KEY_ERR}.length > 0)`,
    'the default model taken and the cloud set up', { timeout: 120000 });
  if (await app.eval(`!!document.querySelector('#wiz-key')`)) {
    throw new Failure('taking the default model did not set the cloud up',
      `the key screen says: ${JSON.stringify(await app.eval(KEY_ERR))}`);
  }
  if (await app.eval(obStep('propose_second'))) {
    check(await app.eval(`/Cloud model ready/.test(${wizText})`), 'the wizard says “Cloud model ready”');
  }

  await pick(app, 'Skip — take me to the agent',
    `${obStep('import_pick')} || !document.querySelector('#onboarding')`, 'the import offer');
  if (await app.eval(obStep('import_pick'))) {
    // Nothing is ticked, so this only closes the step — no other agent's
    // data is ever read by a scenario.
    await pick(app, 'Skip adding data from other agents', `!document.querySelector('#onboarding')`, 'the wizard closing');
  }
  await app.waitFor(`!document.querySelector('#onboarding')`, 'the agent window, set up and ready', { timeout: 30000 });
  await app.waitFor(`!!document.querySelector('#entry')`, 'the composer');
  /* Finishing the wizard restarts `atag serve` ("Setup complete — Restarting
     the agent…"). Typing into a composer whose send button is still locked is
     the commonest way a person loses their first message, so wait it out. */
  await app.waitFor(`!document.querySelector('.sendbtn[disabled]')`,
    'the send button live again after the restart', { timeout: 90000 });
}

/** Pick a list row until the screen moves on. Calm (S6): a click selects the
    row and the step's primary button (Continue / Download / Use …) sends it;
    a verb that is itself a button (the import step's skip) acts at once. */
export async function pick(app, text, doneExpr, doneLabel, { tries = 4 } = {}) {
  const done = () => app.eval(`(() => (${doneExpr}))()`);
  for (let i = 0; i < tries; i++) {
    if (await done()) break;
    try {
      await app.clickText(text, { timeout: 5000 });
      await sleep(300);
      if (!(await done()) && await app.eval(`!!document.querySelector('#onboarding .ob-foot .btn-p')`)) {
        await app.clickSel('#onboarding .ob-foot .btn-p', { timeout: 5000, scroll: false });
      }
    } catch (e) {
      /* The row is gone. Two innocent reasons, and both look like this:
         the second click landed and the next screen painted while we were
         measuring; or the step went away to do work first — finishing the
         wizard scans this machine for other agents behind a bare
         "setting up…". Neither is a failure, so wait the screen out before
         believing the miss, and only then say the click had nowhere to go. */
      if (await done()) break;
      try {
        await app.waitFor(doneExpr, doneLabel, { timeout: 45000, quiet: true });
        break;
      } catch { throw e; }
    }
    await sleep(600);
  }
  await app.waitFor(doneExpr, doneLabel, { timeout: 60000 });
}

/* ------------------------------------------------------------ the chat -- */
/** Type a message into the composer and click the send button. */
export async function ask(app, text) {
  const before = await app.eval(`document.querySelectorAll('#content .turn').length`);
  /* How many answers were on screen before this question. `waitTurn` needs it
     to tell "the turn is over" apart from "the turn has not started yet" —
     see the start-grace note there. */
  app.repliesBefore = (await app.replies()).length;
  await app.clickSel('#entry');
  await app.type(text, { perChar: 1 });
  const sent = await app.eval(`(document.querySelector('#entry')||{}).value`);
  if (sent !== text) {
    throw new Failure('the composer did not receive what was typed',
      `wanted ${JSON.stringify(text.slice(0, 60))}, the box holds ${JSON.stringify(String(sent).slice(0, 60))}`);
  }
  await app.clickSel('.sendbtn');
  /* A turn can be over before we look. Either the strip is up, the question
     has left the box, or an answer has already landed — any of the three
     means the click was taken. */
  await app.waitFor(
    `!!document.querySelector('.statusstrip')`
    + ` || (document.querySelector('#entry')||{}).value === ''`
    + ` || document.querySelectorAll('#content .turn').length > ${before}`,
    'the question sent', { timeout: 20000 });
}

/**
 * Pick a stance from the composer's Mode chip, by clicking: the chip, then
 * the row ("Ask first", "Plan", "Auto", "Bypass"). A row applies as it is
 * picked and closes the popover (ATO-167: there is no Done). `id` is the
 * agent's own mode id: default | plan | auto | bypass.
 */
export async function chooseMode(app, id) {
  await app.waitFor(`!!document.querySelector('.cmodechip[data-id]:not([data-id=""])')`,
    'the Mode chip, once the agent has reported its stance', { timeout: 60000 });
  if (await app.eval(`(document.querySelector('.cmodechip')||{dataset:{}}).dataset.id === ${JSON.stringify(id)}`)) return;
  await app.clickSel('.cmodechip');
  await app.waitFor(`!!document.querySelector('.modepop [data-mode="${id}"]')`, 'the Mode popover');
  await app.clickSel(`.modepop [data-mode="${id}"]`, { scroll: false });
  await app.waitFor(`(document.querySelector('.cmodechip')||{dataset:{}}).dataset.id === ${JSON.stringify(id)}`
    + ` && !document.querySelector('.modepop')`, `the Mode chip reading ${id}`, { timeout: 20000 });
}

/**
 * Wait for the turn to finish, approving what it asks for with a real click
 * on the real Allow once button. Returns the agent's reply text.
 *
 * `approve: 'none'` leaves the request standing so a scenario can assert on
 * the card itself before answering it.
 */
export async function waitTurn(app, { timeout = 300000, approve = 'auto', quiet = 5000, startGrace = 90000 } = {}) {
  const t0 = Date.now();
  const until = t0 + timeout;
  const before = typeof app.repliesBefore === 'number' ? app.repliesBefore : -1;
  let approvals = 0;
  let idleSince = 0;
  let sawBusy = false;
  for (;;) {
    if (Date.now() > until) throw new Failure(`the turn was still running after ${Math.round(timeout / 1000)}s`);
    /* `steer`: with words in the box the running turn's button is the steer
       arrow, not Stop — a person drafting their next message while the agent
       works is still watching a busy window. `lit`: the composer's
       travelling light, drawn for the whole turn (Calm S2). */
    const st = await app.eval(`(() => ({
      strip: !!document.querySelector('.statusstrip'),
      stop: !!document.querySelector('.sendbtn.stop'),
      steer: !!document.querySelector('.sendbtn.steer'),
      lit: !!document.querySelector('#composer.cl-on'),
      locked: !!document.querySelector('.sendbtn[disabled]'),
      pending: !!document.querySelector('#apprcard'),
    }))()`);
    if (st.pending && approve === 'auto') {
      /* The open card has no badge (only an answered one does); its question
         is the `.ttl` line. The click is scoped to the card the request is
         ON — `#apprcard` is only ever the current request's (ATO-209) — and
         "Allow once ⌘↩" still contains "Allow once". */
      const kind = await app.eval(`(document.querySelector('#apprcard .ttl')||{textContent:''}).textContent.trim().slice(0, 80)`);
      await app.clickText('Allow once', { scope: '#apprcard' });
      approvals++;
      idleSince = 0;
      app.log(`approved a "${kind}" request with a click (${approvals} so far)`);
      await sleep(600);
      continue;
    }
    if (st.pending && approve === 'none') return { pending: true, approvals, reply: await app.lastReply() };
    const busy = st.strip || st.stop || st.steer || st.lit || st.locked;
    if (busy) { sawBusy = true; idleSince = 0; await sleep(700); continue; }
    /* The gap between the send click and the app looking busy. `ask` returns
       as soon as the composer empties, which happens instantly; the strip only
       appears once the request is away, and on a loaded Mac that took longer
       than the five seconds of quiet below — so the turn "finished" before it
       began and the scenario read an empty reply. Found in scenario 06 in a
       full-suite run (it passed on its own, which is what a start-up race
       looks like). So: until this window has been seen busy once, quiet means
       "not started", not "done", and the only things that end the wait are a
       new answer on screen or the grace running out. */
    if (!sawBusy && Date.now() - t0 < startGrace) {
      const now = (await app.replies()).length;
      if (before < 0 || now <= before) { idleSince = 0; await sleep(400); continue; }
    }
    /* Quiet is not the same as finished. Between a tool result coming back
       and the next model call going out the strip is gone and the send
       button is a plain arrow — the app looks exactly as idle as it does at
       the end of a turn. Returning on the first quiet sample is how a
       scenario "passes" against a run that had not started yet, so insist
       the quiet HOLDS. */
    if (!idleSince) idleSince = Date.now();
    if (Date.now() - idleSince >= quiet) break;
    await sleep(400);
  }
  return { pending: false, approvals, reply: await app.lastReply() };
}

/* --------------------------------------------------------------- runner -- */
/**
 * Run one scenario end to end. Handles the throwaway dirs, the launch, the
 * teardown and the exit code, so a scenario file is just the story.
 *
 * Every scenario is independently runnable: `node desktop/test/scenarios/<f>.mjs`.
 */
export async function scenario(name, body, { firstRunFirst = true, setup, skip = null } = {}) {
  const t0 = Date.now();
  console.log(`\n▶ ${name}`);
  /* A scenario that cannot be driven honestly on this machine says why and
     stops before anything is launched. Counted apart from passes. */
  if (skip) {
    console.log(`– ${name} — SKIPPED: ${skip}`);
    return { name, ok: true, skipped: skip, secs: '0' };
  }
  const dirs = freshDirs(name);
  console.log(`   state ${dirs.stateDir}`);
  console.log(`   workspace ${dirs.workspace}`);
  console.log(`   provider ${PROVIDER} (set up by clicking through the wizard)`);
  let app = null;
  try {
    /* `setup(dirs)` is how a scenario arranges the MACHINE it is about — a
       Mac so busy the agent's CLI cannot answer, say. It runs BEFORE the
       window opens, like everything else a person does in Finder first, may
       return environment for the launch, and never reaches inside the
       running app. */
    const extra = setup ? await setup(dirs) : null;
    app = await launch({
      port: CDP_PORT, stateDir: dirs.stateDir, workspace: dirs.workspace,
      ...(extra ? { env: extra } : {}),
    });
    if (firstRunFirst) {
      await firstRun(app);
      console.log(`   model in use: ${activeModel(dirs.stateDir) ?? 'unknown'}`);
    }
    await body({ app, ...dirs, write, read: readIf });
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`✔ ${name} — PASSED in ${secs}s`);
    return { name, ok: true, secs };
  } catch (e) {
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    const model_s_fault = e instanceof ModelShortfall;
    console.log(`✘ ${name} — ${model_s_fault ? 'THE MODEL FELL SHORT' : 'FAILED'} after ${secs}s`);
    console.log(`   ${e.message}`);
    /* Say what the MACHINE was doing, because a failure has three possible
       authors and only two of them are worth a bug. Several of these
       scenarios failed at 90 seconds on a Mac carrying a load average of 290
       (four other checkouts running their own suites); the same scenarios
       passed in fifty seconds on an idle one. Printing the load turns
       "the app is broken" into a question a reader can answer. */
    const [l1, l5] = loadavg();
    const cores = cpus().length || 1;
    console.log(`   the machine, meanwhile: load ${l1.toFixed(1)} (5 min ${l5.toFixed(1)}) across ${cores} cores`
      + `${l1 > cores * 2 ? ' — SATURATED. Re-run this on a quiet machine before calling it an app defect.' : ''}`);
    if (app) {
      try {
        const shot = join(dirs.base, 'failure.png');
        await app.screenshot(shot);
        console.log(`   what was on screen: ${shot}`);
        console.log(`   last reply: ${JSON.stringify((await app.lastReply()).slice(0, 400))}`);
      } catch { /* the window may already be gone */ }
      const tail = app.output().split('\n').filter((l) => /error|Error|EADDR|throw/.test(l)).slice(-6);
      if (tail.length) console.log(`   app stderr: ${tail.join(' | ')}`);
    }
    return { name, ok: false, modelFault: model_s_fault, secs, error: e.message };
  } finally {
    if (app) await app.close();
  }
}

/** Put a fixture file in the workspace before the person starts. */
function write(path, content) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}
function readIf(path) { return existsSync(path) ? readFileSync(path, 'utf8') : null; }
export { write, readIf as read, sleep, MOD_KEY };

/** `node scenarios/foo.mjs` → run it and set the exit code. */
export async function main(result) {
  const r = await result;
  process.exit(r && r.ok ? 0 : 1);
}

export const SCENARIO_NAME = (url) => basename(new URL(url).pathname).replace(/\.mjs$/, '');
