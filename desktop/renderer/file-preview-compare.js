/* ---------------- ATO-2445: Compare, when the file changed on disk while it was edited ----------------
   Loaded after file-preview-edit.js and line-diff.js. The conflict bar
   ("This file changed on disk since you opened it", file-preview-edit.js)
   has Compare next to Reload from disk and Overwrite, as VS Code's "The
   file is newer on disk" does. Compare reads the file as it is now through
   main (app:filePreview, the panel's own read) and shows under the bar what
   would change if Overwrite wrote the editor's text: lines on disk that
   would go in red, the editor's lines in green (line-diff.js makes the diff,
   diff-lines.js draws it). Compare again hides it.

   The diff follows the typing: it is made again from the editor's text each
   time the bar is drawn. It belongs to one version of the file on disk; a
   newer change, Reload or Overwrite drops it.

   Shared with the Node checks (test/file-preview-line.test.mjs):
   fpCompareHtml, fpCompareToggle. */

/** Compare's diff under the conflict bar, or '' when it is not open (or is about another version). */
function fpCompareHtml(ed) {
  if (!fpCompareOpen(ed)) return '';
  const c = ed.compare;
  if (c.loading) return '<div class="fp-compare"><div class="fp-editstat">Reading the file on disk…</div></div>';
  if (c.error) return '<div class="fp-compare"><div class="fp-editstat">' + fpEsc(c.error) + '</div></div>';
  const diff = typeof unifiedDiff === 'function' ? unifiedDiff(c.disk, ed.draft, 'On disk', 'Your changes') : '';
  if (!diff) return '<div class="fp-compare"><div class="fp-editstat">Your text is the same as the file on disk.</div></div>';
  const counts = typeof diffCounts === 'function' ? diffCounts(diff) : null;
  const html = typeof diffLinesHTML === 'function' ? diffLinesHTML(diff, fpEsc) : '<pre>' + fpEsc(diff) + '</pre>';
  return '<div class="fp-compare" role="region" aria-label="Changes against the file on disk">'
    + (counts ? '<div class="fp-editstat">Overwrite would remove ' + counts.del + (counts.del === 1 ? ' line' : ' lines')
      + ' from the file on disk and add ' + counts.add + (counts.add === 1 ? ' line' : ' lines') + '.</div>' : '')
    + '<div class="fp-compare-diff">' + html + '</div></div>';
}

/** Compare is open for the version of the file the conflict is about. */
function fpCompareOpen(ed) {
  const c = ed && ed.compare;
  return !!(c && ed.conflict && c.stamp === ed.conflict.size + ':' + ed.conflict.mtimeMs);
}
/** Compare's label for the bar's button. */
function fpCompareLabel(ed) {
  return fpCompareOpen(ed) ? 'Hide compare' : 'Compare';
}

/** Compare, or hide it: reads the file on disk once per version of it. */
async function fpCompareToggle() {
  const ed = FP.edit;
  const br = fpBridge();
  if (!ed || !ed.conflict || !FP.data || !FP.data.ok) return;
  const stamp = ed.conflict.size + ':' + ed.conflict.mtimeMs;
  if (ed.compare && ed.compare.stamp === stamp && !ed.compare.loading) { ed.compare = null; fpEditPaintBar(); return; }
  if (!br || typeof br.filePreview !== 'function') return;
  const path = FP.data.path;
  ed.compare = {stamp, loading: true, disk: '', error: ''};
  fpEditPaintBar();
  let r = null;
  try { r = await br.filePreview(path); } catch (e) { r = null; }
  if (FP.edit !== ed || !ed.compare || ed.compare.stamp !== stamp) return;   // left, or another change meanwhile
  const c = {stamp, loading: false, disk: '', error: ''};
  if (!r || !r.ok) c.error = 'The file on disk could not be read.';
  else if (typeof r.text !== 'string') c.error = 'The file on disk is no longer text.';
  else if (r.truncated) c.error = 'The file on disk is too long to compare here.';
  else c.disk = r.text;
  ed.compare = c;
  fpEditPaintBar();
}

if (typeof module !== 'undefined') module.exports = {fpCompareHtml, fpCompareToggle, fpCompareLabel};
