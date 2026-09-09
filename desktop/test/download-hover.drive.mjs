/**
 * download-hover.drive.mjs — "when I hovered them with my mouse, they are
 * just lighting up and down, up and down. They are not stable."
 *
 * What the operator saw: while a model downloads, the percentage, the
 * transferred bytes and the ETA change on every sample the CLI emits, so
 * the HTML the surface would draw is DIFFERENT every time — and both
 * surfaces that draw it rebuilt themselves whole with `innerHTML`. The node
 * under the pointer is destroyed and recreated on every sample, and
 * `:hover` cannot survive its own element being replaced. That is the
 * flicker.
 *
 * This driver parks a real pointer on a real control and watches it while a
 * REAL `atag models pull` reports, on the two surfaces a download repaints:
 *
 *   A. the wizard's download screen — its two offer cards;
 *   B. the wait-or-jump screen — its rows (the "patterns" of the report);
 *   C. the agent window's own download strip — its Cancel button, which is
 *      on screen everywhere in the app while a pull runs.
 *
 * How it looks, and why that is proof rather than a guess: the identity of
 * the node under the pointer is read with `DOM.getNodeForLocation`, from
 * OUTSIDE the page — nothing is written into the document to obtain it. A
 * backendNodeId that changes between two samples means that element was
 * destroyed and rebuilt; `:hover` and the background it paints are read
 * alongside it. A stable id with `:hover` held throughout is the fix.
 *
 * The progress frames: each lane first watches under the CLI's own samples
 * (and refuses to conclude anything if none arrived — a quiet download
 * proves nothing), and then under a dense burst of frames pushed through
 * `window.__dlFeed`, which hands `dlOnPull` exactly the object main sends
 * on `cli:pull`. The burst is the same code path at a rate a person can
 * see; it is the tripwire, and the real samples are the evidence that the
 * tripwire is watching the real thing.
 *
 *   ATOMIC_AGENT_STATE_DIR=/some/scratch/dir node test/download-hover.drive.mjs
 *
 * Options: --port=N (default 9422), --state=DIR, --shots=DIR, --lane=a|b|c.
 */

import { join } from 'node:path';
import {
  SMALL_MODEL, arg, boxOf, cancelPull, configureCloud, dl, freshRun, hoverAt,
  launch, nodeIdAt, ob, passIntro, pickLocalModel, reporter, scrollTo, sleep, waitForRealSamples,
} from './drive-download-lib.mjs';

const PORT = Number(arg('port', '9422'));
const ROOT = arg('state', process.env.ATOMIC_AGENT_STATE_DIR || null);
const SHOTS = arg('shots', null);
if (!ROOT) throw new Error('set ATOMIC_AGENT_STATE_DIR (or --state=DIR) — never the operator’s own');
const SEED = join(ROOT, '.env');

const R = reporter('download-hover — a hover that survives a download');

async function shot(app, name) {
  if (SHOTS) { try { await app.screenshot(join(SHOTS, name)); } catch { /* window gone */ } }
}

/* ------------------------------------------------------------ watching --- */
/**
 * Park the pointer on `sel` and report what happens to it while `drive()`
 * makes the download report. Nothing is clicked: a hand that has come to
 * rest on a control is the whole of the operator's complaint.
 */
async function watch(app, sel, drive) {
  const box = await boxOf(app, sel);
  if (!box) throw new Error(`nothing on screen at ${sel}`);
  await hoverAt(app, box.x, box.y);
  await sleep(250);
  const seen = { label: box.label, samples: 0, replaced: 0, reshaped: 0, hoverOff: 0, backgrounds: [], progress: [] };
  let lastId = await nodeIdAt(app, box.x, box.y);
  /* When the node under the pointer last changed. The card carries
     `transition: background .1s ease`, so for a tenth of a second after a
     LEGITIMATE rebuild — the queue moving from the llama.cpp runtime to the
     weights, which genuinely changes what the surface says — the background
     is mid-fade: a run of this driver read
     ["rgba(0,106,255,0.16)","rgba(0,0,0,0)","rgba(0,106,255,0.14)"] around
     one such rebuild and called it oscillation. Those are three points on
     one fade, not three states. The background is therefore sampled only
     once the fade has had time to finish; what the flicker check rests on
     is `replaced` (an identity change with the surface saying the same
     thing), which stays strict and is not touched by this. */
  let settledAt = Date.now();
  const FADE_MS = 250;
  /* What the download IS, as against how far along it is. A queue that moves
     from the llama.cpp runtime to the model weights changes the strip's
     label and drops its "· 1 more queued" suffix — the surface genuinely
     says something else and rebuilding it is right. A rebuild while THIS is
     unchanged is a repaint driven by nothing but the percentage, which is
     the flicker. The two are counted apart so the check can name the one it
     is about. */
  const shapeOf = () => app.eval('(() => { const d = window.__dl() || {};'
    + ' return [d.label, d.kind, d.queued, d.measured].join("|"); })()');
  let lastShape = await shapeOf();
  let stop = false;
  const look = async () => {
    while (!stop) {
      const id = await nodeIdAt(app, box.x, box.y);
      const shape = await shapeOf();
      const now = await app.eval(`(() => {
        const under = document.elementFromPoint(${Math.round(box.x)}, ${Math.round(box.y)});
        const t = under && under.closest(${JSON.stringify(sel)});
        return t ? { hovered: t.matches(':hover'), bg: getComputedStyle(t).backgroundColor } : null;
      })()`);
      /* What a person reads while they wait: the strip's line, and the two
         phase rows and the rate line on the wizard's own progress block. If
         none of it changes, the download did not report during this watch
         and the watch proves nothing — see `judge`. */
      const p = await app.eval(`(() => {
        const strip = (window.__dl() || {}).text || '';
        const rows = [...document.querySelectorAll('#onboarding .ob-phase .pt, #onboarding .ob-rate')]
          .map((n) => n.innerText).join('|');
        return strip + ' || ' + rows;
      })()`);
      seen.samples += 1;
      if (id && lastId && id !== lastId) {
        if (shape === lastShape) seen.replaced += 1; else seen.reshaped += 1;
        settledAt = Date.now();
      }
      if (id) lastId = id;
      lastShape = shape;
      if (now) {
        if (!now.hovered) seen.hoverOff += 1;
        if (Date.now() - settledAt > FADE_MS && seen.backgrounds.indexOf(now.bg) < 0) {
          seen.backgrounds.push(now.bg);
        }
      } else {
        seen.hoverOff += 1;          // the control is not even under the pointer any more
      }
      if (seen.progress[seen.progress.length - 1] !== p) seen.progress.push(p);
      await sleep(50);
    }
  };
  const looking = look();
  try { await drive(); } finally { stop = true; await looking; }
  return seen;
}

/** Report one watch. `moves` is how many distinct progress readings it saw. */
function judge(where, seen, { needMoves = 2 } = {}) {
  const moves = seen.progress.length - 1;
  R.say(`${where}: pointer on "${seen.label}", ${seen.samples} looks, `
    + `${moves} progress changes, node replaced ${seen.replaced}× by a sample`
    + ` (${seen.reshaped}× when the strip itself changed what it says), `
    + `hover lost on ${seen.hoverOff} looks, backgrounds ${JSON.stringify(seen.backgrounds)}`);
  if (moves < needMoves) {
    /* Too few repaints to conclude anything — a download that finished
       early, or a quiet stretch between samples. Refusing to pass is
       right; failing is not, because nothing about the app was observed
       to be wrong. Say it did not run, the way the suite says it
       elsewhere, so a red line always means a real defect. */
    R.say(`SKIP ${where}: the download reported only ${moves} progress change(s) while the pointer`
      + ` was parked — too few repaints to prove stability either way, so this watch drew no conclusion`);
    R.skipped = (R.skipped || 0) + 1;
    return;
  }
  R.check(`${where}: a progress sample never rebuilds the node under the pointer`, seen.replaced === 0,
    seen.replaced ? `replaced ${seen.replaced} times in ${seen.samples} looks — this is the flicker` : '');
  R.check(`${where}: :hover holds for the whole download`, seen.hoverOff === 0,
    seen.hoverOff ? `lost on ${seen.hoverOff} of ${seen.samples} looks` : '');
  R.check(`${where}: the background never oscillates`, seen.backgrounds.length === 1,
    seen.backgrounds.length > 1 ? `painted ${JSON.stringify(seen.backgrounds)}` : '');
}

/**
 * A burst of frames shaped exactly like the ones main sends on `cli:pull`
 * (main.ts: `send("cli:pull", { id, line, ...parsePullProgress(line, kind) })`),
 * pushed one every 120 ms so a repaint storm happens while the pointer is
 * parked. `window.__dlFeed` hands them to `dlOnPull` — the same function the
 * IPC subscriber hands the real ones to, and nothing else.
 */
async function burst(app, n = 14) {
  const d = await dl(app);
  if (!d || !d.visible) return 0;
  const kind = d.kind || 'weights';
  const id = d.label || SMALL_MODEL;
  const total = d.total || 2_700_000_000;
  const from = Math.max(1, d.percent || 1);
  /* How many of the frames the strip actually took. `__dlFeed` answers with
     the strip's own state, so this counts what MOVED rather than what was
     sent — a burst that a finished pull swallowed reports 0 and the watch
     around it says it timed out instead of passing on silence. */
  const moved = new Set();
  for (let i = 0; i < n; i += 1) {
    const pct = Math.min(95, from + i + 1);
    const bytes = Math.round((pct / 100) * total);
    const after = await app.eval(`window.__dlFeed(${JSON.stringify({
      id, kind, percent: pct, transferredBytes: bytes, totalBytes: total,
      line: `[====      ] ${pct}%  ${(bytes / 1e9).toFixed(2)} GB / ${(total / 1e9).toFixed(2)} GB`,
    })})`);
    if (after && after.percent !== null) moved.add(after.percent);
    await sleep(120);
  }
  return moved.size;
}

/** Watch a point under real samples, then under a dense burst. */
async function bothWays(app, where, sel, { realMs = 40000 } = {}) {
  const real = await watch(app, sel, () => sleep(realMs));
  judge(`${where} · real CLI samples`, real, { needMoves: 1 });
  const dense = await watch(app, sel, () => burst(app));
  judge(`${where} · a dense burst of the same frames`, dense, { needMoves: 6 });
}

/* ----------------------------------------------------------------- A B --- */
async function lanesAB() {
  const dirs = freshRun(join(ROOT, 'dl-hover-ab'), SEED);
  const app = await launch({ port: PORT, stateDir: dirs.stateDir, workspace: dirs.workspace });
  try {
    await passIntro(app);
    await pickLocalModel(app, SMALL_MODEL);
    const measured = await waitForRealSamples(app, { timeout: 240000 });
    R.check('a real download is running and reporting', !!measured,
      measured ? `${measured.label} at ${measured.percent}%` : 'no sample in four minutes');
    if (!measured) return;
    await shot(app, 'a0-download-screen.png');

    // A: the download screen's own offer cards.
    await bothWays(app, 'the download screen’s offer card', '#onboarding .ob-offer.cloud');

    // B: the wait-or-jump rows — the same screen with a list on it.
    await app.clickSel('#onboarding .ob-offer.cloud', { scroll: false });
    const after = await configureCloud(app, SEED);
    if (after.step !== 'wait_or_jump') {
      R.check('lane B reached the wait-or-jump screen', false, `step ${after.step}`);
      return;
    }
    await shot(app, 'b0-wait-or-jump.png');
    await bothWays(app, 'the wait-or-jump row', '#onboarding .ob-row[data-obrow="0"]');
  } finally {
    await cancelPull(app);
    await app.close();
  }
}

/* ------------------------------------------------------------------- C --- */
/** The strip's Cancel button, in the agent window, with the pull still live. */
async function laneC() {
  const dirs = freshRun(join(ROOT, 'dl-hover-c'), SEED);
  const app = await launch({ port: PORT, stateDir: dirs.stateDir, workspace: dirs.workspace });
  try {
    await passIntro(app);
    await pickLocalModel(app, SMALL_MODEL);
    const measured = await waitForRealSamples(app, { timeout: 240000 });
    R.check('lane C: a real download is running and reporting', !!measured,
      measured ? `${measured.label} at ${measured.percent}%` : 'no sample in four minutes');
    if (!measured) return;

    // "Or skip the wait — start using the agent now": the second offer card.
    await app.clickSel('#onboarding .ob-offer:not(.cloud)', { scroll: false });
    /* Whatever the flow raises after that — the second-backend pitch, the
       import step — the way past it is its own skip row, and this lane only
       wants to be standing in the agent window with the pull still running.
       The wait matters: `obSettle` reads readiness and scans the machine for
       other agents over IPC first, so for a second or two after the click the
       flow is on `finished` with no rows on it at all. A loop that looked
       once and gave up read exactly that gap. */
    const until = Date.now() + 120000;
    while (Date.now() < until) {
      if (!(await app.eval('!!document.querySelector("#onboarding")'))) break;
      const skip = await app.eval(`(() => {
        const n = [...document.querySelectorAll('#onboarding .ob-row')]
          .find((r) => /^Skip/i.test(((r.querySelector('.t')||{innerText:''}).innerText || '').trim()));
        return n ? n.getAttribute('data-obrow') : null;
      })()`);
      if (skip === null) { await sleep(1000); continue; }
      const sel = `#onboarding .ob-row[data-obrow="${skip}"]`;
      try {
        await scrollTo(app, sel);
        await app.clickSel(sel, { scroll: false });
      } catch (e) { app.log(`the skip click did not come back (${e.message})`); }
      await sleep(1200);
    }
    const gone = await app.waitFor('!document.querySelector("#onboarding")', 'the agent window',
      { timeout: 60000 }).then(() => true, () => false);
    R.check('lane C: the wizard handed over the agent with the pull still running', gone);
    if (!gone) return;
    const strip = await dl(app);
    R.check('lane C: the strip is reporting in the agent window', !!(strip && strip.visible),
      strip ? strip.text.slice(0, 70) : '');
    await shot(app, 'c0-agent-with-strip.png');
    await bothWays(app, 'the strip’s Cancel button', '#dlbar .dl-x');
  } finally {
    await cancelPull(app);
    await app.close();
  }
}

const only = arg('lane', null);
if (!only || only === 'a' || only === 'b') await lanesAB();
if (!only || only === 'c') await laneC();
process.exit(R.done() ? 1 : 0);
