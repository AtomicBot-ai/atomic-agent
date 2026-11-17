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
  /* ATO-985: a selection from the app in front: the quoted chip, and the
     actions that set the line (quick-entry-selection.js). */
  const selection = opened && typeof opened.selection === 'string' && opened.selection ? opened.selection : null;
  if (selection && typeof qeSelectionPreview === 'function') {
    document.body.classList.add('qe--sel');
    document.getElementById('qe-sel-text').textContent = qeSelectionPreview(selection);
    const row = document.getElementById('qe-actions');
    for (const a of QE_SELECTION_ACTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'qe-act';
      b.textContent = a.label;
      b.addEventListener('click', () => {
        input.value = a.prompt + ' ';
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        if (BR && BR.quickEntryDraft) BR.quickEntryDraft(input.value);
      });
      row.appendChild(b);
    }
    document.getElementById('qe-sel').hidden = false;
    input.placeholder = 'Ask about the selected text…';
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
    const out = selection && typeof qeComposeWithSelection === 'function' ? qeComposeWithSelection(text, selection) : text;
    BR.quickEntrySubmit(out).catch(() => {}).finally(() => { sending = false; });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); if (BR && BR.quickEntryHide) BR.quickEntryHide(); else window.close(); }
  });
})();
