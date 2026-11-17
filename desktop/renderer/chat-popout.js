/* ---------------- ATO-561: "Open in new window" on a chat row ----------------
   Loaded after renderer.js, in the main window only. The row menu's item
   (chat-list.js chatMenuItems `windowable`) asks main to show the chat in a
   window of its own (main/chat-popout-ipc.ts), which loads the mini chat page
   for that chat. Main focuses the chat's window when it already has one, and
   refuses a chat whose reply is still being written; a turn this window is
   streaming is refused here first, with the same words.

   Reads renderer.js's globals (BR, RUNNING, toast) only when it runs. The
   pure part is exported for test/chat-popout.test.mjs. */

const CWO_LIVE_LINE = 'A reply is still being written in this chat. Open it in its own window once it is done.';

/** Whether a turn this window streams belongs to chat `id` (RUNNING: turnId → sessionId). */
function cwoStreamsHere(running, id) {
  if (!id || !running || typeof running.values !== 'function') return false;
  for (const sid of running.values()) if (sid === id) return true;
  return false;
}

/** The toast for main's answer, or null when the window opened or was focused. */
function cwoAnswerToast(res) {
  if (res && res.ok) return null;
  return {title: 'Could not open the chat in a new window', sub: (res && typeof res.error === 'string' && res.error) || ''};
}

/** The row menu offers the item only where the preload has the route. */
function chatPopoutCanOffer() {
  const B = typeof window !== 'undefined' ? window.atomic : null;
  return !!B && typeof B.chatPopoutOpen === 'function';
}

function chatPopoutOpen(id) {
  const B = typeof window !== 'undefined' ? window.atomic : null;
  if (!id || !B || typeof B.chatPopoutOpen !== 'function') return Promise.resolve(false);
  const say = (t) => { if (t && typeof toast === 'function') toast(t.title, t.sub); };
  if (typeof RUNNING !== 'undefined' && cwoStreamsHere(RUNNING, id)) {
    say({title: 'Could not open the chat in a new window', sub: CWO_LIVE_LINE});
    return Promise.resolve(false);
  }
  return B.chatPopoutOpen(id).then((res) => {
    say(cwoAnswerToast(res));
    return !!(res && res.ok);
  }, (err) => {
    say(cwoAnswerToast({ok: false, error: err && err.message}));
    return false;
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {cwoStreamsHere, cwoAnswerToast, CWO_LIVE_LINE};
}
