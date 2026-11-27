/* ---------------- the engine failure card's title (ATO-2515) ----------------
   Loaded before renderer.js; declares only.

   main/engine-failure.ts sends one failure word with a `reason`. Most reasons
   are the engine itself (a download, a verify, a start), and the card says
   "The local engine isn't ready". Two kinds are the model, not the engine:
   a damaged or missing model file (ATO-1745, the card offers "Download model
   again") and a model the engine is too old for (ATO-1739, update the app).
   Those carry their own title, so the toast, the strip over the composer, the
   Settings card and the setup's runtime row do not read as a broken engine.
   The body (`why`) stays main's sentence. renderer.js owns the markup. */

const ENGF_TITLE = 'The local engine isn\u2019t ready';
const ENGF_TITLE_MODEL_FILE = 'The model file needs to be downloaded again';
const ENGF_TITLE_UNSUPPORTED = 'Update Atomic Agent to run this model';

/** The title for a failure word: the model's own trouble, or the engine's. */
function engfTitleOf(f) {
  const r = f && f.reason;
  if (r === 'model_file_corrupt' || r === 'model_file_missing') return ENGF_TITLE_MODEL_FILE;
  if (r === 'model_unsupported') return ENGF_TITLE_UNSUPPORTED;
  return ENGF_TITLE;
}

/** The app line said once: the model's title when it is the model, else the engine's line as before. */
function engfSayLine(f) {
  const title = engfTitleOf(f);
  const rest = (f && (f.detail || f.why)) || '';
  return (title === ENGF_TITLE ? 'The local engine is not ready' : title) + ': ' + rest;
}

if (typeof module !== 'undefined') {
  module.exports = {ENGF_TITLE, ENGF_TITLE_MODEL_FILE, ENGF_TITLE_UNSUPPORTED, engfTitleOf, engfSayLine};
}
