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
import { launch, sleep } from './drive.mjs';

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
/**
 * Get through the first-run wizard by clicking, exactly as a person does:
 * dismiss the intro, choose Cloud models, choose the provider, type the key,
 * click Next, decline the local model, decline importing other agents' data.
 *
 * The row lists are two-stage on purpose (mouse-list-row.tsx: the first
 * click selects, the second activates), so `pick` clicks until the screen
 * actually changes — which is what a hand does too.
 */
export async function firstRun(app, { provider = PROVIDER, key } = {}) {
  const P = PROVIDERS[provider];
  if (!P) throw new Error(`unknown provider "${provider}"`);
  const wizText = `((document.querySelector('#onboarding')||{innerText:''}).innerText)`;

  await app.waitFor(`!!document.querySelector('#onboarding')`, 'the first-run wizard', { timeout: 90000 });
  // The intro answers any key; the first one only finishes the typewriter.
  for (let i = 0; i < 8; i++) {
    if (await app.eval(`/Cloud models/.test(${wizText})`)) break;
    await app.press('Enter');
    await sleep(500);
  }
  await app.waitFor(`/Cloud models/.test(${wizText})`, 'the three backend choices');
  await pick(app, 'Cloud models', `/LLM provider/.test(${wizText})`, 'the provider list');
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
  await app.waitFor(`/one more thing|Verifying/.test(${wizText})`, 'the key going off to be verified', { timeout: 30000 });
  await app.waitFor(`/one more thing/.test(${wizText})`, 'the key accepted — “Cloud model ready”', { timeout: 90000 });

  await pick(app, 'Skip — take me to the agent',
    `/bring your data/.test(${wizText}) || !document.querySelector('#onboarding')`, 'the import offer');
  if (await app.eval(`/bring your data/.test(${wizText})`)) {
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

/** Click a two-stage list row until the screen moves on. */
export async function pick(app, text, doneExpr, doneLabel, { tries = 4 } = {}) {
  const done = () => app.eval(`(() => (${doneExpr}))()`);
  for (let i = 0; i < tries; i++) {
    if (await done()) break;
    try {
      await app.clickText(text, { timeout: 5000 });
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
 * Wait for the turn to finish, approving what it asks for with a real click
 * on the real Approve button. Returns the agent's reply text.
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
    const st = await app.eval(`(() => ({
      strip: !!document.querySelector('.statusstrip'),
      stop: !!document.querySelector('.sendbtn.stop'),
      locked: !!document.querySelector('.sendbtn[disabled]'),
      pending: !!document.querySelector('#apprcard'),
    }))()`);
    if (st.pending && approve === 'auto') {
      const kind = await app.eval(`(document.querySelector('#apprcard .badge')||{textContent:''}).textContent.trim()`);
      await app.clickText('Approve');
      approvals++;
      idleSince = 0;
      app.log(`approved a "${kind}" request with a click (${approvals} so far)`);
      await sleep(600);
      continue;
    }
    if (st.pending && approve === 'none') return { pending: true, approvals, reply: await app.lastReply() };
    const busy = st.strip || st.stop || st.locked;
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
export async function scenario(name, body, { firstRunFirst = true, setup } = {}) {
  const t0 = Date.now();
  console.log(`\n▶ ${name}`);
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
export { write, readIf as read, sleep };

/** `node scenarios/foo.mjs` → run it and set the exit code. */
export async function main(result) {
  const r = await result;
  process.exit(r && r.ok ? 0 : 1);
}

export const SCENARIO_NAME = (url) => basename(new URL(url).pathname).replace(/\.mjs$/, '');
