/**
 * compare.mjs: one baseline PNG against one fresh shot, with pixelmatch.
 *
 * The only file that touches pngjs and pixelmatch (desktop devDependencies),
 * so the pure modules and their unit tests load without them. Writes the
 * red-on-grey difference image pixelmatch draws when anything differs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import pixelmatch from 'pixelmatch';
import pngjs from 'pngjs';

import { judge } from './verdict.mjs';

const { PNG } = pngjs;

function readPng(path) {
  return PNG.sync.read(readFileSync(path));
}

/**
 * @param {object} o
 * @param {string} o.baseline        path of the baseline PNG (may not exist)
 * @param {string} o.actual          path of the fresh shot
 * @param {string} o.diff            where to write the difference image
 * @param {{pixelThreshold:number, maxDiffRatio:number}} o.thresholds
 * @returns {{status:string, ratio:number|null, reason:string, diffPixels:number|null, wroteDiff:boolean}}
 */
export function compareFiles({ baseline, actual, diff, thresholds }) {
  if (!existsSync(baseline)) {
    return { ...judge({ hasBaseline: false }, thresholds.maxDiffRatio), diffPixels: null, wroteDiff: false };
  }
  const a = readPng(baseline);
  const b = readPng(actual);
  if (a.width !== b.width || a.height !== b.height) {
    const v = judge({ hasBaseline: true, sizeMismatch: true }, thresholds.maxDiffRatio);
    return { ...v, reason: `${v.reason}: baseline ${a.width}x${a.height}, now ${b.width}x${b.height}`, diffPixels: null, wroteDiff: false };
  }
  const out = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(a.data, b.data, out.data, a.width, a.height, {
    threshold: thresholds.pixelThreshold,
    includeAA: false,
  });
  const v = judge({ hasBaseline: true, diffPixels, totalPixels: a.width * a.height }, thresholds.maxDiffRatio);
  let wroteDiff = false;
  if (diffPixels > 0) {
    mkdirSync(dirname(diff), { recursive: true });
    writeFileSync(diff, PNG.sync.write(out));
    wroteDiff = true;
  }
  return { ...v, diffPixels, wroteDiff };
}
