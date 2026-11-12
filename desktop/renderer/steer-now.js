/* ---------------- ATO-1183: "Steer now" on a queued message ----------------
   Loaded before renderer.js. The queue above the composer (.qtray / .qchip)
   showed what waits for the next turn and let the person remove it (×), but
   gave no other choice: a message sat there until the running turn ended.
   Now each chip carries a "Steer now" button while this chat's turn runs. It
   takes the message out of the queue and sends it through the same steer
   path a message typed under a running turn takes (steerOrQueue): the agent
   folds it into the turn, or refuses and it is parked again.

   The button must not go round in circles. The agent refuses a steer for two
   reasons (src/http/route-sessions.ts, POST /api/sessions/{id}/steer):
   - 409 "no turn accepting steers": the turn has already done its final
     drain (or there is no turn). Asking again in the same turn gets the same
     answer, so a message refused that way loses the button until a turn ends.
   - 429 "steering inbox ... is full": the turn has not read the steers it
     has yet. That clears as the turn moves on, so the button stays.
   A message with no session to ask (a new chat whose first turn has not
   reported its session yet) or with no steer bridge shows no button.

   The pure part is exported for test/steer-now.test.mjs. */

/* Messages the running turn refused for good (409), as a multiset like
   STEER.mine: one entry per refusal. Emptied when a turn ends. */
const STEER_NOW = {refused: []};

/** Whether a refused steer's answer means "not in this turn" (409), as
    opposed to "not yet" (429, inbox full) or a failed round trip. */
function steerNowRefusedForTurn(res) {
  if (!res) return false;                       // nothing was answered: try again is honest
  if (res.ok && res.steered) return false;      // accepted
  if (res.ok) return true;                      // 200 without steered: refused
  const err = String(res.error || '');
  if (/inbox[\s\S]*full/i.test(err)) return false; // 429: the turn will read its inbox
  return /no turn accepting steers|409/i.test(err);
}

/** Records `text` as refused for this turn when `res` says so. */
function steerNowNoteRefusal(text, res, state) {
  const st = state || STEER_NOW;
  if (steerNowRefusedForTurn(res)) st.refused.push(String(text));
}

/** A turn ended: every message may be asked again in the next one. */
function steerNowTurnEnded(state) {
  (state || STEER_NOW).refused.length = 0;
}

/**
 * Whether queued `text` gets the button. ctx: {running (this chat runs a turn
 * here), sid (the session the steer would go to), canSteer (the bridge has
 * steer), refused (the list above)}.
 */
function steerNowAvailable(text, ctx) {
  const c = ctx || {};
  if (!c.running || !c.sid || !c.canSteer) return false;
  return (c.refused || STEER_NOW.refused).indexOf(String(text)) < 0;
}

/**
 * Takes the message at `at` out of `queue` (in place) and returns the new
 * STEER.ahead: the watermark of refused steers parked ahead of ordinary
 * backlog drops by one when the message came from in front of it, as
 * unqueueMessage does. Out of range: nothing changes.
 */
function steerNowTake(queue, at, ahead) {
  if (!Array.isArray(queue) || !(at >= 0) || at >= queue.length) return ahead;
  queue.splice(at, 1);
  return at < ahead ? ahead - 1 : ahead;
}

/** The chip's button. deps: {esc}. */
function steerNowButtonHTML(i, deps) {
  const esc = (deps && deps.esc) || String;
  return '<button class="qsteer" data-steernow="' + esc(String(i)) + '"'
    + ' title="Send it into the running turn now" aria-label="Steer now">Steer now</button>';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {STEER_NOW, steerNowRefusedForTurn, steerNowNoteRefusal, steerNowTurnEnded,
    steerNowAvailable, steerNowTake, steerNowButtonHTML};
}
