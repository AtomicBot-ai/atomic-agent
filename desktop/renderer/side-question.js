/* ---------------- ATO-1152: /btw, a side question ----------------
   Loaded before renderer.js; the pure half is shared with the Node checks
   (test/side-question.test.mjs).

   `/btw <question>` asks a quick question beside the main task, as Claude
   Code's /btw: the agent answers it with the chat so far as read-only
   context, runs no tools, and saves nothing (POST /api/btw through main,
   agent:btw). The question and the answer never become messages: they are
   shown in one card above the composer and are gone when it is closed. It
   works while a turn is running; the turn is left alone.

   One side question at a time, as the TUI: asking another replaces the
   card, and the answer to the old one is dropped when it lands. Closing the
   card drops an answer still on its way. */

const BTW_MAX_CHARS = 4000;   // the agent's limit (src/runtime/side-question.ts)
const BTW_USAGE = 'usage: /btw <question>, a quick side question that is not saved to the chat';

/* The card: null, or {id, question, status: 'asking' | 'done' | 'failed', text}. */
const BTW = {card: null, seq: 0};

/** The question from the words after `/btw`: {ok, text} or {ok:false, error}. */
function btwQuestionFrom(words) {
  const text = (Array.isArray(words) ? words.join(' ') : String(words || '')).trim();
  if (!text) return {ok: false, error: BTW_USAGE};
  if (text.length > BTW_MAX_CHARS) {
    return {ok: false, error: 'That side question is too long (' + text.length + ' characters, at most ' + BTW_MAX_CHARS + ').'};
  }
  return {ok: true, text};
}

/** The agent session to read as context, or undefined for a chat it has not saved yet. */
function btwSessionOf(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId : '';
  return id && id.indexOf('waiting-') !== 0 ? id : undefined;
}

/** The card's words for the agent's answer (main's {ok, supported, text?, error?}). */
function btwOutcome(r) {
  if (r && r.ok && typeof r.text === 'string' && r.text.trim()) return {status: 'done', text: r.text.trim()};
  if (r && r.supported === false) return {status: 'failed', text: 'This agent cannot answer side questions. Update Atomic Agent to use /btw.'};
  const why = String((r && r.error) || 'the agent gave no answer').trim().replace(/[.!?\s]+$/, '');
  return {status: 'failed', text: "Couldn't answer the side question: " + why + '.'};
}

/**
 * Start a side question. Returns '' when it was asked, or the line the chat
 * should show instead (usage, too long). `deps`: {bridge, sessionId, paint}.
 */
function btwAsk(words, deps) {
  const q = btwQuestionFrom(words);
  if (!q.ok) return q.error;
  const bridge = deps && deps.bridge;
  if (!bridge || typeof bridge.askSideQuestion !== 'function') return 'Side questions need the desktop app.';
  const id = ++BTW.seq;
  BTW.card = {id, question: q.text, status: 'asking', text: ''};
  const paint = (deps && deps.paint) || (() => {});
  paint();
  Promise.resolve()
    .then(() => bridge.askSideQuestion(q.text, btwSessionOf(deps.sessionId)))
    .catch((err) => ({ok: false, supported: true, error: String((err && err.message) || err)}))
    .then((r) => {
      // Closed, or replaced by a newer question: this answer is nobody's.
      if (!BTW.card || BTW.card.id !== id) return;
      Object.assign(BTW.card, btwOutcome(r));
      paint();
    });
  return '';
}

/** Close the card; an answer still on its way is dropped. */
function btwClose() {
  BTW.card = null;
}

/**
 * The card above the composer, or '' with none. `h`: {esc, ic, md} where md
 * turns the answer's markdown into the window's own safe markup (optional).
 */
function btwCardHTML(h) {
  const c = BTW.card;
  if (!c) return '';
  const esc = h.esc;
  const close = '<button class="iconbtn sm btw-x" data-btw-close aria-label="Close side question" title="Close (not saved)">'
    + (h.ic ? h.ic('x') : '×') + '</button>';
  const body = c.status === 'asking'
    ? '<div class="btw-body btw-wait">Thinking…</div>'
    : c.status === 'failed'
      ? '<div class="btw-body btw-fail">' + esc(c.text) + '</div>'
      : '<div class="btw-body btw-md">' + (typeof h.md === 'function' ? h.md(c.text) : esc(c.text)) + '</div>';
  return '<div class="btwcard" role="region" aria-label="Side question" aria-live="polite">'
    + '<div class="btw-top"><span class="btw-l">/btw</span><span class="btw-q" title="' + esc(c.question) + '">' + esc(c.question) + '</span>'
    + '<span class="btw-note">not saved to the chat</span>' + close + '</div>'
    + body + '</div>';
}

if (typeof document !== 'undefined') {
  /* The close button and Escape inside the card. Escape elsewhere keeps its
     own meaning (it can stop a running turn), so it is not taken here. */
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t && t.closest && t.closest('[data-btw-close]'))) return;
    e.preventDefault();
    btwClose();
    if (typeof render === 'function') render();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !BTW.card) return;
    const t = e.target;
    if (!(t && t.closest && t.closest('.btwcard'))) return;
    e.stopPropagation();
    btwClose();
    if (typeof render === 'function') render();
  }, true);
}

if (typeof module !== 'undefined') {
  module.exports = {BTW, BTW_MAX_CHARS, BTW_USAGE, btwQuestionFrom, btwSessionOf, btwOutcome, btwAsk, btwClose, btwCardHTML};
}
