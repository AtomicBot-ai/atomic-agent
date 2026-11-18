/* ATO-494 — View › Reading Voice and Speed…

   One small dialog for what tts.js reads with: the voice for English
   replies, the voice for Russian replies, and the speed. Every list is the
   system's own voices (speechSynthesis.getVoices()); "System default" lets
   the system choose. A voice the system marks as not local reads through a
   network service, so it is labelled as such rather than hidden. Built
   outside render(): the chat repaints underneath it without closing it. */

const TTS_LANGS = [
  { id: 'en', label: 'English replies', sample: 'This is how replies will sound.' },
  { id: 'ru', label: 'Russian replies', sample: 'Так будут звучать ответы.' },
];

function ttsSettingsVoiceOptions(lang) {
  const voices = ttsVoicesFor(lang);
  let h = '<option value="">System default</option>';
  voices.forEach((v) => {
    h += '<option value="' + esc(v.name) + '"' + (TTS.voice[lang] === v.name ? ' selected' : '') + '>'
      + esc(v.name) + (v.localService === false ? ' (online)' : '') + '</option>';
  });
  return { html: h, count: voices.length };
}

/* ATO-1167: the engine row. "Neural voice" is a speech model from the
   Atomic Chat catalog served by Atomic Core on this computer
   (main/core-speech.ts); its status line and Download button are filled in
   by ttsSettingsCorePaint once main answers. */
const TTS_CORE_UI = {status: null, busy: false, line: '', listening: false};

function ttsGb(bytes) {
  const gb = Number(bytes) / 1024 ** 3;
  return gb >= 1 ? gb.toFixed(1) + ' GB' : Math.max(1, Math.round(Number(bytes) / 1024 ** 2)) + ' MB';
}

/** The words under the engine row for main's CoreSpeechStatus. */
function ttsCoreStatusText(st) {
  if (!st) return 'Checking the neural voice…';
  if (st.ok) return (st.model ? st.model.name : 'The neural voice') + ' reads replies on this computer.';
  const name = st.model ? st.model.name + ' (' + ttsGb(st.model.bytes) + ')' : 'the voice model';
  switch (st.reason) {
    case 'core-too-old': return 'This build\'s Atomic Core has no voice engine yet. The system voices read until an update brings it.';
    case 'catalog-unavailable': return 'The list of neural voices could not be loaded. Check your connection and try again.';
    case 'no-model': return 'No neural voice is offered for this computer yet.';
    case 'model-not-downloaded': case 'engine-not-installed': return 'Download ' + name + ' to read with it. It runs on this computer, no key and no internet after the download.';
    case 'core-unavailable': return 'Atomic Core could not be reached. Try again.';
    default: return 'The neural voice cannot read right now.';
  }
}

function ttsCoreRowHTML() {
  const st = TTS_CORE_UI.status;
  let h = '<p class="ttsset-note" data-tts-core-line>' + esc(TTS_CORE_UI.line || ttsCoreStatusText(st)) + '</p>';
  const models = (st && st.models) || [];
  if (models.length > 1) {
    h += '<label class="ttsset-row"><span>Neural voice</span><span class="ttsset-pick"><select data-tts-core-model' + (TTS_CORE_UI.busy ? ' disabled' : '') + '>';
    models.forEach((m) => {
      h += '<option value="' + esc(m.id) + '"' + (st.model && st.model.id === m.id ? ' selected' : '') + '>'
        + esc(m.name) + ' · ' + ttsGb(m.bytes) + (m.downloaded ? '' : ' (download)') + '</option>';
    });
    h += '</select></span></label>';
  }
  const canGet = st && !st.ok && (st.reason === 'model-not-downloaded' || st.reason === 'engine-not-installed');
  const retry = st && !st.ok && (st.reason === 'core-unavailable' || st.reason === 'catalog-unavailable');
  if (TTS_CORE_UI.busy) h += '<div class="ttsset-foot"><button type="button" class="btn btn-t xs" data-tts-core-stop>Stop download</button></div>';
  else if (canGet) h += '<div class="ttsset-foot"><button type="button" class="btn xs" data-tts-core-get>Download</button></div>';
  else if (retry) h += '<div class="ttsset-foot"><button type="button" class="btn btn-t xs" data-tts-core-retry>Try again</button></div>';
  return h;
}

function ttsSettingsCorePaint() {
  const box = document.querySelector('#tts-settings [data-tts-core]');
  if (box) box.innerHTML = TTS.engine === 'core' ? ttsCoreRowHTML() : '';
}

async function ttsSettingsCoreCheck() {
  TTS_CORE_UI.status = null;
  TTS_CORE_UI.line = '';
  ttsSettingsCorePaint();
  TTS_CORE_UI.status = await ttsCoreRefresh();
  ttsSettingsCorePaint();
}

async function ttsSettingsCoreGet() {
  if (TTS_CORE_UI.busy || !BR || !BR.ttsCorePrepare) return;
  if (!TTS_CORE_UI.listening && BR.onTtsCore) {
    TTS_CORE_UI.listening = true;
    BR.onTtsCore((ev) => {
      if (!TTS_CORE_UI.busy || !ev) return;
      if (ev.type === 'engine') TTS_CORE_UI.line = ev.state === 'installing' ? 'Installing the voice engine…' : 'Downloading the voice…';
      else if (ev.type === 'download' && ev.total > 0) TTS_CORE_UI.line = 'Downloading the voice… ' + Math.min(100, Math.floor(ev.received / ev.total * 100)) + '%';
      else if (ev.type === 'verifying') TTS_CORE_UI.line = 'Checking the download…';
      const line = document.querySelector('#tts-settings [data-tts-core-line]');
      if (line) line.textContent = TTS_CORE_UI.line;
    });
  }
  TTS_CORE_UI.busy = true;
  TTS_CORE_UI.line = 'Preparing…';
  ttsSettingsCorePaint();
  let res = null;
  try { res = await BR.ttsCorePrepare(TTS.coreModel); } catch (e) { res = {ok: false}; }
  TTS_CORE_UI.busy = false;
  if (res && !res.ok && !res.cancelled) toast('The neural voice was not downloaded', (res.message || 'Check your connection and try again.'), 'bad');
  await ttsSettingsCoreCheck();
}

function ttsSettingsHTML() {
  let h = '<form method="dialog" class="ttsset"><h2 class="ttsset-h">Reading voice and speed</h2>';
  if (typeof BR !== 'undefined' && BR && BR.ttsCoreStatus) {
    h += '<label class="ttsset-row"><span>Voice</span><span class="ttsset-pick"><select data-tts-engine>'
      + '<option value="system"' + (TTS.engine === 'system' ? ' selected' : '') + '>System voices</option>'
      + '<option value="core"' + (TTS.engine === 'core' ? ' selected' : '') + '>Neural voice, on this computer</option>'
      + '</select></span></label><div data-tts-core></div>';
  }
  TTS_LANGS.forEach((L) => {
    const o = ttsSettingsVoiceOptions(L.id);
    h += '<label class="ttsset-row"><span>' + L.label + '</span>'
      + '<span class="ttsset-pick"><select data-tts-voice="' + L.id + '"' + (o.count ? '' : ' disabled') + '>' + o.html + '</select>'
      + '<button type="button" class="btn btn-t xs" data-tts-try="' + L.id + '"' + (o.count ? '' : ' disabled') + '>Try</button></span></label>';
    if (!o.count) {
      h += '<p class="ttsset-note">No ' + (L.id === 'ru' ? 'Russian' : 'English') + ' voice on this computer. '
        + 'On a Mac, add one in System Settings › Accessibility › Spoken Content › System Voice › Manage Voices.</p>';
    }
  });
  h += '<label class="ttsset-row"><span>Speed</span><span class="ttsset-pick">'
    + '<input type="range" min="0.5" max="2" step="0.1" value="' + TTS.rate + '" data-tts-rate>'
    + '<output data-tts-rate-out>' + TTS.rate.toFixed(1) + '×</output></span></label>'
    + '<p class="ttsset-note">Voices are your system\'s own. A reply is read by the voice of its language.</p>'
    + '<div class="ttsset-foot"><button class="btn xs" value="close">Done</button></div></form>';
  return h;
}

function ttsSettingsOpen() {
  const canCore = typeof BR !== 'undefined' && BR && BR.ttsCoreStatus;
  if (!ttsAvailable() && !canCore) { toast('No voices to read with', 'This computer has no system voices for reading aloud yet.', 'bad'); return; }
  let d = document.getElementById('tts-settings');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'tts-settings';
    d.className = 'ttsdlg';
    // The app's own key layers must not act on keys meant for this dialog.
    d.addEventListener('keydown', (e) => e.stopPropagation());
    d.addEventListener('change', ttsSettingsChanged);
    d.addEventListener('input', ttsSettingsChanged);
    d.addEventListener('click', (e) => {
      const c = e.target.closest && e.target.closest('[data-tts-core-get],[data-tts-core-stop],[data-tts-core-retry]');
      if (c) {
        if (c.hasAttribute('data-tts-core-get')) ttsSettingsCoreGet();
        else if (c.hasAttribute('data-tts-core-stop')) { if (BR.ttsCorePrepareCancel) BR.ttsCorePrepareCancel(); }
        else ttsSettingsCoreCheck();
        return;
      }
      const t = e.target.closest && e.target.closest('[data-tts-try]');
      if (!t) return;
      const L = TTS_LANGS.find((x) => x.id === t.dataset.ttsTry);
      if (L) ttsSpeak('tts-try', L.sample);
    });
    d.addEventListener('close', () => { if (TTS.speakingId === 'tts-try') ttsStop(); });
    document.body.appendChild(d);
  }
  d.innerHTML = ttsSettingsHTML();
  if (!d.open) d.showModal();
  if (TTS.engine === 'core') ttsSettingsCoreCheck();
}

function ttsSettingsChanged(e) {
  const t = e.target;
  if (e.type === 'change' && t.hasAttribute('data-tts-engine')) {
    ttsSetEngine(t.value);
    if (TTS.engine === 'core') ttsSettingsCoreCheck(); else ttsSettingsCorePaint();
    return;
  }
  if (e.type === 'change' && t.hasAttribute('data-tts-core-model')) {
    ttsSetEngine('core', t.value);
    ttsSettingsCoreCheck();
    return;
  }
  if (t.dataset.ttsVoice) ttsSetVoice(t.dataset.ttsVoice, t.value);
  if (t.hasAttribute('data-tts-rate')) {
    ttsSetRate(t.value);
    const out = t.parentNode.querySelector('[data-tts-rate-out]');
    if (out) out.textContent = TTS.rate.toFixed(1) + '×';
  }
}

if (typeof module !== 'undefined') module.exports = { ttsCoreStatusText, ttsGb };
