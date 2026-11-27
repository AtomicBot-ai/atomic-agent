/* ---------------- ATO-2738: before "Replace in <app>" pastes anything ----------------
   Loaded by mini-chat.html after diff-lines.js and before mini-chat-selection.js
   and mini-chat.js; the pure part is exported for test/mini-chat-replace-preview.test.mjs.

   The answer used to go straight into the other app. Now "Replace in Safari"
   first opens this preview under the answer: the selected text as it was
   (red) and what the paste will put there (green), line by line through
   diff-lines.js, the same colours as an edit's diff in the main window.
   The text comes from main (app:quickEntryReplacePreview), so what is shown
   is exactly what is pasted, the model's "Here is the rewritten text:"
   already off (main/replace-preamble.ts). The preview's own button is the
   [data-replace] button mini-chat.js already handles, so the paste and its
   error lines are the ones they were; Cancel or Esc closes the preview and
   keeps the window.

   The precedent: Microsoft Copilot's rewrite preview and Apple's Writing
   Tools, which show before / after with Replace and Cancel. */

const MCRP = {rowId: null, loading: false, view: null, error: null, ask: 0};
const MCRP_MAX_CELLS = 250000;   // lines × lines the line diff may compare; past it, all old then all new

/** Line ops from `before` to `after`: [{op:' '|'-'|'+', text}], by longest common run of lines. */
function mcRpLineDiff(before, after) {
  const a = before ? String(before).replace(/\r\n?/g, '\n').split('\n') : [];
  const b = after ? String(after).replace(/\r\n?/g, '\n').split('\n') : [];
  if (a.length * b.length > MCRP_MAX_CELLS) {
    return a.map((text) => ({op: '-', text})).concat(b.map((text) => ({op: '+', text})));
  }
  const n = a.length, m = b.length;
  const L = Array.from({length: n + 1}, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({op: ' ', text: a[i]}); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({op: '-', text: a[i++]});
    else out.push({op: '+', text: b[j++]});
  }
  while (i < n) out.push({op: '-', text: a[i++]});
  while (j < m) out.push({op: '+', text: b[j++]});
  return out;
}

/** The same as diff text for diff-lines.js: one line each, its op first. */
function mcRpDiffText(before, after) {
  return mcRpLineDiff(before, after).map((l) => l.op + l.text).join('\n');
}

function mcRpClose() {
  MCRP.rowId = null; MCRP.loading = false; MCRP.view = null; MCRP.error = null; MCRP.ask++;
}

/** The preview under reply `row`, or '' when it is not open there. `label` is "Replace in Safari". */
function mcRpHTML(row, label, esc) {
  if (!row || MCRP.rowId !== row.id) return '';
  const id = esc(String(row.id));
  const cancel = '<button type="button" class="mc-act" data-replace-cancel="' + id + '">Cancel</button>';
  if (MCRP.loading) return '<div class="mc-rp" role="status"><div class="mc-rp-head">Preparing the preview…</div><div class="mc-rp-acts">' + cancel + '</div></div>';
  if (MCRP.error) return '<div class="mc-rp bad" role="alert"><div class="mc-rp-head">' + esc(MCRP.error) + '</div><div class="mc-rp-acts">' + cancel + '</div></div>';
  const v = MCRP.view || {before: '', after: '', same: false};
  if (v.same) return '<div class="mc-rp"><div class="mc-rp-head">The answer is the same as the selected text.</div><div class="mc-rp-acts">' + cancel + '</div></div>';
  const lines = typeof diffLinesHTML === 'function' ? diffLinesHTML(mcRpDiffText(v.before, v.after), esc) : esc(v.after);
  return '<div class="mc-rp" role="group" aria-label="What will be replaced">'
    + '<div class="mc-rp-legend"><span class="mc-rp-was">Was</span><span class="mc-rp-will">Will be</span></div>'
    + '<div class="mc-rp-body">' + lines + '</div>'
    + '<div class="mc-rp-acts"><button type="button" class="mc-act mc-replace" data-replace="' + id + '">' + esc(label || 'Replace') + '</button>' + cancel + '</div></div>';
}

/** A click in the chat: opens or cancels a preview. True when it was one of its buttons. */
function mcRpClick(e, ctx) {
  const at = (sel) => (e.target && e.target.closest ? e.target.closest(sel) : null);
  if (at('[data-replace-cancel]')) { mcRpClose(); ctx.repaint(); return true; }
  const ask = at('[data-replace-ask]');
  if (!ask) return false;
  const row = ctx.st.rows.find((r) => String(r.id) === ask.getAttribute('data-replace-ask'));
  if (!row) return true;
  mcRpClose();
  MCRP.rowId = row.id; MCRP.loading = true;
  const mine = MCRP.ask;
  ctx.repaint();
  const done = (res) => {
    if (MCRP.ask !== mine) return;   // closed or opened again meanwhile
    MCRP.loading = false;
    if (res && res.ok) MCRP.view = {before: String(res.before || ''), after: String(res.after || ''), same: !!res.same};
    else MCRP.error = (res && res.error) || 'The preview could not be made.';
    ctx.repaint();
  };
  if (!ctx.BR || typeof ctx.BR.quickEntryReplacePreview !== 'function') { done(null); return true; }
  ctx.BR.quickEntryReplacePreview(row.text).then(done, () => done(null));
  return true;
}

/** Esc with a preview open closes the preview, not the window. True when it did. */
function mcRpKey(e, repaint) {
  if (!e || e.key !== 'Escape' || MCRP.rowId === null) return false;
  e.preventDefault();
  mcRpClose();
  repaint();
  return true;
}

if (typeof module !== 'undefined' && module.exports) module.exports = {MCRP, MCRP_MAX_CELLS, mcRpLineDiff, mcRpDiffText, mcRpClose, mcRpHTML, mcRpClick, mcRpKey};
