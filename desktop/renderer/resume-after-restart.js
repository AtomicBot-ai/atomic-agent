/* ---------------- ATO-2768: Continue in the chat a crash cut off ----------------
   Loaded before renderer.js. When the agent exits on its own, main starts it
   again (ATO-767, main/agent-auto-restart.ts) and the window adds "The agent
   stopped unexpectedly and was restarted." (autoRestartApply). The new
   agent's boot sweep records the turn the exit cut off as cancelled with
   "turn interrupted: the agent stopped before it finished"
   (src/session/session-store.ts INTERRUPTED_TURN_ENDING), and ATO-448 offers
   a Continue row for such a chat. That row was only added when a chat was
   opened, so the chat on screen when the agent died showed the failed reply
   and no way to pick it up again.

   On the `restarted` notice the chat on screen is read again; when the agent
   says its last turn was cut off, the same ATO-448 row goes under it. It
   stays a click: the continuing turn may repeat side effects, so it is never
   sent by itself (ChatGPT and Claude.ai offer Retry on a reply a dropped
   connection cut, they do not resend it).

   renderer.js passes its own state in, so test/resume-after-restart.test.mjs
   drives this with stand-ins. */

const RESUME_AFTER_RESTART = {seq: 0};

/** The chat holds the ATO-448 Continue row already. */
function hasResumeOffer(log) {
  return Array.isArray(log) && log.some((x) => x && x.k === 'system' && x.act === 'resume-turn');
}

/**
 * After the agent came back from a crash: add the Continue row to the chat on
 * screen when its last turn was cut off. `deps` = {S, BR, offerFor, render},
 * where offerFor is renderer.js interruptedTurnOffer. Resolves true when the
 * row was added.
 */
async function offerResumeAfterRestart(deps) {
  const {S, BR, offerFor, render} = deps || {};
  if (!S || !BR || typeof BR.session !== 'function' || typeof offerFor !== 'function') return false;
  const sid = S.agentSession;
  const screen = S.sessionId;
  if (!sid) return false;
  const seq = ++RESUME_AFTER_RESTART.seq;   // a second restart's read supersedes this one
  let res;
  try { res = await BR.session(sid); } catch { return false; }
  // The person opened another chat, or started a new one, while this was read.
  if (seq !== RESUME_AFTER_RESTART.seq || S.agentSession !== sid || S.sessionId !== screen) return false;
  if (!res || !res.ok || !res.data) return false;
  if (hasResumeOffer(S.log)) return false;
  // A turn running (or waiting for an approval) here gets no offer, as in openSession.
  const offer = offerFor(res.data, !!(S.busy || S.pending));
  if (!offer) return false;
  S.log.push(offer);
  if (typeof render === 'function') render();
  return true;
}

if (typeof module !== 'undefined') module.exports = {offerResumeAfterRestart, hasResumeOffer};
