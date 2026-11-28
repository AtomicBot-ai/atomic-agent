/* ATO-2333: Record a meeting, the pure half of the panel (meeting-panel.js
   draws it). No DOM, no bridge: test/meeting-logic.test.mjs requires it.

   The live transcript arrives one chunk at a time on app:meeting, each
   segment already on the meeting's clock (main/meeting-recorder.ts). The
   panel keeps them in time order and draws a `12:34` clock that runs while
   the red indicator is up. */

/** `754.2` seconds → `12:34`; an hour and more → `1:02:03`. */
function meetingClock(seconds) {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? h + ':' + two(m) + ':' + two(sec) : two(m) + ':' + two(sec);
}

/** The lines so far plus a chunk's segments: in time order, blanks dropped, a repeat not added twice.
    ATO-2514: `who` ("Me", "Them" or '') labels the chunk's lines. */
function meetingMergeLines(lines, segments, who) {
  const out = Array.isArray(lines) ? lines.slice() : [];
  const label = typeof who === 'string' ? who : '';
  const seen = new Set(out.map((l) => (l.who || '') + '|' + l.start + '|' + l.text));
  for (const s of Array.isArray(segments) ? segments : []) {
    if (!s || typeof s.start !== 'number') continue;
    const text = String(s.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = label + '|' + s.start + '|' + text;
    if (seen.has(key)) continue;
    seen.add(key);
    const line = {start: s.start, end: typeof s.end === 'number' ? s.end : s.start, text};
    if (label) line.who = label;
    out.push(line);
  }
  return out.sort((a, b) => a.start - b.start);
}

/* ATO-2749: the microphone refused, said for the computer it is on. The
   Settings path is spelled as elsewhere in the app (System Settings ›
   Privacy & Security › …, dictate-hold.ts); Windows names its own pane;
   Linux has no one place, so it gets plain words and no button. */
function meetingMicDeniedText(platform) {
  if (platform === 'win32') return 'Microphone access is turned off for Atomic Agent. Turn it on in Settings › Privacy & security › Microphone, then try again.';
  if (platform === 'linux') return 'Atomic Agent could not use the microphone. Check that one is connected and that your sound settings let apps use it, then try again.';
  return 'Microphone access is turned off for Atomic Agent. Turn it on in System Settings › Privacy & Security › Microphone, then try again.';
}

/** Whether the mic-denied card offers Open Settings (main's app:openMicSettings opens the pane). */
function meetingCanOpenMicSettings(platform) {
  return platform === 'darwin' || platform === 'win32';
}

/* The mic-denied card: it stays until it is closed (a 6-second toast was
   gone before the path could be read), with Open Settings where the OS has
   one pane for it, as voice input does. `canOpen`: the bridge can open it. */
function meetingDeniedCardHTML(platform, canOpen, esc) {
  const open = canOpen && meetingCanOpenMicSettings(platform) ? '<button class="btn btn-p sm" data-mtg="micsettings">Open Settings</button>' : '';
  return '<div class="mtgpanel mtgrecover mtgdenied" role="alert" aria-label="Microphone is off">'
    + '<p>' + esc(meetingMicDeniedText(platform)) + '</p>'
    + '<div class="mtgfoot">' + open + '<button class="btn sm" data-mtg="retry">Try again</button>'
    + '<button class="btn sm" data-mtg="deniedx">Close</button></div></div>';
}

/** True for a start that failed because the microphone was refused (main's answer or getUserMedia's error). */
function meetingMicDenied(code) {
  return code === 'mic-denied' || code === 'NotAllowedError' || code === 'SecurityError';
}

/* ATO-2749: Delete recording asks first, in place, as My files' Remove
   does (a second click on a red button; Keep goes back). In place, because
   the panel floats above the app's dialogs. */
function meetingDeleteConfirmHTML(id, esc) {
  return '<span class="mtgask">Delete this recording? Its audio and transcript are removed. This cannot be undone.</span>'
    + '<button class="btn btn-s sm" data-mtg="delno">Keep</button>'
    + '<button class="btn btn-df sm" data-mtg="delyes" data-mtg-id="' + esc(id) + '">Delete recording</button>';
}

/** The toast after a delete: only a delete that happened says so. */
function meetingDiscardToast(res) {
  if (res && res.ok) return {t: 'Recording deleted', s: 'Its audio and transcript are gone from this computer.', kind: ''};
  return {t: 'Could not delete the recording', s: 'It may still be on this computer. The app offers it again, so you can try once more.', kind: 'bad'};
}

/** Why a recording could not start or finish, in the person's words. */
function meetingErrorText(code, platform) {
  switch (code) {
    case 'mic-denied': return meetingMicDeniedText(platform || 'darwin');
    case 'mic-failed': return 'The microphone could not be opened';
    case 'busy': return 'A meeting is already being recorded or finished';
    case 'disk': return 'The recording could not be written to disk';
    case 'missing': return 'This recording is no longer on disk';
    case 'voice-model-missing': return 'The speech model for your language is not on this computer yet. Turn on voice input once in Settings to get it';
    case 'voice-os-too-old': return 'Transcribing on this computer needs a newer macOS';
    case 'voice-not-macos': case 'voice-whisper-missing': case 'voice-whisper-model-missing':
      return 'Speech recognition is not set up on this computer yet. Use the microphone in the composer once to set it up';
    case 'voice-helper-missing': case 'voice-helper-failed': return 'The speech helper of this app could not run';
    default: return 'Something went wrong with the recording';
  }
}

/** `27 Nov, 14:05` in local time, for the "not finished" card. */
function meetingWhen(startedAt) {
  const d = new Date(Number.isFinite(startedAt) ? startedAt : 0);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return d.getDate() + ' ' + months[d.getMonth()] + ', ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** `12 min` / `under a minute` / `1 h 5 min`. */
function meetingLength(seconds) {
  const m = Math.round((Number.isFinite(seconds) && seconds > 0 ? seconds : 0) / 60);
  if (m < 1) return 'under a minute';
  if (m < 60) return m + ' min';
  return Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
}

/** The card for a meeting a crash or a closed window left unfinished. */
function meetingRecoverText(list) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return '';
  const first = items[0];
  const more = items.length > 1 ? ' (and ' + (items.length - 1) + ' more)' : '';
  return 'A meeting from ' + meetingWhen(first.startedAt) + ', ' + meetingLength(first.seconds) + ' recorded, was not finished' + more + '.';
}

/** True when the attachment is in and nothing is still being prepared: the notes can be asked for. */
function meetingReadyToSend(items) {
  const list = Array.isArray(items) ? items : [];
  return list.some((i) => i.status === 'ready') && !list.some((i) => i.status === 'preparing');
}

if (typeof module !== 'undefined') {
  module.exports = {meetingClock, meetingMergeLines, meetingErrorText, meetingWhen, meetingLength, meetingRecoverText, meetingReadyToSend,
    meetingMicDeniedText, meetingCanOpenMicSettings, meetingDeniedCardHTML, meetingMicDenied, meetingDeleteConfirmHTML, meetingDiscardToast};
}
