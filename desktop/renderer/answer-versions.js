/* ---------------- ATO-2114: answer versions, ‹ 2/3 › under the last reply ----------------
   Loaded before renderer.js; declares only (plus one click listener).

   "Regenerate" used to make the old answer simply vanish from the window.
   The agent already keeps it (ATO-864, src/session/session-previous-replies.ts):
   up to 10 earlier answers to the chat's LAST question, beside the
   transcript, so the model only ever reads the one on screen. This file
   draws the ChatGPT / Claude.ai switcher for them under the last reply:
   "‹ 2/3 ›", oldest answer first. A step to another answer asks the agent to
   put it back (POST /api/sessions/{id}/restore-previous-reply): the one on
   screen joins the kept ones, and the chat is drawn again from the agent.
   The kept answers live in the chat's own file, so the switcher is there
   again after a restart.

   The order is by when each answer was written (the transcript row's `at`,
   `storedAt` on the window's row): the agent's own list reorders on every
   swap, the times do not. A reply streamed in this window has no `storedAt`
   yet; it is the newest answer, since it came after every kept one.

   msgActs (renderer.js) adds answerVersionsHTML(m) to the last reply's row. */

/* ---- pure part (unit-tested in desktop/test/answer-versions.test.mjs) ---- */

/** The question `m` answers, when it is the chat's last one (steers not counted); else null. */
function answerVersionsQuestion(log, m) {
  if (!m || m.k !== 'assistant' || !Array.isArray(log)) return null;
  const at = log.indexOf(m);
  if (at < 0) return null;
  if (log.slice(at + 1).some((x) => x && x.k === 'user' && !x.steered)) return null;
  for (let i = at - 1; i >= 0; i--) {
    const x = log[i];
    if (x && x.k === 'user' && !x.steered) return x;
  }
  return null;
}

/** Every version oldest first: the kept ones (`index` into the agent's list) and the one on screen (`index: null`). */
function answerVersionsOrder(previous, currentAt) {
  const kept = (Array.isArray(previous) ? previous : [])
    .filter((p) => p && Number.isInteger(p.index) && p.index >= 0)
    .map((p) => ({index: p.index, at: Number(p.at) || 0}));
  const current = {index: null, at: typeof currentAt === 'number' && Number.isFinite(currentAt) ? currentAt : Infinity};
  const list = kept.concat([current]).sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    if (a.index === null) return 1;   // a tie: the one on screen counts as the later one
    if (b.index === null) return -1;
    return a.index - b.index;
  });
  return {list, pos: list.indexOf(current) + 1, total: list.length};
}

/** The switcher's view for the last reply, or null when there is nothing to switch to. */
function answerVersionsView(data, questionText, currentAt) {
  if (!data || !data.ok || !data.questionStored) return null;
  if (!Array.isArray(data.previous) || !data.previous.length) return null;
  if (String(data.question || '').trim() !== String(questionText || '').trim()) return null;
  const order = answerVersionsOrder(data.previous, currentAt);
  return order.total > 1 ? order : null;
}

/** The kept answer one step back (dir -1) or forward (dir 1), as its index in the agent's list; null at either end. */
function answerVersionsStep(view, dir) {
  if (!view || !Array.isArray(view.list)) return null;
  const to = view.list[view.pos - 1 + (dir < 0 ? -1 : 1)];
  return to && to.index !== null ? to.index : null;
}

/** "‹ 2/3 ›": both arrows stay in place at the ends, just disabled, so the row never shifts. */
function answerVersionsSwitchHTML(view, busy) {
  const chev = (n) => (typeof ic === 'function' ? ic(n) : '');
  const btn = (dir, label, icon, off) => '<button type="button" class="msgact" data-ver="' + dir + '" title="' + label
    + '" aria-label="' + label + '"' + (off || busy ? ' disabled' : '') + '>' + chev(icon) + '</button>';
  return '<span class="ansver" role="group" aria-label="Answer versions">'
    + btn('prev', 'Previous answer', 'chevL', view.pos <= 1)
    + '<span class="ansver-n">' + view.pos + '/' + view.total + '</span>'
    + btn('next', 'Next answer', 'chevR', view.pos >= view.total)
    + '</span>';
}

/* rewind-error.js: a global in the window, required in the Node checks (looked up at call time). */
function answerVersionsErr() { return typeof rewindErrorView === 'function' ? {rewindErrorView} : require('./rewind-error.js'); }

/** The words for the agent refusing a swap (its 409 code); null for any other failure. */
function answerVersionsCodeText(r) {
  const code = r && r.code;
  if (code === 'turn_in_progress') return 'The agent is still answering. Wait for it to finish, then try again.';
  if (code === 'turn_has_tools') return 'The answer on screen used tools, so it cannot be swapped for another one.';
  if (code === 'turn_steered') return 'You added to the answer on screen while it ran, so it cannot be swapped.';
  if (code === 'turn_stopped') return 'The answer on screen was stopped, so it cannot be swapped.';
  if (code === 'turn_compacted') return 'This part of the chat was summarized, so its answer cannot be swapped.';
  if (code === 'no_previous_reply' || code === 'bad_index') return 'That earlier answer is gone, so the chat was reloaded.';
  if (code === 'session_not_found') return 'This chat is not saved yet.';
  return null;
}

/** ATO-2752: the toast's sentence; a failure the agent names no code for is one plain line, its raw reason in the log. */
function answerVersionsRefusalText(r) { return answerVersionsErr().rewindErrorView(r, answerVersionsCodeText).text; }

/* ---- the window part ---- */

/* One chat's kept answers at a time, for the reply on screen (`key`: chat
   and row id, so a new reply or a redrawn chat asks again). */
const AVER = {supported: true, key: null, sid: null, data: null, view: null, busy: false};

function answerVersionsHTML(m) {
  if (!AVER.supported || typeof BR === 'undefined' || !BR || !BR.previousReplies) return '';
  if (!m || m.k !== 'assistant' || m.placeholder || S.busy || S.pending || !S.agentSession) return '';
  if (!isLastReply(m)) return '';
  const q = answerVersionsQuestion(S.log, m);
  if (!q) return '';
  const key = S.agentSession + '\n' + m.id;
  if (AVER.key !== key) { answerVersionsLoad(key, S.agentSession); return ''; }
  AVER.view = answerVersionsView(AVER.data, q.text, m.storedAt);
  return AVER.view ? answerVersionsSwitchHTML(AVER.view, AVER.busy) : '';
}

async function answerVersionsLoad(key, sid) {
  Object.assign(AVER, {key, sid, data: null, view: null});
  let r;
  try { r = await BR.previousReplies(sid); } catch (err) { r = {ok: false, supported: true, error: String(err)}; }
  if (AVER.key !== key) return;
  if (r && r.supported === false) { AVER.supported = false; return; }
  if (!r || !r.ok || !Array.isArray(r.previous) || !r.previous.length) return;   // nothing kept: no switcher
  AVER.data = r;
  render();
}

async function answerVersionsGo(dir) {
  const sid = AVER.sid;
  const index = answerVersionsStep(AVER.view, dir);
  if (index === null || AVER.busy || S.busy || S.pending || !sid || S.agentSession !== sid) return;
  AVER.busy = true;
  render();
  let r;
  try { r = await BR.restorePreviousReply(sid, index); } catch (err) { r = {ok: false, supported: true, error: String(err)}; }
  AVER.busy = false;
  if (r && r.supported === false) { AVER.supported = false; render(); toast('Not available', 'This agent version keeps no earlier answers. Update Atomic Agent.', 'bad'); return; }
  if (!r || !r.ok) {
    toast("Couldn't switch answers", answerVersionsRefusalText(r), 'bad');
    const stale = r && (r.code === 'no_previous_reply' || r.code === 'bad_index');
    if (!stale) { render(); return; }
  }
  /* Swapped (or the kept answers moved on without this window): the chat is
     drawn again from the agent, which also asks for the kept answers again. */
  AVER.key = null;
  if (S.agentSession === sid) await openSession(sid);
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-ver]') : null;
    if (!b || b.disabled) return;
    e.preventDefault();
    answerVersionsGo(b.dataset.ver === 'prev' ? -1 : 1);
  });
}

if (typeof module !== 'undefined') module.exports = {answerVersionsQuestion, answerVersionsOrder, answerVersionsView, answerVersionsStep,
  answerVersionsSwitchHTML, answerVersionsRefusalText, answerVersionsCodeText, AVER, answerVersionsHTML, answerVersionsGo};
