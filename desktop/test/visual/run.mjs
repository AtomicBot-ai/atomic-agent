/**
 * run.mjs: shoot every screen in the matrix and compare with the baselines.
 *
 *   npm run visual          compare; exit 1 if any shot changed or failed
 *   npm run visual:update   write this run's shots as the new baselines
 *
 * Both need a built app (`npm run build`; the npm scripts do it first).
 * Output goes to test/visual/out/ (or VISUAL_OUT): actual/, baseline/,
 * diff/, report.html and summary.json. Baselines live in
 * test/visual/baselines/<process.platform>/ (or VISUAL_BASELINES).
 * A shot with no baseline is reported as new and never fails the run.
 *
 * Other knobs: VISUAL_VARIANTS, VISUAL_THEMES, VISUAL_SCREENS (matrix.mjs),
 * VISUAL_PIXEL_THRESHOLD, VISUAL_MAX_DIFF_RATIO (verdict.mjs),
 * VISUAL_PORT (CDP port, default 9495), VISUAL_VERBOSE=1 (narrate clicks).
 * README.md in this folder has the review workflow.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DESKTOP_DIR, sleep } from '../drive.mjs';
import { compareFiles } from './compare.mjs';
import { launchApp } from './launch.mjs';
import { buildMatrix, shotName } from './matrix.mjs';
import { renderReport } from './report.mjs';
import { hooksNeeded, leaveOnboarding, partitionByHooks, SCREENS } from './screens.mjs';
import { FONTS_EXPR, pinPage, readyForShot, setViewport } from './stabilize.mjs';
import { formatPercent, summarize, thresholdsFrom } from './verdict.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const UPDATE = argv.includes('--update');
const outArg = argv.indexOf('--out');
const OUT = resolve(outArg !== -1 && argv[outArg + 1] ? argv[outArg + 1] : (process.env.VISUAL_OUT || join(HERE, 'out')));
const BASELINES = resolve(process.env.VISUAL_BASELINES || join(HERE, 'baselines', process.platform));
const PORT = Number(process.env.VISUAL_PORT || 9495);

const thresholds = thresholdsFrom();
const matrix = buildMatrix({ screens: SCREENS });
const appVersion = (() => {
  try { return JSON.parse(readFileSync(join(DESKTOP_DIR, 'package.json'), 'utf8')).version; } catch { return ''; }
})();

rmSync(OUT, { recursive: true, force: true });
for (const d of ['actual', 'baseline', 'diff']) mkdirSync(join(OUT, d), { recursive: true });
if (UPDATE) mkdirSync(BASELINES, { recursive: true });

const stateDir = mkdtempSync(join(tmpdir(), 'atag-visual-state-'));
const workspace = mkdtempSync(join(tmpdir(), 'atag-visual-ws-'));
const results = [];
let fonts = { ok: true, detail: '' };
let dropped = [];

async function setTheme(app, theme) {
  /* act() refuses the theme verb while the first-run flow is open
     (visual.drive.mjs learned that the hard way): close it first. */
  await leaveOnboarding(app);
  await app.eval(`window.__theme(${JSON.stringify(theme)})`);
  await app.waitFor(`(document.documentElement.getAttribute('data-theme') || 'system') === ${JSON.stringify(theme)}`,
    `the ${theme} theme`, { timeout: 8000 });
}

async function shootOne(app, screen, theme, variant) {
  const name = shotName(screen.id, theme, variant);
  const actual = join(OUT, 'actual', `${name}.png`);
  const base = join(BASELINES, `${name}.png`);
  const r = { name, screen: screen.id, theme, variant, status: 'same', reason: '', ratio: null, images: {} };
  let shotError = null;
  try {
    if (screen.phase === 'app') await leaveOnboarding(app);
    await screen.run(app);
    await readyForShot(app, variant, { quick: !!screen.quick });
    if (screen.check && !(await app.eval(screen.check))) throw new Error('the screen moved on before the shot');
    await app.screenshot(actual);
  } catch (e) {
    shotError = String((e && e.message) || e).split('\n')[0].slice(0, 300);
    // Whatever is on screen instead: the quickest way to see why.
    await app.screenshot(actual).catch(() => null);
  } finally {
    await (screen.after ? screen.after(app) : leaveOnboarding(app)).catch(() => null);
  }

  if (existsSync(base)) {
    copyFileSync(base, join(OUT, 'baseline', `${name}.png`));
    r.images.baseline = `baseline/${name}.png`;
  }
  if (existsSync(actual)) r.images.actual = `actual/${name}.png`;

  if (shotError) {
    Object.assign(r, { status: 'error', reason: 'could not reach this screen', error: shotError });
  } else if (UPDATE) {
    mkdirSync(dirname(base), { recursive: true });
    copyFileSync(actual, base);
    Object.assign(r, { status: 'updated', reason: existsSync(join(OUT, 'baseline', `${name}.png`)) ? 'replaced the old baseline' : 'first baseline' });
  } else {
    const c = compareFiles({ baseline: base, actual, diff: join(OUT, 'diff', `${name}.png`), thresholds });
    Object.assign(r, { status: c.status, reason: c.reason, ratio: c.ratio });
    if (c.wroteDiff) r.images.diff = `diff/${name}.png`;
  }
  const pct = typeof r.ratio === 'number' ? ` (${formatPercent(r.ratio)})` : '';
  console.log(`visual: ${r.status.padEnd(7)} ${name}${pct}${r.error ? `: ${r.error}` : ''}`);
  return r;
}

let app = null;
let fatal = null;
try {
  console.log(`visual: ${UPDATE ? 'updating baselines' : 'comparing'} on ${process.platform}, ${matrix.shots.length} shot(s), baselines ${BASELINES}`);
  app = await launchApp({ port: PORT, stateDir, workspace, verbose: process.env.VISUAL_VERBOSE === '1' });
  await app.waitFor("typeof window.__ob === 'function' && typeof window.__theme === 'function'", 'the renderer hooks', { timeout: 60000 });
  // A first run opens the flow by itself; give it the time visual.drive.mjs does.
  for (let i = 0; i < 90 && !(await app.eval('window.__ob().open').catch(() => false)); i++) await sleep(250);
  await pinPage(app);

  const f = await app.eval(FONTS_EXPR);
  fonts = { ok: !!(f.figtree && f.inter && f.mono), detail: `Figtree ${f.figtree}, Inter (Cyrillic) ${f.inter}, DM Mono ${f.mono}` };
  console.log(`visual: fonts ${fonts.detail}`);
  if (!fonts.ok && UPDATE) throw new Error('the vendored fonts did not load; refusing to write baselines with fallback letterforms');

  const need = hooksNeeded(matrix.screens);
  const present = new Set(await app.eval(`${JSON.stringify(need)}.filter((h) => typeof window[h] === 'function')`));
  const parts = partitionByHooks(matrix.screens, present);
  dropped = parts.dropped;
  for (const d of dropped) console.log(`visual: left out ${d.id}: ${d.reason}`);

  for (const variant of matrix.variants) {
    await setViewport(app, variant);
    for (const theme of matrix.themes) {
      await setTheme(app, theme);
      for (const screen of parts.runnable) results.push(await shootOne(app, screen, theme, variant));
    }
  }
  await app.eval("window.__theme('system')").catch(() => null);
} catch (e) {
  fatal = e;
  console.error(`visual: the run stopped: ${(e && e.message) || e}`);
  if (app) console.error(app.output().slice(-3000));
} finally {
  if (app) await app.close().catch(() => null);
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}

const meta = {
  platform: `${process.platform}-${process.arch}`,
  when: new Date().toISOString(),
  mode: UPDATE ? 'update' : 'compare',
  thresholds,
  fonts,
  dropped,
  unknownScreens: matrix.unknownScreens,
  version: appVersion,
};
const sum = summarize(results, { fontsOk: fonts.ok });
writeFileSync(join(OUT, 'report.html'), renderReport(results, meta));
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ ...meta, ...sum, fatal: fatal ? String(fatal.message || fatal) : null,
  results: results.map(({ images, ...rest }) => rest) }, null, 2));
console.log(`visual: ${Object.entries(sum.counts).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ') || 'no shots'}`);
console.log(`visual: report ${join(OUT, 'report.html')}`);
process.exit(fatal ? 2 : sum.exitCode);
