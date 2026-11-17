"use strict";

/* ---------------- ATO-490: reasoning depth in the composer ----------------
   Loaded before renderer.js; declares only, plus one click listener.

   A chip next to the model picker: Auto, Low, Medium, High. Each click moves
   to the next level. Auto is what the app did before: the turn carries
   nothing new and the model thinks as its settings say. A level is sent with
   every turn of that chat as `reasoning_effort` (POST /v1/chat/completions);
   the agent maps it per model (a cloud reasoning effort, or a local thinking
   model's think budget) and ignores it for a model that does not reason.

   The chip is drawn only where it does something: the agent says so in
   GET /api/capabilities `reasoning.control` (effort | budget | none). An
   agent from before the field draws no chip and gets no field.

   The level is remembered per chat (localStorage, this window only). A new
   chat keeps its pick as a draft until the agent names the chat's session,
   then the draft becomes that chat's level. */

const REASONING_LEVELS = ['auto', 'low', 'medium', 'high'];
const REASONING_WORDS = {auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High'};
const REASONING_STORE_KEY = 'atag.reasoningByChat';
/* Enough for every chat a person keeps; the oldest picks go first past it. */
const REASONING_STORE_MAX = 500;

const RSN = {draft: 'auto', byChat: null};

/** A stored or sent value as a level; anything else is Auto. */
function reasoningLevel(v) {
  return REASONING_LEVELS.includes(v) ? v : 'auto';
}
/** The level after `v` in the chip's cycle. */
function reasoningNext(v) {
  const at = REASONING_LEVELS.indexOf(reasoningLevel(v));
  return REASONING_LEVELS[(at + 1) % REASONING_LEVELS.length];
}
/** Whether the agent's capabilities say the active model takes a level. */
function reasoningSupported(caps) {
  const r = caps && caps.reasoning;
  return !!r && (r.control === 'effort' || r.control === 'budget');
}
/** What the turn sends: the chat's level, or nothing for Auto or a route without the switch. */
function reasoningForTurn(level, caps) {
  const l = reasoningLevel(level);
  return l !== 'auto' && reasoningSupported(caps) ? l : undefined;
}
/** The chip's tooltip: what the level does on this route. */
function reasoningTip(level, caps) {
  const l = reasoningLevel(level);
  const local = caps && caps.reasoning && caps.reasoning.control === 'budget';
  const what = l === 'auto' ? 'as the model’s settings say'
    : local ? (l === 'high' ? 'with no limit on thinking' : 'with a ' + (l === 'low' ? 'short' : 'medium') + ' thinking budget')
      : 'at ' + l + ' reasoning effort';
  return 'Reasoning: ' + REASONING_WORDS[l] + '. The model thinks ' + what + '. Click to change (Auto, Low, Medium, High).';
}

/* Per-chat store: {sessionId: level}, Auto not kept. Insertion order is age. */
function reasoningMapRead(raw) {
  try {
    const v = JSON.parse(raw || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out = {};
    for (const [k, l] of Object.entries(v)) if (typeof k === 'string' && k && reasoningLevel(l) !== 'auto') out[k] = l;
    return out;
  } catch (e) { return {}; }
}
function reasoningMapSet(map, sessionId, level) {
  const next = Object.assign({}, map);
  delete next[sessionId];
  if (reasoningLevel(level) !== 'auto') next[sessionId] = reasoningLevel(level);
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - REASONING_STORE_MAX))) delete next[k];
  return next;
}
function reasoningStore() {
  if (RSN.byChat) return RSN.byChat;
  let raw = null;
  try { raw = localStorage.getItem(REASONING_STORE_KEY); } catch (e) { /* no storage: picks last this launch */ }
  RSN.byChat = reasoningMapRead(raw);
  return RSN.byChat;
}
function reasoningSave(map) {
  RSN.byChat = map;
  try { localStorage.setItem(REASONING_STORE_KEY, JSON.stringify(map)); } catch (e) { /* no storage: picks last this launch */ }
}

/** The level of the chat on screen (`sessionId` null: a new chat, its draft). */
function reasoningLevelFor(sessionId) {
  if (!sessionId) return RSN.draft;
  return reasoningLevel(reasoningStore()[sessionId]);
}
function reasoningSetFor(sessionId, level) {
  if (!sessionId) { RSN.draft = reasoningLevel(level); return; }
  reasoningSave(reasoningMapSet(reasoningStore(), sessionId, level));
}
/** The agent named a new chat's session: its draft is that chat's level now. */
function reasoningAdoptDraft(sessionId) {
  if (!sessionId || RSN.draft === 'auto') return;
  if (reasoningStore()[sessionId] === undefined) reasoningSetFor(sessionId, RSN.draft);
  RSN.draft = 'auto';
}

/* ---- window wiring (renderer.js globals: S, LIVE_CAPS, BR, ic, esc, render) ---- */

function reasoningCaps() { return typeof LIVE_CAPS !== 'undefined' ? LIVE_CAPS : null; }
function reasoningSession() { return typeof S !== 'undefined' && S ? S.agentSession || null : null; }

/** The composer chip, or '' where the route takes no level. */
function reasoningChipHtml() {
  const caps = reasoningCaps();
  if (!reasoningSupported(caps)) return '';
  const level = reasoningLevelFor(reasoningSession());
  const tip = reasoningTip(level, caps);
  return '<button class="cchip reasonchip' + (level === 'auto' ? ' is-auto' : '') + '" data-reasoning-chip="1" data-level="' + esc(level) + '"'
    + ' title="' + esc(tip) + '" aria-label="' + esc(tip) + '">' + ic('bulb')
    + '<span class="cval">' + esc(REASONING_WORDS[level]) + '</span></button>';
}
/** What BR.chat sends with this chat's turn: a level, or undefined. */
function reasoningTurnLevel(sessionId) {
  return reasoningForTurn(reasoningLevelFor(sessionId || null), reasoningCaps());
}
/** Re-read the agent's capabilities after the model changed, for the chip only. */
async function reasoningRefresh() {
  if (typeof BR === 'undefined' || !BR || !BR.capabilities) return;
  let res = null;
  try { res = await BR.capabilities(); } catch (e) { return; }
  const caps = reasoningCaps();
  if (!res || !res.ok || !res.data || !caps) return;
  caps.reasoning = res.data.reasoning;
  render();
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const chip = e.target && e.target.closest ? e.target.closest('[data-reasoning-chip]') : null;
    if (!chip) return;
    e.preventDefault();
    const sid = reasoningSession();
    reasoningSetFor(sid, reasoningNext(reasoningLevelFor(sid)));
    render();
  });
}
if (typeof window !== 'undefined') {
  // --smoke: read and drive the chip.
  window.__reasoningState = () => ({level: reasoningLevelFor(reasoningSession()), shown: !!document.querySelector('[data-reasoning-chip]')});
}

if (typeof module !== 'undefined') {
  module.exports = {
    REASONING_LEVELS, REASONING_STORE_MAX, reasoningLevel, reasoningNext, reasoningSupported, reasoningForTurn, reasoningTip,
    reasoningMapRead, reasoningMapSet,
  };
}
