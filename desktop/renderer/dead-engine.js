/* ---------------- the local model is not running (ATO-771, ATO-772) ----------------
   Loaded before renderer.js; declares only.

   A turn on the managed local model fails because the engine process is not
   running (it never started, or it died). The decision (ATO-771, option A):
   say so at once, "The local model isn't running.", with one button, "Start
   model", which runs the same start as Settings › Models. When the app's own
   supervisor (main/daemon-supervisor.ts) is already bringing the server back,
   the row waits for it instead of offering a second start.

   Two ways to know. A newer agent ends such a turn with a machine-readable
   reason, `local_engine_down` (on the error frame's `cause.kind`, or as its
   `reason` / `category`). Today's agent has no such reason: its sentence
   names a refused connection or a provider that is not answering, and that
   only means the engine is down when the route is the managed local model.
   renderer.js owns the rows (turnFailure, sysRowHTML, deadEngineStart). */

const DEAD_ENGINE_REASON = 'local_engine_down';
const DEAD_ENGINE_LINE = "The local model isn't running.";
const DEAD_ENGINE_WAIT = 'The app is starting it again.';
const DEAD_ENGINE_BACK = 'It is running again.';

/** Does the frame carry the agent's `local_engine_down` reason? */
function engineDownReasonIn(ev) {
  if (!ev) return false;
  const p = ev.payload || {};
  const code = DEAD_ENGINE_REASON;
  return (p.cause && p.cause.kind === code) || p.reason === code || p.kind === code
    || p.category === code || ev.category === code || ev.reason === code;
}

/** Words of an older agent that mean nothing answered on the local port. */
const ENGINE_DOWN_WORDS = /ECONNREFUSED|connection refused|connect refused|is not answering|isn't answering|not answering/i;

/**
 * Why a failed turn reads as the local model not running, or null.
 * `st.local`: the route is the managed local model (local-llama or a
 * llama-server entry on the managed port). `st.replied`: the endpoint
 * answered with a status, so something is listening.
 * 'reason' when the agent said so, 'refused' when the old wording says so
 * on the local route, null otherwise.
 */
function engineDownOf(ev, st) {
  if (engineDownReasonIn(ev)) return 'reason';
  if (!st || !st.local || st.replied) return null;
  const said = String((ev && ev.error) || '');
  return ENGINE_DOWN_WORDS.test(said) ? 'refused' : null;
}

/**
 * What the row offers right now. `watch`: the supervisor's open notice kind
 * (`restarting`, `restart_failed`, `restarted`, `gave_up`) or null.
 * `row.starting` / `row.started` / `row.startError`: this row's own Start.
 *   {kind: 'wait'}    the supervisor is bringing it back: no button, a note
 *   {kind: 'starting'} the row's Start is running: the button, disabled
 *   {kind: 'back'}    it is up again: no Start, the row's Try again stays
 *   {kind: 'start'}   the Start model button
 */
function deadEngineOffer(row, watch) {
  const r = row || {};
  if (r.starting) return {kind: 'starting'};
  if (r.started) return {kind: 'back'};
  if (watch === 'restarting' || watch === 'restart_failed') return {kind: 'wait'};
  if (watch === 'restarted') return {kind: 'back'};
  return {kind: 'start'};
}

if (typeof module !== 'undefined') {
  module.exports = {DEAD_ENGINE_REASON, DEAD_ENGINE_LINE, DEAD_ENGINE_WAIT, DEAD_ENGINE_BACK, engineDownReasonIn, engineDownOf, deadEngineOffer};
}
