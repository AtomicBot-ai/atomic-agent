/**
 * report.mjs: the report.html a reviewer opens, built as one string.
 *
 * Pure: takes the results and the run's facts, returns HTML. Image paths
 * are relative to the report (baseline/, actual/, diff/ next to it), so the
 * folder can be zipped as a CI artifact and opened anywhere. The page is
 * self-contained: no scripts, no fonts, no network.
 *
 * The same page is the per-release "what changed visually" summary: the
 * combined run's report.html, changed shots first.
 */

import { formatPercent, sortForReport, STATUS_ORDER, summarize } from './verdict.mjs';
import { variantLabel } from './matrix.mjs';

const LABEL = {
  changed: 'Changed',
  error: 'Could not shoot',
  new: 'New (no baseline)',
  updated: 'Baseline updated',
  same: 'Unchanged',
};

/** Escape for HTML text and attribute values. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function figure(title, src) {
  if (!src) return `<figure class="none"><figcaption>${esc(title)}</figcaption><div class="ph">none</div></figure>`;
  return `<figure><figcaption>${esc(title)}</figcaption><a href="${esc(src)}"><img loading="lazy" src="${esc(src)}" alt="${esc(title)}"></a></figure>`;
}

function row(r) {
  const img = r.images || {};
  const ratio = typeof r.ratio === 'number' ? ` · ${formatPercent(r.ratio)}` : '';
  const variant = r.variant ? variantLabel(r.variant) : '';
  return `<section class="shot s-${esc(r.status)}" id="${esc(r.name)}">
  <h3><span class="tag">${esc(LABEL[r.status] || r.status)}</span> ${esc(r.screen)} · ${esc(r.theme)} · ${esc(variant)}${esc(ratio)}</h3>
  <p class="why">${esc(r.reason || '')}${r.error ? ` <code>${esc(r.error)}</code>` : ''}</p>
  <div class="trio">${figure('Before (baseline)', img.baseline)}${figure('After (this run)', img.actual)}${figure('Difference', img.diff)}</div>
</section>`;
}

/**
 * @param {Array<object>} results  one per shot (see run.mjs)
 * @param {object} meta
 * @param {string} meta.platform
 * @param {string} meta.when        ISO time of the run
 * @param {string} meta.mode        'compare' | 'update'
 * @param {{pixelThreshold:number,maxDiffRatio:number}} meta.thresholds
 * @param {{ok:boolean, detail:string}} [meta.fonts]
 * @param {Array<{id:string,label:string,reason:string}>} [meta.dropped]   screens left out
 * @param {string[]} [meta.unknownScreens]  ids asked for in VISUAL_SCREENS that do not exist
 * @param {string} [meta.version]   app version under test, if known
 */
export function renderReport(results, meta) {
  const fontsOk = meta.fonts ? meta.fonts.ok !== false : true;
  const sum = summarize(results, { fontsOk });
  const counts = STATUS_ORDER.filter((s) => sum.counts[s] > 0)
    .map((s) => `<li class="c-${s}"><b>${sum.counts[s]}</b> ${esc(LABEL[s])}</li>`).join('');
  const verdict = sum.exitCode === 0
    ? '<p class="ok">Nothing over the limit.</p>'
    : `<p class="bad">${sum.failing} shot(s) changed or could not be shot${fontsOk ? '' : ', and the vendored fonts did not load'}.</p>`;

  const warnings = [];
  if (!fontsOk) warnings.push(`The vendored fonts did not load (${esc(meta.fonts.detail || '')}). Every shot uses fallback letterforms; do not take these as baselines.`);
  for (const id of meta.unknownScreens || []) warnings.push(`VISUAL_SCREENS asked for "${esc(id)}", which is not a known screen.`);
  const warn = warnings.length ? `<ul class="warn">${warnings.map((w) => `<li>${w}</li>`).join('')}</ul>` : '';

  const dropped = (meta.dropped || []).length
    ? `<h2>Screens left out</h2><ul class="dropped">${meta.dropped.map((d) => `<li><b>${esc(d.label || d.id)}</b>: ${esc(d.reason)}</li>`).join('')}</ul>`
    : '';

  const shots = sortForReport(results).map(row).join('\n');
  const th = meta.thresholds || {};

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Visual diff report</title>
<style>
:root{--bg:#fafaf8;--fg:#1c1c1a;--mut:#6b6b66;--line:#e3e2dc;--bad:#b42318;--ok:#1f7a3a;--new:#2557a7;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--mut:#9a9993;--line:#2c2c29;--bad:#ff6b5e;--ok:#5cc27e;--new:#7aa7ff;--card:#1e1e1c}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
main{max-width:1400px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}h3{font-size:14px;margin:0 0 4px}
.meta{color:var(--mut);margin:0 0 16px}
.counts{display:flex;flex-wrap:wrap;gap:8px;list-style:none;padding:0;margin:0 0 8px}
.counts li{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:6px 12px}
.c-changed b,.c-error b,.bad{color:var(--bad)}.c-new b{color:var(--new)}.ok,.c-same b,.c-updated b{color:var(--ok)}
.warn{border:1px solid var(--bad);border-radius:8px;padding:8px 8px 8px 28px;color:var(--bad)}
.shot{border-top:1px solid var(--line);padding:16px 0}
.tag{display:inline-block;font-size:12px;border-radius:6px;padding:1px 8px;border:1px solid var(--line)}
.s-changed .tag,.s-error .tag{border-color:var(--bad);color:var(--bad)}.s-new .tag{border-color:var(--new);color:var(--new)}
.why{color:var(--mut);margin:0 0 8px}
.trio{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
@media (max-width:800px){.trio{grid-template-columns:1fr}}
figure{margin:0}figcaption{font-size:12px;color:var(--mut);margin-bottom:4px}
img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:6px;background:var(--card)}
.ph{border:1px dashed var(--line);border-radius:6px;padding:24px;text-align:center;color:var(--mut)}
code{font-size:12px;word-break:break-word}
</style></head>
<body><main>
<h1>Visual diff report</h1>
<p class="meta">${esc(meta.mode === 'update' ? 'Baselines updated' : 'Compared with baselines')} · ${esc(meta.platform)}${meta.version ? ` · app ${esc(meta.version)}` : ''} · ${esc(meta.when)} · ${sum.total} shot(s) · pixel threshold ${esc(th.pixelThreshold)}, changed above ${esc(formatPercent(th.maxDiffRatio ?? 0))}</p>
<ul class="counts">${counts}</ul>
${verdict}
${warn}
${dropped}
<h2>Shots</h2>
${shots || '<p class="meta">No shots were taken.</p>'}
</main></body></html>
`;
}
