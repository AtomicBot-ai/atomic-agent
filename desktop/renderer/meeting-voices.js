/* ATO-2514: Record a meeting, speakers told apart by voice.

   main/meeting-voices.ts runs the agent's `diarize` (sherpa-onnx, on this
   computer). It is off by default (opt-in); when off, a stopped recording
   shows one line linking to Settings, Meetings. The first meeting with it on downloads the engine and two
   small models once (about 56 to 64 MB); the panel shows that download with
   a Skip, and during Make notes "Telling speakers apart". When it cannot
   run, the meeting uses Me / Them or the pause guess; nothing fails.

   Loaded after meeting-system.js, before meeting-panel.js; uses BR, esc,
   MTG and mtgPaint only at run time. The pure part is exported for
   test/meeting-voices-panel.test.mjs. */

const MTGV = {on: false, offer: false, download: null, failed: false, running: null, listening: false};

/** `Getting the speaker model, 23 of 56 MB. It is downloaded once.` */
function meetingDownloadText(fraction, totalBytes) {
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  const total = Number.isFinite(totalBytes) && totalBytes > 0 ? Math.round(totalBytes / 1e6) : 0;
  const part = total ? Math.round(f * total) + ' of ' + total + ' MB' : Math.round(f * 100) + '%';
  return 'Getting the speaker model, ' + part + '. It is downloaded once and stays on this computer.';
}

/** The line under the transcript about voices; '' when there is nothing to say. */
function meetingVoicesText(v, phase) {
  if (!v) return '';
  if (phase === 'finishing' && typeof v.running === 'number') return 'Telling speakers apart, ' + Math.round(v.running * 100) + '%.';
  if (v.download) return meetingDownloadText(v.download.fraction, v.download.totalBytes);
  if (v.failed) return 'The speaker model could not be downloaded. This meeting uses the simpler speaker labels.';
  return '';
}

/** Off (the default) and possible here: after a recording, one line offers it, linked to Settings, Meetings. */
function meetingVoicesOfferHTML(v, phase) {
  if (!v || !v.offer || v.on || phase !== 'stopped') return '';
  return '<p class="mtgsys"><button class="set-link" data-act="settings:meetings">Tell voices apart: Download (60 MB)</button></p>';
}

function mtgVoicesHTML() {
  const phase = typeof MTG !== 'undefined' ? MTG.phase : '';
  const offer = meetingVoicesOfferHTML(MTGV, phase);
  if (offer) return offer;
  const text = meetingVoicesText(MTGV, phase);
  if (!text) return '';
  const skip = MTGV.download && phase !== 'finishing' ? '<button class="btn sm" data-mtgv="skip">Skip</button>' : '';
  return '<p class="mtgsys">' + esc(text) + skip + '</p>';
}

function mtgvPaint() { if (typeof mtgPaint === 'function') mtgPaint(); }

function mtgvListen() {
  if (MTGV.listening || typeof BR === 'undefined' || !BR || !BR.onMeeting) return;
  MTGV.listening = true;
  BR.onMeeting((ev) => {
    if (!ev) return;
    if (ev.type === 'voices') {
      if (ev.state === 'downloading') { MTGV.download = {fraction: ev.fraction || 0, totalBytes: ev.totalBytes || 0}; MTGV.failed = false; }
      else { MTGV.download = null; MTGV.failed = ev.state === 'failed'; if (ev.state === 'cancelled') MTGV.on = false; }
      mtgvPaint();
    } else if (ev.type === 'voices-run' && typeof MTG !== 'undefined' && ev.id === MTG.id) {
      MTGV.running = ev.fraction || 0;
      mtgvPaint();
    }
  });
}

/** At the start of a recording: is it on here (main started the download if it was missing)? */
async function mtgVoicesRefresh() {
  mtgvListen();
  MTGV.running = null; MTGV.failed = false;
  if (typeof BR === 'undefined' || !BR || !BR.meetingVoicesStatus) { MTGV.on = false; return; }
  try {
    const st = await BR.meetingVoicesStatus();
    MTGV.on = !!(st && st.enabled && st.supported);
    MTGV.offer = !!(st && st.known && st.supported && !st.enabled);   // ATO-2514: opt-in, offered after a recording
    if (st && !st.downloading) MTGV.download = null;
  } catch (e) { MTGV.on = false; MTGV.offer = false; }
  mtgvPaint();
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-mtgv="skip"]') : null;
    if (!b) return;
    e.preventDefault();
    if (typeof BR !== 'undefined' && BR && BR.meetingVoicesCancel) BR.meetingVoicesCancel();
  });
}

if (typeof module !== 'undefined') {
  module.exports = {meetingDownloadText, meetingVoicesText, meetingVoicesOfferHTML};
}
