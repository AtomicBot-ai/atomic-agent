/* ATO-1042 — the first launch goes straight to a chat on the starter model.

   Main fetches the starter model when the app starts with nothing to answer
   on (ATO-1041, app:starterModel). While it is on its way the window does not
   ask for a key or a model: a wizard still on its title card closes, the chat
   shows one line with the download's progress, and the first message goes out
   once the model is ready (until then Send says why). A cloud key or a bigger
   model stays one click away: the line links to the setup. */

const STARTER = { phase: null, id: null, percent: null, error: null };

function starterNoticeHTML() {
  if (!STARTER.phase) return '';
  const tone = STARTER.phase === 'failed' ? 'red' : STARTER.phase === 'ready' ? 'green' : 'blue';
  const text = STARTER.phase === 'downloading'
    ? 'Getting a small model ready on this computer' + (STARTER.percent != null ? ' (' + STARTER.percent + '%)' : '') + '. You can start typing; it answers as soon as the model is here.'
    : STARTER.phase === 'ready'
      ? 'Ready: chats run on a small model on this computer. A cloud key or a bigger model is in the setup.'
      : 'The small model could not be downloaded' + (STARTER.error ? ': ' + STARTER.error : '') + '.';
  return '<div class="tk-notice tk-notice--' + tone + ' starter-note" role="status">' + ic(STARTER.phase === 'failed' ? 'alert' : 'info')
    + '<span class="grow">' + esc(text) + '</span>'
    + '<button class="btn btn-s sm" data-act="onboarding">' + (STARTER.phase === 'failed' ? 'Set up' : 'Add a key or a model') + '</button></div>';
}

/** Send is held while the starter model is still coming, unless the person moved to the cloud meanwhile (renderer submit). */
function starterHoldsSend() {
  if (STARTER.phase !== 'downloading') return false;
  return !(typeof selBackend === 'function' && selBackend() === 'cloud');
}

/** A window that loads after main said where the starter stands asks once (app:starterGet). */
function starterCatchUp() {
  if (typeof BR === 'undefined' || !BR || !BR.starterGet) return;
  BR.starterGet().then((ev) => { if (ev && !STARTER.phase) starterOnEvent(ev); }).catch(() => {});
}

function starterOnEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  STARTER.id = ev.id || STARTER.id;
  STARTER.phase = ev.phase || null;
  STARTER.error = ev.error || null;
  if (STARTER.phase === 'downloading' && typeof OB !== 'undefined' && OB.open && OB.step === 'intro' && !OB.introTyped) {
    // The title card was all the wizard had shown: the chat takes its place.
    OB.open = false;
    if (typeof obSkyStop === 'function') obSkyStop();
  }
  if (STARTER.phase === 'done') STARTER.phase = null;   // another choice stood; the line goes
  if (STARTER.phase === 'ready' && typeof refreshLiveConfig === 'function') refreshLiveConfig().catch(() => {});
  render();
}

function starterOnPull(ev) {
  if (!ev || STARTER.phase !== 'downloading' || ev.id !== STARTER.id) return;
  if (typeof ev.percent === 'number') { STARTER.percent = Math.round(ev.percent); render(); }
}

if (typeof module !== 'undefined') module.exports = { STARTER, starterNoticeHTML: () => '', starterHoldsSend };
