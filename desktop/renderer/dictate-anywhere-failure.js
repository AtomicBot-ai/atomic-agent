/* ---------------- ATO-2750: a failure in the dictation pill ----------------
   dictate-anywhere.html's failure mode. main (dictate-anywhere-window.ts
   `fail`) opens the pill with a line and, where a settings pane fixes it,
   a button ("Open Privacy Settings": the microphone or Accessibility pane).
   The words are main's (main/dictate-errors.ts); this only draws them.
   × puts it away (app:dictateCancel); it also goes on its own after a few
   seconds. The microphone is never opened in this mode.

   The pure part is exported for test/dictate-errors.test.mjs. */

/** What the pill shows for main's `failure`, or null when it is not one. */
function daFailureView(f) {
  if (!f || typeof f !== 'object' || typeof f.line !== 'string' || !f.line) return null;
  return {line: f.line, button: typeof f.fixLabel === 'string' && f.fixLabel ? f.fixLabel : null};
}

function daShowFailure(f, br) {
  const view = daFailureView(f);
  if (!view) return false;
  document.body.classList.add('da--failed');
  const text = document.getElementById('da-text');
  text.textContent = view.line;
  text.title = view.line;   // the whole line when the pill cuts it
  document.getElementById('da-hint').textContent = '';
  const fix = document.getElementById('da-done');
  if (view.button) {
    fix.textContent = view.button;
    fix.title = view.button;
    fix.addEventListener('click', () => { if (br && br.dictateFix) br.dictateFix().catch(() => {}); });
  } else {
    fix.hidden = true;
  }
  document.getElementById('da-cancel').addEventListener('click', () => { if (br && br.dictateCancel) br.dictateCancel(); });
  return true;
}

if (typeof module !== 'undefined' && module.exports) module.exports = {daFailureView, daShowFailure};
