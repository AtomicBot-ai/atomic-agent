/* ---------------- ATO-2442: Settings › Usage ----------------
   Loaded BEFORE renderer.js, so it only declares: everything it touches
   (BR, S, esc, ic, render, settingsPaneId, paneRepaintKeepFocus, segControl,
   dashNormalize, dashBar, dashLegend, DASH_W, DASH_H) is read when a
   function runs, never at load time.

   The agent's usage report (GET /api/usage, the same figures as
   `atomic-agent usage --models --tools --projects`), read through
   main/usage-ipc.ts: tokens per day as a bar chart (dashboard-templates.js),
   cloud cost, chats per day, "saved by local" (an estimate, priced at a
   cloud model's list prices) and tables by model, tool and project.

   Like OpenCode `stats`, `ccusage daily` and Claude Code's `/usage`. */

const US = {
  days: 7,         // 7 | 30 | 'all'
  compare: '',     // the model "saved by local" is priced at; '' = the agent's default
  data: null,      // the last report
  err: null,       // {error, detail} from the last call
  loading: false,
  seq: 0,          // the newest call; older answers are dropped
};

const US_INTRO = 'Tokens and cost per day over every chat on this computer, by model, tool and project. Local models cost nothing to run; "Saved by local" is a rough estimate of what the same tokens would cost on a cloud model.';
const US_PERIODS = [['7', '7 days'], ['30', '30 days'], ['all', 'All']];

/* ---- pure helpers (exported for test/usage-tab.test.mjs) ---- */

/** 1234 → "1.2k", 3000000 → "3.0M". */
function usTok(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v));
}

/** "$0.75", "$0.003" under a cent, "$0" for nothing. */
function usUsd(n) {
  const v = Number(n) || 0;
  if (v === 0) return '$0';
  if (v < 0.01) return '$' + Number(v.toFixed(4));
  return '$' + v.toFixed(2);
}

function usShare(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 100) + '%' : '-';
}

/** A cost cell: "$1.20", "$1.20+" when some calls had no price, "n/a" when none did, "-" for no cloud calls. */
function usCost(t) {
  if (!t) return '-';
  if (t.pricedCalls > 0) return usUsd(t.usd) + (t.unpricedCalls > 0 ? '+' : '');
  return t.unpricedCalls > 0 ? 'n/a' : '-';
}

/** `days:30` → 30, `days:all` → 'all'; null for anything else. */
function usParseDays(arg) {
  if (arg === 'all') return 'all';
  const n = Number(arg);
  return n === 7 || n === 30 ? n : null;
}

/** The days' models summed over the window, most tokens first. */
function usModels(days) {
  const by = new Map();
  (days || []).forEach((d) => (d.models || []).forEach((m) => {
    const key = m.billing + '\u0000' + m.providerId + '\u0000' + m.model;
    const t = by.get(key) || {billing: m.billing, providerId: m.providerId, model: m.model, calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, pricedCalls: 0, unpricedCalls: 0};
    t.calls += m.calls || 0; t.inputTokens += m.inputTokens || 0; t.outputTokens += m.outputTokens || 0;
    t.usd += m.usd || 0; t.pricedCalls += m.pricedCalls || 0; t.unpricedCalls += m.unpricedCalls || 0;
    by.set(key, t);
  }));
  return [...by.values()].sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
}

/** The chart's spec: tokens per day, one series per kind of model that served any. */
function usChartSpec(days) {
  const list = days || [];
  const kinds = [['localTokens', 'Local'], ['cloudTokens', 'Cloud'], ['planTokens', 'Plan']]
    .filter(([k]) => list.some((d) => (d[k] || 0) > 0));
  if (!list.length || !kinds.length) return null;
  return {type: 'bar', labels: list.map((d) => String(d.day).slice(5)),
    series: kinds.map(([k, name]) => ({name, values: list.map((d) => d[k] || 0)}))};
}

/** The "Saved by local" card: {value, note}. */
function usSavedText(saved) {
  const s = saved || {status: 'none'};
  if (s.status === 'estimate' && s.reference) {
    const r = s.reference;
    return {value: 'About ' + usUsd(s.usd),
      note: 'Estimate: the ' + usTok((s.localInputTokens || 0) + (s.localOutputTokens || 0)) + ' local tokens at ' + r.provider + '/' + r.model
        + ' list prices. Another model would not use the same tokens, so it is a rough figure.'};
  }
  if (s.status === 'unknown') {
    return {value: 'Unknown', note: s.requested ? 'The built-in price list has no price for ' + s.requested + '.' : 'No cloud price to compare the local tokens with.'};
  }
  return {value: '-', note: 'Nothing ran on a local model in this period.'};
}

/* ---- reading ---- */

function usBridge() { return typeof BR !== 'undefined' && BR && typeof BR.usageReport === 'function' ? BR : null; }

function usVisible() {
  return typeof S !== 'undefined' && !!S.settings && typeof settingsPaneId === 'function' && settingsPaneId(S.settingsPane) === 'usage';
}

function usRepaint() {
  if (!usVisible()) return;
  if (typeof paneRepaintKeepFocus === 'function') paneRepaintKeepFocus(usageTab()); else render();
}

async function usRefresh() {
  const br = usBridge();
  if (!br) { US.err = {error: 'Usage needs the desktop app.', detail: ''}; usRepaint(); return; }
  const seq = ++US.seq;
  US.loading = true; US.err = null;
  usRepaint();
  let answer;
  try {
    answer = await br.usageReport({days: US.days, compare: US.compare || null});
  } catch (e) {
    answer = {ok: false, error: 'Could not read usage from the agent. Try again in a moment.', detail: String((e && e.message) || e)};
  }
  if (seq !== US.seq) return;
  US.loading = false;
  if (answer && answer.ok && answer.data && typeof answer.data === 'object') { US.data = answer.data; US.err = null; }
  else US.err = {error: (answer && answer.error) || 'Could not read usage from the agent.', detail: (answer && answer.detail) || ''};
  usRepaint();
}

function usageTabEntered() { usRefresh(); }

function usageAct(what) {
  const s = String(what || '');
  const i = s.indexOf(':');
  const verb = i === -1 ? s : s.slice(0, i), arg = i === -1 ? '' : s.slice(i + 1);
  if (verb === 'refresh') { usRefresh(); return; }
  if (verb === 'days') {
    const d = usParseDays(arg);
    if (d === null || d === US.days) return;
    US.days = d; US.data = null; usRefresh();
    return;
  }
  if (verb === 'compare') {
    const box = typeof document !== 'undefined' ? document.querySelector('[data-uscompare]') : null;
    const name = box ? String(box.value || '').trim().slice(0, 200) : '';
    if (name === US.compare) return;
    US.compare = name; usRefresh();
    return;
  }
  if (verb === 'compareClear') { if (US.compare) { US.compare = ''; usRefresh(); } }
}

/* Enter in the model box prices "saved by local" at that model. */
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('keydown', (ev) => {
    const t = ev.target;
    if (!t || !t.dataset || t.dataset.uscompare === undefined || ev.key !== 'Enter') return;
    ev.preventDefault();
    usageAct('compare');
  }, true);
}

/* ---- drawing ---- */

function usCard(label, value, note) {
  return '<div class="tk-card pad us-card"><span class="us-card-l">' + esc(label) + '</span><span class="us-card-v">' + esc(value) + '</span>'
    + (note ? '<span class="us-card-n">' + esc(note) + '</span>' : '') + '</div>';
}

function usTable(label, head, rows) {
  if (!rows.length) return '';
  return '<h4 class="set-plgtitle us-sub">' + esc(label) + '</h4><div class="tk-list us-tblwrap"><table class="tk-tbl us-tbl" aria-label="' + esc(label) + '"><thead><tr>'
    + head.map((h, i) => '<th' + (i ? ' class="num"' : '') + '>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>'
    + rows.map((r) => '<tr>' + r.map((c, i) => '<td' + (i ? ' class="num"' : '') + '>' + esc(c) + '</td>').join('') + '</tr>').join('')
    + '</tbody></table></div>';
}

function usChart(days) {
  const spec = usChartSpec(days);
  if (!spec || typeof dashNormalize !== 'function' || typeof dashBar !== 'function') return '';
  const c = dashNormalize(spec);
  const inner = c.ok ? dashBar(c) : null;
  if (!inner) return '';
  return '<div class="tk-card pad us-chartcard"><svg class="us-chart" viewBox="0 0 ' + DASH_W + ' ' + DASH_H + '" role="img" aria-label="Tokens per day">' + inner + '</svg>'
    + (typeof dashLegend === 'function' ? dashLegend(c.series) : '') + '</div>';
}

function usBody(d) {
  const days = Array.isArray(d.days) ? d.days : [];
  if (!days.length) {
    const p = US.days === 'all' ? 'No model calls are recorded yet. When you chat with the agent, tokens and cost per day show up here.'
      : 'No model calls in the last ' + US.days + ' days. Pick All to see older days.';
    return '<div class="tk-empty set-empty us-empty"><span class="tk-ico tk-ico--lg">' + ic('barchart') + '</span><h4>No usage yet</h4><p>' + esc(p) + '</p></div>';
  }
  const t = d.total || {};
  const tokens = (t.localTokens || 0) + (t.cloudTokens || 0) + (t.planTokens || 0);
  const saved = usSavedText(d.savedByLocal);
  const cards = '<div class="us-cards">'
    + usCard('Tokens', usTok(tokens), usTok(t.inputTokens) + ' in, ' + usTok(t.outputTokens) + ' out')
    + usCard('Local share', usShare(t.localTokens || 0, tokens), usTok(t.localTokens) + ' tokens on local models')
    + usCard('Cloud cost', usCost(t), t.unpricedCalls > 0 ? 'Some calls had no known price.' : '')
    + usCard('Saved by local', saved.value, saved.note)
    + usCard('Chats', d.sessions == null ? '-' : String(d.sessions), d.sessions == null ? 'Counted from this version on.' : '')
    + '</div>';
  const compare = '<div class="us-compare"><label class="us-compare-l" for="us-compare">Price local tokens at</label>'
    + '<input class="tk-inp us-compare-in" id="us-compare" data-uscompare value="' + esc(US.compare) + '" maxlength="200" placeholder="the default cheap cloud model, or provider/model">'
    + '<button class="btn btn-s sm" data-act="usage:compare">Apply</button>'
    + (US.compare ? '<button class="btn btn-s sm" data-act="usage:compareClear">Use default</button>' : '') + '</div>';
  const dayRows = days.slice().reverse().map((x) => [x.day, String(x.calls || 0), usTok(x.inputTokens), usTok(x.outputTokens),
    usShare(x.localTokens || 0, (x.localTokens || 0) + (x.cloudTokens || 0) + (x.planTokens || 0)), usCost(x), x.sessions == null ? '-' : String(x.sessions)]);
  const modelRows = usModels(days).map((m) => [m.providerId + '/' + m.model + (m.billing === 'local' ? ' (local)' : m.billing === 'plan' ? ' (plan)' : ''),
    String(m.calls), usTok(m.inputTokens), usTok(m.outputTokens), m.billing === 'cloud' ? usCost(m) : '-']);
  const toolRows = (d.tools || []).map((x) => [x.tool, String(x.calls), x.errors > 0 ? String(x.errors) : '-', Math.round((x.share || 0) * 100) + '%']);
  const projRows = (d.projects || []).map((x) => [x.label, String(x.calls), usTok(x.inputTokens), usTok(x.outputTokens),
    usShare(x.localTokens || 0, (x.localTokens || 0) + (x.cloudTokens || 0) + (x.planTokens || 0)), usCost(x)]);
  const from = d.breakdownCountedFrom && days[0] && days[0].day < d.breakdownCountedFrom
    ? '<p class="us-foot">Tools and projects are counted from ' + esc(d.breakdownCountedFrom) + '; earlier days were recorded without this split.</p>' : '';
  return cards + compare + usChart(days)
    + usTable('Days', ['Day', 'Calls', 'Input', 'Output', 'Local', 'Cloud cost', 'Chats'], dayRows)
    + usTable('Models', ['Model', 'Calls', 'Input', 'Output', 'Cloud cost'], modelRows)
    + usTable('Tools', ['Tool', 'Calls', 'Errors', 'Share'], toolRows)
    + usTable('Projects', ['Project', 'Calls', 'Input', 'Output', 'Local', 'Cloud cost'], projRows)
    + from;
}

function usageTab() {
  const about = '<div class="mf-about"><p class="mf-intro">' + esc(US_INTRO) + '</p></div>';
  const period = typeof segControl === 'function' ? segControl(US_PERIODS, String(US.days), 'usage:days:') : '';
  const head = '<div class="set-sechead us-head"><h4 class="set-plgtitle">Usage</h4>' + period + '<span class="grow"></span>'
    + '<button class="iconbtn sm" data-act="usage:refresh" title="Refresh" aria-label="Refresh"' + (US.loading ? ' disabled aria-busy="true"><span class="tk-spin"></span>' : '>' + ic('refresh')) + '</button></div>';
  let err = '';
  if (US.err) {
    err = '<div class="tuierr tk-notice tk-notice--red us-note">' + ic('alert') + '<span class="grow">' + esc(US.err.error) + '</span>'
      + '<button class="btn btn-s sm" data-act="usage:refresh">Try again</button></div>'
      + (US.err.detail ? '<details class="us-details"><summary>Details</summary><pre>' + esc(US.err.detail) + '</pre></details>' : '');
  }
  let body;
  if (!US.data) body = US.err ? '' : '<div class="tk-empty set-empty us-empty"><span class="tk-spin"></span><p>reading usage…</p></div>';
  else body = usBody(US.data);
  return '<div class="set-pane mf-pane us-pane">' + about + head + err + body + '</div>';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {US, US_INTRO, usTok, usUsd, usShare, usCost, usParseDays, usModels, usChartSpec, usSavedText, usageAct, usageTab, usageTabEntered};
}
