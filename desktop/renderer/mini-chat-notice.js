/* ---------------- ATO-2736: the mini chat's one-line notice ----------------
   mini-chat.html's line over the message box: why the hotkey opened the
   window without the selected text, with a button that fixes it (Raycast
   and PopClip say so in one line instead of opening empty). main decides
   what to say (main/selected-text-grab.ts selectionMissNotice) and hands
   it over in app:quickEntryOpened's `notice`; this draws it.

   The pure part is exported for test/mini-chat-notice.test.mjs. */

/** main's notice as the line draws it, or null for nothing. */
function mcSelectionNoticeView(n) {
  if (!n || typeof n !== 'object' || typeof n.text !== 'string' || !n.text) return null;
  return n.settings === true
    ? {text: n.text, tone: 'warn', button: 'Open Settings', act: 'settings'}
    : {text: n.text, tone: 'warn', button: null, act: null};
}

/** Draws `view` in #mc-notice (null hides it); the button calls onAct(view.act). */
function mcShowNotice(view, onAct) {
  const box = document.getElementById('mc-notice');
  if (!box) return;
  if (!view) { box.hidden = true; return; }
  box.className = 'mc-notice' + (view.tone ? ' ' + view.tone : '');
  document.getElementById('mc-notice-text').textContent = view.text;
  const b = document.getElementById('mc-notice-btn');
  b.hidden = !view.button;
  b.textContent = view.button || '';
  b.onclick = view.button ? () => onAct(view.act) : null;
  box.hidden = false;
}

/** The hook mini-chat.js calls once the window knows what it opened with. */
function mcSelectionNotice(notice, br) {
  mcShowNotice(mcSelectionNoticeView(notice), (act) => {
    // Settings › General in the main window; main closes this one.
    if (act === 'settings' && br && br.quickEntryOpenSettings) br.quickEntryOpenSettings().catch(() => {});
  });
}

if (typeof module !== 'undefined' && module.exports) module.exports = {mcSelectionNoticeView, mcShowNotice, mcSelectionNotice};
