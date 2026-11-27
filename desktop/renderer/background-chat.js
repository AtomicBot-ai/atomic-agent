/* ---------------- ATO-2309: a background chat from the ⌘K palette ----------------
   Loaded before renderer.js; declares only, and reads renderer.js globals at
   call time, as project-workers.js does. The Node checks load it as is
   (test/background-chat.test.mjs).

   Typing a task in the palette and pressing ⌘↩ (Ctrl+Enter elsewhere), or
   picking its "New background chat" row, starts a NEW chat with that text
   and leaves the person in the chat they are in. The turn runs the way a
   worker chat's does (project-workers.js): the window takes it over as a
   turn of a chat it is not showing (adoptLiveTurns), so its frames are kept
   for that chat, its row joins the list with the running dot once the
   stream names its session, and an approval it asks for waits on that row
   (the amber dot) until the person opens the chat and answers it. Nothing
   is approved by itself. When the turn ends with the chat not on screen, a
   toast says so; with the window in the background, main's end-of-turn
   notification (main/turn-notify.ts) covers it as for any turn.

   The precedent: Cursor's background agents started from the command
   palette, and Claude desktop's quick entry, which opens a new chat with
   what was typed. */

const BGCHAT = {turns: new Map(), starting: false};
const BGCHAT_MAX = 20000;
const BGCHAT_LINE = 'Started in the background from the command palette.';

/** The text a background chat starts with: trimmed, capped; null for nothing. */
function bgChatText(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  return text.length > BGCHAT_MAX ? text.slice(0, BGCHAT_MAX) : text;
}

/** The toast a background chat's end raises: null while its chat is on screen. */
function bgChatEndToast(kind, title, onScreen) {
  if (onScreen) return null;
  const s = title ? '“' + title + '”' : '';
  if (kind === 'done') return {t: 'Background chat finished', s, kind: undefined};
  if (kind === 'aborted') return {t: 'Background chat stopped', s, kind: undefined};
  return {t: 'Background chat failed', s, kind: 'bad'};
}

/** The palette's row for it, after the other results; null with no query or no results (the empty state has its own). */
function bgChatPaletteRow(rawQuery, resultCount) {
  if (!bgChatText(rawQuery) || !resultCount) return null;
  return {ic: 'arrowR', t: 'New background chat: “' + String(rawQuery).trim() + '”', cx: 'Starts working in a new chat while you stay here',
    sc: '⌘↩', act: 'bgchat:', badge: 'bg'};
}

/** The same, under "Ask the agent" when nothing matched. */
function bgChatEmptyRowHTML(q) {
  if (!bgChatText(q)) return '';
  const e = typeof esc === 'function' ? esc : (s) => String(s);
  const icon = typeof ic === 'function' ? ic('arrowR') : '';
  const caps = typeof keycaps === 'function' ? keycaps('⌘↩') : '';
  return '<button class="palrow" data-act="bgchat:"><span class="ic">' + icon + '</span>'
    + '<span class="ti">New background chat: &ldquo;' + e(String(q).trim()) + '&rdquo;</span><span class="cx"></span><span class="sc">' + caps + '</span></button>';
}

/** ⌘↩ in the palette and its row: the palette closes, the person stays where they are. */
function bgChatFromPalette() {
  const text = bgChatText(S.q);
  if (!text) return false;
  if (typeof act === 'function') act('close');
  if (typeof render === 'function') render();
  void bgChatStart(text);
  return true;
}

/** Start the turn in a new chat and take it over as a background turn. */
async function bgChatStart(text) {
  if (BGCHAT.starting || typeof BR === 'undefined' || !BR || typeof BR.chat !== 'function') return false;
  BGCHAT.starting = true;
  const title = typeof chatTitle === 'function' ? chatTitle(text) : text.slice(0, 72);
  let res = null;
  try {
    // A new chat: no session, no project; its level and model as a new chat here would take.
    const level = typeof reasoningTurnLevel === 'function' ? reasoningTurnLevel(null) : undefined;
    const model = typeof projectTurnModel === 'function' ? projectTurnModel(null) : null;
    res = await BR.chat([{role: 'user', content: text}], undefined, undefined, level, model);
  } catch (e) {
    res = {ok: false, error: String((e && e.message) || e)};
  }
  BGCHAT.starting = false;
  if (!res || !res.ok || typeof res.turnId !== 'string') {
    toast('Could not start the background chat', (res && res.error) || 'unknown error', 'bad');
    return false;
  }
  BGCHAT.turns.set(res.turnId, title);
  if (typeof adoptLiveTurns === 'function') {
    adoptLiveTurns([{turnId: res.turnId, sessionId: null, text, startedAt: Date.now(), firstTurn: true}]);
    const rec = typeof LIVE_TURNS !== 'undefined' ? LIVE_TURNS.get(res.turnId) : null;
    const note = rec && rec.log ? rec.log.find((r) => r.k === 'system') : null;
    // adoptLiveTurns' line is for a window opened mid-turn; this one was started from here.
    if (note) note.text = BGCHAT_LINE;
  }
  if (typeof renderSidebar === 'function') renderSidebar();
  toast('Background chat started', '“' + title + '” runs while you stay here.');
  return true;
}

/** renderer.js onChatEvent: a turn ended (done / aborted / error) in chat `sid`. */
function bgChatTurnEnded(turnId, sid, kind) {
  if (!BGCHAT.turns.has(turnId)) return;
  const title = BGCHAT.turns.get(turnId);
  BGCHAT.turns.delete(turnId);
  const onScreen = !!sid && S.sessionId === sid && S.room === 'chat';
  const msg = bgChatEndToast(kind, title, onScreen);
  if (msg) toast(msg.t, msg.s, msg.kind);
}

if (typeof module !== 'undefined') module.exports = {BGCHAT, BGCHAT_LINE, bgChatText, bgChatEndToast, bgChatPaletteRow, bgChatEmptyRowHTML,
  bgChatFromPalette, bgChatStart, bgChatTurnEnded};
