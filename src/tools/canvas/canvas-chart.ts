/**
 * The page `canvas.render` writes for a chart (ATO-1137): one HTML file
 * that needs nothing else, no script from a CDN and no network, so it
 * opens the same in the desktop's canvas panel, a browser, or a file
 * sent to Telegram. The chart is inline SVG drawn here; hovering a bar,
 * point or slice shows its value (`<title>`), and the numbers are also
 * listed in a table under the chart.
 */

export const CHART_TYPES = ["bar", "line", "area", "pie", "table"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartSpec {
  type: ChartType;
  labels: string[];
  series: ChartSeries[];
}

/** Colours that read on both a light and a dark page. */
const PALETTE = ["#4f7cff", "#f2994a", "#27ae60", "#eb5757", "#9b51e0", "#2d9cdb", "#f2c94c", "#828282"];

const W = 720;
const H = 360;
const PAD = { top: 16, right: 16, bottom: 56, left: 64 };

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function fmt(value: number): string {
  return numberFormat.format(value);
}

/** Round axis bounds and a tick step: 0..87 becomes 0..100 by 20. */
function niceScale(min: number, max: number): { lo: number; hi: number; step: number } {
  let lo = Math.min(0, min);
  let hi = Math.max(0, max);
  if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / 5;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  return { lo, hi, step };
}

function axes(spec: ChartSpec, lo: number, hi: number, step: number, xAt: (i: number) => number): string {
  const plotH = H - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const parts: string[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) {
    const yy = y(v).toFixed(1);
    parts.push(`<line class="grid" x1="${PAD.left}" x2="${W - PAD.right}" y1="${yy}" y2="${yy}"/>`);
    parts.push(`<text class="tick" x="${PAD.left - 8}" y="${yy}" text-anchor="end" dominant-baseline="middle">${escapeHtml(compactFormat.format(v))}</text>`);
  }
  // At most ~12 x labels, so a long series stays readable.
  const every = Math.max(1, Math.ceil(spec.labels.length / 12));
  spec.labels.forEach((label, i) => {
    if (i % every !== 0) return;
    const short = label.length > 14 ? `${label.slice(0, 13)}…` : label;
    parts.push(`<text class="tick" x="${xAt(i).toFixed(1)}" y="${H - PAD.bottom + 18}" text-anchor="middle">${escapeHtml(short)}</text>`);
  });
  return parts.join("");
}

function barChart(spec: ChartSpec): string {
  const all = spec.series.flatMap((s) => s.values);
  const { lo, hi, step } = niceScale(Math.min(...all), Math.max(...all));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const band = plotW / spec.labels.length;
  const barW = (band * 0.8) / spec.series.length;
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const bars: string[] = [];
  spec.series.forEach((s, si) => {
    s.values.forEach((v, i) => {
      const x = PAD.left + band * i + band * 0.1 + barW * si;
      const top = Math.min(y(v), y(0));
      const height = Math.abs(y(v) - y(0));
      bars.push(
        `<rect class="mark" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, barW - 1).toFixed(1)}" height="${height.toFixed(1)}" fill="${PALETTE[si % PALETTE.length]}">` +
          `<title>${escapeHtml(`${spec.labels[i]} · ${s.name}: ${fmt(v)}`)}</title></rect>`,
      );
    });
  });
  return axes(spec, lo, hi, step, (i) => PAD.left + band * i + band / 2) + bars.join("");
}

function lineChart(spec: ChartSpec, area: boolean): string {
  const all = spec.series.flatMap((s) => s.values);
  const { lo, hi, step } = niceScale(Math.min(...all), Math.max(...all));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const n = spec.labels.length;
  const x = (i: number) => PAD.left + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const marks: string[] = [];
  spec.series.forEach((s, si) => {
    const colour = PALETTE[si % PALETTE.length];
    const points = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    if (area) {
      const base = y(Math.max(lo, 0)).toFixed(1);
      marks.push(`<polygon class="area" points="${x(0).toFixed(1)},${base} ${points.join(" ")} ${x(n - 1).toFixed(1)},${base}" fill="${colour}"/>`);
    }
    marks.push(`<polyline class="line" points="${points.join(" ")}" stroke="${colour}"/>`);
    s.values.forEach((v, i) => {
      marks.push(
        `<circle class="mark" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4" fill="${colour}">` +
          `<title>${escapeHtml(`${spec.labels[i]} · ${s.name}: ${fmt(v)}`)}</title></circle>`,
      );
    });
  });
  return axes(spec, lo, hi, step, x) + marks.join("");
}

/** A donut of the first series; negative values cannot be a slice and are left out. */
function pieChart(spec: ChartSpec): string {
  const values = spec.series[0]!.values.map((v) => Math.max(0, v));
  const total = values.reduce((sum, v) => sum + v, 0);
  const cx = W / 2;
  const cy = H / 2;
  const r = H / 2 - 24;
  const inner = r * 0.55;
  if (total === 0) return `<text class="tick" x="${cx}" y="${cy}" text-anchor="middle">No positive values to draw</text>`;
  const slices: string[] = [];
  let angle = -Math.PI / 2;
  values.forEach((v, i) => {
    if (v === 0) return;
    const share = v / total;
    const label = escapeHtml(`${spec.labels[i]}: ${fmt(v)} (${(share * 100).toFixed(1)}%)`);
    const colour = PALETTE[i % PALETTE.length];
    if (share >= 0.9999) {
      slices.push(`<circle class="mark" cx="${cx}" cy="${cy}" r="${(r + inner) / 2}" fill="none" stroke="${colour}" stroke-width="${r - inner}"><title>${label}</title></circle>`);
      return;
    }
    const end = angle + share * Math.PI * 2;
    const large = share > 0.5 ? 1 : 0;
    const p = (a: number, rad: number) => `${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)}`;
    slices.push(
      `<path class="mark" fill="${colour}" d="M${p(angle, r)} A${r},${r} 0 ${large} 1 ${p(end, r)} L${p(end, inner)} A${inner},${inner} 0 ${large} 0 ${p(angle, inner)} Z"><title>${label}</title></path>`,
    );
    angle = end;
  });
  return slices.join("");
}

function legend(spec: ChartSpec): string {
  const names = spec.type === "pie" ? spec.labels : spec.series.map((s) => s.name);
  if (spec.type !== "pie" && names.length < 2) return "";
  return `<ul class="legend">${names
    .map((name, i) => `<li><span class="swatch" style="background:${PALETTE[i % PALETTE.length]}"></span>${escapeHtml(name)}</li>`)
    .join("")}</ul>`;
}

function dataTable(spec: ChartSpec): string {
  const head = `<tr><th></th>${spec.series.map((s) => `<th>${escapeHtml(s.name)}</th>`).join("")}</tr>`;
  const rows = spec.labels
    .map((label, i) => `<tr><th>${escapeHtml(label)}</th>${spec.series.map((s) => `<td>${fmt(s.values[i]!)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

export const PAGE_STYLE = `:root{color-scheme:light dark;--bg:#ffffff;--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--fg:#f2f2f7;--muted:#a1a1a6;--line:#3a3a3c}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}.subtitle{color:var(--muted);margin:0 0 16px}
svg{width:100%;height:auto;display:block}.grid{stroke:var(--line);stroke-width:1}.tick{fill:var(--muted);font-size:11px}
.line{fill:none;stroke-width:2.5}.area{opacity:.18}.mark{cursor:default;transition:opacity .15s}.mark:hover{opacity:.7}
.legend{list-style:none;display:flex;flex-wrap:wrap;gap:6px 16px;padding:0;margin:8px 0 16px}.swatch{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}
table{border-collapse:collapse;width:100%;margin-top:8px;font-variant-numeric:tabular-nums}th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:right}
th:first-child{text-align:left;font-weight:500}thead th{color:var(--muted);font-weight:500}`;

/** The whole page for a chart: title, optional subtitle, the chart, a legend, the numbers. */
export function renderChartPage(title: string, subtitle: string | undefined, spec: ChartSpec): string {
  let figure = "";
  if (spec.type !== "table") {
    const body = spec.type === "bar" ? barChart(spec) : spec.type === "pie" ? pieChart(spec) : lineChart(spec, spec.type === "area");
    figure = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(title)}">${body}</svg>${legend(spec)}`;
  }
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta name="generator" content="Atomic Agent canvas.render"><title>${escapeHtml(title)}</title>`,
    `<style>${PAGE_STYLE}</style></head><body><main>`,
    `<h1>${escapeHtml(title)}</h1>`,
    subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : "",
    figure,
    dataTable(spec),
    "</main></body></html>",
    "",
  ].join("\n");
}

/**
 * The page for `html` the model wrote: a whole document as it is, a
 * fragment inside the same page frame a chart gets.
 */
export function renderHtmlPage(title: string, subtitle: string | undefined, html: string): string {
  if (/^\s*(<!doctype\s|<html[\s>])/i.test(html)) return html;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta name="generator" content="Atomic Agent canvas.render"><title>${escapeHtml(title)}</title>`,
    `<style>${PAGE_STYLE}</style></head><body><main>`,
    `<h1>${escapeHtml(title)}</h1>`,
    subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : "",
    html,
    "</main></body></html>",
    "",
  ].join("\n");
}
