/* ---------------- ATO-1502: the agent's question card (ask_user) ----------------
   Loaded before renderer.js; declares only. The pure half (the question
   read from the request, the answer checked before it goes, the card's
   markup) is shared with the Node checks (test/question-card.test.mjs);
   the page half reads renderer.js globals (S, BR, ANX, render, esc, ic,
   approvalOpen, approvalAnswered, approvalTurnId, apprNoLongerWaiting,
   approvalNotWaiting, placeAfterRow, agentReplyWords, nid, CLOSED_APPROVALS,
   PENDING_APPROVALS, APPROVAL_CARDS, approvalOnScreen) at call time, as
   handoff.js does.

   The agent's `ask_user` (ATO-489, #1506) reaches the window as an ordinary
   approval request with `category: "user_question"` and a `question`
   object, so it is kept, replayed and closed by the approval machinery like
   any other card (onApprovalEvent). Only the card and the answer differ:

   - The card shows the question, its options (one pick, or several when
     `multiSelect`), and a field for the person's own words when
     `allowOther`. As in other chat apps' option cards (Claude's and
     ChatGPT's): a click on an option of a one-pick question answers with
     it; several picks and own words go with Send. Skip closes it unanswered.
   - The answer goes to POST /api/question/answer (BR.answerQuestion), never
     /api/approval/resolve, which refuses a bare approve of a question.
   - ⌘↩ (Ctrl+↩) sends what is picked, ⌘. (Ctrl+.) skips; Abort run stays.

   The desktop opts in per turn with `x-atomic-questions: 1`
   (main/agent-client.ts); an agent without ask_user ignores the header. */

const QC_MAX_OPTIONS = 8;
const QC_OTHER_MAX = 2000;

/** The question a request carries, cleaned up; null when it has none the card can draw. */
function qcQuestion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt || !Array.isArray(raw.options)) return null;
  const seen = new Set();
  const options = [];
  for (const o of raw.options) {
    const label = o && typeof o.label === 'string' ? o.label.trim() : '';
    if (!label || seen.has(label)) continue;
    seen.add(label);
    options.push({label, description: typeof o.description === 'string' ? o.description.trim() : ''});
    if (options.length >= QC_MAX_OPTIONS) break;
  }
  const allowOther = raw.allowOther === true;
  if (!options.length && !allowOther) return null;
  return {prompt, options, multiSelect: raw.multiSelect === true, allowOther};
}

/** What the card would send now: {selected, other?} or a reason it cannot go yet (a string). The agent checks it again. */
function qcAnswer(q, picked, otherRaw) {
  const want = new Set(Array.isArray(picked) ? picked : []);
  const selected = q.options.map((o) => o.label).filter((l) => want.has(l));
  const other = typeof otherRaw === 'string' ? otherRaw.trim().slice(0, QC_OTHER_MAX) : '';
  if (other && !q.allowOther) return 'this question takes no answer of your own';
  if (!q.multiSelect && selected.length > 1) return 'pick one option';
  if (!selected.length && !other) return 'pick an option or type an answer';
  return other ? {selected, other} : {selected};
}

/** The answer in one line, for the receipt. */
function qcAnswerLine(a) {
  if (!a || typeof a !== 'object') return '';
  const parts = (a.selected || []).slice();
  if (a.other) parts.push('“' + a.other + '”');
  return parts.join(', ');
}

/** The card for an approval row `m` whose request is a question. `h` has esc and ic; `current`: the card the keys answer. */
function qcCardHTML(m, h, current) {
  const q = m.question;
  const e = h.esc;
  if (m.state) {
    const label = m.state === 'answered' ? 'Answered'
      : m.state === 'skipped' ? 'Skipped'
      : m.state === 'stopped' ? 'Not answered — the run was stopped'
      : m.state === 'expired' ? 'Not answered — the agent stopped waiting'
      : 'Skipped';
    const ok = m.state === 'answered';
    const line = ok ? qcAnswerLine(m.qcSent) : '';
    return '<div class="appr done qc-done' + (ok ? ' ok' : '') + '">'
      + '<span class="tk-gly ' + (ok ? 'tk-gly--ok' : 'tk-gly--warn') + '">' + h.ic(ok ? 'check' : 'chat') + '</span>'
      + '<span class="apprlbl"><b>' + label + '</b>' + (ok || m.state === 'skipped' ? ' by you' : '') + ' · <span class="mono">' + e(m.at || '') + '</span></span>'
      + '<span class="qc-recap" title="' + e(q.prompt) + '">' + e(line || q.prompt) + '</span></div>';
  }
  const picked = new Set(Array.isArray(m.qcPick) ? m.qcPick : []);
  const multi = q.multiSelect;
  const ready = typeof qcAnswer(q, m.qcPick, m.qcOther) !== 'string';
  const kbd = (w) => current && h.keyLabel ? ' <span class="apprkbd">' + h.keyLabel(w) + '</span>' : '';
  const opts = q.options.map((o, i) => {
    const on = picked.has(o.label);
    return '<button type="button" class="qc-opt' + (on ? ' on' : '') + '" data-qc="pick" data-qc-i="' + i + '"'
      + ' role="' + (multi ? 'checkbox' : 'radio') + '" aria-checked="' + (on ? 'true' : 'false') + '">'
      + '<span class="qc-mark' + (multi ? ' sq' : '') + '" aria-hidden="true">' + (on ? h.ic('check') : '') + '</span>'
      + '<span class="qc-txt"><span class="qc-lbl">' + e(o.label) + '</span>'
      + (o.description ? '<span class="qc-desc">' + e(o.description) + '</span>' : '') + '</span></button>';
  }).join('');
  /* The Send button is there whenever a click on an option does not send by
     itself: several picks, or own words. */
  const needsSend = multi || q.allowOther;
  return '<div class="appr qc"' + (current ? ' id="apprcard"' : '') + ' tabindex="-1" data-appr-id="' + e(m.approvalId || '') + '">'
    + '<div class="apprhead"><span class="apprico">' + h.ic('chat') + '</span>'
      + '<div class="apprmain"><div class="ttl">' + e(q.prompt) + '</div>'
      + '<div class="apprwhy">' + (multi ? 'Pick one or more.' : 'Pick one.') + (q.allowOther ? ' Or answer in your own words.' : '') + '</div>'
    + '</div></div>'
    + (opts ? '<div class="qc-opts" role="' + (multi ? 'group' : 'radiogroup') + '" aria-label="' + e(q.prompt) + '">' + opts + '</div>' : '')
    + (q.allowOther ? '<div class="qc-other"><textarea class="qc-input" data-qc-other rows="1" maxlength="' + QC_OTHER_MAX + '"'
      + ' placeholder="Your own answer" aria-label="Your own answer">' + e(m.qcOther || '') + '</textarea></div>' : '')
    + (m.qcError ? '<div class="apprrisk" role="status">' + e(m.qcError) + '</div>' : '')
    + '<div class="apprbtns">'
      + (needsSend ? '<button class="btn sm appr-yes" data-qc="send"' + (ready ? '' : ' disabled') + ' title="Send your answer">Send' + kbd('y') + '</button>' : '')
      + '<button class="btn sm btn-s apprdeny" data-qc="skip" title="Close the question without an answer; the agent goes on with its best guess">Skip' + kbd('n') + '</button>'
      + '<button class="btn sm btn-g apprabort" data-appr="esc" title="Stop the whole run">Abort run</button>'
    + '</div></div>';
}

/* ---------- the page half ---------- */

/** The open question row a card element belongs to. */
function qcRowOf(el) {
  const box = el && el.closest ? el.closest('.appr.qc[data-appr-id]') : null;
  if (!box) return null;
  const id = box.getAttribute('data-appr-id');
  return S.log.find((m) => m.k === 'approval' && m.question && m.approvalId === id && approvalOpen(m)) || null;
}

/** Send `body` ({selected, other?} or {skip: true}) for the question row `req`. */
function qcSend(req, body) {
  if (!approvalOpen(req) || req.answering || !BR || typeof BR.answerQuestion !== 'function') return;
  const skip = body.skip === true;
  ANX.apprAnswered(req, skip ? 'n' : 'y');
  approvalAnswered(req);
  req.state = skip ? 'skipped' : 'answered';
  req.at = new Date().toTimeString().slice(0, 8);
  req.qcSent = skip ? null : body;
  delete req.qcError;
  // As answerLive: the turn goes on, so the chat that asked looks busy again.
  const turn = approvalTurnId(req);
  if (turn && (!req.sessionId || req.sessionId === S.agentSession)) S.busy = true;
  req.answering = true; delete req.landed;
  BR.answerQuestion(Object.assign({approvalId: req.approvalId}, body)).then((res) => {
    req.answering = false;
    const data = res && res.data;
    req.landed = !!(res && res.ok !== false && data && data.resolved === true);
    if (req.landed) { render(); return; }
    if (res && res.ok !== false && approvalNotWaiting(data)) { apprNoLongerWaiting(req); render(); return; }
    if (res && res.ok !== false && data && data.error) { qcReopen(req, data.error); render(); return; }
    placeAfterRow(req, {id:nid(), k:'system', apprNote:true, sev:'warn',
      text:'Couldn’t send your answer to the agent: ' + esc(agentReplyWords((res && res.error) || ''))});
    render();
  }, (err) => {
    req.answering = false;
    placeAfterRow(req, {id:nid(), k:'system', apprNote:true, sev:'warn',
      text:'Couldn’t send your answer to the agent: ' + esc(agentReplyWords((err && err.message) || ''))});
    render();
  });
  render();
}

/** The agent refused the answer (a 400): the question is still open, the card comes back with why. */
function qcReopen(req, err) {
  const why = typeof err === 'string' ? err : (err && typeof err.message === 'string' ? err.message : '');
  delete req.state; delete req.at; delete req.landed; delete req.qcSent;
  req.qcError = why ? 'The agent did not take that answer: ' + why : 'The agent did not take that answer. Try again.';
  const sid = req.sessionId;
  if (sid) { PENDING_APPROVALS.set(sid, req.approvalId); APPROVAL_CARDS.set(sid, req); }
  if (S.log.includes(req) && (!sid || approvalOnScreen(sid))) S.pending = req;
  if (!sid || sid === S.agentSession) S.busy = false;
}

/** A click inside the chat. True when it was the question card's. */
function qcClick(t) {
  const btn = t && t.closest ? t.closest('[data-qc]') : null;
  if (!btn) return false;
  const req = qcRowOf(btn);
  if (!req) return true;
  const q = req.question;
  const what = btn.getAttribute('data-qc');
  if (what === 'skip') { qcSend(req, {skip: true}); return true; }
  if (what === 'send') { qcKey(req, 'y'); return true; }
  if (what === 'pick') {
    const o = q.options[Number(btn.getAttribute('data-qc-i'))];
    if (!o) return true;
    delete req.qcError;
    if (!q.multiSelect && !q.allowOther) { qcSend(req, {selected: [o.label]}); return true; }
    const now = new Set(req.qcPick || []);
    if (q.multiSelect) { if (now.has(o.label)) now.delete(o.label); else now.add(o.label); }
    else if (now.has(o.label)) now.clear();
    else { now.clear(); now.add(o.label); }
    req.qcPick = [...now];
    render();
    return true;
  }
  return true;
}

/** Typing in the own-answer field: kept on the row, Send follows it without a full render (the caret stays). */
function qcInput(t) {
  if (!t || !t.matches || !t.matches('[data-qc-other]')) return false;
  const req = qcRowOf(t);
  if (!req) return true;
  req.qcOther = t.value;
  const send = t.closest('.appr.qc').querySelector('[data-qc="send"]');
  if (send) send.disabled = typeof qcAnswer(req.question, req.qcPick, req.qcOther) === 'string';
  return true;
}

/** Enter in the own-answer field sends; Shift+Enter is a new line. True when the key was the card's. */
function qcKeydown(e) {
  const t = e.target;
  if (!t || !t.matches || !t.matches('[data-qc-other]')) return false;
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return false;
  e.preventDefault();
  const req = qcRowOf(t);
  if (req) { req.qcOther = t.value; qcKey(req, 'y'); }
  return true;
}

/** The card's keys, from answerLive: 'y' (⌘↩ / Send) sends what is picked, 'n' (⌘.) skips. */
function qcKey(req, key) {
  if (key === 'n') { qcSend(req, {skip: true}); return; }
  if (key !== 'y') return;
  const a = qcAnswer(req.question, req.qcPick, req.qcOther);
  if (typeof a === 'string') { req.qcError = a.charAt(0).toUpperCase() + a.slice(1) + '.'; render(); return; }
  qcSend(req, a);
}

/* The card's own listeners, in the capture phase so the chat's click
   delegator and the window's keys (renderer.js) never see a click or an
   Enter that was the card's. Abort run keeps `data-appr` and goes through
   the delegator as on every approval card. */
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  document.addEventListener('click', (e) => { if (qcClick(e.target)) { e.preventDefault(); e.stopPropagation(); } }, true);
  document.addEventListener('input', (e) => { qcInput(e.target); }, true);
  document.addEventListener('keydown', (e) => { if (qcKeydown(e)) e.stopPropagation(); }, true);
}

if (typeof module !== 'undefined') {
  module.exports = {qcQuestion, qcAnswer, qcAnswerLine, qcCardHTML, QC_MAX_OPTIONS, QC_OTHER_MAX};
}
