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

function ttsSettingsHTML() {
  let h = '<form method="dialog" class="ttsset"><h2 class="ttsset-h">Reading voice and speed</h2>';
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
  if (!ttsAvailable()) { toast('No voices to read with', 'This computer has no system voices for reading aloud yet.', 'bad'); return; }
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
}

function ttsSettingsChanged(e) {
  const t = e.target;
  if (t.dataset.ttsVoice) ttsSetVoice(t.dataset.ttsVoice, t.value);
  if (t.hasAttribute('data-tts-rate')) {
    ttsSetRate(t.value);
    const out = t.parentNode.querySelector('[data-tts-rate-out]');
    if (out) out.textContent = TTS.rate.toFixed(1) + '×';
  }
}
