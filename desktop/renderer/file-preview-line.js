/* ---------------- ATO-2445: the preview opened on a line ----------------
   Loaded after file-preview.js and file-preview-edit.js. A `path:line` chip
   in a reply (reply-line-links.js) opens the panel with {line, col};
   filePreviewOpen hands them to fpLineSet, and fpLoad calls fpLineGo once the
   file is drawn. The line is scrolled to a third of the way down and marked
   with a band that fades, as VS Code's "Go to line" does.

   Line numbers belong to the file's source, so a Markdown, HTML or CSV file
   asked for a line opens as its source. In the editor the caret goes to the
   line (and column). A line past the part of a long file the preview read
   says so instead of scrolling somewhere else.

   The line is a one-shot: a later reload of the same file (the panel's
   poll) keeps the reader's scroll and does not jump back. FP.shownLine keeps
   it for "Open in editor" (file-preview-editor.js).

   Shared with the Node checks (test/file-preview-line.test.mjs):
   fpLineOffset, fpLineSpan, fpLineSet. */

const FP_LINE_SOURCE_KINDS = ['markdown', 'html', 'csv', 'tsv'];

/** Where line `line` (1-based) starts in `text`, or -1 past its end. */
function fpLineOffset(text, line) {
  const s = String(text == null ? '' : text);
  if (!(line >= 1)) return -1;
  let at = 0;
  for (let n = 1; n < line; n++) {
    const nl = s.indexOf('\n', at);
    if (nl < 0) return -1;
    at = nl + 1;
  }
  return at;
}
/** [start, end) of line `line` with the caret at column `col` (1-based) inside it, or null past the end. */
function fpLineSpan(text, line, col) {
  const s = String(text == null ? '' : text);
  const start = fpLineOffset(s, line);
  if (start < 0) return null;
  const nl = s.indexOf('\n', start);
  const end = nl < 0 ? s.length : nl;
  const caret = Math.min(end, start + Math.max(0, (col || 1) - 1));
  return {start, end, caret};
}

/** filePreviewOpen's options: a line to go to once the file is drawn. */
function fpLineSet(opts) {
  const line = opts && opts.line > 0 ? Math.floor(opts.line) : 0;
  FP.line = line ? {line, col: opts.col > 0 ? Math.floor(opts.col) : 0} : null;
  FP.shownLine = line || 0;
  if (line) FP.view = 'source';   // markdown, HTML, CSV: the line is a line of the source
}

/** After fpLoad drew the file: scroll to the line asked for, once. */
function fpLineGo() {
  const want = FP.line;
  const el = fpEl();
  const body = el && el.querySelector('.fp-body');
  const d = FP.data;
  if (!want || !body || !d || !d.ok) return;
  FP.line = null;
  if (FP.edit) { fpLineInEditor(body, want); return; }
  const pre = body.querySelector('pre.fp-code, pre.fp-text');
  if (!pre || typeof d.text !== 'string') return;
  const span = fpLineSpan(pre.textContent, want.line, want.col);
  if (!span) {
    body.insertAdjacentHTML('afterbegin', '<div class="fp-note">Line ' + want.line + ' is past the part of the file shown here.'
      + (d.truncated ? ' Open the file to see all of it.' : '') + '</div>');
    return;
  }
  const rect = fpLineRect(pre, span.start, span.end);
  if (!rect) return;
  const top = body.scrollTop + rect.top - body.getBoundingClientRect().top;
  body.scrollTop = Math.max(0, top - body.clientHeight / 3);
  const band = document.createElement('div');
  band.className = 'fp-lineband';
  band.style.top = (rect.top - pre.getBoundingClientRect().top + pre.scrollTop) + 'px';
  band.style.height = Math.max(rect.height, 14) + 'px';
  pre.classList.add('fp-haslineband');
  pre.appendChild(band);
}

/** The box of characters [start, end) of `pre`'s text, found through its text nodes (wrapped lines too). */
function fpLineRect(pre, start, end) {
  const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  let seen = 0, node, range = null;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (seen + len > start || (seen + len === start && end === start)) {
      range = document.createRange();
      const off = start - seen;
      range.setStart(node, off);
      range.setEnd(node, Math.min(len, off + Math.max(1, end - start)));
      break;
    }
    seen += len;
  }
  if (!range) return null;
  const boxes = range.getClientRects();
  const r = boxes && boxes.length ? boxes[0] : range.getBoundingClientRect();
  return r && (r.height || r.top) ? r : null;
}

function fpLineInEditor(body, want) {
  const ta = body.querySelector('textarea.fp-editor');
  if (!ta) return;
  const span = fpLineSpan(ta.value, want.line, want.col);
  if (!span) return;
  try { ta.focus(); ta.setSelectionRange(span.caret, span.caret); } catch (e) { /* not focusable yet */ }
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  ta.scrollTop = Math.max(0, (want.line - 1) * lh - ta.clientHeight / 3);
}

/** The line the reader is on, for "Open in editor": the caret's line in the editor, else the line opened on. */
function fpLineNow() {
  const ta = FP.edit && fpEl() && fpEl().querySelector('textarea.fp-editor');
  if (ta && typeof ta.selectionStart === 'number') return String(ta.value).slice(0, ta.selectionStart).split('\n').length;
  return FP.shownLine || 0;
}

if (typeof module !== 'undefined') module.exports = {fpLineOffset, fpLineSpan, fpLineSet, fpLineNow};
