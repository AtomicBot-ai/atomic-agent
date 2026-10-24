/* ---------------- Settings › Connections › Telegram: Restart agent (ATO-900 item 6) ----------------
   Loaded BEFORE renderer.js, so it only declares. Shared by the renderer and
   the Node checks (test/telegram-restart.test.mjs): the restart's own state,
   the words it shows, and the button every "restart the agent" line in the
   tab carries. No IPC, no timers and no storage here.

   The token, telegram.enabled and the owner are read by the agent when it
   starts, so the tab often has to ask for a restart. On a real build that
   line had only a small tertiary button, and the person took "restart" to
   mean quitting the whole app. Every such line now has a primary
   "Restart agent" beside it, says the app stays open, and the restart's
   result is shown in the same place: Restarting…, then connected (or what
   is still missing), or the error. */

const TG_RESTART_APPLY = 'Restart the agent to apply this. The app stays open.';
const TG_RESTARTING = 'Restarting the agent… The app stays open.';
const TG_RESTART_BUSY = 'A reply is still running. Restart the agent when it finishes.';

function tgRestartInitial() { return {phase:'idle', text:null}; }
function tgRestartStart() { return {phase:'restarting', text:TG_RESTARTING}; }
/* Refused before it began: a reply is running, and the restart would end it. */
function tgRestartRefused() { return {phase:'failed', text:TG_RESTART_BUSY}; }

/* What the restart left. `st` is the agent status BR.restart resolved with
   (`{state, error?}`), or null when the call itself failed; `view` is the tab
   read again after it: {hasToken, owner, enabled}. Returns a new state. */
function tgRestartResult(st, view) {
  if (!st || st.state !== 'connected') {
    const why = st && typeof st.error === 'string' && st.error.trim() ? st.error.trim().replace(/\.$/, '') : 'no reason given';
    return {phase:'failed', text:'The agent did not start again: ' + why + '. Press Restart agent to try again.'};
  }
  const v = view || {};
  if (v.hasToken !== true) return {phase:'done', text:'The agent restarted.'};
  if (v.owner === null || v.owner === undefined) return {phase:'done', text:'The agent restarted. Press Pair to confirm your Telegram account.'};
  if (v.enabled !== true) return {phase:'done', text:'The agent restarted. Turn on Answer in Telegram for the bot to reply.'};
  return {phase:'done', text:'The agent restarted and the bot is connected. Message it in Telegram.'};
}

/* Whether the "restart owed" lines should step aside: the restart's own line says it now. */
function tgRestartSpeaks(r) { return !!r && (r.phase === 'restarting' || r.phase === 'failed'); }

/* The primary button beside every line that asks for a restart. `h`: {esc, ic}. */
function tgRestartButtonHTML(r, h) {
  const busy = !!r && r.phase === 'restarting';
  return '<button class="btn btn-p sm" data-act="telegram:restart" data-tg-restart' + (busy ? ' disabled' : '') + '>'
    + (busy ? '<span class="tk-spin"></span>Restarting…' : h.ic('refresh') + 'Restart agent') + '</button>';
}

/* The restart's own line, or '' at rest. A failure carries the button again. */
function tgRestartNoticeHTML(r, h) {
  if (!r || r.phase === 'idle' || !r.text) return '';
  const tone = r.phase === 'done' ? 'green' : r.phase === 'failed' ? 'red' : 'blue';
  const icon = r.phase === 'done' ? h.ic('check') : r.phase === 'failed' ? h.ic('alert') : '<span class="tk-spin"></span>';
  return '<div class="tk-notice tk-notice--' + tone + '" data-tg-restart-result="' + r.phase + '">' + icon
    + '<span class="grow">' + h.esc(r.text) + '</span>' + (r.phase === 'failed' ? tgRestartButtonHTML(r, h) : '') + '</div>';
}

if (typeof module !== 'undefined') {
  module.exports = {TG_RESTART_APPLY, TG_RESTARTING, TG_RESTART_BUSY,
    tgRestartInitial, tgRestartStart, tgRestartRefused, tgRestartResult, tgRestartSpeaks, tgRestartButtonHTML, tgRestartNoticeHTML};
}
