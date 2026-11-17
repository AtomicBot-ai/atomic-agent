/* ---------------- ATO-1074: transcribe an audio file, on this computer ----------------
   An audio file dropped on the composer or picked with "+" → Files becomes a
   chip with a Transcribe button (attachments.js hands audio items here). The
   file is heard by the same on-device speech helper as voice input
   (main/transcribe-file.ts); the result comes back as `[HH:MM:SS] text` lines
   and replaces the audio chip with a `<name> transcript.txt` attachment, so
   the agent reads it like any other file. The audio itself is never sent.

   Offered only where the helper can run: macOS with the voice helper
   (BR.voiceSupported), and main's speech:fileAvailable says why not
   otherwise (older macOS, no helper, no language model on this Mac).

   Loaded after attachments.js and before renderer.js; it reads their globals
   (ATT, attRepaint, attFail, attLive, attPrepare, BR, esc, ic, toast) only
   when a function runs. The pure part is exported for the unit suite. */

const TRX = {listening: false};

/** The chip's line while it works. */
function trxProgressText(fraction) {
  const f = typeof fraction === 'number' && isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  return f > 0 ? 'Transcribing… ' + Math.round(f * 100) + '%' : 'Transcribing…';
}
/** Why an audio chip cannot offer Transcribe (main's TranscribeReason). */
function trxReasonText(reason) {
  switch (reason) {
    case 'voice-os-too-old': return 'Transcribing audio needs macOS 26 or later';
    case 'voice-helper-missing': return 'This build has no speech helper, so audio cannot be transcribed';
    case 'voice-model-missing': return 'Add a language in voice input first, then transcribe';
    case 'voice-not-macos': return 'Audio files are not supported yet';
    default: return 'Audio cannot be transcribed on this computer';
  }
}
/** Why a run failed (main's TranscribeResult.error). */
function trxErrorText(error) {
  switch (error) {
    case 'missing': return 'The audio file is no longer there';
    case 'not-audio': return 'This file type cannot be transcribed';
    case 'busy': return 'Another file is being transcribed. Try again when it is done';
    case 'open-file': return 'This audio file could not be opened';
    case 'voice-model-missing': case 'voice-os-too-old': case 'voice-helper-missing': return trxReasonText(error);
    default: return 'The transcription stopped before it finished';
  }
}

/** True where the Transcribe action can exist at all (never off macOS). */
function trxOffer() {
  return !!(typeof BR !== 'undefined' && BR && BR.voiceSupported && BR.transcribeFile && BR.transcribeAvailable);
}
function trxLangName(id) {
  try { if (typeof voiceLangName === 'function') return voiceLangName(id); } catch (e) { /* the tag */ }
  return id;
}

/** An audio item just added (attAdd): find out whether it can be heard here. */
async function trxPrepare(item, path) {
  if (!path) return attFail(item, 'Drop or pick the audio file itself to transcribe it');
  let av = null;
  try { av = await BR.transcribeAvailable(); } catch (e) { av = null; }
  if (!attLive(item)) return;
  if (!av || !av.ok) return attFail(item, trxReasonText(av && av.reason));
  item.audioPath = path;
  item.locale = av.locale || '';
  item.status = 'audio';
  attRepaint();
}

function trxListen() {
  if (TRX.listening || !BR || !BR.onTranscribe) return;
  TRX.listening = true;
  BR.onTranscribe((p) => {
    if (!p || typeof p.job !== 'string') return;
    const item = ATT.items.find((i) => i.job === p.job);
    if (!item || item.status !== 'transcribing') return;
    if (typeof p.fraction === 'number') item.progress = p.fraction;
    attRepaint();
  });
}

async function trxRun(id) {
  const item = ATT.items.find((i) => i.id === id);
  if (!item || item.kind !== 'audio' || item.status !== 'audio') return;
  trxListen();
  item.status = 'transcribing';
  item.progress = 0;
  item.job = 'trx-' + Date.now() + '-' + id;
  attRepaint();
  let res;
  try { res = await BR.transcribeFile({job: item.job, path: item.audioPath}); } catch (e) { res = {ok: false, error: 'spawn'}; }
  item.job = null;
  if (!attLive(item) || item.status !== 'transcribing') return;
  if (!res || !res.ok) {
    item.status = 'audio';
    attRepaint();
    if (!(res && res.cancelled)) toast('Could not transcribe ' + item.name, trxErrorText(res && res.error), 'bad');
    return;
  }
  if (!res.segments || !res.segments.length || !res.document) {
    item.status = 'audio';
    attRepaint();
    toast('Nothing to transcribe', 'No speech was heard in ' + item.name + (item.locale ? ' (' + trxLangName(item.locale) + ')' : ''));
    return;
  }
  // The audio chip becomes the transcript's chip and is saved like a typed file.
  const fileName = res.fileName || (item.name + ' transcript.txt');
  let file;
  try { file = new File([res.document], fileName, {type: 'text/plain'}); } catch (e) { return attFail(item, 'The transcript could not be saved'); }
  item.kind = 'document';
  item.name = fileName;
  item.size = file.size;
  item.key = 'trx:' + item.audioPath;
  item.status = 'preparing';
  attRepaint();
  const lines = res.segments.length;
  attPrepare(item, {file}).then(() => {
    if (attLive(item) && item.status === 'ready') toast('Transcript attached', lines + (lines === 1 ? ' line' : ' lines') + ', ready to send with your message');
  }).catch(() => attFail(item, 'The transcript could not be saved'));
}

/** The chip is removed (attRemove): a run in flight is stopped. */
function trxForget(item) {
  if (item && item.job && BR && BR.transcribeCancel) {
    const job = item.job;
    item.job = null;
    BR.transcribeCancel(job);
  }
}

/** An audio chip that is not an error: waiting, ready to transcribe, or working. */
function trxChipHTML(i, x) {
  const busy = i.status === 'transcribing' || i.status === 'preparing';
  const lang = i.locale ? trxLangName(i.locale) : '';
  const tip = i.name + (i.status === 'audio' && lang ? ' · Transcribed on this computer, in ' + lang : '');
  const sub = i.status === 'transcribing' ? trxProgressText(i.progress) : i.status === 'preparing' ? 'Preparing…' : '';
  return '<div class="attchip is-doc is-audio' + (busy ? ' is-busy' : '') + '" title="' + esc(tip) + '">'
    + '<span class="atticon">' + ic('mic') + '</span>'
    + '<span class="attmeta"><span class="attname">' + esc(i.name) + '</span>'
    + (i.status === 'audio'
      ? '<button class="trxbtn" data-trx-run="' + esc(i.id) + '">Transcribe</button>'
      : '<span class="attsub">' + esc(sub) + '</span>')
    + '</span>' + x + '</div>';
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const t = e.target;
    const run = t && t.closest ? t.closest('[data-trx-run]') : null;
    if (!run) return;
    e.preventDefault();
    trxRun(run.getAttribute('data-trx-run'));
  });
}

if (typeof module !== 'undefined') {
  module.exports = {trxProgressText, trxReasonText, trxErrorText, trxOffer};
}
