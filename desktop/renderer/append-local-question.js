/* ATO-1461: the desktop's side of the agent's one-time question for people
   who had "Use local models as the last resort" turned on before v0.7.0
   (GET/POST /api/fallback/local-question). The agent keeps the answer in
   the shared ~/.atomic-agent, so a question answered in the terminal is not
   asked here and the other way round. Shared by the renderer and Node
   checks; no DOM, no IPC of its own. */

/* `api.read()`         → {supported:false} | {supported:true, ok:true, status} | {supported:true, ok:false, error}
   `api.answer(answer)` → {supported:false} | {ok:true, status} | {ok:false, error}
   An agent without the route (supported:false) shows nothing and changes nothing. */
function createAppendLocalQuestion(api) {
  const st = {supported: null, question: null, busy: false, error: null, dismissed: false, serial: 0};
  function apply(status) {
    st.question = !st.dismissed && status && typeof status.question === 'string' && status.question ? status : null;
  }
  return {
    state: st,
    async check() {
      if (st.supported === false) return null;
      const mine = ++st.serial;
      const res = await Promise.resolve().then(() => api.read()).catch(error => ({supported: true, ok: false, error: String(error)}));
      if (mine !== st.serial) return st.question;
      if (!res || res.supported === false) { st.supported = false; apply(null); return null; }
      st.supported = true;
      if (!res.ok) { st.error = res.error || 'could not read the fallback setting'; return st.question; }
      st.error = null; apply(res.status);
      return st.question;
    },
    /* Another agent is on the wire: it may have the route the last one lacked. */
    reset() { st.supported = null; st.serial++; st.busy = false; st.error = null; apply(null); },
    /* "Not now": closed until the app starts again, as the terminal's Esc. Nothing is recorded. */
    dismiss() { st.dismissed = true; st.question = null; },
    /* Keep / Turn off on the card, or Keep when the person turns the switch on themselves. */
    async answer(answer) {
      if (st.busy || (answer !== 'keep' && answer !== 'off')) return {ok: false};
      st.busy = true; st.serial++;
      const res = await Promise.resolve().then(() => api.answer(answer)).catch(error => ({ok: false, error: String(error)}));
      st.busy = false;
      if (!res || res.supported === false) { st.supported = false; apply(null); return {ok: false, unsupported: true}; }
      if (res.ok) { st.error = null; apply(res.status); }
      else st.error = res.error || 'could not save the answer';
      return res;
    },
  };
}

if (typeof module !== 'undefined') module.exports = {createAppendLocalQuestion};
