/* ATO-523: the global hotkey's one-line box (main/quick-entry-window.ts).
   Enter sends the text into a new chat in the main window; Esc hides the
   box. What was typed and not sent is kept by main and comes back next time. */
(async () => {
  const BR = window.atomic;
  // The theme the main window was set to (renderer.js atag.theme); System follows the OS.
  try { const t = localStorage.getItem('atag.theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch (e) { /* follow the OS */ }
  const input = document.getElementById('qe-text');
  const form = document.getElementById('qe-form');
  const opened = BR && BR.quickEntryOpened ? await BR.quickEntryOpened().catch(() => null) : null;
  if (opened && typeof opened.draft === 'string' && opened.draft) {
    input.value = opened.draft;
    input.setSelectionRange(input.value.length, input.value.length);
  }
  input.focus();
  window.addEventListener('focus', () => input.focus());
  input.addEventListener('input', () => { if (BR && BR.quickEntryDraft) BR.quickEntryDraft(input.value); });
  let sending = false;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || sending || !BR || !BR.quickEntrySubmit) return;
    sending = true;
    BR.quickEntrySubmit(text).catch(() => {}).finally(() => { sending = false; });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); if (BR && BR.quickEntryHide) BR.quickEntryHide(); else window.close(); }
  });
})();
