/* ---------------- ATO-1063: the main window opens a chat the mini window started ----------------
   Loaded after renderer.js, in the main window only. The mini chat page
   (mini-chat.html) runs its chat through the same agent:chat route, so main
   keeps its live-turn record; this window never started that turn and so
   ignores its frames. "Open in big window" there leaves the chat's id with
   main (main/mini-chat-ipc.ts) and says so (mini:openSession); a window
   opened again from closed asks at load.

   Opening it goes the way this window takes over turns at boot: the live
   turns first (adoptLiveTurns, so a reply still being written is this
   window's from here and draws into the chat when it opens), then the chat
   itself, then the approvals still pending are replayed so a request of
   that turn finds its chat and its card. A turn already over is simply its
   stored transcript.

   The chats the mini window started are known here before that (main tells
   them, mini:sessionKnown, and lists them at load, mini:sessions). This
   window never saw their turns start, so an approval of one had no chat to
   be kept for (approvalReachable) and was drawn, with live buttons, in
   whatever chat was on screen. approvalReachable asks mchoKnows: the request
   is kept for its own chat, with a stand-in row and its dot, until that chat
   is opened (here, or by "Open in big window").

   Reads renderer.js's globals (BR, adoptLiveTurns, openSession,
   refreshSessions, render, PENDING_CHATS, SESSIONS, chatTitle,
   renderSidebar) only when it runs. The pure part is exported for the unit
   suite at the bottom. */

const MCHO_KNOWN_MAX = 50;
/** sessionId → the first message, for the chats the mini window started. */
const MCHO_KNOWN = new Map();

/** Main's word about a mini chat → its id, noted in `known` (newest kept). Null when it is not one. */
function mchoNote(known, payload) {
  const id = mchoTarget(payload);
  if (!id) return null;
  const title = payload && typeof payload.title === 'string' ? payload.title.slice(0, 200) : '';
  known.delete(id);
  known.set(id, title);
  while (known.size > MCHO_KNOWN_MAX) known.delete(known.keys().next().value);
  return id;
}

/** approvalReachable: a chat the mini window started has a chat here to be kept for. */
function mchoKnows(sid) {
  return !!sid && MCHO_KNOWN.has(sid);
}

/**
 * Where an approval goes in this window, the way onApprovalEvent decides:
 * drawn in the chat on screen, or kept for its own. `reachable` is
 * approvalReachable without the mini chats; `known` the mini chats.
 */
function mchoApprovalPlace(sid, screenSid, reachable, known) {
  const onScreen = !sid || sid === screenSid;
  return !onScreen && (reachable || (!!sid && known.has(sid))) ? 'kept' : 'here';
}

/** A known mini chat not on the list yet gets the stand-in row a new chat's first turn gets (its dot says it waits). */
function mchoStandIn(sid) {
  if (!mchoKnows(sid) || typeof PENDING_CHATS === 'undefined' || typeof SESSIONS === 'undefined') return;
  if (PENDING_CHATS.has(sid) || SESSIONS.some((x) => x.id === sid)) return;
  const text = MCHO_KNOWN.get(sid) || '';
  PENDING_CHATS.set(sid, {id: sid, t: (typeof chatTitle === 'function' ? chatTitle(text) : text) || '(empty)',
    named: true, titled: false, updatedAt: Date.now(), status: '', turnCount: 0, pending: true, endedAt: null});
  if (typeof renderSidebar === 'function') renderSidebar();
}

/** mini:take's answer → the chat id to open, or null. */
function mchoTarget(res) {
  const id = res && typeof res.sessionId === 'string' ? res.sessionId.trim() : '';
  return /^[A-Za-z0-9_.:-]{1,200}$/.test(id) ? id : null;
}

/**
 * Opens chat `id` with the steps in `deps` (all optional, each awaited in
 * order): liveTurns → adopt → open → replay → refresh. Never throws.
 */
async function mchoOpen(id, deps) {
  const d = deps || {};
  if (!id || typeof d.open !== 'function') return false;
  try {
    if (typeof d.liveTurns === 'function' && typeof d.adopt === 'function') d.adopt(await d.liveTurns());
  } catch { /* the chat still opens; its reply shows once the turn is stored */ }
  try {
    await d.open(id);
  } catch {
    return false;
  }
  try { if (typeof d.replay === 'function') await d.replay(); } catch { /* the card comes with the next replay */ }
  try { if (typeof d.refresh === 'function') await d.refresh(); } catch { /* the list catches up later */ }
  return true;
}

let MCHO_BUSY = null;
/** Takes what is waiting and opens it; a second signal while one opens waits for it. */
function mchoTakeAndOpen() {
  const B = typeof window !== 'undefined' ? window.atomic : null;
  if (!B || typeof B.miniChatTake !== 'function') return Promise.resolve(false);
  const run = async () => {
    const id = mchoTarget(await B.miniChatTake().catch(() => null));
    if (!id) return false;
    return mchoOpen(id, {
      liveTurns: B.liveTurns ? () => B.liveTurns() : null,
      adopt: typeof adoptLiveTurns === 'function' ? adoptLiveTurns : null,
      open: typeof openSession === 'function' ? openSession : null,
      replay: B.replayApprovals ? () => B.replayApprovals() : null,
      refresh: typeof refreshSessions === 'function'
        ? () => refreshSessions().then(() => { if (typeof render === 'function') render(); })
        : null,
    });
  };
  MCHO_BUSY = (MCHO_BUSY || Promise.resolve()).then(run, run);
  return MCHO_BUSY;
}

if (typeof window !== 'undefined' && window.atomic && typeof window.atomic.onMiniChatOpen === 'function') {
  window.atomic.onMiniChatOpen(() => { mchoTakeAndOpen(); });
  if (typeof window.atomic.onMiniChatSession === 'function') {
    window.atomic.onMiniChatSession((p) => { const id = mchoNote(MCHO_KNOWN, p); if (id) mchoStandIn(id); });
  }
  // A reloaded window: the mini chats told before it loaded.
  if (typeof window.atomic.miniChatSessions === 'function') {
    window.atomic.miniChatSessions().then((list) => {
      if (Array.isArray(list)) for (const p of list) mchoNote(MCHO_KNOWN, p);
    }, () => {});
  }
  // A request of a mini chat whose stand-in row went (or never came): the row, and its dot, again.
  if (typeof window.atomic.onApproval === 'function') {
    window.atomic.onApproval((p) => { if (p && mchoKnows(p.sessionId)) mchoStandIn(p.sessionId); });
  }
  // A window created by the click itself: what is waiting is asked for once the page is up.
  if (document.readyState === 'complete') mchoTakeAndOpen();
  else window.addEventListener('load', () => { mchoTakeAndOpen(); }, {once: true});
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {mchoTarget, mchoOpen, mchoNote, mchoApprovalPlace, MCHO_KNOWN_MAX};
}
