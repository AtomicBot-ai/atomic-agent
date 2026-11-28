/* ---------------- ATO-2470: versions of a message, ‹ 2/3 › on any question ----------------
   Loaded before renderer.js; declares only (plus one click listener).

   An Edit used to cut the old message and everything after it out of the
   chat for good. The agent now keeps that tail as a version of the message
   (src/session/session-message-branches.ts), and keeps the answers
   Regenerate replaced even after the chat moved on. This file draws the
   ChatGPT / Claude.ai switchers for them:

     - on a message that was edited: "‹ 2/3 ›" over its different texts,
       oldest first (by when each text was first sent);
     - under the answer to any question that has other answers with the
       same text (Regenerate kept them): "‹ 2/3 ›", oldest answer first;
     - on the failure row of a Regenerate whose new try failed, the same
       answer switcher, with the failed try as the newest version.

   A step asks the agent to put that version back
   (POST /api/sessions/{id}/switch-version): the conversation on screen from
   that question on becomes a version itself, so nothing is lost, and the
   chat is drawn again from the agent. Everything lives in the chat's own
   file, so the switchers are back after a restart.

   An agent without the routes answers "unsupported": then nothing here is
   drawn and answer-versions.js (ATO-2114, last answer only) does the work.

   Hooks: msgActs (renderer.js) adds messageVersionsUserHTML(m) to a
   question's row and messageVersionsAnswerHTML(m) to an answer's;
   sysRowHTML adds messageVersionsFailHTML(m) to a failure row. */

/* ---- pure part (unit-tested in desktop/test/message-versions.test.mjs) ---- */

const mverNorm = (s) => String(s || '').trim();

/** The agent's entry for the question with `p` questions before it, or null. */
function mverQuestionAt(questions, p) {
  return (Array.isArray(questions) ? questions : []).find((q) => q && q.priorQuestions === p) || null;
}

/** The text in the chat for `q`: the agent's, or the window's when the agent has none stored. */
function mverLiveText(q, windowText) {
  return mverNorm(q && q.live ? q.live.text : windowText);
}

/** The message's different texts, oldest first; null when there is only one. */
function mverEditView(q, windowText) {
  if (!q || !Array.isArray(q.versions)) return null;
  const groups = new Map();
  const group = (text) => {
    if (!groups.has(text)) groups.set(text, {text, at: Infinity, newest: null, live: false});
    return groups.get(text);
  };
  for (const v of q.versions) {
    const g = group(mverNorm(v.text));
    g.at = Math.min(g.at, Number(v.at) || 0);
    if (!g.newest || (Number(v.keptAt) || 0) > (Number(g.newest.keptAt) || 0)) g.newest = v;
  }
  const live = group(mverLiveText(q, windowText));
  live.live = true;
  if (q.live) live.at = Math.min(live.at, Number(q.live.at) || 0);
  const list = [...groups.values()].sort((a, b) => (a.at !== b.at ? a.at - b.at : a.live ? 1 : b.live ? -1 : 0));
  if (list.length < 2) return null;
  return {list, pos: list.indexOf(live) + 1, total: list.length};
}

/** The answers to the text in the chat, oldest first, the one on screen among them; null when there is only one. */
function mverAnswerView(q, windowText) {
  if (!q || !Array.isArray(q.versions)) return null;
  const text = mverLiveText(q, windowText);
  const kept = q.versions.filter((v) => mverNorm(v.text) === text)
    .map((v) => ({ref: v.ref, at: typeof v.answerAt === 'number' ? v.answerAt : Number(v.keptAt) || 0}));
  if (!kept.length) return null;
  // The one on screen: its answer's time, or the newest when it has none (a failed try).
  const current = {ref: null, at: q.live && typeof q.live.answerAt === 'number' ? q.live.answerAt : Infinity};
  const list = kept.concat([current]).sort((a, b) => (a.at !== b.at ? a.at - b.at : a.ref === null ? 1 : b.ref === null ? -1 : 0));
  return {list, pos: list.indexOf(current) + 1, total: list.length};
}

/** The ref one step back (dir -1) or forward (dir 1) in either view; null at the ends. */
function mverStep(view, dir) {
  if (!view || !Array.isArray(view.list)) return null;
  const to = view.list[view.pos - 1 + (dir < 0 ? -1 : 1)];
  if (!to) return null;
  if ('newest' in to) return to.live || !to.newest ? null : to.newest.ref;
  return to.ref || null;
}

/** "‹ 2/3 ›"; both arrows stay in place at the ends, just disabled, so the row never shifts. */
function mverSwitchHTML(view, kind, p, busy) {
  const chev = (n) => (typeof ic === 'function' ? ic(n) : '');
  const what = kind === 'edit' ? 'version' : 'answer';
  const btn = (dir, label, icon, off) => '<button type="button" class="msgact" data-mver="' + dir + '" data-mver-kind="' + kind
    + '" data-mver-q="' + p + '" title="' + label + '" aria-label="' + label + '"' + (off || busy ? ' disabled' : '') + '>' + chev(icon) + '</button>';
  return '<span class="ansver mver-' + kind + '" role="group" aria-label="' + (kind === 'edit' ? 'Message versions' : 'Answer versions') + '">'
    + btn('prev', 'Previous ' + what, 'chevL', view.pos <= 1)
    + '<span class="ansver-n">' + view.pos + '/' + view.total + '</span>'
    + btn('next', 'Next ' + what, 'chevR', view.pos >= view.total)
    + '</span>';
}

/** The words for the agent refusing a switch (its 409 code). */
function mverRefusalText(r) {
  const code = r && r.code;
  if (code === 'point_mismatch' || code === 'no_version') return 'The chat changed since this was drawn. It is drawn again.';
  if (code === 'point_compacted') return 'This part of the chat was summarized, so its versions cannot be switched.';
  if (code === 'session_not_found') return 'This chat is not saved yet.';
  if (typeof answerVersionsRefusalText === 'function') return answerVersionsRefusalText(r);
  return (r && r.error) || 'The agent gave no reason. Nothing was changed.';
}

/** The question row an answer row belongs to, when `m` is that turn's last answer; else null. */
function mverAnswerQuestion(log, m) {
  if (!Array.isArray(log)) return null;
  const at = log.indexOf(m);
  if (at < 0) return null;
  for (let i = at + 1; i < log.length; i++) {
    const x = log[i];
    if (x && x.k === 'user' && !x.steered) break;
    if (x && x.k === 'assistant' && !x.placeholder && mverNorm(x.text)) return null;   // a later answer in the same turn
  }
  for (let i = at - 1; i >= 0; i--) {
    const x = log[i];
    if (x && x.k === 'user' && !x.steered) return x;
  }
  return null;
}

/** The question a failure row belongs to, when it is the chat's last question and has no answer on screen; else null. */
function mverFailQuestion(log, m) {
  if (!Array.isArray(log)) return null;
  const at = log.indexOf(m);
  if (at < 0 || log.slice(at + 1).some((x) => x && x.k === 'user' && !x.steered)) return null;
  for (let i = at - 1; i >= 0; i--) {
    const x = log[i];
    if (x && x.k === 'assistant' && !x.placeholder && mverNorm(x.text)) return null;
    if (x && x.k === 'user' && !x.steered) return x;
  }
  return null;
}

/* ---- the window part ---- */

/* One chat's versions at a time; `key` changes with the chat and its rows,
   so a finished turn or a redrawn chat asks again. */
const MVER = {supported: true, key: null, sid: null, questions: null, busy: false};

/** Whether this file draws the answer switchers (answer-versions.js then steps aside). */
function messageVersionsActive() {
  return MVER.supported && typeof BR !== 'undefined' && !!BR && !!BR.messageVersions;
}

function mverReady() {
  return messageVersionsActive() && !!S.agentSession && !S.busy && !S.pending;
}

/** The agent's questions for the chat on screen, or null while they are being asked for. */
function mverQuestions() {
  const last = S.log.length ? S.log[S.log.length - 1] : null;
  const key = S.agentSession + '\n' + S.log.length + '\n' + (last ? last.id : '');
  if (MVER.key !== key) { messageVersionsLoad(key, S.agentSession); return null; }
  return MVER.questions;
}

function mverView(kind, u) {
  if (!u || !mverReady()) return null;
  const qs = mverQuestions();
  if (!qs) return null;
  const p = priorQuestions(u);
  const q = mverQuestionAt(qs, p);
  if (!q || q.compacted) return null;
  const view = kind === 'edit' ? mverEditView(q, u.text) : mverAnswerView(q, u.text);
  return view ? {view, p} : null;
}

function messageVersionsUserHTML(m) {
  if (!m || m.k !== 'user' || m.steered || m.placeholder) return '';
  const v = mverView('edit', m);
  return v ? mverSwitchHTML(v.view, 'edit', v.p, MVER.busy) : '';
}

function messageVersionsAnswerHTML(m) {
  if (!m || m.k !== 'assistant' || m.placeholder) return '';
  const v = mverView('answer', mverAnswerQuestion(S.log, m));
  return v ? mverSwitchHTML(v.view, 'answer', v.p, MVER.busy) : '';
}

function messageVersionsFailHTML(m) {
  if (!m || m.sev !== 'err') return '';
  const v = mverView('answer', mverFailQuestion(S.log, m));
  return v ? ' ' + mverSwitchHTML(v.view, 'answer', v.p, MVER.busy) : '';
}

async function messageVersionsLoad(key, sid) {
  Object.assign(MVER, {key, sid, questions: null});
  let r;
  try { r = await BR.messageVersions(sid); } catch (err) { r = {ok: false, supported: true, error: String(err)}; }
  if (MVER.key !== key) return;
  if (r && r.supported === false) { MVER.supported = false; render(); return; }   // answer-versions.js takes over
  if (!r || !r.ok || !Array.isArray(r.questions)) return;
  MVER.questions = r.questions;
  if (r.questions.length) render();
}

/** The question row with `p` questions before it, as priorQuestions counts them. */
function mverUserRowAt(p) {
  return S.log.find((x) => x && x.k === 'user' && !x.steered && priorQuestions(x) === p) || null;
}

async function messageVersionsGo(kind, p, dir) {
  const sid = MVER.sid;
  if (MVER.busy || !mverReady() || !sid || S.agentSession !== sid) return;
  const q = mverQuestionAt(MVER.questions, p);
  const u = mverUserRowAt(p);
  if (!q || !u) return;
  const ref = mverStep(kind === 'edit' ? mverEditView(q, u.text) : mverAnswerView(q, u.text), dir);
  if (!ref) return;
  MVER.busy = true;
  render();
  let r;
  try { r = await BR.switchMessageVersion(sid, p, q.live ? q.live.text : undefined, ref); } catch (err) { r = {ok: false, supported: true, error: String(err)}; }
  MVER.busy = false;
  if (r && r.supported === false) {
    MVER.supported = false;
    render();
    toast('Not available', 'This agent version keeps no earlier versions of a message. Update Atomic Agent.', 'bad');
    return;
  }
  if (!r || !r.ok) {
    toast("Couldn't switch versions", mverRefusalText(r), 'bad');
    const stale = r && (r.code === 'no_version' || r.code === 'point_mismatch');
    if (!stale) { render(); return; }
  }
  /* Switched (or the chat moved on without this window): drawn again from
     the agent, which also asks for the versions again. */
  MVER.key = null;
  if (typeof AVER !== 'undefined') AVER.key = null;
  if (S.agentSession === sid) await openSession(sid);
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-mver]') : null;
    if (!b || b.disabled) return;
    e.preventDefault();
    messageVersionsGo(b.dataset.mverKind === 'edit' ? 'edit' : 'answer', Number(b.dataset.mverQ), b.dataset.mver === 'prev' ? -1 : 1);
  });
}

if (typeof module !== 'undefined') module.exports = {mverQuestionAt, mverEditView, mverAnswerView, mverStep, mverSwitchHTML, mverRefusalText,
  mverAnswerQuestion, mverFailQuestion, MVER, messageVersionsActive, messageVersionsUserHTML, messageVersionsAnswerHTML, messageVersionsFailHTML,
  messageVersionsGo};
