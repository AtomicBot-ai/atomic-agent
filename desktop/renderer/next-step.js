/* ---------------- next-step suggestions in the composer (ATO-1094, epic ATO-995) ----------------
   Loaded before renderer.js; declares only.

   After a turn ends, the agent may run one short model call that proposes
   what to ask next (ATO-1093) and keep it for the chat. This shows it as grey
   text in the EMPTY composer: Tab puts it in the field (it is never sent by
   itself), typing anything or Escape puts it away. It is the textarea's own
   placeholder, so it can never be mistaken for typed text, it vanishes on
   the first keystroke, and a render that rebuilds the field loses nothing:
   afterChat() calls nextStepPaint() again.

   Off unless `tui.nextStepSuggestions` is true (ATO-1096, default off: the
   call is one more model request after every turn). The agent route is
   GET /api/sessions/{id}/next-step -> {sessionId, suggestion|null}, through
   main/agent-client.ts nextStep(); an agent without the route answers
   {supported:false} and the window stops asking for good.

   The suggestion lands AFTER the turn's `done` (the call runs once the turn
   is finalised), so it is read a few times, like the chat title
   (session-titles.js), and the first answer with text wins.

   Analytics (desktop/ANALYTICS.md): `suggestion_shown` and
   `suggestion_accepted`, never the text. */

const NEXT = {sid:null, text:null, shownAt:0, unsupported:false, token:0, busy:false, error:null, note:null};
const NEXT_STEP_POLL_MS = [1500, 4000, 8000, 15000];
const NEXT_STEP_MAX_CHARS = 160;

/** The suggestion as the composer shows it: one line, trimmed, capped; null when empty. */
function nextStepClean(raw) {
  if (typeof raw !== 'string') return null;
  let t = raw.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length > NEXT_STEP_MAX_CHARS) t = t.slice(0, NEXT_STEP_MAX_CHARS - 1).trimEnd() + '…';
  return t;
}

/* What a key does to a suggestion on screen: 'accept' (Tab), 'dismiss'
   (Escape), or null (the key keeps its usual meaning). Only a bare Tab
   accepts: Shift+Tab and modified Tabs move focus as before, and nothing
   happens mid-IME composition or with text already in the field. */
function nextStepKeyAction(k) {
  if (!k || !k.ghost || k.composing || k.draft) return null;
  if (k.alt || k.meta || k.ctrl) return null;
  if (k.key === 'Tab' && !k.shift) return 'accept';
  if (k.key === 'Escape') return 'dismiss';
  return null;
}

/** tui.nextStepSuggestions: absent reads as the default, off. */
function nextStepOn() {
  const t = typeof LIVE_CONFIG !== 'undefined' && LIVE_CONFIG && LIVE_CONFIG.tui;
  return !!(t && t.nextStepSuggestions === true);
}

function nextStepClear() {
  NEXT.sid = null; NEXT.text = null; NEXT.shownAt = 0;
  NEXT.token++;   // a read still in flight for the old turn is dropped when it lands
}

/** Is the suggestion for the chat on screen, with nothing typed and no turn running? */
function nextStepActive() {
  return !!(NEXT.text && NEXT.sid && NEXT.sid === S.sessionId && !S.draft && !S.busy
    && S.room === 'chat' && nextStepOn());
}

/* Called for every turn end (done, aborted, error) on chat `sid`. Any of
   them retires the old suggestion; only a finished one asks for a new one. */
function nextStepTurnEnded(sid, kind) {
  if (NEXT.sid === sid || !sid) nextStepClear();
  if (kind !== 'done' || !sid || NEXT.unsupported || !nextStepOn() || !BR || !BR.nextStep) return;
  if (sid !== S.sessionId) return;   // a chat in the background: its composer is not on screen
  const token = ++NEXT.token;
  let i = 0;
  const next = () => {
    if (token !== NEXT.token || i >= NEXT_STEP_POLL_MS.length) return;
    setTimeout(async () => {
      if (token !== NEXT.token || !nextStepOn()) return;
      // The user already moved on: typed, sent another message, or left the chat.
      if (sid !== S.sessionId || S.busy || S.draft) return;
      let res = null;
      try { res = await BR.nextStep(sid); } catch (e) { res = null; }
      if (token !== NEXT.token) return;
      if (res && res.supported === false) { NEXT.unsupported = true; return; }
      const text = nextStepClean(res && res.text);
      if (!text) { next(); return; }
      NEXT.sid = sid; NEXT.text = text; NEXT.shownAt = 0;
      const el = document.getElementById('entry');
      if (el) nextStepPaint(el);
    }, NEXT_STEP_POLL_MS[i++]);
  };
  next();
}

/* afterChat() and the poll above: draw the suggestion into #entry, or take
   it out. The field's own placeholder is kept on the element so it comes back. */
function nextStepPaint(el) {
  if (!el) return;
  if (el.dataset.basePlaceholder === undefined) el.dataset.basePlaceholder = el.getAttribute('placeholder') || '';
  const on = nextStepActive() && !el.value;
  const field = el.parentElement;
  let hint = field ? field.querySelector('.ns-tab') : null;
  if (!on) {
    if (el.classList.contains('has-ghost')) {
      el.classList.remove('has-ghost');
      el.setAttribute('placeholder', el.dataset.basePlaceholder);
      el.removeAttribute('aria-description');
    }
    if (hint) hint.remove();
    return;
  }
  el.classList.add('has-ghost');
  el.setAttribute('placeholder', NEXT.text);
  el.setAttribute('aria-description', 'Suggested next step. Press Tab to use it.');
  if (field && !hint) {
    hint = document.createElement('kbd');
    hint.className = 'ns-tab';
    hint.title = 'Press Tab to use this suggestion';
    hint.textContent = 'Tab';
    field.insertBefore(hint, el.nextSibling);
  }
  if (!NEXT.shownAt) {
    NEXT.shownAt = Date.now();
    if (typeof ANX !== 'undefined') ANX.track('suggestion_shown', {});
  }
}

/* The composer's keydown (renderer.js), after the slash list had its turn.
   True when the key was the suggestion's. */
function nextStepKey(e) {
  const el = e.target;
  if (!el || el.id !== 'entry') return false;
  const action = nextStepKeyAction({key: e.key, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, ctrl: e.ctrlKey,
    composing: e.isComposing, draft: el.value, ghost: nextStepActive()});
  if (!action) return false;
  e.preventDefault();
  if (action === 'accept') {
    const text = NEXT.text;
    const shownAt = NEXT.shownAt;
    nextStepClear();
    S.draft = text;
    el.value = text;
    nextStepPaint(el);
    autosize(el);
    el.setSelectionRange(text.length, text.length);
    refreshSend();
    if (typeof ANX !== 'undefined') ANX.track('suggestion_accepted', {ms_to_accept: shownAt ? Math.max(0, Date.now() - shownAt) : null});
    return true;
  }
  nextStepClear();
  nextStepPaint(el);
  return true;
}

/** The composer's input handler: the first character typed puts the suggestion away for good. */
function nextStepTyped(el) {
  if (!NEXT.text || !el || !el.value) return;
  nextStepClear();
  nextStepPaint(el);
}

/* Settings › General row, the same parts as "Name chats automatically". */
function nextStepRowHTML() {
  const known = typeof LIVE_CONFIG !== 'undefined' && !!LIVE_CONFIG;
  const on = known && nextStepOn();
  return '<div class="tk-setrow">'
      + '<div class="body"><div class="t">Suggest a next step</div>'
        + '<div class="d">After a reply, shows a short suggestion in the empty message box. Press Tab to use it. Uses one short model call per reply.</div>'
        + (NEXT.unsupported ? '<div class="tk-help">This version of the agent does not make suggestions yet.</div>' : '')
        + (NEXT.note ? '<div class="tk-help">' + esc(NEXT.note) + '</div>' : '')
        + (NEXT.error ? '<div class="tk-help tk-help--warn">' + esc(NEXT.error) + '</div>' : '')
      + '</div>'
      + setSwitchHTML({on, busy: NEXT.busy || (!known && !!BR), disabled: !known || NEXT.busy || !BR, act: 'nextstep:toggle',
        label: 'Suggest a next step', title: 'Turn next-step suggestions ' + (on ? 'off' : 'on')})
    + '</div>';
}

async function nextStepSet(enabled) {
  if (!BR || NEXT.busy) return {ok:false, error:'busy'};
  NEXT.busy = true; NEXT.error = null; NEXT.note = null; render();
  const res = await configPatchOr({tui:{nextStepSuggestions:!!enabled}}, () => BR.configSet('tui.nextStepSuggestions', String(!!enabled)));
  if (!res.ok) NEXT.error = 'Could not save: ' + res.error;
  else if (!res.live) NEXT.note = 'Saved. Restart Atomic Agent to apply.';
  if (!enabled) nextStepClear();
  await refreshLiveConfig();
  NEXT.busy = false; render();
  return res;
}

if (typeof window !== 'undefined') {
  // --smoke: the switch, and what the composer shows.
  window.__nextStep = () => ({on:nextStepOn(), active:nextStepActive(), sid:NEXT.sid, hasText:!!NEXT.text,
    unsupported:NEXT.unsupported, busy:NEXT.busy, error:NEXT.error, note:NEXT.note});
  window.__nextStepSet = (on) => nextStepSet(on);
}
if (typeof module !== 'undefined') {
  module.exports = {nextStepClean, nextStepKeyAction, NEXT_STEP_MAX_CHARS};
}
