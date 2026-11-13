/* ---------------- ATO-1138: dashboard templates (chart, table, cards) ----------------
   The window's own small chart library: no dependency, no network, no script
   in the page it makes. dashboardHtml(spec, theme) answers a whole page for
   the sandboxed artifact frame (chat-artifact.js): inline SVG charts, a
   table, KPI cards, every text escaped, light or dark.

   The spec is canvas.render's own argument shape (ATO-1137), so the same data
   draws the same chart on either side:
     {type | chart: 'line'|'bar'|'area'|'pie'|'table'|'cards', title, subtitle?,
      labels: [...], series: [{name, values: [...]}] | values: [...]}
   and the shorter `{type, title, data}`, where `data` holds the rest:
     line / bar / area / pie: data = {labels, series | values}
     table:  data = {columns: [...], rows: [[...], ...]} or [{col: value, ...}, ...]
             (or labels + series: a row per label, a column per series)
     cards:  data = [{label, value, delta?, note?}, ...]  (or `cards`: the same list)

   Where it is used: a ```chart block (its JSON is such a spec) gets Preview,
   like a ```html block, and draws through this. Loaded before renderer.js;
   only declares; exported for test/dashboard-templates.test.mjs. */

const DASH_TYPES = ['line', 'bar', 'area', 'pie', 'table', 'cards'];
const DASH_PALETTE = ['#4f7cff', '#f2994a', '#27ae60', '#eb5757', '#9b51e0', '#2d9cdb', '#f2c94c', '#828282'];
const DASH_W = 720, DASH_H = 340;
const DASH_PAD = {top: 16, right: 16, bottom: 48, left: 60};
const DASH_MAX_POINTS = 1000, DASH_MAX_SERIES = 8, DASH_MAX_ROWS = 2000, DASH_MAX_CARDS = 24;

function dashEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

/** A number from a model's data: 12, "1,200", "42%"; null for anything else. */
function dashNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^\s*-?\d[\d,]*(\.\d+)?\s*%?\s*$/.test(v)) {
    const n = Number(v.replace(/[,%\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function dashFmt(v) {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  if (a >= 1e9) return +(v / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return +(v / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return +(v / 1e3).toFixed(1) + 'K';
  return String(+v.toFixed(2));
}

const DASH_MAX_TICKS = 50;
const DASH_TOO_BIG = 'The numbers are too large to draw as a chart. Use a table, or scale them down.';

/**
 * Axis bounds and step: 0..87 → 0..100 by 20. Always includes 0. null when
 * the range cannot be drawn (1.7e308 rounds up to Infinity, a step of 0), so
 * no tick loop is ever built on a range it cannot walk.
 */
function dashScale(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  let lo = Math.min(0, min), hi = Math.max(0, max);
  if (lo === hi) hi = lo + 1;
  if (!Number.isFinite(hi - lo)) return null;
  const raw = (hi - lo) / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) || raw;
  if (!Number.isFinite(step) || !(step > 0)) return null;
  const out = {lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step};
  if (!Number.isFinite(out.hi - out.lo) || !(out.hi > out.lo)) return null;
  return out;
}

/**
 * The spec, checked and flattened: {ok:true, type, title, subtitle, labels, series, columns, rows, cards}
 * or {ok:false, error} with words for the person.
 */
function dashNormalize(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return {ok: false, error: 'The chart data is not an object.'};
  const d = spec.data;
  const src = d && typeof d === 'object' && !Array.isArray(d) ? Object.assign({}, spec, d) : spec;
  const type = String(src.type || src.chart || '').trim().toLowerCase();
  if (!DASH_TYPES.includes(type)) return {ok: false, error: 'Unknown chart type. Use one of: ' + DASH_TYPES.join(', ') + '.'};
  const out = {ok: true, type, title: String(src.title || '').slice(0, 200), subtitle: String(src.subtitle || '').slice(0, 300),
    labels: [], series: [], columns: [], rows: [], cards: []};
  if (type === 'cards') {
    const list = Array.isArray(d) ? d : Array.isArray(src.cards) ? src.cards : Array.isArray(src.items) ? src.items : null;
    if (!list || !list.length) return {ok: false, error: 'Cards need a list of {label, value}.'};
    out.cards = list.slice(0, DASH_MAX_CARDS).filter((c) => c && typeof c === 'object').map((c) => ({
      label: String(c.label != null ? c.label : c.name != null ? c.name : ''), value: c.value == null ? '' : String(c.value),
      delta: c.delta == null ? '' : String(c.delta), note: c.note == null ? '' : String(c.note)}));
    return out.cards.length ? out : {ok: false, error: 'Cards need a list of {label, value}.'};
  }
  if (type === 'table') {
    if (Array.isArray(d) && d.length && d[0] && typeof d[0] === 'object' && !Array.isArray(d[0])) {
      out.columns = Object.keys(d[0]).slice(0, 50);
      out.rows = d.slice(0, DASH_MAX_ROWS).map((r) => out.columns.map((k) => (r && r[k] != null ? r[k] : '')));
      return out;
    }
    if (Array.isArray(src.columns) && Array.isArray(src.rows)) {
      out.columns = src.columns.slice(0, 50).map(String);
      out.rows = src.rows.slice(0, DASH_MAX_ROWS).map((r) => (Array.isArray(r) ? r.slice(0, out.columns.length) : [r]));
      return out;
    }
  }
  if (!Array.isArray(src.labels) || !src.labels.length) return {ok: false, error: 'The chart needs `labels`: one per data point.'};
  out.labels = src.labels.slice(0, DASH_MAX_POINTS).map((l) => String(l == null ? '' : l));
  const raw = Array.isArray(src.series) && src.series.length ? src.series
    : Array.isArray(src.values) ? [{name: 'Value', values: src.values}] : null;
  if (!raw) return {ok: false, error: 'The chart needs its numbers: `series` [{name, values}] or `values`.'};
  out.series = raw.slice(0, DASH_MAX_SERIES).map((s, i) => {
    const r = s && typeof s === 'object' ? s : {};
    const vals = Array.isArray(r.values) ? r.values : [];
    return {name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : 'Series ' + (i + 1),
      values: out.labels.map((_, j) => dashNum(vals[j]))};
  });
  if (type === 'table') {
    out.columns = [''].concat(out.series.map((s) => s.name));
    out.rows = out.labels.map((l, j) => [l].concat(out.series.map((s) => (s.values[j] == null ? '' : s.values[j]))));
  }
  return out;
}

function dashAxes(n, lo, hi, step, xAt) {
  const plotH = DASH_H - DASH_PAD.top - DASH_PAD.bottom;
  const y = (v) => DASH_PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const parts = [];
  for (let v = lo, i = 0; v <= hi + step / 2 && i < DASH_MAX_TICKS; v += step, i++) {
    const yy = y(v).toFixed(1);
    parts.push('<line class="grid" x1="' + DASH_PAD.left + '" x2="' + (DASH_W - DASH_PAD.right) + '" y1="' + yy + '" y2="' + yy + '"/>'
      + '<text class="tick" x="' + (DASH_PAD.left - 8) + '" y="' + yy + '" text-anchor="end" dominant-baseline="middle">' + dashEsc(dashFmt(v)) + '</text>');
  }
  return {svg: parts.join(''), y, every: Math.max(1, Math.ceil(n / 12)), xAt};
}

function dashXLabels(labels, every, xAt) {
  return labels.map((l, i) => (i % every ? '' : '<text class="tick" x="' + xAt(i).toFixed(1) + '" y="' + (DASH_H - DASH_PAD.bottom + 18)
    + '" text-anchor="middle">' + dashEsc(l.length > 14 ? l.slice(0, 13) + '…' : l) + '</text>')).join('');
}

function dashRange(series) {
  const all = [];
  series.forEach((s) => s.values.forEach((v) => { if (v != null) all.push(v); }));
  return all.length ? {min: Math.min.apply(null, all), max: Math.max.apply(null, all)} : {min: 0, max: 1};
}

function dashBar(c) {
  const {min, max} = dashRange(c.series);
  const sc = dashScale(min, max);
  if (!sc) return null;
  const {lo, hi, step} = sc;
  const plotW = DASH_W - DASH_PAD.left - DASH_PAD.right;
  const slot = plotW / c.labels.length;
  const xAt = (i) => DASH_PAD.left + slot * (i + 0.5);
  const ax = dashAxes(c.labels.length, lo, hi, step, xAt);
  const bw = Math.max(1, (slot * 0.8) / c.series.length);
  const bars = [];
  c.series.forEach((s, k) => s.values.forEach((v, i) => {
    if (v == null) return;
    const x = DASH_PAD.left + slot * i + slot * 0.1 + bw * k;
    const y0 = ax.y(Math.max(0, v)), y1 = ax.y(Math.min(0, v));
    bars.push('<rect x="' + x.toFixed(1) + '" y="' + y0.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0.5, y1 - y0).toFixed(1)
      + '" fill="' + DASH_PALETTE[k % DASH_PALETTE.length] + '" rx="2"><title>' + dashEsc(c.labels[i] + ' · ' + s.name + ': ' + v) + '</title></rect>');
  }));
  return ax.svg + bars.join('') + dashXLabels(c.labels, ax.every, xAt);
}

function dashLine(c, area) {
  const {min, max} = dashRange(c.series);
  const sc = dashScale(min, max);
  if (!sc) return null;
  const {lo, hi, step} = sc;
  const plotW = DASH_W - DASH_PAD.left - DASH_PAD.right;
  const xAt = (i) => DASH_PAD.left + (c.labels.length === 1 ? plotW / 2 : (plotW * i) / (c.labels.length - 1));
  const ax = dashAxes(c.labels.length, lo, hi, step, xAt);
  const out = [];
  c.series.forEach((s, k) => {
    const col = DASH_PALETTE[k % DASH_PALETTE.length];
    const pts = s.values.map((v, i) => (v == null ? null : [xAt(i), ax.y(v)])).filter(Boolean);
    if (!pts.length) return;
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    if (area) {
      const base = ax.y(Math.max(lo, Math.min(0, hi))).toFixed(1);
      out.push('<path d="' + d + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + base + ' L' + pts[0][0].toFixed(1) + ' ' + base + ' Z" fill="' + col + '" fill-opacity=".18" stroke="none"/>');
    }
    out.push('<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');
    if (pts.length <= 60) s.values.forEach((v, i) => {
      if (v == null) return;
      out.push('<circle cx="' + xAt(i).toFixed(1) + '" cy="' + ax.y(v).toFixed(1) + '" r="3" fill="' + col + '"><title>'
        + dashEsc(c.labels[i] + ' · ' + s.name + ': ' + v) + '</title></circle>');
    });
  });
  return ax.svg + out.join('') + dashXLabels(c.labels, ax.every, xAt);
}

function dashPie(c) {
  const vals = (c.series[0] ? c.series[0].values : []).map((v) => (v != null && v > 0 ? v : 0));
  const total = vals.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total)) return null;
  if (!total) return '<text class="tick" x="' + DASH_W / 2 + '" y="' + DASH_H / 2 + '" text-anchor="middle">No values above zero.</text>';
  const cx = DASH_H / 2, cy = DASH_H / 2, r = DASH_H / 2 - 12;
  let a0 = -Math.PI / 2;
  const parts = [], legend = [];
  vals.forEach((v, i) => {
    if (!v) return;
    const col = DASH_PALETTE[i % DASH_PALETTE.length];
    const tip = '<title>' + dashEsc(c.labels[i] + ': ' + v + ' (' + Math.round((v / total) * 100) + '%)') + '</title>';
    if (v === total) parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + col + '">' + tip + '</circle>');
    else {
      const a1 = a0 + (v / total) * Math.PI * 2;
      const p = (a) => (cx + r * Math.cos(a)).toFixed(1) + ' ' + (cy + r * Math.sin(a)).toFixed(1);
      parts.push('<path d="M' + cx + ' ' + cy + ' L' + p(a0) + ' A' + r + ' ' + r + ' 0 ' + (a1 - a0 > Math.PI ? 1 : 0) + ' 1 ' + p(a1) + ' Z" fill="' + col + '">' + tip + '</path>');
      a0 = a1;
    }
    if (legend.length < 12) {
      const ly = 24 + legend.length * 22;
      legend.push('<rect x="' + (DASH_H + 24) + '" y="' + (ly - 9) + '" width="12" height="12" rx="3" fill="' + col + '"/>'
        + '<text class="tick" x="' + (DASH_H + 44) + '" y="' + ly + '" dominant-baseline="middle">' + dashEsc(c.labels[i] + '  ' + Math.round((v / total) * 100) + '%') + '</text>');
    }
  });
  return parts.join('') + legend.join('');
}

function dashLegend(series) {
  if (series.length < 2) return '';
  return '<div class="legend">' + series.map((s, k) => '<span><i style="background:' + DASH_PALETTE[k % DASH_PALETTE.length] + '"></i>' + dashEsc(s.name) + '</span>').join('') + '</div>';
}

function dashTable(c) {
  const cell = (v) => {
    const n = typeof v === 'number' ? v : null;
    return '<td' + (n != null ? ' class="num"' : '') + '>' + dashEsc(v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v) + '</td>';
  };
  return '<div class="tbl"><table><thead><tr>' + c.columns.map((h) => '<th>' + dashEsc(h) + '</th>').join('') + '</tr></thead><tbody>'
    + c.rows.map((r) => '<tr>' + r.map(cell).join('') + '</tr>').join('') + '</tbody></table></div>';
}

function dashCards(c) {
  return '<div class="cards">' + c.cards.map((k) => {
    const neg = /^\s*[-−]/.test(k.delta);
    return '<div class="kpi"><div class="kpi-l">' + dashEsc(k.label) + '</div><div class="kpi-v">' + dashEsc(k.value) + '</div>'
      + (k.delta ? '<div class="kpi-d ' + (neg ? 'down' : 'up') + '">' + dashEsc(k.delta) + '</div>' : '')
      + (k.note ? '<div class="kpi-n">' + dashEsc(k.note) + '</div>' : '') + '</div>';
  }).join('') + '</div>';
}

const DASH_CSS = ':root{--bg:#fff;--ink:#101112;--ink2:#575b60;--line:#e3e5e7;--card:#f4f5f6;--up:#136c33;--down:#c4342f;color-scheme:light}'
  + ':root[data-theme=dark]{--bg:#0e0f10;--ink:#edeff1;--ink2:#9aa0a6;--line:#2a2e32;--card:#17191b;--up:#5edb81;--down:#ff6a5c;color-scheme:dark}'
  + '@media (prefers-color-scheme:dark){:root:not([data-theme]){--bg:#0e0f10;--ink:#edeff1;--ink2:#9aa0a6;--line:#2a2e32;--card:#17191b;--up:#5edb81;--down:#ff6a5c;color-scheme:dark}}'
  + '*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}'
  + 'body{padding:14px 16px}h1{font-size:15px;margin:0 0 2px;font-weight:600}.sub{color:var(--ink2);margin:0 0 10px}'
  + 'svg{display:block;width:100%;height:auto}.grid{stroke:var(--line);stroke-width:1}.tick{fill:var(--ink2);font-size:11px}'
  + '.legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:6px;color:var(--ink2)}.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}'
  + '.tbl{overflow:auto;max-height:520px}table{border-collapse:collapse;width:100%}th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}'
  + 'th{color:var(--ink2);font-weight:600;position:sticky;top:0;background:var(--bg)}td.num{text-align:right;font-variant-numeric:tabular-nums}'
  + '.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}.kpi{background:var(--card);border-radius:12px;padding:12px 14px}'
  + '.kpi-l{color:var(--ink2);font-size:12px}.kpi-v{font-size:22px;font-weight:600;margin-top:2px;font-variant-numeric:tabular-nums}'
  + '.kpi-d{font-size:12px;margin-top:2px}.kpi-d.up{color:var(--up)}.kpi-d.down{color:var(--down)}.kpi-n{color:var(--ink2);font-size:12px;margin-top:4px}'
  + '.err{color:var(--down)}';

/**
 * A whole page for the artifact frame. `theme`: 'light' | 'dark' (the
 * window's), anything else follows the page's own colour scheme. No script.
 */
function dashHead(title, theme) {
  const th = theme === 'dark' || theme === 'light' ? ' data-theme="' + theme + '"' : '';
  return '<html lang="en"' + th + '><head><meta charset="utf-8"><title>' + dashEsc(title || 'Chart') + '</title><style>' + DASH_CSS + '</style></head><body>';
}
function dashErrorPage(msg, theme) { return dashHead('Chart', theme) + '<p class="err">' + dashEsc(msg) + '</p></body></html>'; }

function dashboardHtml(spec, theme) {
  const c = dashNormalize(spec);
  if (!c.ok) return dashErrorPage(c.error, theme);
  const head = dashHead(c.title, theme);
  let body = '';
  if (c.type === 'cards') body = dashCards(c);
  else if (c.type === 'table') body = dashTable(c);
  else {
    const svg = c.type === 'bar' ? dashBar(c) : c.type === 'pie' ? dashPie(c) : dashLine(c, c.type === 'area');
    if (svg == null) return dashErrorPage(DASH_TOO_BIG, theme);
    body = '<svg viewBox="0 0 ' + DASH_W + ' ' + DASH_H + '" role="img" aria-label="' + dashEsc(c.title || c.type + ' chart') + '">' + svg + '</svg>'
      + (c.type === 'pie' ? '' : dashLegend(c.series));
  }
  return head + (c.title ? '<h1>' + dashEsc(c.title) + '</h1>' : '') + (c.subtitle ? '<p class="sub">' + dashEsc(c.subtitle) + '</p>' : '')
    + body + '</body></html>';
}

/** A ```chart block's text → its page (a page that says what is wrong when the JSON is not a spec). */
function dashboardFromJson(text, theme) {
  let spec;
  try { spec = JSON.parse(String(text || '')); } catch (e) { return dashErrorPage('This chart block is not valid JSON.', theme); }
  return dashboardHtml(spec, theme);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {DASH_TYPES, DASH_PALETTE, dashEsc, dashNum, dashFmt, dashScale, dashNormalize, dashboardHtml, dashboardFromJson};
}
