/* ---------------- ATO-2755: "Atomic Agent needs your OK" ----------------
   Loaded after renderer.js (and mini-chat-handoff.js), in the main window
   only. A request on agent:approval is first drawn by renderer.js
   (onApprovalEvent, registered before this file runs, so it has already
   placed the card on screen or kept it for its chat). Then this file tells
   main what the card says (approvalNotify:describe): the chat's title as
   the sidebar shows it, the card's own question in plain text (apprAsk),
   and whether the card is in the chat on screen. Main decides whether a
   notification goes up (main/approval-notify.ts): one per request, none
   while the window is focused on that chat, under tui.notify.enabled.

   A click on the notification brings the window up and says so
   (approvalNotify:open); this file then takes the chat (approvalNotify:take)
   and opens it the way "Open in big window" does (mchoOpen): openSession
   draws the chat's kept card. A card that went meanwhile (answered in the
   TUI or on the phone, its turn over) leaves just the chat to open.

   The events stream says nothing when a request ends elsewhere, so this
   file also lists the cards still open (approvalNotify:pending, on a change
   and every 5 s); main closes the notification of one no longer listed.

   Reads renderer.js's globals (BR, S, APPROVAL_CARDS, chatApprovalCards,
   approvalOpen, approvalOnScreen, apprAsk, chatById, openSession, act) only
   when it runs. The pure part is exported for the unit suite at the bottom. */

const APN_ENTITIES = {'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'"};

/** The card's html words (apprAsk) as plain text for a notification. */
function apnPlain(html) {
  return String(html == null ? '' : html)
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (all) => APN_ENTITIES[all])
    .replace(/\s+/g, ' ')
    .trim();
}

/** The card this window holds for a request (on screen, or kept for its chat), or null. */
function apnFindCard(approvalId, sid, places) {
  const p = places || {};
  const match = (m) => !!m && m.k === 'approval' && m.approvalId === approvalId && !m.stored;
  const kept = sid && p.kept ? p.kept.get(sid) : null;
  if (match(kept)) return kept;
  const here = (p.log || []).find(match);
  if (here) return here;
  return sid && typeof p.forChat === 'function' ? (p.forChat(sid) || []).find(match) || null : null;
}

/**
 * What main is told about an open card. `ctx`: ask (apprAsk), chat (the
 * chat's title), onScreen (the card is in the chat in front of the person).
 */
function apnDescribe(card, ctx) {
  const c = ctx || {};
  const question = !!card.question || card.cat === 'user_question';
  const prompt = card.question && typeof card.question.prompt === 'string' ? card.question.prompt : '';
  const action = question ? (prompt || 'The agent has a question for you.') : apnPlain(typeof c.ask === 'function' ? c.ask(card) : '');
  return {
    approvalId: card.approvalId,
    sessionId: card.sessionId || null,
    chat: typeof c.chat === 'string' ? c.chat : '',
    action,
    question,
    onScreen: c.onScreen === true,
  };
}

/** One agent:approval frame, after renderer.js drew it: tell main when its card is open. */
function apnOnApproval(payload) {
  const B = typeof window !== 'undefined' ? window.atomic : null;
  if (!B || typeof B.approvalNotify !== 'function' || !payload || typeof payload.approvalId !== 'string') return;
  const sid = payload.sessionId || null;
  const card = apnFindCard(payload.approvalId, sid, {
    kept: typeof APPROVAL_CARDS !== 'undefined' ? APPROVAL_CARDS : null,
    log: typeof S !== 'undefined' ? S.log : [],
    forChat: typeof chatApprovalCards === 'function' ? chatApprovalCards : null,
  });
  if (!card || (typeof approvalOpen === 'function' && !approvalOpen(card))) return;
  const drawnHere = S.log.includes(card) || (typeof approvalOnScreen === 'function' && approvalOnScreen(sid));
  const row = sid && typeof chatById === 'function' ? chatById(sid) : null;
  B.approvalNotify(apnDescribe(card, {
    ask: typeof apprAsk === 'function' ? apprAsk : null,
    chat: row && row.t ? String(row.t) : '',
    onScreen: drawnHere && (S.room || 'chat') === 'chat' && !S.settings,
  }));
}

/** The ids of every open card in `lists` (each an array of rows), sorted, once each. */
function apnOpenIds(lists, isOpen) {
  const ids = new Set();
  for (const list of lists || []) {
    for (const m of list || []) {
      if (m && m.k === 'approval' && !m.stored && typeof m.approvalId === 'string' && (!isOpen || isOpen(m))) ids.add(m.approvalId);
    }
  }
  return [...ids].sort();
}

let APN_LAST = null;
/** Tells main which cards are still open (a notification whose card went closes): on a change, and every few seconds. */
function apnSyncPending(force) {
  const B = typeof window !== 'undefined' ? window.atomic : null;
  if (!B || typeof B.approvalNotifyPending !== 'function' || typeof S === 'undefined') return;
  const lists = [S.log];
  if (typeof LIVE_TURNS !== 'undefined') for (const rec of LIVE_TURNS.values()) if (rec && Array.isArray(rec.log)) lists.push(rec.log);
  if (typeof APPROVAL_CARDS !== 'undefined') lists.push([...APPROVAL_CARDS.values()]);
  const ids = apnOpenIds(lists, typeof approvalOpen === 'function' ? approvalOpen : null);
  const key = ids.join(',');
  if (!force && key === APN_LAST) return;
  APN_LAST = key;
  B.approvalNotifyPending(ids);
}

/** approvalNotify:take's answer → the chat id to open, or null. */
function apnTarget(res) {
  const id = res && typeof res.sessionId === 'string' ? res.sessionId.trim() : '';
  return /^[A-Za-z0-9_.:-]{1,200}$/.test(id) ? id : null;
}

let APN_BUSY = null;
/** Takes the chat a clicked notification names and opens it on its card. */
function apnTakeAndOpen() {
  const B = typeof window !== 'undefined' ? window.atomic : null;
  if (!B || typeof B.approvalNotifyTake !== 'function') return Promise.resolve(false);
  const run = async () => {
    const id = apnTarget(await B.approvalNotifyTake().catch(() => null));
    if (!id) return false;
    // The card is the one thing to look at: Settings closes, as for a deep link.
    if (S.settings) S.settings = null;
    if (id === S.sessionId && S.room === 'chat') { render(); return true; }
    if (typeof mchoOpen === 'function') {
      return mchoOpen(id, {
        liveTurns: B.liveTurns ? () => B.liveTurns() : null,
        adopt: typeof adoptLiveTurns === 'function' ? adoptLiveTurns : null,
        open: openSession,
        replay: B.replayApprovals ? () => B.replayApprovals() : null,
        refresh: null,
      });
    }
    act('ses:' + id);
    return true;
  };
  APN_BUSY = (APN_BUSY || Promise.resolve()).then(run, run);
  return APN_BUSY;
}

if (typeof window !== 'undefined' && window.atomic && typeof window.atomic.onApproval === 'function') {
  window.atomic.onApproval((p) => { apnOnApproval(p); apnSyncPending(false); });
  // A turn that ends, stops or is answered elsewhere takes its card with it.
  let apnSoon = null;   // one look per burst of frames, not one per streamed token
  if (typeof window.atomic.onChat === 'function') window.atomic.onChat(() => {
    if (!apnSoon) apnSoon = setTimeout(() => { apnSoon = null; apnSyncPending(false); }, 250);
  });
  setInterval(() => apnSyncPending(true), 5000);
  if (typeof window.atomic.onApprovalNotifyOpen === 'function') window.atomic.onApprovalNotifyOpen(() => { apnTakeAndOpen(); });
  // A window opened again by the click: the chat is taken once the page is up.
  if (document.readyState === 'complete') apnTakeAndOpen();
  else window.addEventListener('load', () => { apnTakeAndOpen(); }, {once: true});
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {apnPlain, apnFindCard, apnDescribe, apnTarget, apnOpenIds};
}
