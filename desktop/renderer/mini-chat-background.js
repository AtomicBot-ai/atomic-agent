/* ---------------- ATO-2478: the mini chat's "run in background" ----------------
   Loaded by mini-chat.html before mini-chat.js; the pure part is exported
   for test/mini-chat-background.test.mjs.

   In the quick entry window (⌘⇧Space, the mini chat) ⌘↩, Ctrl+Enter on
   Windows and Linux, or the Background button, sends what was typed (with
   the selected text quoted under it, as Send does) to a NEW chat that runs
   in the background in the main window. This window goes away and the main
   window is not brought up, so the person stays in the app they were in;
   the chat shows in the main window's list with the running dot, and its
   end raises a toast there with "Open" (renderer/background-chat.js) or,
   with that window behind, main's end-of-turn notification.

   Not in a chat's own window (?window=chat, ATO-561): that one goes on in
   its own chat, and has no quick entry text to hand over.

   The precedent: Cursor's background agents, and the ⌘K palette's ⌘↩
   (ATO-2309), which this matches. */

/** The chord as this platform writes it: ⌘↩ on macOS, Ctrl+Enter elsewhere. */
function mcBgChord(platform) {
  return platform === 'darwin' ? '⌘↩' : 'Ctrl+Enter';
}

/** True for the chord: ⌘↩ on macOS, Ctrl+Enter on Windows and Linux; never with Shift or Alt, never mid-IME. */
function mcBgIsChord(e, platform) {
  if (!e || e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing) return false;
  return platform === 'darwin' ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey;
}

/** The text handed over: what was typed, with the selection quoted under it as Send does; null for nothing. */
function mcBgText(typed, selection, compose) {
  const raw = typeof typed === 'string' ? typed : '';
  if (!raw.trim()) return null;
  const text = selection && typeof compose === 'function' ? compose(raw, selection) : raw;
  return String(text).trim() || null;
}

/** Whether it can go now: the mini window (not a chat's own), no turn of its own running, something typed. */
function mcBgReady(st, own, typed) {
  return !own && !!st && !st.busy && !st.loading && !st.locked && typeof typed === 'string' && !!typed.trim();
}

/**
 * Wires the Background button and returns {go, paint, platform, usable}:
 * go() hands the text over (true when it went), paint() sets the button's
 * state; `usable` is false in a chat's own window, where ⌘↩ still sends. `ctx` carries
 * what mini-chat.js owns: BR, $, st, own, selection() and note(text), which
 * adds a red line to the chat.
 */
function mcBgWire(ctx) {
  const btn = ctx.$('mc-bg');
  const platform = (ctx.BR && ctx.BR.platform) || 'darwin';
  const usable = !ctx.own && !!btn && !!ctx.BR && typeof ctx.BR.quickEntryBackground === 'function';
  if (btn) {
    btn.hidden = !usable;
    btn.title = 'Run in a new chat in the background (' + mcBgChord(platform) + ')';
    btn.setAttribute('aria-label', btn.title);
  }
  let sending = false;
  const paint = () => {
    if (usable) btn.disabled = sending || !mcBgReady(ctx.st, ctx.own, ctx.$('mc-input').value);
  };
  const go = () => {
    const typed = ctx.$('mc-input').value;
    if (!usable || sending || !mcBgReady(ctx.st, ctx.own, typed)) return false;
    const compose = typeof mcComposeWithSelection === 'function' ? mcComposeWithSelection : null;
    const text = mcBgText(typed, ctx.selection(), compose);
    if (!text) return false;
    sending = true;
    paint();
    // On success main closes this window; the text is kept here until then.
    const failed = () => { sending = false; ctx.note('Could not start a background chat. Try Send instead.'); paint(); };
    ctx.BR.quickEntryBackground(text).then((res) => { if (!res || !res.ok) failed(); }, failed);
    return true;
  };
  if (usable) btn.addEventListener('click', () => { go(); });
  return {go, paint, platform, usable};
}

if (typeof module !== 'undefined' && module.exports) module.exports = {mcBgChord, mcBgIsChord, mcBgText, mcBgReady, mcBgWire};
