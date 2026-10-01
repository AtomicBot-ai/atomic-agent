/**
 * wizard-resume.drive.mjs — "when I have chosen to proceed to the agent, I
 * should have proceeded to the agent, not to the setup again".
 *
 * Backlog 18 took that one step further: Download itself is the choice to
 * proceed. The sequence, driven with a mouse:
 *
 *   fresh state dir → the splash → Local models → pick the smallest model
 *   → press Download → setup CLOSES at once onto the agent window (no
 *   "Downloading your model" screen, no second-backend pitch, no import
 *   step) and a REAL `atag models pull` reports in the download card in the
 *   bottom-right corner → the card's "Set up a cloud model meanwhile" opens
 *   the composer's cloud setup → configure a real cloud provider with the
 *   key in the state dir's `.env` → back in the agent window, the download
 *   still reporting in the card.
 *
 * and the neighbour that must not be broken to make that true:
 *
 *   B. the cloud setup opened from the card and CLOSED without configuring
 *      anything goes back to the agent window, the download untouched — it
 *      never brings setup back.
 *
 * and D, what only a real pull shows: the ETA the card prints while the
 * rate is still a guess, and `tui.onboarding.localSetupSeenAt`, which a
 * whole-file config write used to overwrite moments after the wizard
 * stamped it. Also D: the steps the hand-over skips stay owed — nothing is
 * stamped as offered.
 *
 * (Lane C — the wait-or-jump choice offered once — went with backlog 18:
 * a download no longer passes through that screen.)
 *
 * Nothing here calls into the app. `window.__ob` / `window.__dl` /
 * `window.__dlcard` are read to narrate what the screen already shows;
 * every step is a click or a key.
 *
 *   ATOMIC_AGENT_STATE_DIR=/some/scratch/dir node test/wizard-resume.drive.mjs
 *
 * Options: --port=N (default 9421), --state=DIR (the run root; a `.env`
 * beside it is copied into each fresh dir), --shots=DIR, --lane=a|b|d.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SMALL_MODEL, arg, cancelPull, configureCloudPopover, dl, dlcard, freshRun,
  launch, ob, passIntro, pickLocalModel, reporter, sleep, waitForRealSamples,
} from './drive-download-lib.mjs';

const PORT = Number(arg('port', '9421'));
const ROOT = arg('state', process.env.ATOMIC_AGENT_STATE_DIR || null);
const SHOTS = arg('shots', null);
if (!ROOT) throw new Error('set ATOMIC_AGENT_STATE_DIR (or --state=DIR) — never the operator’s own');
const SEED = join(ROOT, '.env');

const R = reporter('wizard-resume — Download hands over the agent, and the card carries the pull');

async function shot(app, name) {
  if (SHOTS) { try { await app.screenshot(join(SHOTS, name)); } catch { /* window gone */ } }
}

/** The file, read back from disk — not from the app. */
function stamps(dirs) {
  try {
    const cfg = JSON.parse(readFileSync(join(dirs.stateDir, 'config.json'), 'utf8'));
    return (cfg.tui || {}).onboarding || {};
  } catch { return null; }   // the CLI rewrites the file whole; read again
}

/** Walk a fresh first run as far as Download, and a real pull reporting bytes in the card. */
async function toDownloading(app) {
  await passIntro(app);
  await pickLocalModel(app, SMALL_MODEL);
  const closed = await app.waitFor('!document.querySelector("#onboarding")',
    'setup closing onto the agent', { timeout: 60000 }).then(() => true, () => false);
  const measured = await waitForRealSamples(app, { timeout: 240000 });
  return { closed, measured };
}

/* ------------------------------------------------------------------ A --- */
async function laneA() {
  const dirs = freshRun(join(ROOT, 'wiz-resume-a'), SEED);
  const app = await launch({ port: PORT, stateDir: dirs.stateDir, workspace: dirs.workspace });
  try {
    const { closed, measured } = await toDownloading(app);
    const end = await ob(app);
    R.check('Download closes setup at once — no download screen, no second-backend pitch, no import step', closed,
      closed ? '' : `still open on "${end && end.step}"`);
    await app.waitFor('!!document.querySelector("#entry")', 'the composer', { timeout: 30000 }).catch(() => {});
    R.check('a real download is running and reporting in the card', !!measured,
      measured ? `${measured.label} at ${measured.percent}%` : 'no sample arrived in four minutes');
    if (!measured) return;
    const card = await dlcard(app);
    R.check('the card stands in the bottom-right corner, with the model by name and the cloud offer under it',
      !!card && card.visible && card.rows.length >= 1 && /Set up a cloud model meanwhile/.test(card.cloud),
      card ? JSON.stringify({ rows: card.rows.map((r) => r.name + ' — ' + r.line), cloud: card.cloud }) : 'no card');
    await shot(app, 'a1-agent-with-card.png');

    // "Set up a cloud model meanwhile."
    await app.clickSel('#dlcard .dlc-cloud', { scroll: false });
    const opened = await app.eval(`({pop: !!document.querySelector('#overlays .selpop'), phase: WIZ.phase})`);
    R.check('the card’s cloud offer opens the composer’s cloud setup', opened.pop && opened.phase === 'pick_kind',
      JSON.stringify(opened));
    await shot(app, 'a2-cloud-setup.png');

    const after = await configureCloudPopover(app, SEED);
    R.check('a cloud provider configured mid-download closes the setup popover onto the agent',
      !after.open && after.wizard === null, JSON.stringify(after));
    const still = await dl(app);
    const wiz = await ob(app);
    R.check('the download it promised to keep running is still in the card, and setup did not come back',
      !!(still && still.running && still.visible) && !(wiz && wiz.open),
      still ? `card: ${JSON.stringify(still.text).slice(0, 90)}` : 'no download');
    await shot(app, 'a3-after-cloud.png');
    await cancelPull(app);
  } finally {
    await app.close();
  }
}

/* ------------------------------------------------------------------ B --- */
/** Closing the cloud setup WITHOUT configuring anything goes back to the agent. */
async function laneB() {
  const dirs = freshRun(join(ROOT, 'wiz-resume-b'), SEED);
  const app = await launch({ port: PORT, stateDir: dirs.stateDir, workspace: dirs.workspace });
  try {
    const { measured } = await toDownloading(app);
    if (!measured) { R.check('lane B could start a download', false, 'no sample in four minutes'); return; }
    await app.clickSel('#dlcard .dlc-cloud', { scroll: false });
    await app.waitFor(`!!document.querySelector('#overlays .selpop')`, 'the cloud setup', { timeout: 30000 });
    // The popover's own way out, clicked: Cancel on the provider list.
    if (await app.eval(`!!document.querySelector('.popover [data-act="wiz:cancel"]')`)) {
      await app.clickSel('.popover [data-act="wiz:cancel"]', { scroll: false });
    } else {
      await app.press('Escape');
    }
    await sleep(400);
    const s = await app.eval(`({pop: !!document.querySelector('#overlays .selpop'), wizard: !!document.querySelector('#onboarding')})`);
    const d = await dl(app);
    R.check('a cloud setup closed with nothing configured returns to the agent window, the download untouched',
      !s.pop && !s.wizard && !!(d && d.running && d.visible), JSON.stringify({ s, running: d && d.running, card: d && d.visible }));
    await shot(app, 'b1-back-in-the-agent.png');
    await cancelPull(app);
  } finally {
    await app.close();
  }
}

/* ------------------------------------------------------------------ D --- */
/**
 * The ETA: `remaining / rate` on a first, cold sample is a rate of a few
 * bytes a second, and the strip this card replaced printed `about 258467h
 * 14m left` while the operator watched. Nothing here asserts a particular
 * number — only that no sample prints an hour count no human would read as
 * an estimate.
 *
 * The stamps: `tui.onboarding.localSetupSeenAt` is written the moment the
 * local half of setup is entered, and it used to be lost to
 * `useManagedMode()`, whose read-modify-write of the whole file started
 * before the stamp and finished after it. And the hand-over writes the
 * closing stamp only: the second-backend pitch and the import step it
 * skipped are still owed, so neither may be stamped as offered.
 */
async function laneD() {
  const dirs = freshRun(join(ROOT, 'wiz-resume-d'), SEED);
  const app = await launch({ port: PORT, stateDir: dirs.stateDir, workspace: dirs.workspace });
  const lines = [];
  try {
    const { measured } = await toDownloading(app);
    R.check('lane D has a real download reporting', !!measured,
      measured ? `${measured.label} at ${measured.percent}%` : 'no sample in four minutes');
    if (!measured) return;

    // The card, while the rate is still whatever the first samples said.
    for (let i = 0; i < 12; i += 1) {
      const card = await dlcard(app);
      const line = card && card.rows[0] ? card.rows[0].line : '';
      if (line && lines.indexOf(line) < 0) lines.push(line);
      await sleep(500);
    }
    R.check('the card never prints an estimate no one could read',
      lines.length > 0 && lines.every((l) => !/\d{3,} ?h/.test(l)), lines.join(' | ') || 'no line sampled');
    await shot(app, 'd1-card-estimating.png');

    let seen = null;
    let file = null;
    for (let i = 0; i < 12 && seen === null; i += 1) {
      file = stamps(dirs);
      seen = file ? (file.localSetupSeenAt ?? null) : null;
      if (seen === null) await sleep(500);
    }
    R.check('the local-setup stamp survived the writes around it',
      typeof seen === 'string' && seen.length > 0, `localSetupSeenAt=${JSON.stringify(seen)}`);
    R.check('the hand-over stamped setup complete and left the skipped steps owed',
      !!file && typeof file.completedAt === 'string' && file.importOfferedAt == null && file.proposedSecondBackendAt == null,
      JSON.stringify(file));
    await cancelPull(app);
  } finally {
    await app.close();
  }
}

const only = arg('lane', null);
if (!only || only === 'a') await laneA();
if (!only || only === 'b') await laneB();
if (!only || only === 'd') await laneD();
process.exit(R.done() ? 1 : 0);
