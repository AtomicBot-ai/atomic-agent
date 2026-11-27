/* ---------------- Settings › My files: scans, photos and audio (ATO-2501) ----------------
   Loaded after my-files.js and BEFORE renderer.js, so it only declares: BR, MF,
   LIVE_CONFIG, esc, ic, setSwitchHTML, configPatchOr, refreshLiveConfig,
   mfRefreshStatus and mfRepaint are read when a function runs.

   One switch, `vision.indexFiles` in the agent's config: while it is on the
   agent reads scanned PDF pages and photos with the vision model running on
   this computer (never a cloud model), and audio with whisper.cpp. Turning it
   on also asks the agent to read again the files it skipped for want of one
   (POST /api/files/retry). Below it: how many scanned pages were read, and why
   files were skipped, in words, with the agent's own reason under Details.

   Precedent: LM Studio and Open WebUI run document OCR on the local model;
   Paperless-ngx lists per document why OCR did not read it. */

const MFO = {
  busy: false,   // the switch's write is running
  error: null,   // the last write's error, in words
  note: null,    // "Saved. Restart …" when only the file changed
};

const MFO_TITLE = 'Read scans, photos and audio';
const MFO_HELP = 'Uses the vision model running on this computer to read scanned PDFs and photos, and whisper.cpp for audio. Cloud models are never used for it. Each page or photo takes one model call, so a big folder takes a while.';

/* The agent's skip reason (file-text.ts, media-text.ts) in words a person can act on. */
function mfoSkipText(reason) {
  const r = String(reason || '');
  if (r.startsWith('scan: OCR not available (no OCR engine')) return 'Scanned PDFs: reading scans is off';
  if (r.startsWith('scan: OCR not available (no vision model')) return 'Scanned PDFs: no vision model is running on this computer';
  if (/^scan: OCR not available \(.* cannot read images\)$/.test(r)) return 'Scanned PDFs: the loaded model cannot read images';
  if (r.startsWith('scan: OCR not available')) return 'Scanned PDFs: no OCR reader is ready';
  if (r.startsWith('scan: OCR failed')) return 'Scanned PDFs: reading the scan failed';
  if (r === 'scan: OCR found no text') return 'Scanned PDFs with no readable text';
  const kind = r.split(':', 1)[0];
  if (kind === 'disabled') return 'Photos and audio: reading them is off';
  if (kind === 'no-vision-model') return 'Photos: no vision model that reads images is running on this computer';
  if (kind === 'no-engine') return 'Audio: whisper.cpp is not installed';
  if (kind === 'needs-model-download') return 'Audio: the speech model is not downloaded yet';
  if (kind === 'no-model') return 'Audio: no speech model was found';
  if (kind === 'needs-ffmpeg') return 'Audio: ffmpeg is needed to convert it';
  if (kind === 'too-large' || r.startsWith('larger than ')) return 'Too large to index';
  if (r === 'unsupported file type' || kind === 'unsupported') return 'File type not supported';
  if (r === 'no text in the file') return 'No text in the file';
  return 'Skipped for another reason';
}

/* Whether this reason waits for the switch: it clears once a local reader is on. */
function mfoWaitsForSwitch(reason) {
  const r = String(reason || '');
  return r.startsWith('scan: OCR not available (no OCR engine') || r === 'disabled';
}

function mfoPagesText(n) {
  const pages = Math.max(0, Math.floor(Number(n) || 0));
  return pages ? pages + ' scanned page' + (pages === 1 ? '' : 's') + ' read' : '';
}

/* `true` / `false` from the agent's config file, `null` before it is known. */
function mfoOn() {
  if (typeof LIVE_CONFIG === 'undefined' || !LIVE_CONFIG) return null;
  const v = LIVE_CONFIG.vision && LIVE_CONFIG.vision.indexFiles;
  return v === true;
}

function mfoReasonsHTML(rows) {
  if (!rows || !rows.length) return '';
  const items = rows.map((row) => '<li class="mfo-reason"><span class="grow">' + esc(mfoSkipText(row.reason)) + '</span>'
    + '<span class="mfo-n">' + esc(row.count + ' file' + (row.count === 1 ? '' : 's')) + '</span></li>').join('');
  const raw = rows.map((row) => row.count + ' × ' + row.reason).join('\n');
  return '<div class="mfo-skips"><h5 class="mfo-h">Skipped files</h5><ul class="mfo-list">' + items + '</ul>'
    + '<details class="mfo-det"><summary>Details</summary><pre class="mono">' + esc(raw) + '</pre></details></div>';
}

/* The section under the progress: the switch, pages read, skip reasons. */
function mfOcrSectionHTML() {
  if (typeof MF === 'undefined' || MF.unsupported || !MF.folders || !MF.folders.length) return '';
  const st = MF.status;
  const on = mfoOn();
  const known = on !== null;
  const waiting = st && st.skippedReasons ? st.skippedReasons.filter((row) => mfoWaitsForSwitch(row.reason)).reduce((n, row) => n + row.count, 0) : 0;
  const pages = st ? mfoPagesText(st.ocrPages) : '';
  const lines = [];
  if (MF.remote) lines.push('<div class="tk-help">This is set on the computer the agent runs on.</div>');
  else if (!on && waiting) lines.push('<div class="tk-help">' + esc(waiting + (waiting === 1 ? ' file is' : ' files are') + ' waiting for this.') + '</div>');
  if (pages) lines.push('<div class="tk-help">' + esc(pages) + '</div>');
  if (MFO.note) lines.push('<div class="tk-help">' + esc(MFO.note) + '</div>');
  if (MFO.error) lines.push('<div class="tk-help tk-help--warn">' + esc(MFO.error) + '</div>');
  const row = '<div class="tk-setrow mfo-row">'
    + '<div class="body"><div class="t">' + esc(MFO_TITLE) + '</div><div class="d">' + esc(MFO_HELP) + '</div>' + lines.join('') + '</div>'
    + setSwitchHTML({on: !!on, busy: MFO.busy || (!known && !!BR), disabled: !known || MFO.busy || !BR || MF.remote, act: 'myfiles:ocr',
      label: MFO_TITLE, title: 'Turn reading scans, photos and audio ' + (on ? 'off' : 'on')})
    + '</div>';
  return '<div class="mfo">' + row + mfoReasonsHTML(st && st.skippedReasons) + '</div>';
}

async function mfOcrToggle() {
  if (!BR || MFO.busy || MF.remote) return;
  const next = !mfoOn();
  MFO.busy = true; MFO.error = null; MFO.note = null; mfRepaint();
  try {
    const res = await configPatchOr({vision: {indexFiles: next}}, () => BR.configSet('vision.indexFiles', String(next)));
    if (!res.ok) MFO.error = 'Could not save the setting. Try again.';
    else if (!res.live) MFO.note = 'Saved. Restart Atomic Agent to apply.';
    else if (next && BR.filesRetry) {
      // The agent reads the files it skipped for want of a reader again.
      const retry = await BR.filesRetry();
      if (retry && retry.ok && retry.requeued) MFO.note = 'Reading ' + retry.requeued + ' skipped file' + (retry.requeued === 1 ? '' : 's') + ' again.';
    }
  } catch (e) {
    MFO.error = 'Could not save the setting. Try again.';
  } finally {
    MFO.busy = false;
  }
  if (typeof refreshLiveConfig === 'function') await refreshLiveConfig();
  if (typeof mfRefreshStatus === 'function') await mfRefreshStatus();
  mfRepaint();
}

if (typeof module !== 'undefined') module.exports = {mfoSkipText, mfoWaitsForSwitch, mfoPagesText, MFO_TITLE, MFO_HELP};
