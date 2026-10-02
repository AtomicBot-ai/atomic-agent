/* ---------------- chat titles (agent 0.6.6 `agent.nameSessions`) ----------------
   Loaded before renderer.js; declares only.

   The agent names a session once, from its first prompt, with one short
   model call after the first answered turn, and stores the name in
   metadata.title. GET /api/sessions rows carry it as `title` (null until
   written); GET /api/sessions/{id} has it under metadata.title, which is
   how an agent whose list route predates `title` is still read.

   The name lands AFTER the turn that earns it has returned (the call has a
   20 s ceiling, SESSION_TITLE_TIMEOUT_MS), so the list read at the end of
   the turn usually has no title yet. sessionTitleFollowUp re-reads the list
   a few times until it does, then stops. */

const NAMES = {busy:false, error:null, note:null, followUps:new Set()};
const TITLE_FOLLOW_UP_MS = [4000, 12000, 24000];

/** The stored title as the agent trims it (readSessionTitle), or null. */
function sessionTitleOf(raw) {
  const t = raw && typeof raw.title === 'string' ? raw.title.trim() : '';
  return t ? t : null;
}
/** Same, from a full session state (GET /api/sessions/{id}). */
function sessionTitleFromState(state) {
  return sessionTitleOf(state && state.metadata);
}

/** After a turn on `sid` ends: pick up the title the agent is about to write. */
function sessionTitleFollowUp(sid) {
  if (!sid || NAMES.followUps.has(sid) || !nameChatsOn()) return;
  const row = SESSIONS.find((x) => x.id === sid);
  if (!row || row.titled) return;
  NAMES.followUps.add(sid);
  let i = 0;
  const next = () => {
    const cur = SESSIONS.find((x) => x.id === sid);
    if (!cur || cur.titled || i >= TITLE_FOLLOW_UP_MS.length) { NAMES.followUps.delete(sid); return; }
    setTimeout(() => { refreshSessions().then(next, next); }, TITLE_FOLLOW_UP_MS[i++]);
  };
  next();
}

/** agent.nameSessions: absent reads as the schema default, true. */
function nameChatsOn() {
  const a = LIVE_CONFIG && LIVE_CONFIG.agent;
  return !(a && a.nameSessions === false);
}

/* Settings › General row. Same parts as the analytics row: title, one
   line of description and the switch (renderer.js setSwitchHTML). */
function nameChatsRowHTML() {
  const known = !!LIVE_CONFIG;
  const on = known && nameChatsOn();
  return '<div class="tk-setrow">'
      + '<div class="body"><div class="t">Name chats automatically</div>'
        + '<div class="d">Titles each new chat from your first message, with one short model call.</div>'
        + (NAMES.note ? '<div class="tk-help">' + esc(NAMES.note) + '</div>' : '')
        + (NAMES.error ? '<div class="tk-help tk-help--warn">' + esc(NAMES.error) + '</div>' : '')
      + '</div>'
      + setSwitchHTML({on, busy: NAMES.busy, disabled: !known || NAMES.busy || !BR, act: 'names:toggle',
        label: 'Name chats automatically', title: 'Turn chat naming ' + (on ? 'off' : 'on')})
    + '</div>';
}

async function nameChatsSet(enabled) {
  if (!BR || NAMES.busy) return {ok:false, error:'busy'};
  NAMES.busy = true; NAMES.error = null; NAMES.note = null; render();
  const res = await configPatchOr({agent:{nameSessions:!!enabled}}, () => BR.configSet('agent.nameSessions', String(!!enabled)));
  if (!res.ok) NAMES.error = 'Could not save: ' + res.error;
  else if (!res.live) NAMES.note = 'Saved. Restart Atomic Agent to apply.';
  await refreshLiveConfig();
  NAMES.busy = false; render();
  return res;
}

if (typeof window !== 'undefined') {
  // --smoke: the General switch and the titles the rail shows.
  window.__nameChats = () => ({on:nameChatsOn(), busy:NAMES.busy, error:NAMES.error, note:NAMES.note});
  window.__nameChatsSet = (on) => nameChatsSet(on);
  window.__sessionTitles = () => SESSIONS.map((s) => ({id:s.id, t:s.t, titled:!!s.titled}));
}
