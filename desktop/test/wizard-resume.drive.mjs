/**
 * wizard-resume.drive.mjs — "when I have chosen to proceed to the agent, I
 * should have proceeded to the agent, not to the setup again".
 *
 * The operator's own sequence, driven with a mouse:
 *
 *   fresh state dir → the splash → Local models → pick the smallest model
 *   → a REAL `atag models pull` starts → from the download screen take the
 *   cloud offer → configure a real cloud provider with the key in the state
 *   dir's `.env` → land on "almost there" → choose "Start using the agent
 *   now" → the wizard must CLOSE and hand over the agent window, with the
 *   download still reporting in the top strip.
 *
 * and the two neighbours that must not be broken to make that true:
 *
 *   B. the cloud wizard opened from the download screen and CLOSED without
 *      configuring anything goes back to the download screen it came from;
 *   C. a cloud setup that finishes while the pull is still running offers
 *      the wait-or-jump choice ONCE — the operator is asked, not looped.
 *
 * and D, the sibling card that makes the same promise on the screen before
 * it — "Or skip the wait — start using the agent now" — which has to keep
 * it too, or two identical promises behave differently. Lane D also watches
 * two things that are only visible in a real run: the ETA the strip prints
 * while the rate is still a guess, and `tui.onboarding.localSetupSeenAt`,
 * which a whole-file config write used to overwrite moments after the
 * wizard stamped it.
 *
 * Nothing here calls into the app. `window.__ob` / `window.__dl` are read
 * to narrate what the screen already shows; every step is a click or a key.
 *
 *   ATOMIC_AGENT_STATE_DIR=/some/scratch/dir node test/wizard-resume.drive.mjs
 *
 * Options: --port=N (default 9421), --state=DIR (the run root; a `.env`
 * beside it is copied into each fresh dir), --shots=DIR.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SMALL_MODEL, arg, boxOf, cancelPull, configureCloud, dl, freshRun,
  launch, ob, passIntro, pickLocalModel, reporter, sleep, waitForRealSamples,
} from './drive-download-lib.mjs';

const PORT = Number(arg('port', '9421'));
const ROOT = arg('state', process.env.ATOMIC_AGENT_STATE_DIR || null);
const SHOTS = arg('shots', null);
if (!ROOT) throw new Error('set ATOMIC_AGENT_STATE_DIR (or --state=DIR) — never the operator’s own');
const SEED = join(ROOT, '.env');

const R = reporter('wizard-resume — the wizard ends where the operator sent it');

async function shot(app, name) {
  if (SHOTS) { try { await app.screenshot(join(SHOTS, name)); } catch { /* window gone */ } }
}

/** Walk a fresh first run as far as a real pull that is reporting bytes. */
async function toDownloading(app) {
  await passIntro(app);
  await pickLocalModel(app, SMALL_MODEL);
  await app.waitFor(`(window.__ob().step === 'local_download')`, 'the download screen', { timeout: 60000 });
  const measured = await waitForRealSamples(app, { timeout: 240000 });
  return measured;
}

/* ------------------------------------------------------------------ A --- */
/** The operator's sequence, end to end. */
async function laneA() {
  const dirs = freshRun(join(ROOT, 'wiz-resume-a'), SEED);
  const app = await launch({ port: PORT, stateDir: dirs.stateDir, workspace: dirs.workspace });
  try {
    const measured = await toDownloading(app);
    R.check('a real download is running and reporting', !!measured,
      measured ? `${measured.label} at ${measured.percent}%` : 'no sample arrived in four minutes');
    if (!measured) return;

    // "Don't want to wait? Set up a cloud model in the meantime."
    await app.clickSel('#onboarding .ob-offer.cloud', { scroll: false });
    const opened = await ob(app);
    R.check('the download screen’s cloud offer opens the provider wizard',
      opened.step === 'cloud' && opened.resumeAfterCloud === 'local_download',
      `step ${opened.step}, resumeAfterCloud ${JSON.stringify(opened.resumeAfterCloud)}`);
    await shot(app, 'a1-cloud-wizard.png');

    const after = await configureCloud(app, SEED);
    R.check('a cloud provider configured mid-download raises the wait-or-jump choice',
      after.open && after.step === 'wait_or_jump',
      `step ${after.step}, outcome ${after.outcome}`);
    await shot(app, 'a2-wait-or-jump.png');
    if (!after.open || after.step !== 'wait_or_jump') return;

    // The row the operator picked: "Start using the agent now".
    await app.clickText('Start using the agent now');
    const closed = await app.waitFor('!document.querySelector("#onboarding")',
      'the wizard closing onto the agent', { timeout: 60000 }).then(() => true, () => false);
    const end = await ob(app);
    R.check('choosing the agent CLOSES the wizard', closed,
      closed ? '' : `still open on "${end && end.step}" — this is the operator’s bug`);
    await shot(app, 'a3-after-choosing.png');
    R.check('it did not land back on a setup screen',
      closed || !(end && ['choose', 'cloud', 'propose_second', 'local_pick'].indexOf(end.step) >= 0),
      end ? `step ${end.step}` : '');
    if (closed) {
      await app.waitFor('!!document.querySelector("#entry")', 'the composer', { timeout: 30000 });
      const strip = await dl(app);
      R.check('the download it promised to keep running is still in the top strip',
        !!(strip && strip.visible),
        strip ? `strip: ${JSON.stringify(strip.text).slice(0, 80)}` : 'no strip');
    }
    await cancelPull(app);
  } finally {
    await app.close();
  }
}

/* ------------------------------------------------------------------ B --- */
/** Closing the cloud wizard WITHOUT configuring anything goes back. */
async function laneB() {
  const dirs = freshRun(join(ROOT, 'wiz-resume-b'), SEED);
  const app = await launch({ port: PORT, stateDir: dirs.stateDir, workspace: dirs.workspace });
  try {
    const measured = await toDownloading(app);
    if (!measured) { R.check('lane B could start a download', false, 'no sample in four minutes'); return; }
    await app.clickSel('#onboarding .ob-offer.cloud', { scroll: false });
    await app.waitFor(`(window.__ob().step === 'cloud')`, 'the cloud step', { timeout: 30000 });
    // The wizard's own way out, clicked: Cancel on the provider list.
    const back = await boxOf(app, '#onboarding [data-act="wiz:cancel"]');
    if (back) await app.clickSel('#onboarding [data-act="wiz:cancel"]', { scroll: false });
    else await app.press('Escape');
    const s = await ob(app);
    R.check('a cloud wizard closed with nothing configured returns to the download screen',
      s.open && s.step === 'local_download',
      `step ${s.step}`);
    await shot(app, 'b1-back-on-download.png');
    await cancelPull(app);
  } finally {
    await app.close();
  }
}

/* ------------------------------------------------------------------ C --- */
/**
 * The wait-or-jump choice is offered ONCE, not repeatedly: adding a second
 * provider from that screen comes back to it (that is what its own row
 * promises — "then straight back to this screen"), and choosing the agent
 * from there still ends the flow.
 */
async function laneC() {
  const dirs = freshRun(join(ROOT, 'wiz-resume-c'), SEED);
  const app = await launch({ port: PORT, stateDir: dirs.stateDir, workspace: dirs.workspace });
  try {
    const measured = await toDownloading(app);
    if (!measured) { R.check('lane C could start a download', false, 'no sample in four minutes'); return; }
    await app.clickSel('#onboarding .ob-offer.cloud', { scroll: false });
    const first = await configureCloud(app, SEED);
    R.check('lane C reached wait-or-jump', first.step === 'wait_or_jump', `step ${first.step}`);
    if (first.step !== 'wait_or_jump') return;

    // "Add another cloud provider — one more key or endpoint, then straight
    // back to this screen."
    await app.clickText('Add another cloud provider');
    const s2 = await ob(app);
    R.check('the second provider offer opens the wizard from wait-or-jump',
      s2.step === 'cloud' && s2.resumeAfterCloud === 'wait_or_jump',
      `step ${s2.step}, resumeAfterCloud ${JSON.stringify(s2.resumeAfterCloud)}`);
    // Back out of it without configuring anything: still the same screen.
    const cancel = await boxOf(app, '#onboarding [data-act="wiz:cancel"]');
    if (cancel) await app.clickSel('#onboarding [data-act="wiz:cancel"]', { scroll: false });
    else await app.press('Escape');
    const s3 = await ob(app);
    R.check('backing out of that second wizard returns to wait-or-jump, not to setup',
      s3.open && s3.step === 'wait_or_jump', `step ${s3.step}`);
    await shot(app, 'c1-still-wait-or-jump.png');

    await app.clickText('Start using the agent now');
    const closed = await app.waitFor('!document.querySelector("#onboarding")',
      'the wizard closing', { timeout: 60000 }).then(() => true, () => false);
    R.check('and choosing the agent from it still ends the flow', closed,
      closed ? '' : `still on "${(await ob(app) || {}).step}"`);
    await cancelPull(app);
  } finally {
    await app.close();
  }
}

/* ------------------------------------------------------------------ D --- */
/**
 * The download screen's own skip card — "Or skip the wait — start using
 * the agent now. The download keeps running; progress shows in the top
 * bar" — and the two things a real pull is the only way to see.
 *
 * The ETA: `remaining / rate` on a first, cold sample is a rate of a few
 * bytes a second, and the strip printed `about 258467h 14m left` in the
 * window chrome while the operator watched. Nothing here asserts a
 * particular number — only that no sample prints an hour count no human
 * would read as an estimate.
 *
 * The stamp: `tui.onboarding.localSetupSeenAt` is written the moment the
 * local half of setup is entered, and it is what decides whether the flow
 * may pitch the other backend on the way out. It was being lost to
 * `useManagedMode()`, whose read-modify-write of the whole file started
 * before the stamp and finished after it.
 */
async function laneD() {
  const dirs = freshRun(join(ROOT, 'wiz-resume-d'), SEED);
  const app = await launch({ port: PORT, stateDir: dirs.stateDir, workspace: dirs.workspace });
  const etas = [];
  try {
    const measured = await toDownloading(app);
    R.check('lane D has a real download reporting', !!measured,
      measured ? `${measured.label} at ${measured.percent}%` : 'no sample in four minutes');
    if (!measured) return;

    // The strip, while the rate is still whatever the first samples said.
    for (let i = 0; i < 12; i += 1) {
      const strip = await dl(app);
      if (strip && strip.eta && etas.indexOf(strip.eta) < 0) etas.push(strip.eta);
      await sleep(500);
    }
    R.check('the strip never prints an estimate no one could read',
      etas.every((e) => !/\d{3,}h/.test(e)),
      etas.join(' | ') || 'no eta sampled');

    // The skip card, clicked — the same promise as the wait-or-jump row.
    await app.clickSel('#onboarding .ob-offer:not(.cloud)', { scroll: false });
    const closed = await app.waitFor('!document.querySelector("#onboarding")',
      'the wizard closing onto the agent', { timeout: 60000 }).then(() => true, () => false);
    const end = await ob(app);
    R.check('"skip the wait — start using the agent now" hands over the agent', closed,
      closed ? '' : `still open on "${end && end.step}"`);
    await shot(app, 'd1-after-skip.png');
    if (closed) {
      await app.waitFor('!!document.querySelector("#entry")', 'the composer', { timeout: 30000 });
      const strip = await dl(app);
      R.check('and the download it promised to keep running is still in the strip',
        !!(strip && strip.visible), strip ? JSON.stringify(strip.text).slice(0, 80) : 'no strip');
    }

    /* The stamp the flow wrote on the way in has to still be there — the
       file is read back from disk, not from the app. */
    let seen = null;
    for (let i = 0; i < 12 && seen === null; i += 1) {
      try {
        const cfg = JSON.parse(readFileSync(join(dirs.stateDir, 'config.json'), 'utf8'));
        seen = ((cfg.tui || {}).onboarding || {}).localSetupSeenAt ?? null;
      } catch { /* the CLI rewrites the file whole; read again */ }
      if (seen === null) await sleep(500);
    }
    R.check('the local-setup stamp survived the writes around it',
      typeof seen === 'string' && seen.length > 0, `localSetupSeenAt=${JSON.stringify(seen)}`);
    await cancelPull(app);
  } finally {
    await app.close();
  }
}

const only = arg('lane', null);
if (!only || only === 'a') await laneA();
if (!only || only === 'b') await laneB();
if (!only || only === 'c') await laneC();
if (!only || only === 'd') await laneD();
process.exit(R.done() ? 1 : 0);
