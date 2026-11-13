/* ATO-1047 — conversation mode: listen → send → read the reply → listen.

   It chains what is already there and replaces none of it: the composer's
   dictation (voiceStart / voiceStop in renderer.js, the on-device speech
   helper behind it), the ordinary submit(), and tts.js for the reply. The
   only new judgement is when the speaker has finished: words were heard and
   then neither the words nor the level have moved for CONV_QUIET_MS.

   Dictation is macOS-only today (main/speech.ts answers voice-not-macos
   elsewhere), so this mode is too, and says so instead of hiding.

   Anything the person does stops the loop: Escape (which also discards a
   take in progress), any other key or a click (a take in progress is then
   inserted into the composer, not sent). Shortcut chords are left to the
   menu, so ⌘⇧J (View › Conversation Mode) toggles it rather than stopping
   and restarting it. An agent turn that is already
   running is left alone; only its reply is no longer read out. The bar at
   the bottom of the window says which step the loop is on. */

const CONV_QUIET_MS = 1600;        // silence after words that ends a take
const CONV_NOTHING_MS = 12000;     // a take that hears nothing ends the loop
const CONV_LOUD = 0.04;            // the peak level that counts as speaking
const CONV_SEND_WAIT_MS = 2500;    // a send that started no turn ends the loop

const CONV = { state: 'off', timer: null, take: null, sendTimer: null };

/** The loop as a pure table: (state, event) → next state and what to do.
    States: off | listening | thinking | speaking. Effects: listen, send,
    speak, halt (stop, keep what was heard), discard (stop, drop it). */
function convStep(state, event) {
  const ev = typeof event === 'string' ? { type: event } : (event || {});
  if (ev.type === 'escape') return { state: 'off', effect: state === 'off' ? null : 'discard' };
  if (ev.type === 'user' || (ev.type === 'toggle' && state !== 'off')) return { state: 'off', effect: state === 'off' ? null : 'halt' };
  if (ev.type === 'fail') return { state: 'off', effect: state === 'off' ? null : 'halt' };
  switch (state) {
    case 'off':
      return ev.type === 'toggle' ? { state: 'listening', effect: 'listen' } : { state, effect: null };
    case 'listening':
      if (ev.type !== 'heard') return { state, effect: null };
      return String(ev.text || '').trim() ? { state: 'thinking', effect: 'send' } : { state: 'off', effect: 'halt' };
    case 'thinking':
      if (ev.type !== 'reply') return { state, effect: null };
      return String(ev.text || '').trim() ? { state: 'speaking', effect: 'speak' } : { state: 'listening', effect: 'listen' };
    case 'speaking':
      return ev.type === 'spoken' ? { state: 'listening', effect: 'listen' } : { state, effect: null };
    default:
      return { state: 'off', effect: null };
  }
}

/** Has the speaker finished? 'wait' | 'send' | 'nothing'. `t` is the take:
    {startedAt, words, changedAt, loudAt}; `now` is the clock. */
function convTakeVerdict(t, now) {
  if (!String(t.words || '').trim()) return now - t.startedAt >= CONV_NOTHING_MS ? 'nothing' : 'wait';
  const last = Math.max(t.changedAt || 0, t.loudAt || 0);
  return now - last >= CONV_QUIET_MS ? 'send' : 'wait';
}

/* ---- wiring (renderer only) ---- */

function convAvailable() {
  if (typeof BR === 'undefined' || !BR || BR.voiceSupported === false) return 'Conversation mode works only on macOS for now, because voice input does.';
  if (VOICE.available === false) return VOICE.reason || 'Voice input is off.';
  if (VOICE.available !== true) return 'Voice input is still starting. Try again in a moment.';
  if (!ttsAvailable()) return 'This computer has no system voice to read replies with.';
  return '';
}

function convToggle() {
  if (CONV.state === 'off') {
    const why = convAvailable();
    if (why) { toast('Conversation mode is off', why, 'bad'); return; }
  }
  convFire('toggle');
}

function convFire(event) {
  const prev = CONV.state;
  const step = convStep(prev, event);
  CONV.state = step.state;
  if (step.effect === 'listen') convListen();
  else if (step.effect === 'send') convSend();
  else if (step.effect === 'speak') convSpeak(event.item);
  else if (step.effect === 'halt' || step.effect === 'discard') convHalt(prev, step.effect === 'discard');
  convPaint();
}

function convListen() {
  convClearTimers();
  if (VOICE.state !== 'idle' && VOICE.state !== 'error') { convFire('fail'); return; }
  CONV.take = { startedAt: Date.now(), words: '', changedAt: 0, loudAt: 0 };
  Promise.resolve(voiceStart()).then(() => {
    if (CONV.state !== 'listening') return;
    CONV.timer = setInterval(convWatch, 150);
  });
}

function convWatch() {
  if (CONV.state !== 'listening' || !CONV.take) return;
  if (VOICE.state === 'error' || VOICE.state === 'idle') { convFire('fail'); return; }
  if (VOICE.state !== 'recording') return;
  const now = Date.now();
  const words = (VOICE.final + VOICE.partial).trim();
  if (words !== CONV.take.words) { CONV.take.words = words; CONV.take.changedAt = now; }
  if (VOICE.level >= CONV_LOUD) CONV.take.loudAt = now;
  const verdict = convTakeVerdict(CONV.take, now);
  if (verdict === 'wait') return;
  convClearTimers();
  if (verdict === 'nothing') { convFire('user'); return; }   // voiceStop inside halt says "Nothing was heard"
  voiceStop().then(() => {
    if (CONV.state === 'listening') convFire({ type: 'heard', text: S.draft });
  });
}

function convSend() {
  submit();
  // A send that did not start a turn (the model still downloading, a slash
  // command, the composer refusing) leaves the words in the composer.
  CONV.sendTimer = setTimeout(() => {
    CONV.sendTimer = null;
    if (CONV.state === 'thinking' && !S.busy) {
      convFire('fail');
      toast('Conversation mode stopped', 'The message was not sent. It is still in the composer.');
    }
  }, CONV_SEND_WAIT_MS);
}

function convSpeak(item) {
  convClearTimers();
  const started = !!item && ttsSpeak(item.id, item.text, () => { if (CONV.state === 'speaking') convFire('spoken'); });
  if (!started) convFire('spoken');   // nothing worth saying (only code): listen again
}

/** tts.js calls this when a turn of the chat on screen ends. True = handled. */
function convReplyDone(item) {
  if (CONV.state !== 'thinking') return false;
  convFire({ type: 'reply', text: item && item.text, item });
  return true;
}

/** An aborted or failed turn ends the loop; there is no reply to read. */
function convTurnFailed() {
  if (CONV.state === 'thinking') convFire('fail');
}

function convHalt(prev, discard) {
  convClearTimers();
  CONV.take = null;
  if (prev === 'speaking') ttsStop();
  const live = VOICE.state === 'recording' || VOICE.state === 'starting';
  if (prev === 'listening' && live) { if (discard) voiceCancel(); else voiceStop(); }
}

function convClearTimers() {
  if (CONV.timer) { clearInterval(CONV.timer); CONV.timer = null; }
  if (CONV.sendTimer) { clearTimeout(CONV.sendTimer); CONV.sendTimer = null; }
}

const CONV_WORDS = { listening: 'Listening…', thinking: 'Waiting for the reply…', speaking: 'Reading the reply…' };

/** The bar that says which step the loop is on, outside render(). */
function convPaint() {
  let bar = document.getElementById('convbar');
  if (CONV.state === 'off') { if (bar) bar.remove(); if (typeof render === 'function') render(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'convbar';
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    document.body.appendChild(bar);
  }
  bar.className = 'convbar is-' + CONV.state;
  bar.innerHTML = '<span class="convdot"></span><span class="convword">Conversation · ' + CONV_WORDS[CONV.state] + '</span>'
    + '<button class="btn btn-t xs" data-conv="1" data-act="conv:toggle">Stop · Esc</button>';
  if (typeof render === 'function') render();
}

/** The composer button beside the microphone (only where dictation exists). */
function convButtonHTML() {
  if (typeof BR === 'undefined' || !BR || BR.voiceSupported === false) return '';
  const on = CONV.state !== 'off';
  const label = on ? 'Stop conversation mode · Esc' : 'Conversation mode: speak, hear the reply, speak again';
  return '<button class="micbtn convbtn' + (on ? ' on' : '') + '" data-conv="1" data-act="conv:toggle" title="' + esc(label)
    + '" aria-label="' + esc(label) + '"' + (on ? ' aria-pressed="true"' : '') + '>' + ic('speak') + '</button>';
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  // Capture phase: ahead of the app's own key layers, so Escape reaches the
  // loop whatever is open. Only Escape is swallowed; other keys go on.
  window.addEventListener('keydown', (e) => {
    if (CONV.state === 'off') return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); convFire('escape'); return; }
    // A chord is a menu shortcut (⌘⇧J itself toggles the loop): leave it to the menu.
    if (e.metaKey || e.ctrlKey || ['Shift', 'Control', 'Alt', 'Meta'].indexOf(e.key) >= 0) return;
    convFire('user');
  }, true);
  window.addEventListener('mousedown', (e) => {
    if (CONV.state === 'off') return;
    if (e.target && e.target.closest && e.target.closest('[data-conv]')) return;   // its own buttons toggle it
    convFire('user');
  }, true);
}
if (typeof module !== 'undefined') module.exports = { convStep, convTakeVerdict, CONV_QUIET_MS, CONV_NOTHING_MS };
