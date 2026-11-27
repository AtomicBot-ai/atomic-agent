/* ---------------- ATO-586: incognito chat ----------------
   Loaded before renderer.js; the pure half is shared with the Node checks
   (test/incognito-chat.test.mjs).

   An incognito chat neither reads nor writes memory, can leave no tasks
   behind, is never listed, and is deleted when it is closed (core PR #1515).
   Copied from ChatGPT's Temporary Chat and Claude's incognito chat: it is
   chosen on a NEW chat (the chip above an empty composer, "New incognito
   chat" in ⌘K, or `/incognito` as in the TUI), the chat says so for as long
   as it is open, it never goes on the chat list, and leaving it (New chat,
   opening another chat) deletes it. There is no way back to it.

   The id is fixed by main before the first message (incognito:open), so the
   first turn already carries `incognito: true`, and main sends the flag with
   every later turn too (main/incognito-chats.ts). The desktop restarts the
   agent on some actions, such as a model switch, and the new agent deletes
   the incognito chats the old one held; the next turn then opens the chat
   again under the same id, still incognito, but the agent no longer has the
   earlier messages. The chat says so once, after such a restart.

   State: INCOG.armed is the toggle on an empty new chat; INCOG.id is the
   chat's id once armed (from main); INCOG.sent is true from its first
   message; INCOG.restarted is an agent restart seen since then. */

const INCOG = {armed: false, id: null, sent: false, restarted: false, noted: false};

const INCOG_BANNER = "Incognito chat: not saved to your chats or memory. When you leave this chat, it is deleted and can't be brought back.";
const INCOG_RESTART_LINE = "The agent restarted, so it no longer has this incognito chat's earlier messages. The chat is still incognito and nothing was saved.";

/** True while the chat on screen is the incognito one (armed, or under way). */
function incognitoOn(sessionId) {
  if (!INCOG.id) return false;
  return !sessionId || sessionId === INCOG.id;
}

/**
 * The session the next turn goes to when the window has none yet: the
 * incognito chat's own id, or undefined for an ordinary new chat. The first
 * call after arming marks the chat as under way.
 */
function incognitoSessionForNewChat() {
  if (!INCOG.armed || !INCOG.id) return undefined;
  INCOG.sent = true;
  return INCOG.id;
}

/** An empty new chat whose first message will open an incognito chat. */
function incognitoArmed() {
  return INCOG.armed && !!INCOG.id;
}

/** Turn incognito on for the empty new chat on screen. `bridge.incognitoOpen` gives the id. */
async function incognitoArm(bridge) {
  if (INCOG.armed) return true;
  if (!bridge || typeof bridge.incognitoOpen !== 'function') return false;
  let r = null;
  try { r = await bridge.incognitoOpen(); } catch { r = null; }
  if (!r || !r.ok || typeof r.id !== 'string') return false;
  Object.assign(INCOG, {armed: true, id: r.id, sent: false, restarted: false, noted: false});
  return true;
}

/**
 * Leave the incognito chat (New chat, another chat, or the toggle on a chat
 * that has no message yet). `nextId`: the chat being opened; leaving for the
 * incognito chat itself is no leave. Main forgets the id and the agent
 * deletes the chat.
 */
function incognitoLeave(bridge, nextId) {
  if (!INCOG.id || (nextId && nextId === INCOG.id)) return false;
  const id = INCOG.id;
  Object.assign(INCOG, {armed: false, id: null, sent: false, restarted: false, noted: false});
  if (bridge && typeof bridge.incognitoClose === 'function') Promise.resolve(bridge.incognitoClose(id)).catch(() => {});
  return true;
}

/* ATO-2748: leaving still deletes the chat (ATO-586), but once something
   was sent it asks first, once, with the app's confirm (S.alert), as
   Firefox does before closing a private window that has content. An empty
   incognito chat leaves silently. INCOG_PENDING.then is the leave that was
   asked about (New chat, opening another chat); Delete chat runs it. */
const INCOG_PENDING = {then: null};
const INCOG_LEAVE_TITLE = 'Leave and delete this chat?';
const INCOG_LEAVE_MSG = "This incognito chat is not saved anywhere, so it can't be brought back.";
const INCOG_LEAVE_RUNNING = 'The reply still being written is deleted with it.';

/** Leaving for `nextId` (none: a new chat) asks first: only an incognito chat with a sent message, and not when reopening it. */
function incognitoLeaveNeedsAsk(nextId) {
  return !!INCOG.id && INCOG.sent && !(nextId && nextId === INCOG.id);
}

/** The confirm (S.alert shape). `running`: a turn of the incognito chat is still under way. */
function incognitoLeaveAlert(running) {
  return {title: INCOG_LEAVE_TITLE, msg: running ? INCOG_LEAVE_MSG + ' ' + INCOG_LEAVE_RUNNING : INCOG_LEAVE_MSG,
    ok: 'Delete chat', cancel: 'Stay', act: 'incogleave:go'};
}

/**
 * Before a leave: true when it was held for the question (the caller stops
 * there), false when it may go on now. `then` is the leave itself, run on
 * Delete chat; `closeFn` takes other overlays down first.
 */
function incognitoLeaveAsk(nextId, then, closeFn) {
  if (!incognitoLeaveNeedsAsk(nextId) || typeof S === 'undefined') return false;
  if (typeof closeFn === 'function') closeFn();
  const running = typeof RUNNING !== 'undefined' && [...RUNNING.values()].includes(INCOG.id);
  INCOG_PENDING.then = then;
  S.alert = incognitoLeaveAlert(running);
  if (typeof render === 'function') render();
  return true;
}

/** Delete chat on the confirm: delete it, then do the leave that was asked about. */
function incognitoLeaveGo(bridge) {
  const then = INCOG_PENDING.then;
  INCOG_PENDING.then = null;
  if (typeof S !== 'undefined') S.alert = null;
  incognitoLeave(bridge);
  if (typeof then === 'function') then();
  else if (typeof render === 'function') render();
}

/** An agent status (agent:status). A start after the first message means the agent lost the chat. */
function incognitoStatus(status) {
  const state = status && status.state;
  if (state === 'starting' && INCOG.id && INCOG.sent) { INCOG.restarted = true; INCOG.noted = false; return ''; }
  if (state === 'connected' && INCOG.restarted && !INCOG.noted) { INCOG.noted = true; return INCOG_RESTART_LINE; }
  return '';
}

/**
 * Above the composer: on an empty new chat, the toggle; on the incognito
 * chat, the banner (with Turn off until its first message). '' otherwise.
 * `st`: {sessionId, empty}; `h`: {esc, ic}.
 */
function incognitoBarHTML(st, h) {
  const icon = h.ic ? h.ic('eyeOff') : '';
  if (incognitoOn(st.sessionId)) {
    const off = INCOG.sent ? '' : '<button class="btn sm incog-off" data-incog="off">Turn off</button>';
    return '<div class="incogbar" role="status">' + icon + '<span class="incog-tx">' + h.esc(INCOG_BANNER) + '</span>' + off + '</div>';
  }
  if (!st.sessionId && st.empty) {
    return '<div class="incogbar incog-idle"><button class="incogchip" data-incog="on" title="Not saved to your chats or memory; deleted when you leave it">'
      + icon + '<span>Incognito</span></button></div>';
  }
  return '';
}

if (typeof document !== 'undefined') {
  const bridge = typeof window !== 'undefined' ? window.atomic : null;
  const repaint = () => { if (typeof render === 'function') render(); };
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('[data-incog]') : null;
    if (!t) return;
    e.preventDefault();
    if (t.getAttribute('data-incog') === 'on') incognitoArm(bridge).then(repaint);
    else { incognitoLeave(bridge); repaint(); }
  });
  if (bridge && typeof bridge.onStatus === 'function') {
    bridge.onStatus((status) => {
      const line = incognitoStatus(status);
      // The line goes in the incognito chat only, and only while it is on screen.
      if (!line || typeof S === 'undefined' || S.agentSession !== INCOG.id) return;
      S.log.push({id: nid(), k: 'system', text: esc(line)});
      repaint();
    });
  }
}

if (typeof module !== 'undefined') {
  module.exports = {INCOG, INCOG_BANNER, INCOG_RESTART_LINE, incognitoOn, incognitoSessionForNewChat, incognitoArmed,
    incognitoArm, incognitoLeave, incognitoStatus, incognitoBarHTML,
    INCOG_PENDING, incognitoLeaveNeedsAsk, incognitoLeaveAlert, incognitoLeaveAsk, incognitoLeaveGo};
}
