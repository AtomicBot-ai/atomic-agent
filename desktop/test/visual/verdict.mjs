/**
 * verdict.mjs: what one compared shot means, and whether the run fails.
 *
 * Pure: the numbers come in from compare.mjs (pixelmatch), the decision
 * goes out. Two knobs, both from the environment so CI can be softer than
 * the second Mac without a code change:
 *
 *   VISUAL_PIXEL_THRESHOLD  pixelmatch's per-pixel colour tolerance, 0..1
 *                           (default 0.1, pixelmatch's own default)
 *   VISUAL_MAX_DIFF_RATIO   share of the shot that may differ before the
 *                           shot counts as changed, 0..1 (default 0.001,
 *                           that is 0.1% of the pixels)
 *
 * Statuses:
 *   same     at or under the ratio (may still have a few anti-aliasing pixels)
 *   changed  over the ratio, or a different image size: FAILS the run
 *   new      no baseline yet: reported, never a failure
 *   updated  visual:update wrote this shot as the new baseline
 *   error    the screen could not be shot (a hook threw, a wait ran out): FAILS
 */

export const DEFAULTS = Object.freeze({ pixelThreshold: 0.1, maxDiffRatio: 0.001 });

export const STATUS_ORDER = ['changed', 'error', 'new', 'updated', 'same'];
const FAILING = new Set(['changed', 'error']);

function numberIn(raw, fallback, name) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`visual: ${name}=${raw} must be a number from 0 to 1`);
  return n;
}

/** The two knobs, read from env with defaults. Throws on a bad value. */
export function thresholdsFrom(env = process.env) {
  return {
    pixelThreshold: numberIn(env.VISUAL_PIXEL_THRESHOLD, DEFAULTS.pixelThreshold, 'VISUAL_PIXEL_THRESHOLD'),
    maxDiffRatio: numberIn(env.VISUAL_MAX_DIFF_RATIO, DEFAULTS.maxDiffRatio, 'VISUAL_MAX_DIFF_RATIO'),
  };
}

/**
 * Judge one comparison.
 *
 * @param {object} c
 * @param {boolean} c.hasBaseline
 * @param {boolean} [c.sizeMismatch]  baseline and shot have different dimensions
 * @param {number}  [c.diffPixels]
 * @param {number}  [c.totalPixels]
 * @param {number}  maxDiffRatio
 * @returns {{status:string, ratio:number|null, reason:string}}
 */
export function judge(c, maxDiffRatio = DEFAULTS.maxDiffRatio) {
  if (!c.hasBaseline) return { status: 'new', ratio: null, reason: 'no baseline yet' };
  if (c.sizeMismatch) return { status: 'changed', ratio: 1, reason: 'the image size changed' };
  const total = Number(c.totalPixels) || 0;
  const diff = Number(c.diffPixels) || 0;
  const ratio = total > 0 ? diff / total : 0;
  if (ratio > maxDiffRatio) {
    return { status: 'changed', ratio, reason: `${formatPercent(ratio)} of the pixels differ (limit ${formatPercent(maxDiffRatio)})` };
  }
  return { status: 'same', ratio, reason: diff ? `${diff} pixels differ, under the limit` : 'identical' };
}

/** 0.0123 -> "1.23%", 0.00004 -> "0.004%". */
export function formatPercent(ratio) {
  const p = ratio * 100;
  if (p === 0) return '0%';
  if (p >= 1) return `${p.toFixed(2)}%`;
  return `${Number(p.toPrecision(2))}%`;
}

/**
 * Counts per status and the run's exit code.
 *
 * @param {Array<{status:string}>} results
 * @param {object} [o]
 * @param {boolean} [o.fontsOk=true]  the vendored fonts loaded; a run without
 *                                    them compares fallback letterforms and fails
 */
export function summarize(results, { fontsOk = true } = {}) {
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const failing = results.filter((r) => FAILING.has(r.status)).length;
  return { counts, total: results.length, failing, exitCode: failing > 0 || !fontsOk ? 1 : 0 };
}

/** Results sorted the way a reviewer wants to read them: problems first. */
export function sortForReport(results) {
  const rank = (s) => {
    const i = STATUS_ORDER.indexOf(s);
    return i === -1 ? STATUS_ORDER.length : i;
  };
  return results.slice().sort((a, b) => rank(a.status) - rank(b.status) || String(a.name).localeCompare(String(b.name)));
}
