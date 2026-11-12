/* ATO-1046 — read a reply aloud, on this computer.

   The system's own voices through the Web Speech API (speechSynthesis):
   macOS speaks with the voices in System Settings › Accessibility › Spoken
   Content, Windows with its SAPI voices, nothing goes over the network. A
   Linux desktop without speech-dispatcher has no voices; the button is then
   not drawn. Under every finished reply a speaker button reads it (a second
   click stops); View › Read Replies Aloud reads each new reply as its turn
   ends. That choice is this window's (localStorage), not the agent's config.

   Code blocks, links and markdown marks are not read out: a voice reading
   "backtick backtick backtick" or a URL letter by letter is noise.

   ATO-494: the voice follows the reply's language (a Russian reply is read by
   a Russian voice, not by the English one spelling Cyrillic), and View ›
   Reading Voice and Speed… (tts-settings.js) picks the voice per language and
   the speed. Only voices the system marks as local are offered first: a
   "remote" voice would send the text off this computer. */

const TTS = { speakingId: null, auto: false, seq: 0, rate: 1, voice: { en: '', ru: '' } };
try {
  TTS.auto = localStorage.getItem('atomic.tts.auto') === '1';
  const r = Number(localStorage.getItem('atomic.tts.rate'));
  if (r >= 0.5 && r <= 2) TTS.rate = r;
  TTS.voice.en = localStorage.getItem('atomic.tts.voice.en') || '';
  TTS.voice.ru = localStorage.getItem('atomic.tts.voice.ru') || '';
} catch (e) { /* private storage: defaults */ }

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
    // Markdown emphasis only at word edges: my_var and a > b are read as written.
    .replace(/(^|\s)[*_~]+|[*_~]+(?=\s|$|[.,;:!?])/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 'ru' when Cyrillic letters outnumber Latin ones, else 'en'. A Russian
    reply full of English identifiers is still a Russian reply. */
function ttsLangOf(text) {
  const s = String(text || '');
  const cyr = (s.match(/[Ѐ-ӿ]/g) || []).length;
  const lat = (s.match(/[A-Za-z]/g) || []).length;
  return cyr > lat ? 'ru' : 'en';
}

/** The voice to read `lang` with. The one picked in settings wins when it
    speaks that language; otherwise a local voice of the language, the
    system default among them first. Null: none on this computer, and the
    utterance's own `lang` leaves the choice to the system. */
function ttsPickVoice(voices, lang, wanted) {
  const list = Array.from(voices || []);
  const speaks = (v) => String((v && v.lang) || '').toLowerCase().replace('_', '-').split('-')[0] === lang;
  if (wanted) {
    const w = list.find((v) => v && v.name === wanted && speaks(v));
    if (w) return w;
  }
  const mine = list.filter(speaks);
  if (!mine.length) return null;
  const local = mine.filter((v) => v.localService !== false);
  const pool = local.length ? local : mine;
  return pool.find((v) => v.default) || pool[0];
}

/** The system voices that read `lang`, local ones first, for the settings lists. */
function ttsVoicesFor(lang) {
  let all = [];
  try { all = window.speechSynthesis.getVoices(); } catch (e) { return []; }
  const mine = all.filter((v) => String(v.lang || '').toLowerCase().replace('_', '-').split('-')[0] === lang);
  return mine.filter((v) => v.localService !== false).concat(mine.filter((v) => v.localService === false));
}

function ttsStop() {
  TTS.seq++;   // the utterance being cancelled must not count as read to the end
  try { window.speechSynthesis.cancel(); } catch (e) { /* nothing was speaking */ }
  TTS.speakingId = null;
}

/** Read `text` aloud. `onEnd` runs once, only when it was read to its end
    (not when it was stopped or failed); conversation mode chains on it. */
function ttsSpeak(id, text, onEnd) {
  if (!ttsAvailable()) return false;
  const words = ttsPlain(text);
  if (!words) return false;
  ttsStop();
  const seq = TTS.seq;
  const lang = ttsLangOf(words);
  const u = new SpeechSynthesisUtterance(words);
  u.lang = lang === 'ru' ? 'ru-RU' : 'en-US';
  const v = ttsPickVoice(window.speechSynthesis.getVoices(), lang, TTS.voice[lang]);
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = TTS.rate;
  const done = (ok) => {
    if (TTS.speakingId === id) { TTS.speakingId = null; ttsRepaint(); }
    if (ok && seq === TTS.seq && typeof onEnd === 'function') onEnd();
  };
  u.onend = () => done(true);
  u.onerror = () => done(false);
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

/** Settings: the voice for one language ('' = the system's choice) and the speed. */
function ttsSetVoice(lang, name) {
  TTS.voice[lang] = String(name || '');
  try { localStorage.setItem('atomic.tts.voice.' + lang, TTS.voice[lang]); } catch (e) { /* this window only */ }
}
function ttsSetRate(rate) {
  const r = Math.min(2, Math.max(0.5, Number(rate) || 1));
  TTS.rate = r;
  try { localStorage.setItem('atomic.tts.rate', String(r)); } catch (e) { /* this window only */ }
}

/** A turn of the chat on screen ended with this reply. Conversation mode
    (converse.js), when on, reads it itself and then listens again. */
function ttsTurnEnded(item) {
  if (typeof convReplyDone === 'function' && convReplyDone(item)) return;
  if (TTS.auto && item && String(item.text || '').trim()) ttsSpeak(item.id, item.text);
}

function ttsRepaint() {
  if (typeof render === 'function') render();
}

if (typeof window !== 'undefined' && window.speechSynthesis) {
  // Voices load late on some systems: the buttons appear once they are there.
  // Repainted only when voices appear or go, not on every repeat of the event.
  let had = ttsAvailable();
  try {
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      const now = ttsAvailable();
      if (now !== had) { had = now; ttsRepaint(); }
    });
  } catch (e) { /* older engines */ }
}
if (typeof module !== 'undefined') module.exports = { ttsPlain, ttsLangOf, ttsPickVoice };
