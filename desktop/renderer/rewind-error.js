/* ATO-2752: a failed roll back, edit, fork or answer switch in plain words.

   chat-rewind.js and answer-versions.js used to show what they got back as
   is: the agent's message, or a thrown IPC error such as "Error: Error
   invoking remote method 'agent:rewind': ...". Now a refusal the agent names
   by its code keeps its own sentence, anything else says one plain line, and
   the raw reason (without Electron's wrapper) sits behind a Details toggle in
   the sheet and in the log. The precedent: Slack's and ChatGPT's error
   banners, a sentence first and the technical part folded away.

   Loaded before chat-rewind.js and answer-versions.js; the Node checks load
   it as is (test/rewind-error.test.mjs). */

const REWIND_ERROR_LINE = 'Something went wrong on the agent’s side. Try again.';

/** The raw reason of an answer `{error}` or a thrown error, without the IPC wrapper; '' when none. */
function rewindRawReason(r) {
  const raw = r instanceof Error ? r.message : r && typeof r === 'object' ? r.error : r;
  return String(raw == null ? '' : raw).trim()
    .replace(/^(?:\w*Error:\s*)?Error invoking remote method '[^']*':\s*/, '')
    .replace(/^\w*Error:\s*/, '');
}

/**
 * `{text, detail}` for a failed answer `r`: `codeText(r)` is the caller's
 * sentence for a code the agent names (null when it names none it knows).
 */
function rewindErrorView(r, codeText) {
  const known = typeof codeText === 'function' ? codeText(r) : null;
  const detail = rewindRawReason(r);
  if (known) return {text: known, detail: ''};
  if (typeof console !== 'undefined' && detail) console.warn('[rewind] the agent said:', detail);
  return {text: REWIND_ERROR_LINE, detail};
}

/** The red notice in the sheet: the sentence, and Details when there is a raw reason. `h`: {esc, ic}. */
function rewindErrorHTML(view, h) {
  if (!view || !view.text) return '';
  const icon = h.ic ? h.ic('alert') : '';
  const more = view.detail
    ? '<details class="rw-det"><summary>Details</summary><code>' + h.esc(view.detail) + '</code></details>'
    : '';
  return '<div class="tk-notice tk-notice--red">' + icon + '<span class="grow">' + h.esc(view.text) + more + '</span></div>';
}

if (typeof module !== 'undefined') module.exports = {REWIND_ERROR_LINE, rewindRawReason, rewindErrorView, rewindErrorHTML};
