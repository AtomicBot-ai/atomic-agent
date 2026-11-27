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
   what was typed.

   ATO-2751: the palette stays open until the chat has started, so a start
   that fails keeps the typed task where it was. Its row then says why in
   plain words and becomes Retry (⌘↩ again does the same), as Cursor's
   palette keeps a failed agent's prompt. A second ⌘↩ while it starts says
   so instead of doing nothing. The raw error goes to the log only. */

/* text: what is starting or failed to start; error: the plain reason it failed. */
const BGCHAT = {turns: new Map(), starting: false, text: '', error: ''};
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

/** A failed start in words; the raw reason is for the log. */
function bgChatErrorLine(raw) {
  const s = String(raw || '');
  if (/\bmodel\b/i.test(s)) return 'No model is ready for it. Pick a model, then try again.';
  if (/not running|not connected|disconnected|did not come back|ECONNREFUSED|offline|restart/i.test(s)) {
    return 'The agent is not running right now. Try again in a moment.';
  }
  return 'Something went wrong while starting it. Try again.';
}

/** The row's words for `text`: starting, failed (Retry) or new. */
function bgChatRowWords(text) {
  const quoted = '“' + text + '”';
  if (BGCHAT.starting && BGCHAT.text === text) return {t: 'Starting a background chat: ' + quoted, cx: 'One moment…'};
  if (BGCHAT.error && BGCHAT.text === text) return {t: 'Retry background chat: ' + quoted, cx: 'Couldn’t start it. ' + BGCHAT.error};
  return {t: 'New background chat: ' + quoted, cx: 'Starts working in a new chat while you stay here'};
}

/** The palette's row for it, after the other results; null with no query or no results (the empty state has its own). */
function bgChatPaletteRow(rawQuery, resultCount) {
  const text = bgChatText(rawQuery);
  if (!text || !resultCount) return null;
  const w = bgChatRowWords(text);
  return {ic: 'arrowR', t: w.t, cx: w.cx, sc: '⌘↩', act: 'bgchat:', badge: 'bg'};
}

/** The same, under "Ask the agent" when nothing matched. */
function bgChatEmptyRowHTML(q) {
  const text = bgChatText(q);
  if (!text) return '';
  const e = typeof esc === 'function' ? esc : (s) => String(s);
  const icon = typeof ic === 'function' ? ic('arrowR') : '';
  const caps = typeof keycaps === 'function' ? keycaps('⌘↩') : '';
  const w = bgChatRowWords(text);
  const mine = BGCHAT.text === text && (BGCHAT.starting || !!BGCHAT.error);   // a new chat's line is the palette row's only
  const cx = mine ? e(w.cx) : '';
  return '<button class="palrow" data-act="bgchat:"><span class="ic">' + icon + '</span>'
    + '<span class="ti">' + e(w.t) + '</span><span class="cx">' + cx + '</span><span class="sc">' + caps + '</span></button>';
}

/** The palette drawn again in place (the caret stays), or the whole window. */
function bgChatRepaint() {
  if (typeof refreshPalette === 'function' && S.overlay === 'palette') refreshPalette();
  else if (typeof render === 'function') render();
}

/** ⌘↩ in the palette and its row: the chat starts, then the palette closes and the person stays where they are. */
function bgChatFromPalette() {
  const text = bgChatText(S.q);
  if (!text) return false;
  if (BGCHAT.starting) {
    toast('Still starting the background chat', 'One moment, it opens in the list when it is ready.', 'info');
    return true;
  }
  void bgChatStart(text);
  return true;
}

/** Start the turn in a new chat and take it over as a background turn. */
async function bgChatStart(text) {
  if (BGCHAT.starting || typeof BR === 'undefined' || !BR || typeof BR.chat !== 'function') return false;
  BGCHAT.starting = true; BGCHAT.text = text; BGCHAT.error = '';
  bgChatRepaint();
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
    const raw = (res && res.error) || 'no turn id';
    if (typeof console !== 'undefined') console.warn('[background chat] start failed:', raw);
    BGCHAT.error = bgChatErrorLine(raw);
    // The task is kept: in the palette if it is still open, else the palette comes back with it.
    if (!S.overlay && !S.settings) { S.overlay = 'palette'; S.q = text; if (typeof render === 'function') render(); }
    else bgChatRepaint();
    if (S.overlay !== 'palette') toast('Couldn’t start the background chat', BGCHAT.error, 'bad');
    return false;
  }
  BGCHAT.text = '';
  // Started: the palette closes if it still holds this task; the person stays where they are.
  if (S.overlay === 'palette' && bgChatText(S.q) === text && typeof act === 'function') act('close');
  else if (typeof render === 'function') render();
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
  bgChatErrorLine, bgChatFromPalette, bgChatStart, bgChatTurnEnded};
