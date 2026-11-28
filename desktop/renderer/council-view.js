/* ---------------- ATO-2432: /council, the model council ----------------
   Loaded before renderer.js; the pure half is shared with the Node checks
   (test/council-view.test.mjs).

   `/council <question>` asks several models at once, as the TUI's /council
   and `atomic-agent models council` (POST /api/council through main,
   agent:council): the seats answer, a judge lists where they agree and
   disagree, the members rank each other's answers with the names hidden,
   and a chairman writes the final answer (Karpathy's llm-council,
   Perplexity Model Council). Nothing becomes a message and nothing is
   saved: the verdict is shown in one card above the composer, final answer
   on top, the answers side by side below, and it is gone when closed.

   One council at a time. While it runs the card shows the cost forecast and
   the stage; Stop or closing the card aborts every request still running. */

const COUNCIL_MAX_CHARS = 4000;   // the agent's limit (src/runtime/council-service.ts)
const COUNCIL_USAGE = 'usage: /council <question>. Flags: --models a,b*2 (default: this chat\'s model three times), --judge <model>, --chairman <model>, --no-chairman, --no-rank, --max-usd <n>, --dry-run. /council stop stops it.';
const COUNCIL_VALUE_FLAGS = ['--models', '--judge', '--chairman', '--max-usd'];

/* The card: null, or {id, question, status: 'asking' | 'done' | 'failed', stage, costLine, report, error, details}. */
const COUNCIL = {card: null, seq: 0, listening: false};

/** The words after `/council`: {ok, request}, {ok, stop}, or {ok:false, error}. */
function councilParse(words) {
  const list = (Array.isArray(words) ? words : String(words || '').split(/\s+/)).filter(Boolean);
  if (!list.length) return {ok: false, error: COUNCIL_USAGE};
  if (list.length === 1 && list[0].toLowerCase() === 'stop') return {ok: true, stop: true};
  const request = {};
  const question = [];
  for (let i = 0; i < list.length; i += 1) {
    const w = list[i];
    if (COUNCIL_VALUE_FLAGS.indexOf(w) !== -1) {
      const v = list[i + 1];
      if (v === undefined || v.indexOf('--') === 0) return {ok: false, error: w + ' needs a value. ' + COUNCIL_USAGE};
      i += 1;
      if (w === '--models') request.models = v;
      else if (w === '--judge') request.judge = v;
      else if (w === '--chairman') request.chairman = v;
      else {
        const usd = Number(v.replace(/^\$/, ''));
        if (!isFinite(usd) || usd < 0) return {ok: false, error: '--max-usd needs a number of dollars. ' + COUNCIL_USAGE};
        request.maxUsd = usd;
      }
    } else if (w === '--no-rank') request.rank = false;
    else if (w === '--no-chairman') request.chairman = null;
    else if (w === '--dry-run') request.dryRun = true;
    else question.push(w);
  }
  request.question = question.join(' ');
  if (!request.question) return {ok: false, error: COUNCIL_USAGE};
  if (request.question.length > COUNCIL_MAX_CHARS) {
    return {ok: false, error: 'That question is too long for a council (' + request.question.length + ' characters, at most ' + COUNCIL_MAX_CHARS + ').'};
  }
  return {ok: true, request};
}

/** The stage line a progress frame says, or null to keep the current one. */
function councilStageOf(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.stage === 'answering') return 'Asking ' + data.total + (data.total === 1 ? ' model…' : ' models…');
  if (data.stage === 'answered') return data.done + ' of ' + data.total + ' answered…';
  if (data.stage === 'reviewing') return data.rankers > 0 ? 'Comparing and ranking the answers…' : 'Comparing the answers…';
  if (data.stage === 'chairman') return 'Writing the final answer…';
  return null;
}

/** Apply one frame of the running council's stream to the card. */
function councilApplyFrame(frame) {
  const c = COUNCIL.card;
  if (!c || !frame || frame.id !== c.id || c.status !== 'asking') return false;
  const data = frame.data || {};
  if (frame.event === 'forecast' && typeof data.cost_line === 'string') { c.costLine = data.cost_line; return true; }
  if (frame.event === 'progress') {
    const stage = councilStageOf(data);
    if (stage) { c.stage = stage; return true; }
  }
  return false;
}

/** The card's state for the agent's outcome (main's {ok, supported, report?, costLine?, error?}). */
function councilOutcome(r, dryRun) {
  if (r && r.ok) {
    if (dryRun || !r.report) return {status: 'done', report: null, costLine: r.costLine || '', stage: 'Nothing was sent (--dry-run).'};
    return {status: 'done', report: r.report, costLine: r.costLine || ''};
  }
  if (r && r.supported === false) return {status: 'failed', error: 'This agent has no model council. Update Atomic Agent to use /council.', details: ''};
  const why = String((r && r.error) || 'the agent gave no answer').trim().replace(/[.!?\s]+$/, '');
  // The spending limit is the one refusal worth reading as is.
  if (/limit; nothing was sent$/.test(why)) return {status: 'failed', error: why.charAt(0).toUpperCase() + why.slice(1) + '.', details: '', costLine: (r && r.costLine) || ''};
  return {status: 'failed', error: "Couldn't run the council.", details: why};
}

/**
 * Start, or stop, a council. Returns '' when it was handled, or the line
 * the chat should show instead (usage, too long, already running).
 * `deps`: {bridge, paint}.
 */
function councilAsk(words, deps) {
  const parsed = councilParse(words);
  if (!parsed.ok) return parsed.error;
  const bridge = deps && deps.bridge;
  const paint = (deps && deps.paint) || (() => {});
  if (parsed.stop) {
    if (!COUNCIL.card || COUNCIL.card.status !== 'asking') return 'No council is running.';
    councilClose(bridge);
    paint();
    return '';
  }
  if (!bridge || typeof bridge.council !== 'function') return 'The model council needs the desktop app.';
  if (COUNCIL.card && COUNCIL.card.status === 'asking') return 'A council is already running; wait for it or type /council stop.';
  if (!COUNCIL.listening && typeof bridge.onCouncilFrame === 'function') {
    COUNCIL.listening = true;
    bridge.onCouncilFrame((frame) => { if (councilApplyFrame(frame)) paint(); });
  }
  const id = 'council-' + (++COUNCIL.seq);
  const request = parsed.request;
  COUNCIL.card = {id, question: request.question, status: 'asking', stage: 'Working out the cost…', costLine: '', report: null, error: '', details: ''};
  paint();
  Promise.resolve()
    .then(() => bridge.council(Object.assign({id}, request)))
    .catch((err) => ({ok: false, supported: true, error: String((err && err.message) || err)}))
    .then((r) => {
      // Closed, stopped, or replaced by a newer council: this outcome is nobody's.
      if (!COUNCIL.card || COUNCIL.card.id !== id) return;
      Object.assign(COUNCIL.card, councilOutcome(r, request.dryRun === true));
      paint();
    });
  return '';
}

/** Close the card; a council still running is stopped. */
function councilClose(bridge) {
  const c = COUNCIL.card;
  COUNCIL.card = null;
  if (c && c.status === 'asking' && bridge && typeof bridge.councilStop === 'function') {
    Promise.resolve().then(() => bridge.councilStop(c.id)).catch(() => {});
  }
}

function councilList(items, esc) {
  const list = Array.isArray(items) ? items.filter((s) => typeof s === 'string' && s.trim()) : [];
  return list.length ? '<ul>' + list.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ul>' : '<div class="cou-none">Nothing here.</div>';
}

/** The verdict: final answer, agree / disagree, ranking, then the answers side by side. */
function councilReportHTML(report, h) {
  const esc = h.esc;
  const md = (t) => (typeof h.md === 'function' ? h.md(t) : esc(t));
  const parts = [];
  const ch = report.chairman;
  if (ch && typeof ch.text === 'string' && ch.text) {
    parts.push('<section class="cou-final"><div class="cou-h">Final answer <span class="cou-by">by ' + esc(ch.model) + '</span></div><div class="cou-md">' + md(ch.text) + '</div></section>');
  } else if (ch && ch.error) {
    parts.push('<section class="cou-final"><div class="cou-h">Final answer</div><div class="cou-fail">The chairman could not answer.</div><details class="cou-det"><summary>Details</summary>' + esc(ch.error) + '</details></section>');
  }
  const s = report.summary;
  if (s && s.parsed) {
    parts.push('<section class="cou-sum"><div class="cou-col"><div class="cou-h">They agree</div>' + councilList(s.agree, esc) + '</div>'
      + '<div class="cou-col"><div class="cou-h">They disagree</div>' + councilList(s.disagree, esc) + '</div></section>');
  } else if (s && s.raw) {
    parts.push('<section class="cou-sum"><div class="cou-h">Summary</div><div class="cou-md">' + md(s.raw) + '</div></section>');
  } else if (report.judgeError) {
    parts.push('<section class="cou-sum"><div class="cou-fail">The judge could not compare the answers.</div><details class="cou-det"><summary>Details</summary>' + esc(report.judgeError) + '</details></section>');
  }
  const standings = Array.isArray(report.standings) ? report.standings : [];
  const place = {};
  standings.forEach((st, i) => { place[st.model] = i + 1; });
  if (standings.length) {
    parts.push('<section class="cou-rank"><div class="cou-h">Peer ranking</div><ol>' + standings.map((st) =>
      '<li><span class="cou-m">' + esc(st.model) + '</span> <span class="cou-avg">average place ' + Number(st.averageRank).toFixed(1) + '</span></li>').join('') + '</ol></section>');
  }
  const answers = Array.isArray(report.answers) ? report.answers : [];
  if (answers.length) {
    parts.push('<section class="cou-answers" aria-label="Answers">' + answers.map((a) => {
      const unique = s && s.unique && Array.isArray(s.unique[a.model]) ? s.unique[a.model] : [];
      const badge = place[a.model] ? '<span class="cou-place">#' + place[a.model] + '</span>' : '';
      const body = a.error !== undefined
        ? '<div class="cou-fail">No answer.</div><details class="cou-det"><summary>Details</summary>' + esc(a.error) + '</details>'
        : '<div class="cou-md">' + md(String(a.text || '').trim() || '(empty answer)') + '</div>';
      const only = unique.length ? '<div class="cou-only"><div class="cou-h">Only this one</div>' + councilList(unique, esc) + '</div>' : '';
      return '<article class="cou-ans"><div class="cou-ans-top">' + badge + '<span class="cou-m">' + esc(a.model) + '</span></div>' + body + only + '</article>';
    }).join('') + '</section>');
  }
  const notes = Array.isArray(report.notes) ? report.notes : [];
  if (notes.length) parts.push('<div class="cou-notes">' + notes.map((n) => esc(n)).join(' · ') + '</div>');
  return parts.join('');
}

/**
 * The card above the composer, or '' with none. `h`: {esc, ic, md} where md
 * turns markdown into the window's own safe markup (optional).
 */
function councilCardHTML(h) {
  const c = COUNCIL.card;
  if (!c) return '';
  const esc = h.esc;
  const icon = (n, alt) => (h.ic ? h.ic(n) : alt);
  const stop = c.status === 'asking'
    ? '<button class="btn btn-g xs cou-stop" data-council-stop>Stop</button>' : '';
  const close = '<button class="iconbtn sm cou-x" data-council-close aria-label="Close the council" title="Close (not saved)">' + icon('x', '×') + '</button>';
  const cost = c.costLine ? '<div class="cou-cost">' + esc(c.costLine) + '</div>' : '';
  let body;
  if (c.status === 'asking') body = '<div class="cou-body cou-wait">' + esc(c.stage || 'Working…') + '</div>';
  else if (c.status === 'failed') {
    body = '<div class="cou-body"><div class="cou-fail">' + esc(c.error) + '</div>'
      + (c.details ? '<details class="cou-det"><summary>Details</summary>' + esc(c.details) + '</details>' : '') + '</div>';
  } else if (!c.report) body = '<div class="cou-body cou-wait">' + esc(c.stage || 'Nothing was sent.') + '</div>';
  else body = '<div class="cou-body">' + councilReportHTML(c.report, h) + '</div>';
  return '<div class="councard" role="region" aria-label="Model council" aria-live="polite" aria-busy="' + (c.status === 'asking') + '">'
    + '<div class="cou-top"><span class="cou-l">/council</span><span class="cou-q" title="' + esc(c.question) + '">' + esc(c.question) + '</span>'
    + '<span class="cou-note">not saved to the chat</span>' + stop + close + '</div>'
    + cost + body + '</div>';
}

if (typeof document !== 'undefined') {
  const bridge = () => (typeof window !== 'undefined' ? window.atomic : null);
  /* Stop, close, and Escape inside the card. Escape elsewhere keeps its own
     meaning (it can stop a running turn), so it is not taken here. */
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t && t.closest && (t.closest('[data-council-close]') || t.closest('[data-council-stop]')))) return;
    e.preventDefault();
    councilClose(bridge());
    if (typeof render === 'function') render();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !COUNCIL.card) return;
    const t = e.target;
    if (!(t && t.closest && t.closest('.councard'))) return;
    e.stopPropagation();
    councilClose(bridge());
    if (typeof render === 'function') render();
  }, true);
}

if (typeof module !== 'undefined') {
  module.exports = {COUNCIL, COUNCIL_MAX_CHARS, COUNCIL_USAGE, councilParse, councilStageOf, councilApplyFrame, councilOutcome, councilAsk, councilClose, councilReportHTML, councilCardHTML};
}
