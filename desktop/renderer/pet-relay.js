/* ---------------- ATO-2391: the desktop pet's Allow / Deny, answered here ----------------
   Loaded after renderer.js, in the main window only. The pet's bubble
   (pet.html) offers Allow once and Deny for a request this window also got
   on agent:approval. Main hands the click over (pet:relayAnswer), and this
   window answers it with its own card's code (answerLive), exactly as a
   click on the card's Allow once / Deny: the card closes with its receipt,
   the chat's dot goes, the analytics count it, and the answer goes out on
   agent:approve like any other.

   A request this window holds no open card for (never drawn here, already
   answered, a question) is not taken: `handled: false`, and main answers it
   itself through agent:approve's own function. Never both.

   Reads renderer.js's globals (BR, S, APPROVAL_CARDS, LIVE_TURNS,
   approvalOpen, answerLive) only when it runs. The pure part is exported
   for the unit suite at the bottom. */

/** Every approval card this window holds: on screen, in a turn kept for its chat, kept to be drawn later. */
function petRelayCards(log, kept, liveTurns) {
  const out = [];
  const take = (m) => { if (m && m.k === 'approval' && !m.stored && !out.includes(m)) out.push(m); };
  (log || []).forEach(take);
  for (const rec of (liveTurns ? liveTurns.values() : [])) if (rec && Array.isArray(rec.log)) rec.log.forEach(take);
  for (const m of (kept ? kept.values() : [])) take(m);
  return out;
}

/** The open card of that request, or null. `isOpen` is renderer.js approvalOpen. */
function petRelayPick(cards, approvalId, isOpen) {
  if (typeof approvalId !== 'string' || !approvalId) return null;
  return cards.find((m) => m.approvalId === approvalId && !m.question && !m.answering && isOpen(m)) || null;
}

/** The card's own key for the pet's answer: y is Allow once, n is Deny. Nothing else. */
function petRelayKey(decision) {
  return decision === 'allow' ? 'y' : decision === 'deny' ? 'n' : null;
}

/** Main's relay → answered by the card (true), or not taken (false). */
function petRelayAnswer(msg) {
  const key = petRelayKey(msg && msg.decision);
  if (!key) return false;
  const req = petRelayPick(petRelayCards(S.log, APPROVAL_CARDS, LIVE_TURNS), msg.approvalId, approvalOpen);
  if (!req) return false;
  // Once the card's code has the answer it is this window's, even if a redraw throws: main must not send it again.
  try { answerLive(req, key); } catch (e) { /* drawn wrong, answered right */ }
  return true;
}

if (typeof BR !== 'undefined' && BR && BR.onPetRelay) {
  BR.onPetRelay((msg) => {
    let handled = false;
    try { handled = petRelayAnswer(msg); } catch (e) { handled = false; }
    if (msg && typeof msg.reqId === 'string') BR.petRelayResult(msg.reqId, handled);
  });
}

if (typeof module !== 'undefined') module.exports = {petRelayCards, petRelayPick, petRelayKey};
