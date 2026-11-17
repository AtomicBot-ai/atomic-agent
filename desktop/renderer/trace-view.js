/* ---------------- ATO-639: Settings › Diagnostics' Timeline ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/trace-tree.test.mjs).

   One turn of the open chat as a waterfall, the way trace viewers draw a
   run: a row per turn, step, model call and tool call, the name indented by
   depth, a bar placed by when it started and how long it took against the
   whole turn, and the tokens, cost and error marks beside it. The tree comes
   from main (`cli:traceTree`, main/trace-tree.ts), read from the agent's own
   trace file; nothing is asked of the agent. "Show timeline" reads it on
   demand, Earlier / Later walk the turns, newest first. */

const TRV = {busy: false, err: '', tree: null, sid: '', turn: -1, onChange: null};

/** Rows drawn for one turn; a runaway turn says how many more it had. */
const TRV_MAX_ROWS = 400;
const TRV_KIND_WORD = {turn: 'Turn', step: 'Step', llm: 'Model', tool: 'Tool', event: 'Mark'};

function traceFmtMs(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '—';
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s';
  const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
  return m + 'm ' + (s < 10 ? '0' : '') + s + 's';
}
function traceFmtTokens(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '';
  if (n < 1000) return String(Math.round(n));
  return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
}
function traceFmtCost(usd) {
  if (typeof usd !== 'number' || !isFinite(usd)) return '';
  if (usd === 0) return '$0';
  return '$' + (usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2));
}

/** A turn → its rows in drawing order: {depth, node, left, width} with left/width in % of the turn. */
function traceViewRows(turn, max) {
  const limit = typeof max === 'number' ? max : TRV_MAX_ROWS;
  if (!turn) return {rows: [], more: 0};
  let span = turn.durationMs || 0;
  const walk = (n) => { span = Math.max(span, n.startMs + (n.durationMs || 0)); (n.children || []).forEach(walk); };
  walk(turn);
  if (span <= 0) span = 1;
  const rows = [];
  let more = 0;
  const visit = (n, depth) => {
    if (rows.length >= limit) { more++; } else {
      const left = Math.min(100, Math.max(0, (n.startMs / span) * 100));
      const raw = n.kind === 'event' || n.durationMs == null ? 0 : (n.durationMs / span) * 100;
      const width = n.kind === 'event' ? 0 : Math.min(100 - left, Math.max(0.5, raw));
      rows.push({depth, node: n, left: +left.toFixed(2), width: +width.toFixed(2)});
    }
    (n.children || []).forEach((c) => visit(c, depth + 1));
  };
  visit(turn, 0);
  return {rows, more};
}

/** Tokens, cost and the error/warning mark of one row, as small badges. */
function traceBadgesHTML(n, esc) {
  const out = [];
  if (n.tokensIn != null || n.tokensOut != null) {
    out.push('<span class="trv-badge" title="Tokens in / out' + (n.cachedTokens ? ', ' + n.cachedTokens + ' from cache' : '') + '">'
      + esc(traceFmtTokens(n.tokensIn) || '0') + ' / ' + esc(traceFmtTokens(n.tokensOut) || '0') + '</span>');
  }
  if (n.costUsd != null) out.push('<span class="trv-badge" title="What the provider said it cost">' + esc(traceFmtCost(n.costUsd)) + '</span>');
  if (n.error) out.push('<span class="trv-badge trv-badge--err">' + (n.kind === 'tool' || n.kind === 'event' ? 'error' : 'has errors') + '</span>');
  else if (n.warn) out.push('<span class="trv-badge trv-badge--warn">check</span>');
  return out.join('');
}

function traceRowHTML(r, esc) {
  const n = r.node;
  const cls = 'trv-row trv-row--' + n.kind + (n.error ? ' trv-row--err' : n.warn ? ' trv-row--warn' : '');
  const tip = TRV_KIND_WORD[n.kind] + ': ' + n.name + (n.detail ? '\n' + n.detail : '');
  const bar = n.kind === 'event'
    ? '<span class="trv-mark" style="left:' + r.left + '%"></span>'
    : '<span class="trv-bar" style="left:' + r.left + '%;width:' + r.width + '%"></span>';
  return '<div class="' + cls + '" role="row" title="' + esc(tip) + '">'
    + '<div class="trv-name" role="cell" style="padding-left:' + (r.depth * 14) + 'px">' + esc(n.name) + '</div>'
    + '<div class="trv-track" role="cell">' + bar + '</div>'
    + '<div class="trv-meta" role="cell"><span class="trv-dur">' + (n.kind === 'event' ? '' : esc(traceFmtMs(n.durationMs))) + '</span>'
    + traceBadgesHTML(n, esc) + '</div>'
    + '</div>';
}

/* st: TRV; h: {esc, ic, sessionId}. A tree read for another chat is not shown. */
function traceViewHTML(st, h) {
  const esc = h.esc;
  const sid = h.sessionId || '';
  const tree = st.tree && st.sid === sid ? st.tree : null;
  const head = '<h4 class="set-h">Timeline</h4>'
    + '<p class="set-desc">What the agent did in a turn of this chat: each step, its model calls and tools, how long they took, tokens and cost. Read from the agent’s trace on this computer.</p>';
  if (!tree) {
    return head + '<div class="set-diagacts">'
      + '<button class="btn btn-s sm" data-act="trace:load"' + (sid && !st.busy ? '' : ' disabled')
        + (sid ? '' : ' title="Open a chat first"') + '>' + (st.busy ? 'Reading…' : 'Show timeline') + '</button>'
      + '</div>'
      + (st.err ? '<p class="set-cap set-err">' + esc(st.err) + '</p>' : '');
  }
  const turns = tree.turns || [];
  if (!turns.length) {
    return head + '<p class="set-cap">This chat has no finished steps in its trace yet.</p>'
      + '<div class="set-diagacts"><button class="btn btn-s sm" data-act="trace:load">Refresh</button>'
      + '<button class="btn btn-s sm" data-act="trace:hide">Hide</button></div>';
  }
  const i = st.turn < 0 || st.turn >= turns.length ? turns.length - 1 : st.turn;
  const turn = turns[i];
  const total = turns.length + (tree.omittedTurns || 0);
  const pos = (tree.omittedTurns || 0) + i + 1;
  const facts = ['Turn ' + pos + ' of ' + total, traceFmtMs(turn.durationMs)];
  if (turn.model) facts.push(turn.model);
  if (turn.tokensIn != null || turn.tokensOut != null) facts.push(traceFmtTokens(turn.tokensIn) + ' in / ' + traceFmtTokens(turn.tokensOut) + ' out');
  if (turn.costUsd != null) facts.push(traceFmtCost(turn.costUsd));
  const {rows, more} = traceViewRows(turn);
  return head
    + '<div class="set-diagacts trv-nav">'
      + '<button class="btn btn-s sm" data-act="trace:prev"' + (i > 0 ? '' : ' disabled') + '>Earlier turn</button>'
      + '<button class="btn btn-s sm" data-act="trace:next"' + (i < turns.length - 1 ? '' : ' disabled') + '>Later turn</button>'
      + '<span class="set-cap grow">' + esc(facts.join(' · ')) + '</span>'
      + '<button class="btn btn-s sm" data-act="trace:load"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? 'Reading…' : 'Refresh') + '</button>'
      + '<button class="btn btn-s sm" data-act="trace:hide">Hide</button>'
    + '</div>'
    + (turn.userMessage ? '<p class="set-cap trv-ask" title="' + esc(turn.userMessage) + '">' + esc(turn.userMessage) + '</p>' : '')
    + '<div class="trv" role="table" aria-label="Timeline of turn ' + pos + '">'
      + rows.map((r) => traceRowHTML(r, esc)).join('')
    + '</div>'
    + (more ? '<p class="set-cap">' + more + ' more rows in this turn are not drawn.</p>' : '')
    + (st.err ? '<p class="set-cap set-err">' + esc(st.err) + '</p>' : '');
}

/* v: load | prev | next | hide. ctx: {stateDir, sessionId, repaint}. */
async function traceViewAct(v, br, ctx) {
  const paint = () => { if (ctx && ctx.repaint) ctx.repaint(); else if (TRV.onChange) TRV.onChange(); };
  const turns = TRV.tree && TRV.tree.turns ? TRV.tree.turns : [];
  const cur = TRV.turn < 0 || TRV.turn >= turns.length ? turns.length - 1 : TRV.turn;
  if (v === 'prev') { TRV.turn = Math.max(0, cur - 1); paint(); return; }
  if (v === 'next') { TRV.turn = Math.min(turns.length - 1, cur + 1); paint(); return; }
  if (v === 'hide') { TRV.tree = null; TRV.sid = ''; TRV.turn = -1; TRV.err = ''; paint(); return; }
  if (v !== 'load' || TRV.busy) return;
  const sid = (ctx && ctx.sessionId) || '';
  const stateDir = (ctx && ctx.stateDir) || '';
  if (!br || !br.traceTree) { TRV.err = 'This build cannot read the trace.'; paint(); return; }
  if (!sid || !stateDir) { TRV.err = 'Open a chat first: the timeline is the open chat’s.'; paint(); return; }
  const same = TRV.sid === sid;
  TRV.busy = true; TRV.err = ''; paint();
  try {
    const r = await br.traceTree(stateDir, sid);
    if (r && r.ok && r.tree) {
      // Refresh on the same chat keeps the turn picked unless it was the newest.
      const keep = same && TRV.tree && TRV.turn >= 0 && TRV.turn < TRV.tree.turns.length - 1;
      TRV.tree = r.tree; TRV.sid = sid;
      if (!keep) TRV.turn = -1;
    } else {
      TRV.err = /ENOENT|no such file/i.test(String((r && r.error) || '')) ? 'This chat has no trace yet: it appears after the first turn.' : ((r && r.error) || 'The trace could not be read.');
    }
  } catch (e) {
    TRV.err = String((e && e.message) || e);
  } finally {
    TRV.busy = false;
    paint();
  }
}

if (typeof module !== 'undefined') module.exports = {TRV, TRV_MAX_ROWS, traceFmtMs, traceFmtTokens, traceFmtCost, traceViewRows, traceViewHTML, traceViewAct};
