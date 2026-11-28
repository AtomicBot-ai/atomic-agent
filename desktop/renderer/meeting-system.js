/* ATO-2514: Record a meeting, the other side of the call ("Them").

   Once the microphone is open (meeting-panel.js meetingStart), the call's
   sound on this computer is recorded as a second channel, so the
   transcript reads "Me" and "Them" like Granola's:
     macOS    main runs a small ScreenCaptureKit helper
              (main/meeting-system-ipc.ts); nothing is captured here.
     Windows  getDisplayMedia with loopback audio (main answers it with the
              screen and WASAPI loopback only while a meeting records); the
              video track is stopped at once and only the sound is tapped.
     Linux    the PulseAudio / PipeWire "Monitor of …" input, when listed.
   When that is not possible the meeting goes on with the microphone only
   and the panel says why, in plain words, with Open Settings on a Mac
   whose Screen and System Audio Recording permission is off.

   Loaded after meeting-logic.js, before meeting-panel.js; uses BR, esc and
   mtgPaint only at run time. The pure part (meetingPickMonitor,
   meetingSystemText, meetingWho) is exported for test/meeting-system.test.mjs. */

const MTGS = {state: 'idle', mode: null, reason: null, stream: null, ac: null, node: null, listening: false};

/** The sound server's monitor input among the devices, or null. */
function meetingPickMonitor(devices) {
  const list = Array.isArray(devices) ? devices : [];
  return list.find((d) => d && d.kind === 'audioinput' && /^monitor of /i.test(String(d.label || ''))) || null;
}

/** The panel's line about the other side of the call; '' while nothing is known. */
function meetingSystemText(state, reason, platform) {
  if (state === 'on') return 'Me and Them: your microphone and the sound of the call.';
  if (state === 'starting') return 'Adding the sound of the call…';
  if (state !== 'off') return '';
  if (reason === 'off') return 'Microphone only. Recording the call\'s sound is turned off in Settings, Meetings.';
  if (reason === 'screen-denied') return 'Microphone only. To include the other side of the call, allow Atomic Agent in System Settings, Privacy and Security, Screen and System Audio Recording, then start a new recording.';
  if (platform === 'linux') return 'Microphone only. No sound monitor was found. With PulseAudio or PipeWire it is listed as "Monitor of" your output.';
  if (platform === 'win32') return 'Microphone only. The sound of this computer could not be recorded.';
  return 'Microphone only. The sound of the call could not be recorded on this computer.';
}

/** The label a live line gets: Me and Them once the call's sound is in, nothing for a microphone-only meeting. */
function meetingWho(channel, systemOn) {
  if (channel === 'them') return 'Them';
  return systemOn ? 'Me' : '';
}

function mtgsPlatform() {
  return (typeof BR !== 'undefined' && BR && BR.platform) || '';
}

function mtgSystemHTML() {
  const text = meetingSystemText(MTGS.state, MTGS.reason, mtgsPlatform());
  if (!text) return '';
  const settings = MTGS.state === 'off' && MTGS.reason === 'screen-denied' && typeof BR !== 'undefined' && BR && BR.meetingOpenScreenSettings
    ? '<button class="btn sm" data-mtgs="settings">Open Settings</button>' : '';
  return '<p class="mtgsys' + (MTGS.state === 'off' ? ' mtgsys-off' : '') + '">' + esc(text) + settings + '</p>';
}

function mtgSpeakersNote() {
  return MTGS.state === 'on' ? 'You are Me, the other side of the call is Them.' : 'Speakers are guessed from pauses.';
}

function mtgsSet(state, reason) {
  MTGS.state = state; MTGS.reason = reason || null;
  if (typeof mtgPaint === 'function') mtgPaint();
}

/** The same 16 kHz s16le tap as the microphone, into meeting:system-audio. */
async function mtgsTap(stream) {
  const ac = new AudioContext({sampleRate: 16000});
  await ac.audioWorklet.addModule('voice-worklet.js');
  const node = new AudioWorkletNode(ac, 'pcm-tap');
  const gain = ac.createGain(); gain.gain.value = 0;
  node.port.onmessage = (ev) => {
    if (MTGS.state !== 'on' || !ev.data) return;
    BR.meetingSystemAudio(new Uint8Array(ev.data.pcm.buffer), ev.data.peak || 0);
  };
  ac.createMediaStreamSource(stream).connect(node); node.connect(gain); gain.connect(ac.destination);
  MTGS.stream = stream; MTGS.ac = ac; MTGS.node = node;
}

async function mtgsOpenLoopback() {
  const stream = await navigator.mediaDevices.getDisplayMedia({audio: true, video: true});
  stream.getVideoTracks().forEach((t) => t.stop());
  if (!stream.getAudioTracks().length) { stream.getTracks().forEach((t) => t.stop()); throw new Error('no-loopback'); }
  await mtgsTap(stream);
}

async function mtgsOpenMonitor() {
  const monitor = meetingPickMonitor(await navigator.mediaDevices.enumerateDevices());
  if (!monitor) throw new Error('no-monitor');
  const stream = await navigator.mediaDevices.getUserMedia({audio: {deviceId: {exact: monitor.deviceId}, echoCancellation: false, noiseSuppression: false, autoGainControl: false}});
  await mtgsTap(stream);
}

function mtgsListen() {
  if (MTGS.listening || typeof BR === 'undefined' || !BR || !BR.onMeeting) return;
  MTGS.listening = true;
  BR.onMeeting((ev) => {
    if (!ev || ev.type !== 'system' || typeof MTG === 'undefined' || ev.id !== MTG.id) return;
    if (ev.state !== 'ready' && MTGS.state === 'on') mtgsSet('off', ev.state);
  });
}

/** After the microphone opened. Never throws: the meeting goes on with the microphone only. */
async function mtgSystemStart() {
  if (typeof BR === 'undefined' || !BR || !BR.meetingSystemStart) { mtgsSet('off', 'unsupported'); return; }
  mtgsListen();
  mtgsSet('starting');
  let r = null;
  try { r = await BR.meetingSystemStart(); } catch (e) { r = null; }
  if (!r || !r.ok) { mtgsSet('off', (r && r.error) || 'failed'); return; }
  // Stopped or deleted while main was starting it.
  if (typeof MTG !== 'undefined' && MTG.phase !== 'recording') { mtgsRelease(); BR.meetingSystemStop().catch(() => {}); mtgsSet('idle'); return; }
  MTGS.mode = r.mode;
  try {
    if (r.mode === 'loopback') { MTGS.state = 'on'; await mtgsOpenLoopback(); }
    else if (r.mode === 'monitor') { MTGS.state = 'on'; await mtgsOpenMonitor(); }
    mtgsSet('on');
  } catch (err) {
    mtgsRelease();
    try { await BR.meetingSystemStop(); } catch (e) { /* nothing to stop */ }
    mtgsSet('off', (err && err.message) || 'failed');
  }
}

function mtgsRelease() {
  try { if (MTGS.node) MTGS.node.port.onmessage = null; } catch (e) { /* gone */ }
  try { if (MTGS.stream) MTGS.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* gone */ }
  try { if (MTGS.ac) MTGS.ac.close(); } catch (e) { /* gone */ }
  MTGS.stream = null; MTGS.ac = null; MTGS.node = null;
}

/** With the microphone: Stop, Delete, a failed start. The panel's line stays until the next recording. */
function mtgSystemStop() {
  const was = MTGS.state;
  mtgsRelease();
  if (was === 'starting' || was === 'on') {
    MTGS.state = was === 'on' ? 'on' : 'idle';
    if (typeof BR !== 'undefined' && BR && BR.meetingSystemStop) BR.meetingSystemStop().catch(() => {});
  }
}

/** A new recording starts with a clean line. */
function mtgSystemReset() { MTGS.state = 'idle'; MTGS.reason = null; MTGS.mode = null; }

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-mtgs="settings"]') : null;
    if (!b) return;
    e.preventDefault();
    if (typeof BR !== 'undefined' && BR && BR.meetingOpenScreenSettings) BR.meetingOpenScreenSettings();
  });
}

if (typeof module !== 'undefined') {
  module.exports = {meetingPickMonitor, meetingSystemText, meetingWho};
}
