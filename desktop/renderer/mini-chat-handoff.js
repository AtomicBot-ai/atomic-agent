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

   Reads renderer.js's globals (BR, adoptLiveTurns, openSession,
   refreshSessions, render) only when it runs. The pure part is exported for
   the unit suite at the bottom. */

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
  // A window created by the click itself: what is waiting is asked for once the page is up.
  if (document.readyState === 'complete') mchoTakeAndOpen();
  else window.addEventListener('load', () => { mchoTakeAndOpen(); }, {once: true});
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {mchoTarget, mchoOpen};
}
