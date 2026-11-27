/* ---------------- ATO-2445: "Open in editor" in the preview panel ----------------
   Loaded after file-preview.js and file-preview-line.js. When main found VS
   Code, Cursor or Zed on this computer (app:editors, main/editor-detect.ts),
   the panel's head has a button for it: one editor, "VS Code"; several, a
   small menu of them. It opens the previewed file in that editor at the line
   the reader is on (the caret's line in the panel's editor, else the line a
   `path:line` link opened, fpLineNow), through main's own check of the path
   (app:openInEditor). No editor found: no button. The list is asked for
   again once it is FP_EDITORS_FRESH_MS old (main looks again after the same
   30 s), so an editor installed meanwhile gets its button without a restart.

   Precedent: GitHub Desktop's and Kilo Desktop's "Open in Visual Studio
   Code", Claude Code's /ide, VS Code's `code -g file:line`.

   The button is not a [data-fp] one (file-preview.js would take the click);
   it is [data-fpx], handled here.

   Shared with the Node checks (test/file-preview-line.test.mjs):
   fpEditorButtonHtml, fpEditorMenuHtml, FP_EDITORS. */

const FP_EDITORS = {list: null, at: 0, asking: false, menu: false};
const FP_EDITORS_FRESH_MS = 30000;

/** Asks main which editors there are, when it has not or the answer is old; the head is drawn again when the list changed. */
function fpEditorsLoad() {
  const br = typeof fpBridge === 'function' ? fpBridge() : null;
  if (FP_EDITORS.asking || !br || typeof br.editors !== 'function') return;
  if (FP_EDITORS.list && Date.now() - FP_EDITORS.at < FP_EDITORS_FRESH_MS) return;
  FP_EDITORS.asking = true;
  const was = JSON.stringify(FP_EDITORS.list);
  Promise.resolve().then(() => br.editors()).then((r) => {
    FP_EDITORS.list = Array.isArray(r) ? r.filter((e) => e && typeof e.id === 'string' && typeof e.name === 'string') : [];
  }, () => { FP_EDITORS.list = FP_EDITORS.list || []; }).then(() => {
    FP_EDITORS.asking = false;
    FP_EDITORS.at = Date.now();
    if (JSON.stringify(FP_EDITORS.list) === was) return;
    if (FP.open && FP.path && typeof fpPaintHead === 'function') fpPaintHead();
  });
}

/** The head's button for a file the panel shows; '' with no editor or no file. */
function fpEditorButtonHtml(d) {
  if (!d || !d.ok || !d.path) return '';
  fpEditorsLoad();
  const list = FP_EDITORS.list;
  if (!list) return '';
  if (!list.length) return '';
  if (list.length === 1) {
    return '<button class="fp-btn" data-fpx="editor" data-fpx-id="' + fpEsc(list[0].id) + '" title="' + fpEsc('Open in ' + list[0].name) + '">' + fpEsc(list[0].name) + '</button>';
  }
  return '<span class="fp-edwrap"><button class="fp-btn" data-fpx="editor-menu" aria-haspopup="menu" aria-expanded="' + FP_EDITORS.menu + '" title="Open in a code editor">Open in…</button>'
    + (FP_EDITORS.menu ? fpEditorMenuHtml(list) : '') + '</span>';
}
function fpEditorMenuHtml(list) {
  return '<span class="fp-edmenu" role="menu">' + list.map((e) =>
    '<button class="fp-edmenu-i" role="menuitem" data-fpx="editor" data-fpx-id="' + fpEsc(e.id) + '">' + fpEsc(e.name) + '</button>').join('') + '</span>';
}

async function fpEditorOpen(id) {
  const br = fpBridge();
  const d = FP.data && FP.data.ok ? FP.data : null;
  FP_EDITORS.menu = false;
  if (typeof fpPaintHead === 'function') fpPaintHead();
  if (!br || typeof br.openInEditor !== 'function' || !d) return;
  const line = typeof fpLineNow === 'function' ? fpLineNow() : 0;
  let r = null;
  try { r = await br.openInEditor(d.path, id, line || undefined); } catch (e) { r = {ok: false, reason: 'failed'}; }
  if (r && r.ok) return;
  const name = ((FP_EDITORS.list || []).find((e) => e.id === id) || {}).name || 'the editor';
  if (typeof toast === 'function') {
    toast('Could not open it in ' + name, r && r.reason === 'outside' ? 'It is outside the folders the preview can read.'
      : r && r.reason === 'missing' ? 'The file is no longer there.'
      : r && r.reason === 'no-editor' ? name + ' is no longer installed.' : name + ' did not start.');
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('#fpreview [data-fpx]') : null;
    if (!b) {
      // A click anywhere else closes the menu.
      if (FP_EDITORS.menu) { FP_EDITORS.menu = false; if (FP.open && typeof fpPaintHead === 'function') fpPaintHead(); }
      return;
    }
    e.preventDefault(); e.stopPropagation();
    if (b.dataset.fpx === 'editor-menu') { FP_EDITORS.menu = !FP_EDITORS.menu; fpPaintHead(); return; }
    if (b.dataset.fpx === 'editor' && b.dataset.fpxId) fpEditorOpen(b.dataset.fpxId);
  }, true);
}

if (typeof module !== 'undefined') module.exports = {fpEditorButtonHtml, fpEditorMenuHtml, FP_EDITORS};
