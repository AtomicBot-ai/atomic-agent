/* ---------------- The Hugging Face mirror field ----------------
   Loaded BEFORE renderer.js, so it only declares. Shared by the renderer
   and the Node checks (test/hf-mirror.test.mjs): the field's markup and
   the sentence under it. No IPC here.

   Where "Look it up" and the model download go: huggingface.co, or a
   mirror for places where it is slow or blocked. main/hf-mirror.ts owns
   the rule and the write (`localModels.download.hfEndpoint`, the key the
   agent's own `models pull` reads); this only draws what it answered.
   Drawn in two places, Settings › Models' Hugging Face card and the
   first-run wizard's Hugging Face step, because the wizard is modal and a
   hint that sends someone to Settings from there would be a dead end. */

const HF_DEFAULT_HOST = 'huggingface.co';
const HF_MIRROR_EXAMPLE = 'https://hf-mirror.com';

/* The host a lookup asks right now, for "asking hf-mirror.com…". `st` is
   the field's state ({state, draft, error, saving, saved}); `state` is
   main's answer (hf-mirror.ts HfMirrorState), null until it has come. */
function hfMirrorHost(st) {
  return (st && st.state && st.state.host) || HF_DEFAULT_HOST;
}

/* The line under the field: where models come from, and why. */
function hfMirrorNote(st) {
  const s = st && st.state;
  if (s && s.override) {
    return 'HF_ENDPOINT is set in ' + (s.override.from === '.env' ? 'the agent’s .env file' : 'the environment')
      + ', so models come from ' + s.host + ' whatever this field says.';
  }
  if (s && s.configured) return 'Models are looked up and downloaded from ' + s.host + '. Leave it empty to use ' + HF_DEFAULT_HOST + '.';
  return 'Leave it empty to use ' + HF_DEFAULT_HOST + '. If it is blocked where you are, try ' + HF_MIRROR_EXAMPLE + '.';
}

/* The field. `ids.input` is the input's id; `ids.save` the attribute that
   routes the Save button (`data-act="…"` in Settings, `data-obact="…"` in
   the wizard). `h` carries the renderer's esc and ic. */
function hfMirrorHTML(st, h, ids) {
  const busy = !!(st && st.saving);
  const draft = st && typeof st.draft === 'string' ? st.draft : '';
  const note = (st && st.saved ? 'Saved. ' : '') + hfMirrorNote(st);
  return '<div class="hfm">'
    + '<label class="hfm-lbl" for="' + ids.input + '">Hugging Face mirror</label>'
    + '<div class="hfm-row"><label class="tk-inpwrap hfm-inp">'
      + '<input id="' + ids.input + '" value="' + h.esc(draft) + '" autocomplete="off" spellcheck="false" placeholder="https://' + HF_DEFAULT_HOST + '"'
      + (busy ? ' disabled' : '') + '></label>'
      + '<button class="btn btn-s sm" ' + ids.save + (busy ? ' disabled' : '') + '>' + (busy ? 'Saving…' : 'Save') + '</button></div>'
    + (st && st.error
      ? '<div class="tk-notice tk-notice--red hfm-err">' + h.ic('alert') + '<span class="grow">' + h.esc(st.error) + '</span></div>'
      : '<p class="hfm-note">' + h.esc(note) + '</p>')
    + '</div>';
}

if (typeof module !== 'undefined') {
  module.exports = {HF_DEFAULT_HOST, HF_MIRROR_EXAMPLE, hfMirrorHost, hfMirrorNote, hfMirrorHTML};
}
