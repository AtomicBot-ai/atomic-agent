/* ---------------- ATO-2347: editing a file in the preview panel ----------------
   Loaded after file-preview.js, whose panel it draws into (FP, fpPaintHead,
   fpPaintBody, fpLoad). A text, code or markdown file read whole (not cut at
   the preview's cap) has Edit in the panel's head. Edit turns the body into a
   plain text area (no editor library) with Save and Done in the head;
   ⌘/Ctrl-S saves, Escape leaves the editor.

   The window never writes the disk. Save hands main the path, the text and
   the size and time of the file as the panel read it (app:filePreviewSave,
   main/file-save.ts); main writes only where the preview may read, only text,
   and only when the file is still the one the panel read. When it is not (the
   agent wrote it meanwhile), nothing is written and a bar offers "Reload from
   disk" (the editor takes the file as it is now) or "Overwrite" (Save again,
   regardless): VS Code's "The file is newer on disk", Kilo Desktop's files
   tab. The panel's own poll sees such a change before Save does: with
   nothing typed the editor just takes the new text; with unsaved text the
   same bar shows at once.

   Leaving the editor, or the file, with unsaved text asks Discard / Keep
   editing first. A file written with CRLF line ends is saved with them.

   Shared with the Node checks (test/file-preview-edit.test.mjs): fpEditable,
   fpEditEol, fpEditOut, fpEditDirty, fpEditHtml, fpEditSave and the rest,
   run in a vm with file-preview.js. */

const FP_EDIT_KINDS = ['text', 'code', 'markdown', 'csv', 'tsv', 'html'];

/** The file can be edited here: text read whole, and a bridge that can save it. */
function fpEditable(d) {
  const br = fpBridge();
  return !!(d && d.ok && FP_EDIT_KINDS.indexOf(d.kind) >= 0 && typeof d.text === 'string' && !d.truncated
    && br && typeof br.filePreviewSave === 'function');
}
/** The line end a text is written with: CRLF when it has any, else LF. */
function fpEditEol(text) { return /\r\n/.test(String(text || '')) ? '\r\n' : '\n'; }
/** A text area's text (always LF) put back into the file's own line ends. */
function fpEditOut(draft, eol) {
  const lf = String(draft == null ? '' : draft).replace(/\r\n?/g, '\n');
  return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
}
/** The editor has text that is not saved. */
function fpEditDirty(ed) { return !!ed && ed.draft !== ed.orig; }

/** The editor's state for the file the panel shows. */
function fpEditState(d) {
  const lf = String(d.text).replace(/\r\n?/g, '\n');
  return {eol: fpEditEol(d.text), orig: lf, draft: lf, base: {size: d.size, mtimeMs: d.mtimeMs},
    conflict: null, ask: null, saving: false, error: ''};
}

function fpEditStart() {
  if (!fpEditable(FP.data)) return;
  FP.edit = fpEditState(FP.data);
  fpPaintHead();
  fpPaintBody(fpBodyHtml(FP.data));
  const ta = fpEl() && fpEl().querySelector('textarea.fp-editor');
  if (ta) { try { ta.focus(); ta.setSelectionRange(0, 0); } catch (e) { /* not focusable yet */ } }
}
/** Back to the preview, dropping whatever is not saved. */
function fpEditStop() {
  FP.edit = null;
  fpPaintHead();
  fpPaintBody(fpBodyHtml(FP.data));
}
/** Before `then` leaves the editor: unsaved text asks Discard / Keep editing and returns true (not done yet). */
function fpEditGuard(then) {
  const ed = FP.edit;
  if (!ed) return false;
  if (!fpEditDirty(ed)) { FP.edit = null; return false; }
  ed.ask = typeof then === 'function' ? then : null;
  fpEditPaintBar();
  return true;
}
/** Done, or Escape: leave the editor, asking first about unsaved text. */
function fpEditLeave() {
  if (!FP.edit) return;
  if (fpEditDirty(FP.edit)) { fpEditGuard(() => {}); return; }
  fpEditStop();
}

async function fpEditSave(force) {
  const ed = FP.edit;
  const br = fpBridge();
  if (!ed || ed.saving || !br || typeof br.filePreviewSave !== 'function' || !FP.data || !FP.data.ok) return null;
  ed.saving = true; ed.error = '';
  fpEditPaintBar();
  const path = FP.data.path;
  const draft = ed.draft;
  const out = fpEditOut(draft, ed.eol);
  let r = null;
  try { r = await br.filePreviewSave(path, out, ed.base, force === true); } catch (e) { r = {ok: false, reason: 'failed'}; }
  ed.saving = false;
  if (FP.edit !== ed || !FP.data || FP.data.path !== path) return r;   // left the editor meanwhile
  if (r && r.ok) {
    ed.base = {size: r.size, mtimeMs: r.mtimeMs};
    ed.orig = draft; ed.conflict = null;
    FP.data = Object.assign({}, FP.data, {text: out, size: r.size, mtimeMs: r.mtimeMs, truncated: false});
    FP.stamp = r.size + ':' + r.mtimeMs;   // the poll does not take our own write for someone else's
    fpPaintHead();
  } else if (r && r.reason === 'changed') {
    ed.conflict = {size: r.size, mtimeMs: r.mtimeMs};
  } else {
    ed.error = fpEditWhy(r && r.reason);
  }
  fpEditPaintBar();
  return r;
}
function fpEditWhy(reason) {
  return reason === 'outside' ? 'It is outside the folders the preview can write to.'
    : reason === 'missing' ? 'The file is no longer there.'
    : reason === 'office' || reason === 'binary' ? 'This kind of file cannot be edited here.'
    : reason === 'too-large' ? 'The text is too long to save from here.'
    : 'It could not be saved.';
}
/** Reload from disk: the editor takes the file as it is now. */
async function fpEditReload() {
  const path = FP.path;
  FP.edit = null;
  await fpLoad(false);
  if (FP.open && FP.path === path && !FP.edit) fpEditStart();   // not on a file opened meanwhile
}
/** The panel's poll saw the file change while the editor is open. */
async function fpEditDiskChanged(f) {
  const ed = FP.edit;
  if (!ed || ed.saving) return;
  if (!fpEditDirty(ed)) { await fpEditReload(); return; }
  if (!ed.conflict) { ed.conflict = {size: f.size, mtimeMs: f.mtimeMs}; fpEditPaintBar(); }
}

/** The head's buttons while editing. */
function fpEditHeadHtml() {
  const ed = FP.edit;
  return '<button class="fp-btn fp-primary" data-fp="edit-save" title="Save (⌘S)"' + (ed && ed.saving ? ' disabled' : '') + '>Save</button>'
    + '<button class="fp-btn" data-fp="edit-done" title="Back to the preview">Done</button>';
}
/** The body while editing: a bar for questions and errors, then the text (filled in by fpEditFill). */
function fpEditHtml(d) {
  return '<div class="fp-editbar"></div>'
    + '<textarea class="fp-editor" spellcheck="false" autocomplete="off" aria-label="' + fpEsc('Edit ' + (d && d.name || 'file')) + '"></textarea>';
}
function fpEditFill(body) {
  const ta = body && body.querySelector('textarea.fp-editor');
  if (ta && FP.edit) ta.value = FP.edit.draft;
  fpEditPaintBar();
}
function fpEditBarHtml(ed) {
  if (!ed) return '';
  const btn = (act, label, primary) => '<button class="fp-btn' + (primary ? ' fp-primary' : '') + '" data-fp="' + act + '">' + label + '</button>';
  if (ed.ask) return '<div class="fp-note fp-editnote"><span>Discard your unsaved changes?</span>' + btn('edit-discard', 'Discard', true) + btn('edit-keep', 'Keep editing') + '</div>';
  if (ed.conflict) return '<div class="fp-note fp-editnote"><span>This file changed on disk since you opened it.</span>'
    + btn('edit-reload', 'Reload from disk') + btn('edit-overwrite', 'Overwrite', true) + '</div>';
  if (ed.error) return '<div class="fp-note fp-editnote"><span>' + fpEsc(ed.error) + '</span></div>';
  if (ed.saving) return '<div class="fp-editstat">Saving…</div>';
  return '<div class="fp-editstat">' + (fpEditDirty(ed) ? 'Edited' : 'Saved') + '</div>';
}
function fpEditPaintBar() {
  const bar = fpEl() && fpEl().querySelector('.fp-editbar');
  if (bar) bar.innerHTML = fpEditBarHtml(FP.edit);
  const save = fpEl() && fpEl().querySelector('[data-fp="edit-save"]');
  if (save) save.disabled = !!(FP.edit && FP.edit.saving);
}

/** The editor's own buttons (file-preview.js's click handler hands them here). */
function fpEditClick(what) {
  const ed = FP.edit;
  if (what === 'edit') fpEditStart();
  else if (!ed) return;
  else if (what === 'edit-save') fpEditSave(false);
  else if (what === 'edit-overwrite') fpEditSave(true);
  else if (what === 'edit-reload') fpEditReload();
  else if (what === 'edit-done') fpEditLeave();
  else if (what === 'edit-keep') { ed.ask = null; fpEditPaintBar(); }
  else if (what === 'edit-discard') { const then = ed.ask; fpEditStop(); if (then) then(); }
}

if (typeof document !== 'undefined') {
  document.addEventListener('input', (e) => {
    const ta = e.target;
    if (!FP.edit || !ta || !ta.matches || !ta.matches('#fpreview textarea.fp-editor')) return;
    const was = fpEditDirty(FP.edit);
    FP.edit.draft = String(ta.value).replace(/\r\n?/g, '\n');
    if (was !== fpEditDirty(FP.edit) && !FP.edit.ask && !FP.edit.conflict && !FP.edit.error) fpEditPaintBar();
  });
  document.addEventListener('keydown', (e) => {
    if (!FP.edit || !(e.metaKey || e.ctrlKey) || e.altKey || String(e.key).toLowerCase() !== 's') return;
    if (!e.target || !e.target.closest || !e.target.closest('#fpreview')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    fpEditSave(false);
  }, true);
}

if (typeof module !== 'undefined') module.exports = {fpEditable, fpEditEol, fpEditOut, fpEditDirty, fpEditState};
