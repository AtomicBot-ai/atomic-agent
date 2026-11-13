/* ---------------- ATO-1186: the quiet status line and a reply's speed ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/status-line.test.mjs).

   Two readouts the best chat apps keep in view (ATO-1032 items 7 and 11):

   1. A grey line under the composer's control row: the model, the chat's
      context in tokens, how long this chat has been open here, and the
      memory this app uses. Each part is left out when it is not known.
      The memory is the desktop app's own processes (Electron's
      app.getAppMetrics, main `app:memory`): cheap to read and true right
      now. It is not the agent's or the model's: the agent reports its own
      only every ten minutes, and a local model's weights sit in the
      engine. The tooltip says which memory it is.

   2. "N tok/s" in the action row under the last reply. The agent puts the
      turn's timed generation on its end-of-turn `usage` frame (`generation:
      {completion_tokens, duration_ms}`, src/http/openai-chunks.ts). An
      older agent sends no such field, and then nothing is shown: a missing
      figure is never drawn as zero or guessed from the wall clock. */

/* The reply speed a `usage` frame carries, or null when it carries none.
   {tokens, ms, tps}. */
function replySpeedOf(payload) {
  const g = payload && typeof payload === 'object' ? payload.generation : null;
  if (!g || typeof g !== 'object') return null;
  const tokens = Number(g.completion_tokens);
  const ms = Number(g.duration_ms);
  if (!Number.isFinite(tokens) || !Number.isFinite(ms) || tokens <= 0 || ms <= 0) return null;
  const tps = tokens / (ms / 1000);
  return Number.isFinite(tps) && tps > 0 ? {tokens, ms, tps} : null;
}

/* "42 tok/s"; one decimal below 10 ("7.5 tok/s"), so a slow local model
   does not read as 7 or 8 by rounding. '' for anything that is not a speed. */
function tpsWord(tps) {
  const n = Number(tps);
  if (!Number.isFinite(n) || n <= 0) return '';
  const v = n < 10 ? (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '') : String(Math.round(n));
  return v + ' tok/s';
}

/* The reply row's speed, as HTML: a quiet figure, its tooltip the exact
   tokens and time. '' when the reply has no speed. */
function replySpeedHTML(speed) {
  if (!speed || !(speed.tps > 0)) return '';
  const word = tpsWord(speed.tps);
  if (!word) return '';
  const tip = speed.tokens + ' tokens in ' + (speed.ms / 1000).toFixed(1) + ' s of generation';
  return '<span class="msgtps" title="' + tip + '" aria-label="Reply speed: ' + word + '">' + word + '</span>';
}

/* How long a chat has been open: "<1m", "12m", "1h 05m". */
function sessionTimeWord(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  const min = Math.floor(n / 60000);
  if (min < 1) return '<1m';
  if (min < 60) return min + 'm';
  const h = Math.floor(min / 60);
  return h + 'h ' + String(min % 60).padStart(2, '0') + 'm';
}

/* "412 MB", "1.2 GB" (binary units, as the rest of the window). '' when unknown. */
function memWord(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  const mb = n / (1024 * 1024);
  if (mb < 1024) return Math.max(1, Math.round(mb)) + ' MB';
  return (mb / 1024).toFixed(1).replace(/\.0$/, '') + ' GB';
}

/* When the chat on screen was opened here. A new chat that has just been
   given its id is the same chat, so its clock goes on; any other change of
   chat starts it again. `state` is STATUS_LINE below; returns the start time. */
function statusChatSince(state, sid, now) {
  const t = typeof now === 'number' ? now : Date.now();
  const id = sid || null;
  if (!state.since || (id !== state.sid && !(state.sid === null && id !== null))) state.since = t;
  state.sid = id;
  return state.since;
}

function statusEsc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

/* The line's parts, in order, each {text, tip}; parts not known are left
   out. `tokens` is the context figure the ring chip reads (CTX.tokens),
   `tokensText` its word (renderer tokensWord). */
function statusLineParts(o) {
  const parts = [];
  if (o && o.model) parts.push({text: String(o.model), tip: 'Model'});
  if (o && o.tokens > 0 && o.tokensText) parts.push({text: o.tokensText + ' tokens', tip: 'Context of this chat'});
  const time = o && typeof o.sessionMs === 'number' ? sessionTimeWord(o.sessionMs) : '';
  if (time) parts.push({text: time, tip: 'Time since you opened this chat in this window'});
  const mem = o ? memWord(o.memBytes) : '';
  if (mem) parts.push({text: mem, tip: 'Memory this app uses (all its windows), not the agent or the model'});
  return parts;
}

/* The line as HTML, '' when there is nothing to say. */
function statusLineHTML(o) {
  const parts = statusLineParts(o);
  if (!parts.length) return '';
  return '<div class="cstatus" aria-label="Status">'
    + parts.map((p) => '<span title="' + statusEsc(p.tip) + '">' + statusEsc(p.text) + '</span>').join('<span class="csep" aria-hidden="true">·</span>')
    + '</div>';
}

/* The cached memory reading. `bytes` is main's last answer (null =
   unknown), `at` when it was asked, `pending` the read in flight. Read at
   most every STATUS_MEM_STALE_MS, never once per paint. */
const STATUS_MEM_STALE_MS = 15 * 1000;
const STATUS_LINE = {sid: null, since: 0, memBytes: null, memAt: 0, pending: null, onChange: null};

/* Read the app's memory again when the reading is stale. Resolves to the
   reading; never rejects. `br` is the preload bridge; an older one without
   `appMemory` leaves the reading unknown. */
function statusMemRefresh(br, now) {
  const t = typeof now === 'number' ? now : Date.now();
  if (STATUS_LINE.pending) return STATUS_LINE.pending;
  if (STATUS_LINE.memAt && t - STATUS_LINE.memAt < STATUS_MEM_STALE_MS) return Promise.resolve(STATUS_LINE.memBytes);
  if (!br || typeof br.appMemory !== 'function') return Promise.resolve(STATUS_LINE.memBytes);
  STATUS_LINE.memAt = t;
  STATUS_LINE.pending = Promise.resolve().then(() => br.appMemory()).then((res) => {
    const n = res && Number(res.bytes);
    const next = Number.isFinite(n) && n > 0 ? n : null;
    const was = STATUS_LINE.memBytes;
    STATUS_LINE.memBytes = next;
    // Repaint only when the word would change.
    if (memWord(was) !== memWord(next) && typeof STATUS_LINE.onChange === 'function') STATUS_LINE.onChange();
    return next;
  }, () => STATUS_LINE.memBytes).finally(() => { STATUS_LINE.pending = null; });
  return STATUS_LINE.pending;
}

if (typeof module !== 'undefined') module.exports = {replySpeedOf, tpsWord, replySpeedHTML, sessionTimeWord, memWord, statusChatSince, statusLineParts, statusLineHTML, statusMemRefresh, STATUS_LINE, STATUS_MEM_STALE_MS};
