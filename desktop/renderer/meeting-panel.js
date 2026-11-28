/* ATO-2333: Record a meeting. One click starts the microphone (the "+"
   menu's Record meeting row, or File, Record Meeting); a red Recording pill with
   a running clock and a Stop button stays at the top of the window the
   whole time anything is heard; the panel under it shows the transcript as
   each chunk is heard on this computer. Make notes saves the transcript into
   Documents/Atomic Agent/Meetings (and adds that folder to My files), then
   opens a new chat that sends it to the meeting-notes skill. The audio is
   deleted once the transcript is saved; Delete removes everything, after a
   confirm (ATO-2749).

   A recording a crash or a closed window cut short is offered again at the
   next start (the card under the pill), from what main kept on disk.

   Precedent: Manus Meeting Minutes (record button, live transcript, Finish
   to a structured summary), Granola (local notes), ChatGPT Meetings (audio
   deleted after the notes). Pure half: meeting-logic.js. Main:
   main/meeting-ipc.ts. Loaded after transcribe.js, before renderer.js; it
   uses that file's globals (esc, ic, toast, act, S, attAdd, submit) only at
   run time. */

const MTG = {phase: 'idle', id: null, startedAt: 0, lines: [], failed: 0, open: true,
  recover: [], stream: null, ac: null, node: null, tick: null, listening: false, denied: false, confirm: null};

/** The platform renderer.js read from the bridge (darwin when it cannot say). */
function mtgPlatform() {
  return typeof PLATFORM !== 'undefined' ? PLATFORM : 'darwin';
}

function meetingOffer() {
  return !!(typeof BR !== 'undefined' && BR && BR.voiceSupported && BR.meetingStart);
}

function mtgRoot() {
  let el = document.getElementById('mtg-root');
  if (!el) { el = document.createElement('div'); el.id = 'mtg-root'; document.body.appendChild(el); }
  return el;
}

function mtgPillHTML() {
  if (MTG.phase !== 'recording' && MTG.phase !== 'starting') return '';
  const clock = MTG.phase === 'recording' ? meetingClock((Date.now() - MTG.startedAt) / 1000) : '';
  return '<div class="mtgpill" role="status" aria-live="polite">'
    + '<span class="mtgdot" aria-hidden="true"></span>'
    + '<span class="mtgrec">' + (MTG.phase === 'starting' ? 'Starting the microphone' : 'Recording') + '</span>'
    + '<span class="mtgclock" id="mtg-clock">' + esc(clock) + '</span>'
    + '<button class="mtgpillbtn" data-mtg="toggle">' + (MTG.open ? 'Hide' : 'Show') + '</button>'
    + '<button class="mtgpillbtn mtgstop" data-mtg="stop"' + (MTG.phase === 'starting' ? ' disabled' : '') + '>Stop</button>'
    + '</div>';
}

function mtgLinesHTML() {
  if (!MTG.lines.length) {
    return '<p class="mtgempty">' + (MTG.phase === 'recording'
      ? 'Listening. The first lines show up about half a minute after people start talking.'
      : 'No speech was heard yet.') + '</p>';
  }
  return MTG.lines.map((l) => '<p class="mtgline"><span class="mtgat">' + esc(meetingClock(l.start)) + '</span>'
    + (l.who ? '<span class="mtgwho">' + esc(l.who) + '</span>' : '') + esc(l.text) + '</p>').join('');   // ATO-2514: Me / Them
}

function mtgPanelHTML() {
  const live = MTG.phase === 'recording' || MTG.phase === 'stopped' || MTG.phase === 'finishing';
  if (!live || !MTG.open) return '';
  const title = MTG.phase === 'recording' ? 'Meeting, recording' : MTG.phase === 'finishing' ? 'Meeting, making the transcript' : 'Meeting, stopped';
  const foot = MTG.phase === 'recording'
    ? '<button class="btn btn-p sm" data-mtg="done">Stop and make notes</button>'
    : MTG.phase === 'finishing'
      ? '<span class="mtgbusy">Transcribing the last part…</span>'
      : MTG.confirm && MTG.confirm === MTG.id ? meetingDeleteConfirmHTML(MTG.id, esc)   // ATO-2749
        : '<button class="btn btn-p sm" data-mtg="done">Make notes</button><button class="btn sm" data-mtg="discard">Delete recording</button>';
  return '<div class="mtgpanel" role="region" aria-label="Meeting transcript">'
    + '<div class="mtghead"><span>' + esc(title) + '</span><button class="mtgx" data-mtg="toggle" aria-label="Hide">' + ic('x') + '</button></div>'
    + '<div class="mtgbody" id="mtg-body">' + mtgLinesHTML() + '</div>'
    + (MTG.failed ? '<p class="mtgwarn">' + MTG.failed + ' part' + (MTG.failed === 1 ? '' : 's') + ' could not be transcribed yet; tried again on Make notes.</p>' : '')
    + (typeof mtgSystemHTML === 'function' ? mtgSystemHTML() : '')   // ATO-2514: the other side of the call (meeting-system.js)
    + '<p class="mtgnote">Heard and transcribed on this computer. ' + esc(typeof mtgSpeakersNote === 'function' ? mtgSpeakersNote() : 'Speakers are guessed from pauses.') + ' The audio is deleted once the transcript is saved.</p>'
    + '<div class="mtgfoot">' + foot + '</div></div>';
}

function mtgRecoverHTML() {
  if (!MTG.recover.length || MTG.phase !== 'idle') return '';
  const id = MTG.recover[0].id;
  return '<div class="mtgpanel mtgrecover" role="region" aria-label="Unfinished meeting">'
    + '<p>' + esc(meetingRecoverText(MTG.recover)) + '</p>'
    + '<div class="mtgfoot">' + (MTG.confirm === id ? meetingDeleteConfirmHTML(id, esc)   // ATO-2749
      : '<button class="btn btn-p sm" data-mtg="recover" data-mtg-id="' + esc(id) + '">Make notes</button>'
      + '<button class="btn sm" data-mtg="drop" data-mtg-id="' + esc(id) + '">Delete recording</button>'
      + '<button class="btn sm" data-mtg="later">Later</button>') + '</div></div>';
}

/* ATO-2749: the microphone was refused: a card that stays until closed (meeting-logic.js). */
function mtgDeniedHTML() {
  return MTG.denied && MTG.phase === 'idle' ? meetingDeniedCardHTML(mtgPlatform(), !!(BR && BR.openMicSettings), esc) : '';
}

function mtgPaint() {
  if (typeof document === 'undefined') return;
  const body = document.getElementById('mtg-body');
  const atBottom = !body || body.scrollTop + body.clientHeight >= body.scrollHeight - 8;
  mtgRoot().innerHTML = mtgPillHTML() + mtgPanelHTML() + mtgDeniedHTML() + mtgRecoverHTML();
  const fresh = document.getElementById('mtg-body');
  if (fresh && atBottom) fresh.scrollTop = fresh.scrollHeight;
}

function mtgListen() {
  if (MTG.listening || !BR.onMeeting) return;
  MTG.listening = true;
  BR.onMeeting((ev) => {
    if (!ev || ev.id !== MTG.id) return;
    if (ev.type === 'segments') { MTG.lines = meetingMergeLines(MTG.lines, ev.segments, typeof meetingWho === 'function' ? meetingWho(ev.channel, MTGS.state === 'on') : ''); mtgPaint(); }
    else if (ev.type === 'chunk-failed') { MTG.failed++; mtgPaint(); }
    else if (ev.type === 'stopped' && MTG.phase === 'recording') {
      // Main closed it (the disk refused): the microphone goes too.
      mtgReleaseMic();
      MTG.phase = 'stopped';
      mtgPaint();
      if (ev.reason === 'disk') toast('Recording stopped', meetingErrorText('disk'), 'bad');
    }
  });
}

/** The same tap as voice input: 16 kHz mono s16le in 100 ms frames (voice-worklet.js). */
async function mtgOpenMic() {
  const stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true}});
  MTG.stream = stream;
  const ac = new AudioContext({sampleRate: 16000});
  MTG.ac = ac;
  await ac.audioWorklet.addModule('voice-worklet.js');
  const src = ac.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ac, 'pcm-tap');
  const gain = ac.createGain(); gain.gain.value = 0;
  node.port.onmessage = (ev) => {
    if (MTG.phase !== 'recording' || !ev.data) return;
    BR.meetingAudio(new Uint8Array(ev.data.pcm.buffer), ev.data.peak || 0);
  };
  src.connect(node); node.connect(gain); gain.connect(ac.destination);
  MTG.node = node;
}

function mtgReleaseMic() {
  if (typeof mtgSystemStop === 'function') mtgSystemStop();   // ATO-2514
  if (MTG.tick) { clearInterval(MTG.tick); MTG.tick = null; }
  try { if (MTG.node) MTG.node.port.onmessage = null; } catch (e) { /* gone */ }
  try { if (MTG.stream) MTG.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* gone */ }
  try { if (MTG.ac) MTG.ac.close(); } catch (e) { /* gone */ }
  MTG.stream = null; MTG.ac = null; MTG.node = null;
}

async function meetingStart() {
  if (!meetingOffer()) { toast('Meeting recording is not available here', meetingErrorText('voice-not-macos'), 'bad'); return; }
  if (MTG.phase !== 'idle') { MTG.open = true; mtgPaint(); return; }
  mtgListen();
  MTG.phase = 'starting'; MTG.lines = []; MTG.failed = 0; MTG.open = true; MTG.denied = false;
  if (typeof mtgSystemReset === 'function') mtgSystemReset();   // ATO-2514
  mtgPaint();
  let r = null;
  try { r = await BR.meetingStart(); } catch (e) { r = null; }
  if (!r || !r.ok) {
    MTG.phase = 'idle';
    if (meetingMicDenied(r && r.error)) { MTG.denied = true; mtgPaint(); return; }   // ATO-2749
    mtgPaint(); toast('Could not start recording', meetingErrorText(r && r.error, mtgPlatform()), 'bad'); return;
  }
  MTG.id = r.id; MTG.startedAt = Date.now();
  MTG.phase = 'recording';
  try {
    await mtgOpenMic();
  } catch (err) {
    mtgReleaseMic();
    MTG.phase = 'idle';
    try { await BR.meetingDiscard(r.id); } catch (e) { /* nothing was kept */ }
    const name = (err && err.name) || '';
    if (meetingMicDenied(name)) { MTG.denied = true; mtgPaint(); return; }   // ATO-2749
    mtgPaint();
    toast('Could not start recording', meetingErrorText('mic-failed'), 'bad');
    return;
  }
  MTG.tick = setInterval(() => { const c = document.getElementById('mtg-clock'); if (c) c.textContent = meetingClock((Date.now() - MTG.startedAt) / 1000); }, 1000);
  mtgPaint();
  if (typeof mtgSystemStart === 'function') mtgSystemStart();   // ATO-2514: the other side of the call, as a second channel
}

async function meetingStop() {
  if (MTG.phase !== 'recording') return;
  mtgReleaseMic();
  MTG.phase = 'stopped';
  mtgPaint();
  try { await BR.meetingStop(); } catch (e) { /* main closes it on its own when the page goes */ }
}

/** Make notes: the transcript is saved, then a new chat asks the meeting-notes skill for the minutes. */
async function meetingDone(id) {
  if (MTG.phase === 'recording') await meetingStop();
  const target = id || MTG.id;
  if (!target) return;
  MTG.id = target; MTG.phase = 'finishing'; MTG.open = true; MTG.recover = MTG.recover.filter((m) => m.id !== target);
  mtgListen();
  mtgPaint();
  let res = null;
  try { res = await BR.meetingFinish(target); } catch (e) { res = null; }
  if (!res || !res.ok) { MTG.phase = 'stopped'; mtgPaint(); toast('Could not make the transcript', meetingErrorText(res && res.error), 'bad'); return; }
  MTG.phase = 'idle'; MTG.id = null; MTG.lines = [];
  mtgPaint();
  if (res.empty) { toast('No speech was heard', 'Nothing was saved, and the recording is deleted.'); return; }
  toast('Transcript saved', res.fileName + ' in Documents, Atomic Agent, Meetings' + (res.failed ? '. Some parts could not be transcribed; their audio is kept for another try.' : '. The audio is deleted.'));
  mtgAddToMyFiles(res.folder);
  mtgMinutesTurn(res);
}

/** The Meetings folder joins My files once, so the agent can find old transcripts. Best effort. */
async function mtgAddToMyFiles(folder) {
  if (!folder || !BR.filesListFolders || !BR.filesAddFolder) return;
  try {
    const listed = await BR.filesListFolders();
    if (!listed || listed.ok === false) return;   // a remote agent, or one without My files
    const folders = (listed && (listed.folders || listed.items)) || [];
    if (folders.some((f) => (typeof f === 'string' ? f : f && f.path) === folder)) return;
    await BR.filesAddFolder(folder);
  } catch (e) { /* My files is optional here */ }
}

function mtgMinutesTurn(res) {
  if (typeof act !== 'function' || typeof attAdd !== 'function') return;
  act('session:new');
  let file;
  try { file = new File([res.document], res.fileName, {type: 'text/plain'}); } catch (e) { return; }
  attAdd([{file}], 'meeting');
  S.draft = res.prompt || '';
  if (typeof render === 'function') render();
  const entry = $('#entry');
  if (entry) { entry.value = S.draft; if (typeof autosize === 'function') autosize(entry); }
  // Sent once the transcript chip is ready; left in the box if it takes too long.
  const until = Date.now() + 15000;
  const wait = setInterval(() => {
    if (meetingReadyToSend(ATT.items)) { clearInterval(wait); submit(); return; }
    if (Date.now() > until) { clearInterval(wait); toast('The transcript is attached', 'Press Enter to make the notes.'); }
  }, 250);
}

async function meetingDiscard(id) {
  const target = id || MTG.id;
  if (!target) return;
  if (MTG.id === target) { mtgReleaseMic(); MTG.phase = 'idle'; MTG.id = null; MTG.lines = []; }
  MTG.recover = MTG.recover.filter((m) => m.id !== target);
  mtgPaint();
  let res = null;
  try { res = await BR.meetingDiscard(target); } catch (e) { res = null; }
  const say = meetingDiscardToast(res);
  toast(say.t, say.s, say.kind);
  if (res && res.ok) return;
  // ATO-2749: it was not deleted, so the card that offers it comes back.
  try { const list = await BR.meetingRecoverable(); if (Array.isArray(list) && MTG.phase === 'idle') { MTG.recover = list; mtgPaint(); } } catch (e) { /* offered again next start */ }
}

/** renderer.js act('meeting:…'): the File menu and anything else that names a verb. */
function meetingAct(v) {
  if (v === 'open' || v === 'start') return meetingStart();
  if (v === 'stop') return meetingStop();
}

/** At load: a reloaded page cannot be holding the microphone, so an open recording is closed; unfinished ones are offered. */
async function meetingBoot() {
  if (!meetingOffer() || !BR.meetingRecoverable) return;
  try {
    const st = await BR.meetingStatus();
    if (st && st.recording) await BR.meetingStop();
    const list = await BR.meetingRecoverable();
    MTG.recover = Array.isArray(list) ? list : [];
    mtgPaint();
  } catch (e) { /* nothing to offer */ }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-meeting-open]')) {
      e.preventDefault();
      if (typeof ATT !== 'undefined' && ATT.menu) { ATT.menu = false; if (typeof attRepaint === 'function') attRepaint(); }
      meetingStart();
      return;
    }
    const b = t.closest('[data-mtg]');
    if (!b) return;
    e.preventDefault();
    const verb = b.getAttribute('data-mtg'), id = b.getAttribute('data-mtg-id');
    if (verb === 'stop') meetingStop();
    else if (verb === 'toggle') { MTG.open = !MTG.open; mtgPaint(); }
    else if (verb === 'done') meetingDone();
    else if (verb === 'recover') meetingDone(id);
    else if (verb === 'discard' || verb === 'drop') { MTG.confirm = id || MTG.id; mtgPaint(); }   // ATO-2749: asks first
    else if (verb === 'delno') { MTG.confirm = null; mtgPaint(); }
    else if (verb === 'delyes') { MTG.confirm = null; meetingDiscard(id); }
    else if (verb === 'micsettings') { if (BR && BR.openMicSettings) BR.openMicSettings(); }
    else if (verb === 'retry') meetingStart();
    else if (verb === 'deniedx') { MTG.denied = false; mtgPaint(); }
    else if (verb === 'later') { MTG.recover = []; mtgPaint(); }
  });
  window.addEventListener('load', () => setTimeout(meetingBoot, 1500));
}
