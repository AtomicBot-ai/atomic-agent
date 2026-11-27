/* ---------------- ATO-2375: live widgets in the chat answer the agent ----------------
   An artifact page (chat-artifact.js draws it in a sandboxed frame; main
   serves it, main/artifact-frame.ts) gets a small bridge before its own
   markup: `sendPrompt(text)`, `atomicWidget.state.get()/set(v)` and a report
   of its first script errors. The bridge only posts messages to this window;
   this file reads them. The page is untrusted code, so every message is:

   - from one of our frames: its sender is the contentWindow of an entry in
     CHAT_ART (read only here, as chatArtifactMessage does);
   - checked and capped: prompt text at most AB_PROMPT_MAX characters, state
     JSON at most AB_STATE_MAX, an error line at most AB_ERROR_MAX, and at
     most AB_ERRORS lines kept per page;
   - rate-limited: one prompt per AB_PROMPT_GAP_MS per artifact, and only
     right after the person clicked or typed in the page (the frame's user
     activation reaches this window too), so a timer in a page fills nothing.

   What each does:

   - prompt: the text goes into the message box and the box takes focus, with
     a toast naming the widget. The person presses Enter: a page never sends
     to the model on its own (Claude artifacts' sendPrompt sends at once, as
     does OpenClaw's show-widget; here the safer default). A draft the person
     typed is never overwritten; one the last widget put there is.
   - state: kept in memory per artifact key (it survives a repaint, a move to
     the canvas, a new page for the same artifact; not an app restart), sent
     back into the frame when it says `ready`.
   - error: shown as small lines under the frame, inside its box (the box is
     kept across repaints, data-morph-keep), cleared when a new page loads.

   Loaded after chat-artifact.js, before renderer.js; renderer globals (S, $,
   autosize, refreshSend, ctxDraftChanged, toast) are read at call time. The
   pure part is exported for test/artifact-bridge.test.mjs. */

const AB_PROMPT_MAX = 4000;
const AB_STATE_MAX = 64 * 1024;
const AB_ERROR_MAX = 300;
const AB_ERRORS = 3;
const AB_PROMPT_GAP_MS = 2000;
/* Artifacts whose state or errors are kept; the oldest goes first. */
const AB_MAX_KEYS = 200;

/* key → {state: value|null, json: string, errors: [{message, line}], url, lastPrompt}. `arts`: a test seam for CHAT_ART. */
const AB = {widgets: new Map(), arts: null, lastFill: ''};

function abArts() {
  if (AB.arts) return AB.arts;
  return typeof CHAT_ART !== 'undefined' ? CHAT_ART : new Map();
}

function abWidget(key) {
  let w = AB.widgets.get(key);
  if (!w) {
    w = {state: null, json: '', errors: [], url: '', lastPrompt: 0};
    AB.widgets.set(key, w);
    while (AB.widgets.size > AB_MAX_KEYS) AB.widgets.delete(AB.widgets.keys().next().value);
  }
  return w;
}

/** The text a page asked to put in the box: trimmed, capped; null when there is none. */
function abPromptText(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.slice(0, AB_PROMPT_MAX).trim();
  return t ? t : null;
}

/** A page's state as it posted it (a JSON string): {json, value} or null (not a string, too large, not JSON). */
function abStateOf(raw) {
  if (typeof raw !== 'string' || raw.length > AB_STATE_MAX) return null;
  try { return {json: raw, value: JSON.parse(raw)}; } catch (e) { return null; }
}

/** One error line a page reported: {message, line} or null. */
function abErrorOf(d) {
  const m = d && typeof d.message === 'string' ? d.message.replace(/\s+/g, ' ').trim().slice(0, AB_ERROR_MAX) : '';
  if (!m) return null;
  const n = Number(d.line);
  return {message: m, line: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0};
}

/** May this artifact fill the box now? One prompt per AB_PROMPT_GAP_MS; true also records it. */
function abPromptAllowed(w, now) {
  if (now - w.lastPrompt < AB_PROMPT_GAP_MS) return false;
  w.lastPrompt = now;
  return true;
}

/** Did the person just click or type (in the window or in a frame inside it)? Unknown counts as yes. */
function abUserActive() {
  const ua = typeof navigator !== 'undefined' ? navigator.userActivation : null;
  return !ua || ua.isActive === true;
}

/** The CHAT_ART entry whose frame sent `source`, or null. */
function abEntryOf(source) {
  if (!source) return null;
  for (const st of abArts().values()) {
    if (st && st.node && st.node.contentWindow && st.node.contentWindow === source) return st;
  }
  return null;
}

/** Put a widget's text in the message box. Answers 'filled' | 'draft' (the person's own draft is there) | 'none'. */
function abFillComposer(text, title) {
  if (typeof S === 'undefined') return 'none';
  const e = typeof $ === 'function' ? $('#entry') : null;
  const draft = String((e ? e.value : S.draft) || '').trim();
  const name = title ? '"' + String(title).slice(0, 60) + '"' : 'A widget';
  if (draft && draft !== AB.lastFill) {
    if (typeof toast === 'function') toast(name + ' has a message for the agent', 'Your draft is in the box: send or clear it, then click in the widget again.', 'bad');
    return 'draft';
  }
  S.draft = text;
  AB.lastFill = text;
  if (e) {
    e.value = text;
    if (typeof autosize === 'function') autosize(e);
    e.focus();
    if (typeof e.setSelectionRange === 'function') e.setSelectionRange(text.length, text.length);
  }
  if (typeof refreshSend === 'function') refreshSend();
  if (typeof ctxDraftChanged === 'function') ctxDraftChanged();
  if (typeof toast === 'function') toast((title ? name : 'The widget') + ' put a message in the box', 'Press Enter to send it to the agent, or change it first.');
  return 'filled';
}

/* ---------- errors on the card ---------- */

/** The error lines under an artifact's frame, inside its box; made, updated or removed to match `w.errors`. */
function abPaintErrors(key) {
  if (typeof document === 'undefined') return;
  const w = AB.widgets.get(key);
  const errs = w ? w.errors : [];
  document.querySelectorAll('[data-chat-art]').forEach((box) => {
    if (box.dataset.chatArt !== key) return;
    let n = box.querySelector(':scope > .chat-art-err');
    if (!errs.length) { if (n) n.remove(); return; }
    const text = errs.map((x) => 'Script error' + (x.line ? ' (line ' + x.line + ')' : '') + ': ' + x.message).join('\n');
    if (!n) { n = document.createElement('div'); n.className = 'chat-art-err'; n.setAttribute('role', 'status'); }
    if (n.textContent !== text) n.textContent = text;
    // Under the frame: the frame may be put in after the lines (chatArtifactHydrate appends it).
    if (n !== box.lastElementChild) box.appendChild(n);
  });
}

/** After a repaint draws a fresh box, put its error lines back (once each; the observer settles). */
function abPaintAll() {
  for (const [key, w] of AB.widgets) if (w.errors.length) abPaintErrors(key);
}

/* ---------- the messages ---------- */

/** A widget's message, from one of our frames. True when handled. `now` is a test seam. */
function artifactBridgeMessage(e, now) {
  const d = e && e.data;
  if (!d || typeof d !== 'object') return false;
  const kind = d.atomicArtifact;
  if (kind !== 'ready' && kind !== 'prompt' && kind !== 'state' && kind !== 'error') return false;
  const st = abEntryOf(e.source);
  if (!st || !st.key) return false;
  const w = abWidget(st.key);
  // A new page in this artifact's frame: its old errors go.
  if (st.url && w.url !== st.url) {
    w.url = st.url;
    if (w.errors.length) { w.errors = []; abPaintErrors(st.key); }
  }
  if (kind === 'ready') {
    try { e.source.postMessage({atomicWidget: 'state', state: w.state}, '*'); } catch (x) { /* the frame went */ }
    return true;
  }
  if (kind === 'state') {
    const s = abStateOf(d.json);
    if (!s) return false;
    w.state = s.value; w.json = s.json;
    return true;
  }
  if (kind === 'error') {
    const er = abErrorOf(d);
    if (!er || w.errors.length >= AB_ERRORS) return false;
    if (w.errors.some((x) => x.message === er.message && x.line === er.line)) return true;
    w.errors.push(er);
    abPaintErrors(st.key);
    return true;
  }
  const text = abPromptText(d.text);
  if (!text || !abUserActive()) return false;
  if (!abPromptAllowed(w, typeof now === 'number' ? now : Date.now())) return false;
  abFillComposer(text, st.title);
  return true;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('message', artifactBridgeMessage);
}
if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
  new MutationObserver(() => { if (AB.widgets.size) abPaintAll(); })
    .observe(document.documentElement, {childList: true, subtree: true});
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {AB, AB_PROMPT_MAX, AB_STATE_MAX, AB_ERROR_MAX, AB_ERRORS, AB_PROMPT_GAP_MS, AB_MAX_KEYS,
    abPromptText, abStateOf, abErrorOf, abPromptAllowed, abEntryOf, abFillComposer, abWidget, artifactBridgeMessage};
}
