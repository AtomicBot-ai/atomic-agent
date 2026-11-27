/* ---------------- ATO-2457: where a widget's message goes ----------------
   Every widget that answers the agent hands its text here: a live page's
   sendPrompt (artifact-bridge.js), an MCP App's ui/message
   (mcp-app-bridge.js) and a ui.render card's click (ui-render-act.js).

   By default the text waits in the message box for Enter (the safer
   default; abFillComposer). Settings › General › "Widgets send right
   away" sends it at once instead, as Claude's widgets and OpenClaw's
   show-widget do. Either way a draft the person typed is never
   overwritten: abFillComposer says so and the widget's text waits.

   Widget text is a message, never a command (review): a page or an MCP
   App controls it, and a card shows only its label, so a hidden
   "/runmode cloud" or "!cmd" must not reach runSlash or bangOpen. The text
   a widget put in the box is remembered (WIDGET_SEND.plain); while the box
   still holds exactly that text, submit() in renderer.js sends it as a
   plain message (widgetTextIsPlain). Text the person edits is theirs again.
   An auto-send also leaves the attachment chips for the person's own
   message ({plain: true}). It answers 'sent' only when the box was emptied:
   a held send (agent starting, voice, queue full...) leaves the text there.

   The choice is per window (localStorage 'atag.widgetSendNow'), off unless
   set. Loaded after artifact-bridge.js; renderer globals (S, $, submit,
   toast) are read at call time. Pure part exported for test/widget-send.test.mjs. */

const WIDGET_SEND_KEY = 'atag.widgetSendNow';
const WIDGET_SEND = {now: (() => {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(WIDGET_SEND_KEY) === '1'; } catch (e) { return false; }
})(), plain: ''};

/** True when `typed` is, unchanged, the text a widget last put in the box: submit() then sends it as a message, not as a /command or !command. */
function widgetTextIsPlain(typed) {
  const t = String(typed == null ? '' : typed).trim();
  return t !== '' && t === WIDGET_SEND.plain;
}

function widgetEntryValue() {
  const e = typeof $ === 'function' ? $('#entry') : null;
  return String((e ? e.value : (typeof S !== 'undefined' ? S.draft : '')) || '').trim();
}

function widgetSendNowOn() { return WIDGET_SEND.now === true; }

function widgetSendNowSet(on) {
  WIDGET_SEND.now = !!on;
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(WIDGET_SEND_KEY, on ? '1' : '0'); } catch (e) { /* no storage: the choice lasts this launch */ }
}

/**
 * A widget's text, on its way to the agent. Answers 'filled' (in the box,
 * waiting for Enter), 'sent', 'draft' (the person's own draft is in the
 * box; nothing changed) or 'none'.
 */
function widgetDeliver(text, title) {
  if (typeof abFillComposer !== 'function') return 'none';
  const plain = String(text == null ? '' : text).trim();
  if (!widgetSendNowOn() || typeof submit !== 'function') {
    const r = abFillComposer(text, title);
    if (r === 'filled') WIDGET_SEND.plain = plain;
    return r;
  }
  // Into the box first, through the same draft check (without its "press Enter" toast); then sent as Enter would, as a plain message.
  const r = abFillComposer(text, title, {quiet: true});
  if (r !== 'filled') return r;
  WIDGET_SEND.plain = plain;
  submit(undefined, {plain: true});
  // Held (agent starting, voice, a full queue...): the text is still in the box, waiting for Enter.
  if (widgetEntryValue() !== '') return 'filled';
  WIDGET_SEND.plain = '';
  if (typeof AB !== 'undefined') AB.lastFill = '';
  return 'sent';
}

/** Settings › General: the row and its switch (renderer.js draws it beside the other chat rows). */
function widgetSendRowHTML(h) {
  const on = widgetSendNowOn();
  return '<div class="tk-setrow">'
    + '<div class="body"><div class="t">Widgets send right away</div>'
      + '<div class="d">When a button or form in a widget answers the agent, send it at once. When off, the text waits in your message box until you press Enter.</div></div>'
    + h.setSwitchHTML({on, act: 'widgets:sendnow', label: 'Widgets send right away', title: 'Turn sending from widgets right away ' + (on ? 'off' : 'on')})
    + '</div>';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {WIDGET_SEND, WIDGET_SEND_KEY, widgetSendNowOn, widgetSendNowSet, widgetTextIsPlain, widgetDeliver, widgetSendRowHTML};
}
