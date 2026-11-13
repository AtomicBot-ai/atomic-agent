/* ---------------- ATO-1040: what the goal card's buttons do ----------------
   Loaded after goal-card.js and before renderer.js; runs only in the window.
   The decisions are the agent's (POST /api/sessions/{id}/goal, the TUI's
   /goal rules): this file asks, draws the answer, and sends the message the
   agent hands back for set and resume through the composer's own submit(),
   so the turn is queued, steered and drawn like any message. */

/** The chat's agent session, when it has one the agent stores already. */
function goalSessionId() {
  const sid = S.agentSession;
  return sid && !String(sid).startsWith('waiting-') ? sid : null;
}

function goalBusy() { return !!(S.busy || S.pending); }

/** The goal the agent stores for `sid` now (after a refusal: what it really is). */
async function goalRefresh(sid) {
  let res = null;
  try { res = await BR.goalGet(sid); } catch (e) { res = null; }
  if (res && res.ok && res.data && goalSet(sid, res.data.goal) && sid === S.agentSession) render();
}

async function goalStart() {
  if (GOAL_FORM.busy) return;
  const parsed = goalParseForm(GOAL_FORM.text, GOAL_FORM.rounds);
  const fail = (msg) => { GOAL_FORM.error = msg; render(); };
  if (!parsed.ok) return fail(parsed.error);
  const sid = goalSessionId();
  if (!sid) return fail('Send a first message in this chat, then set a goal.');
  if (goalBusy()) return fail('Wait for the reply to finish, then start the goal.');
  GOAL_FORM.busy = true; GOAL_FORM.error = ''; render();
  let res;
  try {
    res = await BR.goalAction(sid, {action: 'set', criteria: parsed.criteria, ...(parsed.maxRounds ? {maxRounds: parsed.maxRounds} : {})});
  } catch (e) {
    res = {ok: false, error: e && e.message};
  }
  GOAL_FORM.busy = false;
  if (!res || !res.ok || !res.data) return fail((res && res.error) || 'The goal could not be set.');
  goalSet(sid, res.data.goal);
  GOAL_FORM.open = false; GOAL_FORM.text = ''; GOAL_FORM.rounds = '';
  const message = typeof res.data.message === 'string' ? res.data.message : '';
  // The person opened another chat meanwhile: the goal waits on its own chat for a message there.
  if (S.agentSession !== sid) { toast('Goal set', 'Send a message in that chat to start it'); render(); return; }
  render();
  if (message) submit(message, {plain: true});
}

async function goalControl(verb) {
  const sid = goalSessionId();
  if (!sid || GOAL_PENDING.has(sid)) return;
  if (verb === 'resume' && goalBusy()) { toast('A reply is running', 'Resume the goal when it finishes'); return; }
  let res;
  try { res = await BR.goalAction(sid, {action: verb}); } catch (e) { res = {ok: false, error: e && e.message}; }
  if (!res || !res.ok || !res.data) {
    toast('Goal', (res && res.error) || 'The agent did not answer', 'bad');
    void goalRefresh(sid);
    return;
  }
  /* A pause or clear asked of a running goal lands after its round: the
     answer is the goal as it will be (null for a clear), so the card keeps
     the goal it shows, says "after this round", and the turn's end reads
     the stored goal (goalTurnEnded). */
  if (res.data.pending) GOAL_PENDING.set(sid, verb);
  else goalSet(sid, res.data.goal);
  if (sid === S.agentSession) render();
  if (verb === 'resume' && sid === S.agentSession && typeof res.data.message === 'string' && res.data.message) {
    submit(res.data.message, {plain: true});
  }
}

/** A turn of chat `sid` ended: a pause or clear asked of it has landed, so the stored goal replaces the card. */
async function goalTurnEnded(sid) {
  if (!sid || !GOAL_PENDING.has(sid)) return;
  await goalRefresh(sid);
  // The goal did not stop (the turn was cut short, the store did not answer): its buttons work again.
  if (GOAL_PENDING.delete(sid) && sid === S.agentSession) render();
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-goal-open]')) {
      e.preventDefault();
      GOAL_FORM.open = !GOAL_FORM.open;
      GOAL_FORM.error = GOAL_FORM.open && !goalSessionId() ? 'Send a first message in this chat, then set a goal.' : '';
      render();
      if (GOAL_FORM.open) { const box = document.getElementById('goal-criteria'); if (box) box.focus(); }
      return;
    }
    const form = t.closest('[data-goal-form]');
    if (form) {
      e.preventDefault();
      if (form.getAttribute('data-goal-form') === 'start') { void goalStart(); return; }
      GOAL_FORM.open = false; GOAL_FORM.error = ''; render();
      return;
    }
    const fold = t.closest('[data-goal-fold]');
    if (fold) {
      e.preventDefault();
      const sid = fold.getAttribute('data-goal-fold');
      if (GOAL_FOLD.has(sid)) GOAL_FOLD.delete(sid); else GOAL_FOLD.add(sid);
      render();
      return;
    }
    const act = t.closest('[data-goal-act]');
    if (act && !act.disabled) { e.preventDefault(); void goalControl(act.getAttribute('data-goal-act')); }
  });
  // The form keeps its draft across the window's redraws.
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t && t.id === 'goal-criteria') GOAL_FORM.text = t.value;
    else if (t && t.id === 'goal-rounds') GOAL_FORM.rounds = t.value;
  });
  /* Inside the form: Cmd/Ctrl+Enter starts the goal and Escape closes the
     form. Caught before the window's own keys, where Cmd+Enter sends the
     composer's draft and Escape stops a running reply. */
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!t || !t.closest || !t.closest('.goalform') || e.isComposing) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); GOAL_FORM.open = false; GOAL_FORM.error = ''; render(); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); void goalStart(); }
  }, true);
}
