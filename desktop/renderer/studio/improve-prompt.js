/* Studio › Improve prompt (ATO-809): a button under the prompt box that has
   the chat model rewrite the prompt once (BR.studio.improvePrompt, main
   studio-improve-prompt.ts). Always shown with the prompt box; greyed, with
   the reason as its tooltip, while the box is empty or no chat model can
   answer (BR.studio.improveReady). After a rewrite an Undo puts the old text
   back. Loaded before the pages; declares only.

   The state rules are pure and tested in test/studio-improve-prompt.test.mjs. */

const STUDIO_IMPROVE_EMPTY = 'Type a prompt first';
const STUDIO_IMPROVE_CHECKING = 'Checking the chat model';
const STUDIO_IMPROVE_OLD_BUILD = 'Improve prompt needs a newer app build';
const STUDIO_IMPROVE_EDITED = 'You edited the prompt while it was being rewritten, so your text was kept.';

/** A page's Improve state before anything is known. */
function studioImproveBlank() {
  return {ready: null, why: '', busy: false, err: '', undo: null};
}

/** Why the button is greyed for `text` and the state `st`, or '' when it can run. */
function studioImproveWhy(text, st) {
  const s = st || studioImproveBlank();
  if (s.busy) return 'Improving the prompt';
  if (!String(text == null ? '' : text).trim()) return STUDIO_IMPROVE_EMPTY;
  if (s.ready === null) return STUDIO_IMPROVE_CHECKING;
  if (!s.ready) return s.why || STUDIO_IMPROVE_OLD_BUILD;
  return '';
}

/**
 * The Improve button (and Undo after a rewrite) for the row under the prompt
 * box, then the last error, if any. `attr(verb)` gives a button's click
 * attribute in the page's own scheme (verbs `improve`, `improve-undo`).
 * A greyed button stays focusable and keeps its tooltip (aria-disabled, not
 * disabled); the page ignores its click.
 */
function studioImproveHTML(text, st, attr) {
  const s = st || studioImproveBlank();
  const e = (x) => String(x).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const why = studioImproveWhy(text, s);
  const icon = typeof ic === 'function' ? ic('wand') : '';
  return '<button class="st-improve' + (why ? ' off' : '') + (s.busy ? ' busy' : '') + '" ' + attr('improve')
    + (why ? ' aria-disabled="true" title="' + e(why) + '"' : ' title="Rewrite this prompt with your chat model"') + '>'
    + icon + '<span>' + (s.busy ? 'Improving…' : 'Improve prompt') + '</span></button>'
    + (s.undo !== null && !s.busy ? '<button class="st-link st-improve-undo" ' + attr('improve-undo') + '>Undo</button>' : '')
    + (s.err ? '<span class="st-improve-err" role="status">' + e(s.err) + '</span>' : '');
}

/** Bring a drawn button in line with `text` without drawing the form again (typing keeps the caret). */
function studioImproveSync(btn, text, st) {
  if (!btn) return;
  const why = studioImproveWhy(text, st);
  btn.classList.toggle('off', !!why);
  if (why) { btn.setAttribute('aria-disabled', 'true'); btn.title = why; }
  else { btn.removeAttribute('aria-disabled'); btn.title = 'Rewrite this prompt with your chat model'; }
}

/** Ask main whether a chat model can rewrite now; fills `st.ready` / `st.why`. */
async function studioImproveCheck(br, st) {
  if (!br || typeof br.improveReady !== 'function') { st.ready = false; st.why = STUDIO_IMPROVE_OLD_BUILD; return st; }
  try {
    const r = await br.improveReady();
    if (r && r.ok && r.data) { st.ready = !!r.data.ready; st.why = String(r.data.why || ''); }
    else { st.ready = false; st.why = (r && r.error && r.error.message) || 'Could not check the chat model'; }
  } catch (e) { st.ready = false; st.why = 'Could not check the chat model'; }
  return st;
}

/**
 * One rewrite of `text` for the `kind` page. Resolves the new prompt, or
 * null with `st.err` set. `st.undo` keeps the old text after a rewrite.
 */
async function studioImproveRun(br, kind, text, st) {
  st.err = '';
  if (studioImproveWhy(text, st)) return null;
  if (!br || typeof br.improvePrompt !== 'function') { st.err = STUDIO_IMPROVE_OLD_BUILD + '.'; return null; }
  st.busy = true;
  let r = null;
  try { r = await br.improvePrompt(kind === 'video' ? 'video' : 'image', String(text)); } catch (e) { r = null; }
  st.busy = false;
  const next = r && r.ok && r.data && typeof r.data.prompt === 'string' ? r.data.prompt.trim() : '';
  if (!next) {
    st.err = (r && r.error && r.error.message) || 'Could not improve the prompt. Try again.';
    if (r && r.error && r.error.code === 'NO_CHAT_MODEL') { st.ready = false; st.why = r.error.message; }
    return null;
  }
  st.undo = String(text);
  return next;
}

/**
 * After a rewrite came back: whether it may replace the box. The box still
 * holds `current`; it held `sent` when the rewrite was asked for. The box
 * stays editable while a rewrite runs, so text typed meanwhile wins over the
 * rewrite (it would be lost otherwise, Undo only knows `sent`).
 */
function studioImproveLands(st, sent, current) {
  if (String(current == null ? '' : current) === String(sent == null ? '' : sent)) return true;
  st.undo = null;
  st.err = STUDIO_IMPROVE_EDITED;
  return false;
}

if (typeof module !== 'undefined') {
  module.exports = {STUDIO_IMPROVE_EMPTY, STUDIO_IMPROVE_EDITED, studioImproveBlank, studioImproveWhy, studioImproveHTML, studioImproveSync, studioImproveCheck, studioImproveRun,
    studioImproveLands};
}
