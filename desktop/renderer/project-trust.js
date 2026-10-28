/* ATO-1250: the desktop's answer to the agent's project-trust question
   (GET/POST /api/project-trust, ATO-298). A folder's own skills and
   instruction files (AGENTS.md, .atomic-agent/skills, …) load only after
   the person trusts that folder; the agent keeps the answer per folder and
   asks only about items nobody answered yet, so "Don't trust" is not asked
   again. Shared by the renderer and Node checks; no DOM, no IPC of its own. */

function ptNames(list) {
  return Array.isArray(list) ? list.filter(x => typeof x === 'string') : [];
}

/* One plain line on what "Trust" would load. */
function projectTrustLine(status) {
  const pending = (status && status.pending) || {};
  const skills = ptNames(pending.skills), files = ptNames(pending.instructions);
  const parts = [];
  if (files.length) parts.push('the instructions in ' + files.join(', '));
  if (skills.length) parts.push((skills.length === 1 ? 'the skill ' : 'the skills ') + skills.join(', '));
  return 'Trust lets the agent read ' + (parts.join(' and ') || 'nothing new') + ' from this folder. '
    + "Don't trust loads nothing from it and is not asked again.";
}

/* What Settings shows about the folder: where things stand and which switch flips it. */
function projectTrustSummary(status) {
  if (!status) return null;
  const count = (v) => ptNames(v && v.skills).length + ptNames(v && v.instructions).length;
  const trusted = count(status.trusted), declined = count(status.declined), pending = count(status.pending);
  if (!trusted && !declined && !pending) return {state: 'none', text: 'This folder has no project skills or instruction files.', canTrust: false, canDecline: false};
  if (pending) return {state: 'pending', text: 'Not answered yet: nothing from this folder is loaded.', canTrust: true, canDecline: true};
  if (trusted && !declined) return {state: 'trusted', text: 'Trusted: this folder’s project skills and instructions load.', canTrust: false, canDecline: true};
  if (declined && !trusted) return {state: 'declined', text: 'Not trusted: nothing from this folder is loaded.', canTrust: true, canDecline: false};
  return {state: 'mixed', text: 'Partly trusted: ' + trusted + ' item' + (trusted === 1 ? '' : 's') + ' load, ' + declined + ' do not.', canTrust: true, canDecline: true};
}

/* `api.read(sessionId)` → {supported:false} | {supported:true, ok:true, status} | {supported:true, ok:false, error}
   `api.answer(body)`   → {supported:false} | {ok:true, status} | {ok:false, conflict:true, status} | {ok:false, error}
   An agent without the route (supported:false) shows nothing and changes nothing. */
function createProjectTrust(api) {
  const st = {supported: null, status: null, question: null, busy: false, error: null, dismissed: new Set(), serial: 0};
  const shown = (status) => !!(status && status.question && status.questionId && !st.dismissed.has(status.workingDir));
  function apply(status) {
    st.status = status || null;
    st.question = shown(status) ? status : null;
  }
  return {
    state: st,
    /* Re-read the folder of this chat (or the agent's own folder). A late answer for an older context is dropped. */
    async check(sessionId) {
      if (st.supported === false) return null;
      const mine = ++st.serial;
      const res = await Promise.resolve().then(() => api.read(sessionId)).catch(error => ({supported: true, ok: false, error: String(error)}));
      if (mine !== st.serial) return st.question;
      if (!res || res.supported === false) { st.supported = false; apply(null); return null; }
      st.supported = true;
      if (!res.ok) { st.error = res.error || 'could not read the folder'; return st.question; }
      st.error = null; apply(res.status);
      return st.question;
    },
    /* Another agent is on the wire (a remote one, or the local one again): it may have the route the last one lacked. */
    reset() {
      st.supported = null; st.serial++; st.busy = false; st.error = null; apply(null);
    },
    /* "Not now": closed until the app starts again, as the TUI's Esc. Nothing is recorded. */
    dismiss() {
      if (st.question) st.dismissed.add(st.question.workingDir);
      st.question = null;
    },
    /* The dialog's buttons: exactly the items the question listed. */
    async answer(kind, sessionId) {
      const q = st.question;
      if (!q || st.busy || (kind !== 'trust' && kind !== 'decline')) return {ok: false};
      return this.send({answer: kind, questionId: q.questionId}, sessionId);
    },
    /* Settings' switch: everything the folder ships, including earlier answers. */
    async setAll(trusted, sessionId) {
      if (!st.status || st.busy) return {ok: false};
      return this.send({answer: trusted ? 'trust' : 'decline', scope: 'all'}, sessionId);
    },
    async send(body, sessionId) {
      st.busy = true; st.serial++;
      const res = await Promise.resolve().then(() => api.answer(Object.assign(sessionId ? {sessionId} : {workingDir: st.status && st.status.workingDir}, body)))
        .catch(error => ({ok: false, error: String(error)}));
      st.busy = false;
      if (!res || res.supported === false) { st.supported = false; apply(null); return {ok: false, unsupported: true}; }
      if (res.status) apply(res.status);
      st.error = res.ok || res.conflict ? null : (res.error || 'could not save the answer');
      return res;
    },
  };
}

if (typeof module !== 'undefined') module.exports = {projectTrustLine, projectTrustSummary, createProjectTrust};
