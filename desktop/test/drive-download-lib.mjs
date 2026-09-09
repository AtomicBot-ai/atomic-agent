/**
 * drive-download-lib.mjs — the parts the two download-lane drivers repeat.
 *
 * Both of them need the same three things and nothing else: a state
 * directory that has never been used (with the operator's `.env` beside it,
 * exactly as a person's own state dir carries one), the first-run wizard
 * walked as far as a REAL `atag models pull` running, and a way to look at
 * what is under the pointer while that pull reports.
 *
 * Every step here is a click or a keystroke through `drive.mjs`, i.e.
 * through CDP's Input domain. `app.eval` and `DOM.getNodeForLocation` are
 * used to LOOK — never to make something happen — and no `window.__*` hook
 * is ever called to advance the flow.
 *
 * The pull is a real one: `qwen-3.5-4b` is the smallest curated model
 * (2.7 GB), the child process is the agent's own `models pull`, and the
 * samples the screen redraws from are the CLI's own progress lines. A
 * driver cancels it the moment it has what it came for, so a run costs
 * whatever bytes arrived in those few seconds and never a whole model.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, sleep } from './drive.mjs';

/** The smallest model in the curated catalogue — the cheapest real pull. */
export const SMALL_MODEL = 'qwen-3.5-4b';

export function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

/* --------------------------------------------------------------- report -- */
export function reporter(title) {
  const failures = [];
  let n = 0;
  process.stdout.write(`\n${title}\n`);
  return {
    check(name, ok, detail = '') {
      n += 1;
      process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}\n`);
      if (!ok) failures.push(name);
    },
    say: (line) => process.stdout.write(`     ${line}\n`),
    done() {
      process.stdout.write(`\n${failures.length ? 'FAILED' : 'OK'}: ${n - failures.length}/${n} checks`
        + `${failures.length ? ' — ' + failures.join(', ') : ''}\n`);
      return failures.length;
    },
  };
}

/* ---------------------------------------------------------------- dirs --- */
/**
 * A state dir nothing has ever run against, carrying a copy of the seed
 * `.env` — which is what a person's own state directory looks like: the
 * keys are theirs, sitting in the file `atag` reads.
 */
export function freshRun(base, seedEnv) {
  rmSync(base, { recursive: true, force: true });
  const stateDir = join(base, 'state');
  const workspace = join(base, 'workspace');
  for (const real of ['.atomic-agent', '.atomic-agent-desktop']) {
    if (resolve(stateDir).startsWith(resolve(homedir(), real))) throw new Error('refusing to use real app data');
  }
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  if (seedEnv && existsSync(seedEnv)) cpSync(seedEnv, join(stateDir, '.env'));
  return { base, stateDir, workspace };
}

/** The key for one provider, read off the seed `.env`. Never printed. */
export function keyFor(seedEnv, envKey) {
  const raw = existsSync(seedEnv) ? readFileSync(seedEnv, 'utf8') : '';
  const m = raw.match(new RegExp(`^${envKey}=(.*)$`, 'm'));
  if (!m) throw new Error(`${seedEnv} has no ${envKey}`);
  return m[1].trim();
}

/* ----------------------------------------------------------- the flow ---- */
export const WIZ_TEXT = `((document.querySelector('#onboarding')||{innerText:''}).innerText)`;

/** What the flow says about itself. Reading only — `window.__ob` is a getter. */
export const ob = (app) => app.eval('window.__ob ? window.__ob() : null');
/** What the download slice says about itself. Reading only. */
export const dl = (app) => app.eval('window.__dl ? window.__dl() : null');

/** Dismiss the two-stage splash by clicking its sky, as a mouse-only person does. */
export async function passIntro(app) {
  await app.waitFor('!!document.querySelector("#onboarding")', 'the first-run wizard', { timeout: 120000 });
  for (let i = 0; i < 8; i += 1) {
    if (!(await app.eval('!!document.querySelector("#ob-sky")'))) break;
    await app.clickSel('#ob-sky', { scroll: false });
    await sleep(400);
  }
  await app.waitFor(`/Cloud models/.test(${WIZ_TEXT})`, 'the three backend choices', { timeout: 60000 });
}

/**
 * Click one curated model in the picker and land on the download screen.
 *
 * The list scrolls, and a wheel notch before the press can move the row out
 * from under it — which is how a first pass clicked "Add a model from
 * Hugging Face…" instead. So the row is addressed by its INDEX and the
 * screen is read back after the press: a click that landed somewhere else
 * is walked back with `esc` and tried again rather than believed.
 */
export async function pickLocalModel(app, id) {
  await app.clickText('Local models');
  await app.waitFor("document.querySelectorAll('#onboarding .ob-row').length > 1",
    'the curated model list', { timeout: 180000 });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    /* Address the row by the index it carries itself, not by its position
       among the matches: the list has section headings between rows and a
       "Add a model from Hugging Face…" row at the end, and an off-by-one
       there is how a first pass ended up on the Hugging Face screen. */
    const at = await app.eval(`(() => {
      const n = [...document.querySelectorAll('#onboarding .ob-row')]
        .find((r) => ((r.querySelector('.t')||{innerText:''}).innerText || '').trim().indexOf(${JSON.stringify(id)}) === 0);
      return n ? n.getAttribute('data-obrow') : null;
    })()`);
    if (at === null) throw new Error(`no row for ${id} in the picker`);
    const rowSel = `#onboarding .ob-row[data-obrow="${at}"]`;
    try {
      await scrollTo(app, rowSel);
      await app.clickSel(rowSel, { scroll: false });
    } catch (e) {
      /* A saturated Mac loses CDP round trips (`Input.dispatchMouseEvent
         timed out` at 30 s). That is the machine, not the app: look at the
         screen and carry on rather than reporting a defect. */
      app.log(`the click did not come back (${e.message}) — looking at the screen instead`);
    }
    await sleep(500);
    const s = (await ob(app)) || {};
    if (s.step === 'local_download') { app.log(`downloading ${s.localModelId}`); return; }
    app.log(`the click landed on "${s.step}" (model ${s.localModelId}), not the download — walking back`);
    if (s.step !== 'local_pick') { await app.press('Escape'); await sleep(600); }
    if ((((await ob(app)) || {}).step) === 'choose') await app.clickText('Local models');
    await app.waitFor("window.__ob().step === 'local_pick'"
      + " && document.querySelectorAll('#onboarding .ob-row').length > 1", 'the picker again',
      { timeout: 60000, quiet: true });
  }
  throw new Error(`four clicks on ${id} and the flow never reached the download screen`);
}

/** Which provider row the drivers set up, and where its key lives. */
export const PROVIDER = { row: 'AI/ML API', envKey: 'AIMLAPI_API_KEY' };

/**
 * Configure a real cloud provider inside the wizard's cloud step, by
 * clicking and typing. Returns the flow's state once the step has left
 * 'cloud' — the provider is verified over the network and the agent is
 * bounced, so that takes as long as it takes.
 */
export async function configureCloud(app, seedEnv, { timeout = 180000 } = {}) {
  await app.waitFor("(window.__ob().step === 'cloud')", 'the cloud step', { timeout: 30000 });
  await app.clickText(PROVIDER.row);
  await app.waitFor('!!document.querySelector("#wiz-key")', 'the key field', { timeout: 30000 });
  await app.clickSel('#wiz-key');
  await app.typeSecret(keyFor(seedEnv, PROVIDER.envKey), `the ${PROVIDER.row} key`);
  const typed = await app.eval('((document.querySelector("#wiz-key")||{}).value || "").length');
  if (!typed) throw new Error('the key field is empty after typing — a repaint took the caret');
  await app.clickText('Next');
  const until = Date.now() + timeout;
  for (;;) {
    const s = await ob(app);
    if (!s || !s.open || s.step !== 'cloud') return s;
    if (Date.now() > until) throw new Error('the cloud step never resolved');
    await sleep(700);
  }
}

/**
 * Wait until the strip is reporting REAL bytes — `sawProgress` is set by
 * the first parsed `cli:pull` sample, so this is the point from which the
 * screen redraws on the CLI's own schedule.
 */
export async function waitForRealSamples(app, { timeout = 240000 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const d = await dl(app);
    if (d && d.visible && d.measured) return d;
    if (Date.now() > until) return null;
    await sleep(1000);
  }
}

/** Stop the pull the way a person does: the strip's own Cancel button. */
export async function cancelPull(app) {
  try {
    if (await app.eval('!!document.querySelector("#dlbar .dl-x")')) {
      await app.clickSel('#dlbar .dl-x', { scroll: false });
    }
  } catch { /* the strip may already be gone */ }
}

/* ------------------------------------------------------- looking closely -- */
/**
 * The identity of the node at (x, y), read from OUTSIDE the page.
 *
 * `DOM.getNodeForLocation` answers with a backendNodeId, which is stable
 * for the lifetime of a node and different for its replacement. Nothing is
 * written to the page to get it — no expando, no probe variable — so what
 * it reports about a repaint is what the repaint really did.
 */
export async function nodeIdAt(app, x, y) {
  try {
    const r = await app.send('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false });
    return r && (r.backendNodeId || null);
  } catch { return null; }
}

/** Park the pointer on a point, as a hand that has stopped moving does. */
export async function hoverAt(app, x, y) {
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none' });
}

/** Where a selector is on screen, and what a person would call it. */
export function boxOf(app, sel, nth = 0) {
  return app.eval(`(() => {
    const ns = [...document.querySelectorAll(${JSON.stringify(sel)})];
    const n = ns[${nth}];
    if (!n) return null;
    const r = n.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom, vh: innerHeight,
             label: (n.textContent || n.tagName).trim().replace(/\\s+/g, ' ').slice(0, 40) };
  })()`);
}

/**
 * Wheel `sel` into view AND WAIT FOR IT TO STOP MOVING before anybody
 * clicks it.
 *
 * Chromium animates a wheel notch. `drive.mjs`'s own scroll-into-view
 * measures 60 ms after the last notch, which is mid-animation: the box it
 * hands to the press is where the row was, not where it is when the button
 * goes down. On the curated model list that put the press on the row BELOW
 * the one measured — a driven run kept landing on "Add a model from
 * Hugging Face…" while its own log named `qwen-3.5-4b`. Nothing about the
 * app is wrong there; the driver was clicking a stale coordinate. So:
 * scroll, then hold still until three consecutive measurements agree.
 */
export async function scrollTo(app, sel) {
  /* The gate is a HIT TEST, not the viewport. The curated model list lives
     in `.ob-scroll` (max-height 46vh), so a row can be inside the window
     and still clipped by its own scroller — the first attempt at this
     measured a row "in view" at y=676 and pressed on the container
     underneath it. `elementFromPoint` resolving to the row itself is the
     only thing that means "a person could click here". */
  const probe = `(() => {
    const n = document.querySelector(${JSON.stringify(sel)});
    if (!n) return null;
    let p = n.parentElement, sc = null;
    while (p) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1) { sc = p; break; }
      p = p.parentElement;
    }
    const r = n.getBoundingClientRect();
    const cr = sc ? sc.getBoundingClientRect() : {top: 0, bottom: innerHeight, left: 0, right: innerWidth};
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, rt: r.top, rb: r.bottom, ct: cr.top, cb: cr.bottom,
             cx: (cr.left + cr.right) / 2, cy: (cr.top + cr.bottom) / 2,
             on: !!(hit && hit.closest(${JSON.stringify(sel)}) === n), vh: innerHeight,
             label: (n.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40) };
  })()`;
  let prev = null;
  let still = 0;
  for (let i = 0; i < 120; i += 1) {
    const b = await app.eval(probe);
    if (!b) throw new Error(`nothing on screen at ${sel}`);
    if (b.on) {
      /* Under the pointer AND holding still: a wheel notch is animated, so
         a box measured mid-animation is not where the press will land. */
      if (prev !== null && Math.abs(b.y - prev) < 0.5) { still += 1; if (still >= 3) return b; }
      else still = 0;
    } else {
      still = 0;
      // Its own scroller first, the window second; if it is inside both and
      // still not under the pointer, something covers it — wait, do not wheel.
      const inner = b.rb > b.cb || b.rt < b.ct;
      const outer = b.rb > b.vh - 8 || b.rt < 8;
      if (inner || outer) {
        const down = inner ? b.rb > b.cb : b.rb > b.vh - 8;
        const x = Math.min(Math.max(inner ? b.cx : b.x, 4), 1200);
        const y = inner ? Math.min(Math.max(b.cy, 8), b.vh - 8) : Math.round(b.vh / 2);
        await app.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: 0,
          deltaY: down ? 160 : -160, button: 'none',
        });
      }
    }
    prev = b.y;
    await sleep(140);
  }
  throw new Error(`${sel} never came to rest under the pointer`);
}

/**
 * Watch one point while the download reports: how often the node under it
 * is REPLACED, whether it keeps matching `:hover`, and what background it
 * is actually painted. A node whose identity changes from sample to sample
 * is the flicker the operator described — `:hover` cannot survive its own
 * element being destroyed and rebuilt.
 */
export async function watchPoint(app, sel, { ms = 12000, every = 60 } = {}) {
  const box = await boxOf(app, sel);
  if (!box) throw new Error(`nothing on screen at ${sel}`);
  await hoverAt(app, box.x, box.y);
  await sleep(200);
  const out = { label: box.label, samples: 0, identities: 0, hoverOn: 0, hoverOff: 0, backgrounds: [], percents: [] };
  let lastId = null;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const id = await nodeIdAt(app, box.x, box.y);
    const look = await app.eval(`(() => {
      const n = document.elementFromPoint(${Math.round(box.x)}, ${Math.round(box.y)});
      if (!n) return null;
      const t = n.closest(${JSON.stringify(sel)});
      return { hovered: !!(t && t.matches(':hover')),
               bg: t ? getComputedStyle(t).backgroundColor : null,
               still: !!t };
    })()`);
    const pct = await app.eval('(window.__dl && window.__dl().percent) || 0');
    out.samples += 1;
    if (id !== null && lastId !== null && id !== lastId) out.identities += 1;
    if (id !== null) lastId = id;
    if (look && look.still) {
      if (look.hovered) out.hoverOn += 1; else out.hoverOff += 1;
      if (look.bg && out.backgrounds.indexOf(look.bg) < 0) out.backgrounds.push(look.bg);
    }
    if (out.percents[out.percents.length - 1] !== pct) out.percents.push(pct);
    await sleep(every);
  }
  return out;
}

export { launch, sleep };
