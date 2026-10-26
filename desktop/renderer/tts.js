/* ATO-1046 — read a reply aloud, on this computer.

   The system's own voices through the Web Speech API (speechSynthesis):
   macOS speaks with the voices in System Settings › Accessibility › Spoken
   Content, Windows with its SAPI voices, nothing goes over the network. A
   Linux desktop without speech-dispatcher has no voices; the button is then
   not drawn. Under every finished reply a speaker button reads it (a second
   click stops); View › Read Replies Aloud reads each new reply as its turn
   ends. That choice is this window's (localStorage), not the agent's config.

   Code blocks, links and markdown marks are not read out: a voice reading
   "backtick backtick backtick" or a URL letter by letter is noise. */

const TTS = { speakingId: null, auto: false };
try { TTS.auto = localStorage.getItem('atomic.tts.auto') === '1'; } catch (e) { /* private storage: off */ }

function ttsAvailable() {
  try {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function'
      && window.speechSynthesis.getVoices().length > 0;
  } catch (e) {
    return false;
  }
}

/** The words worth saying: no fenced code, no inline code marks, no link targets, no markdown punctuation. */
function ttsPlain(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_~>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ttsStop() {
  try { window.speechSynthesis.cancel(); } catch (e) { /* nothing was speaking */ }
  TTS.speakingId = null;
}

function ttsSpeak(id, text) {
  if (!ttsAvailable()) return false;
  const words = ttsPlain(text);
  if (!words) return false;
  ttsStop();
  const u = new SpeechSynthesisUtterance(words);
  const done = () => { if (TTS.speakingId === id) { TTS.speakingId = null; ttsRepaint(); } };
  u.onend = done;
  u.onerror = done;
  TTS.speakingId = id;
  window.speechSynthesis.speak(u);
  ttsRepaint();
  return true;
}

/** The speaker button: speak, or stop when this reply is the one speaking. */
function ttsToggle(id, text) {
  if (TTS.speakingId === id) { ttsStop(); ttsRepaint(); return; }
  ttsSpeak(id, text);
}

function ttsButtonHTML(m) {
  if (!ttsAvailable()) return '';
  const on = TTS.speakingId === m.id;
  const label = on ? 'Stop reading' : 'Read aloud';
  return '<button class="msgact' + (on ? ' on' : '') + '" data-speak="' + esc(m.id) + '" title="' + label + '" aria-label="' + label + '"'
    + (on ? ' aria-pressed="true"' : '') + '>' + ic(on ? 'stop' : 'speak') + '</button>';
}

/** View › Read Replies Aloud. */
function ttsSetAuto(on) {
  TTS.auto = !!on;
  try { localStorage.setItem('atomic.tts.auto', TTS.auto ? '1' : '0'); } catch (e) { /* kept for this window only */ }
  if (!TTS.auto) ttsStop();
  toast(TTS.auto ? 'Replies are read aloud' : 'Replies are not read aloud',
    TTS.auto ? (ttsAvailable() ? 'Each new reply is read as it finishes.' : 'This computer has no voices for it yet.') : '');
  ttsRepaint();
}

/** A turn of the chat on screen ended with this reply. */
function ttsTurnEnded(item) {
  if (TTS.auto && item && String(item.text || '').trim()) ttsSpeak(item.id, item.text);
}

function ttsRepaint() {
  if (typeof render === 'function') render();
}

if (typeof window !== 'undefined' && window.speechSynthesis) {
  // Voices load late on some systems: the buttons appear once they are there.
  try { window.speechSynthesis.addEventListener('voiceschanged', () => ttsRepaint()); } catch (e) { /* older engines */ }
}
if (typeof module !== 'undefined') module.exports = { ttsPlain };
