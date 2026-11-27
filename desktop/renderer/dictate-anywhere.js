/* ATO-1064: the dictation pill (main/dictate-anywhere-window.ts). It holds
   the microphone for the take, the way the composer does (renderer.js
   voiceCapture): a 16 kHz AudioContext, the voice-worklet.js tap, 100 ms
   chunks to main. main owns the take, its text and the paste; this page
   only listens and shows what main says. */
(async () => {
  const BR = window.atomic;
  try { const t = localStorage.getItem('atag.theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch (e) { /* follow the OS */ }
  const textEl = document.getElementById('da-text');
  const hintEl = document.getElementById('da-hint');
  let stream = null;
  let ac = null;
  let live = true;

  const stopMic = () => {
    live = false;
    try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* gone */ }
    try { if (ac) ac.close(); } catch (e) { /* gone */ }
    stream = null; ac = null;
  };
  window.addEventListener('beforeunload', stopMic);

  const show = (p) => {
    if (!p) return;
    if (p.phase === 'finishing') {
      stopMic();
      document.body.classList.add('da--busy');
      textEl.textContent = p.text ? p.text : 'Typing it in…';
      hintEl.textContent = '';
      return;
    }
    textEl.textContent = p.text ? p.text : 'Listening…';
  };

  if (!BR || !BR.dictateOpened) return;
  const opened = await BR.dictateOpened().catch(() => null);
  // ATO-2750: a failure line from main, with its settings button; the microphone is not opened.
  if (opened && opened.failure && typeof daShowFailure === 'function') { daShowFailure(opened.failure, BR); return; }
  if (opened && (opened.hint || opened.label)) hintEl.textContent = opened.hint || (opened.label + ' types it · esc');
  if (BR.onDictate) BR.onDictate(show);
  document.getElementById('da-done').addEventListener('click', () => { if (BR.dictateStop) BR.dictateStop(); });
  document.getElementById('da-cancel').addEventListener('click', () => { stopMic(); if (BR.dictateCancel) BR.dictateCancel(); });

  try {
    stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true}});
    if (!live) { stopMic(); return; }
    ac = new AudioContext({sampleRate: 16000});
    await ac.audioWorklet.addModule('voice-worklet.js');
    if (!live) { stopMic(); return; }
    const src = ac.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ac, 'pcm-tap');
    const gain = ac.createGain(); gain.gain.value = 0;
    node.port.onmessage = (ev) => {
      if (!live || !ev.data) return;
      BR.dictateAudio(new Uint8Array(ev.data.pcm.buffer));
      document.getElementById('da-dot').style.transform = 'scale(' + (1 + Math.min(1, (ev.data.peak || 0) * 3) * 0.6).toFixed(2) + ')';
    };
    src.connect(node); node.connect(gain); gain.connect(ac.destination);
  } catch (err) {
    stopMic();
    const name = (err && err.name) || '';
    // ATO-2750: main words it (dictate-errors.ts); the browser's own message goes to the log only.
    if (BR.dictateMicFailed) BR.dictateMicFailed({denied: name === 'NotAllowedError' || name === 'SecurityError', detail: String((err && err.message) || name || '')});
  }
})();
