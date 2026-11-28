/* ---------------- ATO-2486: a job's password the agent asked for ----------------
   Loaded before renderer.js; declares only. The pure half (the request read
   from the frame, the card's markup, the line over the panel's field) is
   shared with the Node checks (test/shell-secret-card.test.mjs); the page
   half reads renderer.js globals (S, BR, ANX, render, esc, nid, approvalOpen,
   approvalAnswered, approvalTurnId, apprNoLongerWaiting, approvalNotWaiting,
   placeAfterRow, agentReplyWords, PENDING_APPROVALS, APPROVAL_CARDS,
   approvalOnScreen) and agent-jobs.js (ajTakeSecret) at call time, as
   question-card.js does.

   The agent's `{"write": id, "secret": "sudo password"}` reaches the window
   as an approval request with `category: "shell_secret_input"` and `secretInput`
   (`jobId`, `label`, `commandLine`, `promptLine`), kept, replayed and closed
   by the approval machinery like any card. Allow would type nothing (the
   agent refuses a bare approve of one), so the card has no Allow:

   - Type it opens the job's tab in the terminal panel under the chat with
     typing hidden (agent-jobs.js); Send there answers this request through
     POST /api/shell/secret (BR.answerShellSecret), never the job's stdin.
   - Skip types nothing; the agent is told so. Abort run stays.
   - ⌘↩ (Ctrl+↩) is Type it, ⌘. (Ctrl+.) Skip.

   The value is never kept on the row, in the chat or in a log; the agent
   hides it from the model in every result of the session's jobs. Like
   sudo's own prompt, and Claude Code / Codex handing a password to the
   person. */

const SS_VALUE_MAX = 1024;

/** The request a frame carries, cleaned up; null when it has none the card can draw. */
function ssPrompt(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const jobId = raw.jobId;
  if (typeof jobId !== 'number' || !Number.isInteger(jobId) || jobId < 1) return null;
  const one = (v, max) => {
    const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  };
  return {jobId, label: one(raw.label, 120) || 'a password', commandLine: one(raw.commandLine, 200), promptLine: one(raw.promptLine, 200)};
}

/** The line over the panel's field while it answers a request. */
function ssAskLine(req) {
  const p = req && req.secret;
  if (!p) return '';
  const base = 'The agent asks for ' + p.label + '. Send types it into the command; the agent does not see it.';
  return req.ssError ? base + ' ' + req.ssError : base;
}

/** The card for an approval row `m` whose request is a job's password. `h` has esc and ic; `current`: the card the keys answer. */
function ssCardHTML(m, h, current) {
  const p = m.secret;
  const e = h.esc;
  if (m.state) {
    const ok = m.state === 'answered';
    const label = ok ? 'Typed into the command'
      : m.state === 'stopped' ? 'Not typed: the run was stopped'
      : m.state === 'expired' ? 'Not typed: the agent stopped waiting'
      : 'Skipped';
    return '<div class="appr done ss-done' + (ok ? ' ok' : '') + '">'
      + '<span class="tk-gly ' + (ok ? 'tk-gly--ok' : 'tk-gly--warn') + '">' + h.ic(ok ? 'check' : 'key') + '</span>'
      + '<span class="apprlbl"><b>' + label + '</b>' + (ok || m.state === 'skipped' ? ' by you' : '') + ' · <span class="mono">' + e(m.at || '') + '</span></span>'
      + '<span class="qc-recap">' + e(p.label) + '</span></div>';
  }
  const kbd = (w) => current && h.keyLabel ? ' <span class="apprkbd">' + h.keyLabel(w) + '</span>' : '';
  return '<div class="appr ss"' + (current ? ' id="apprcard"' : '') + ' tabindex="-1" data-appr-id="' + e(m.approvalId || '') + '">'
    + '<div class="apprhead"><span class="apprico">' + h.ic('key') + '</span>'
      + '<div class="apprmain"><div class="ttl">The agent’s command asks for ' + e(p.label) + '</div>'
      + '<div class="apprwhy">Job ' + p.jobId + (p.commandLine ? ': <span class="mono">' + e(p.commandLine) + '</span>' : '')
      + '. Type it in the terminal panel under the chat. It goes to the command only; the agent does not see it.</div>'
      + (p.promptLine ? '<div class="ss-prompt mono">' + e(p.promptLine) + '</div>' : '')
    + '</div></div>'
    + (m.ssError ? '<div class="apprrisk" role="status">' + e(m.ssError) + '</div>' : '')
    + '<div class="apprbtns">'
      + '<button class="btn sm appr-yes" data-ss="type" title="Open the job in the terminal panel with typing hidden">Type it' + kbd('y') + '</button>'
      + '<button class="btn sm btn-s apprdeny" data-ss="skip" title="Type nothing; the agent is told nothing was typed">Skip' + kbd('n') + '</button>'
      + '<button class="btn sm btn-g apprabort" data-appr="esc" title="Stop the whole run">Abort run</button>'
    + '</div></div>';
}

/* ---------- the page half ---------- */

/** The open request of job `jobId` in chat `sid`, for the panel; null when none. */
function ssOpenFor(sid, jobId) {
  if (typeof S === 'undefined' || !S || !Array.isArray(S.log)) return null;
  return S.log.find((m) => m.k === 'approval' && m.secret && m.secret.jobId === jobId
    && (!m.sessionId || m.sessionId === sid) && approvalOpen(m) && !m.answering) || null;
}

function ssRowOf(el) {
  const box = el && el.closest ? el.closest('.appr.ss[data-appr-id]') : null;
  if (!box) return null;
  const id = box.getAttribute('data-appr-id');
  return S.log.find((m) => m.k === 'approval' && m.secret && m.approvalId === id && approvalOpen(m)) || null;
}

/** Send `body` ({value} or {skip: true}) for the row `req`. The value is not kept on the row. */
function ssSend(req, body) {
  if (!approvalOpen(req) || req.answering || !BR || typeof BR.answerShellSecret !== 'function') return;
  const skip = body.skip === true;
  if (!skip && (typeof body.value !== 'string' || !body.value || body.value.length > SS_VALUE_MAX)) {
    req.ssError = body.value ? 'That is too long to send in one go.' : 'Type it first.';
    render();
    return;
  }
  ANX.apprAnswered(req, skip ? 'n' : 'y');
  approvalAnswered(req);
  req.state = skip ? 'skipped' : 'answered';
  req.at = new Date().toTimeString().slice(0, 8);
  delete req.ssError;
  // As answerLive: the turn goes on, so the chat that asked looks busy again.
  const turn = approvalTurnId(req);
  if (turn && (!req.sessionId || req.sessionId === S.agentSession)) S.busy = true;
  req.answering = true; delete req.landed;
  const fail = (why) => {
    placeAfterRow(req, {id:nid(), k:'system', apprNote:true, sev:'warn',
      text:'Couldn’t send it to the agent: ' + esc(agentReplyWords(why || ''))});
    render();
  };
  BR.answerShellSecret(Object.assign({approvalId: req.approvalId}, skip ? {skip: true} : {value: body.value})).then((res) => {
    req.answering = false;
    const data = res && res.data;
    req.landed = !!(res && res.ok !== false && data && data.resolved === true);
    if (req.landed) { render(); return; }
    if (res && res.ok !== false && approvalNotWaiting(data)) { apprNoLongerWaiting(req); render(); return; }
    if (res && res.ok !== false && data && data.error) { ssReopen(req, data.error); render(); return; }
    fail(res && res.error);
  }, (err) => { req.answering = false; fail(err && err.message); });
  render();
}

/** The agent refused the value (a 400): the request is still open, the card comes back with why. */
function ssReopen(req, err) {
  const why = typeof err === 'string' ? err : (err && typeof err.message === 'string' ? err.message : '');
  delete req.state; delete req.at; delete req.landed;
  req.ssError = why ? 'The agent did not take it: ' + why + '.' : 'The agent did not take it. Try again.';
  const sid = req.sessionId;
  if (sid) { PENDING_APPROVALS.set(sid, req.approvalId); APPROVAL_CARDS.set(sid, req); }
  if (S.log.includes(req) && (!sid || approvalOnScreen(sid))) S.pending = req;
  if (!sid || sid === S.agentSession) S.busy = false;
}

/** Type it: the job's tab in the terminal panel, typing hidden. */
function ssTypeIt(req) {
  const ok = typeof ajTakeSecret === 'function' && ajTakeSecret(req.secret.jobId);
  if (ok) delete req.ssError;
  else req.ssError = 'The terminal panel can’t show this job with this version of the agent. Skip it, or update Atomic Agent.';
  render();
}

/** The card's keys, from answerLive: 'y' (⌘↩) is Type it, 'n' (⌘.) Skip. */
function ssKey(req, key) {
  if (key === 'n') ssSend(req, {skip: true});
  else if (key === 'y') ssTypeIt(req);
}

/* The card's own listener, in the capture phase like question-card.js;
   Abort run keeps `data-appr` and goes through the chat's delegator. */
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-ss]') : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const req = ssRowOf(btn);
    if (req) ssKey(req, btn.getAttribute('data-ss') === 'skip' ? 'n' : 'y');
  }, true);
}

if (typeof module !== 'undefined') {
  module.exports = {ssPrompt, ssAskLine, ssCardHTML, SS_VALUE_MAX};
}
