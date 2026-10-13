/* ---------------- context compaction (ATO-259, ATO-295) ----------------
   Loaded before renderer.js; declares only.

   The agent summarizes a chat's older history when the context fills up
   (auto compaction, PR #618), or when asked (`/compact`, "Compact now",
   POST /api/sessions/{id}/compact). An auto compaction runs inside the turn
   and can take 15-20 s on a local model, so the stream says so with named
   frames (compaction_started / _progress / _completed / _failed). When the
   agent cannot compact and leaves older history out instead, it sends
   `history_trimmed` once per cut.

   These are the words the chat shows for them, and the rule for when the
   manual command is available. renderer.js owns the rows (compactTurnFrame,
   compactNow). Counts and statuses only: the summary itself never reaches
   the window. */

const COMPACTING_LINE = 'Compacting the conversation…';
const HISTORY_TRIMMED_LINE = "Older messages were left out to fit the model's context. Use /compact to summarize them instead.";

/** "12k", "9.5k", as the context popover counts (fmtTokens). */
function compactTokens(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 1e6) { const k = v / 1000; return Number.isInteger(k) ? k + 'k' : k.toFixed(1) + 'k'; }
  const m = v / 1e6; return Number.isInteger(m) ? m + 'M' : m.toFixed(1) + 'M';
}

/** The running line, with the part when the agent sends the input in pieces. */
function compactionProgressLine(p) {
  const chunks = Number(p && p.chunks) || 0;
  const chunk = Number(p && p.chunk) || 0;
  return chunks > 1 && chunk > 0 ? COMPACTING_LINE + ' part ' + chunk + ' of ' + chunks : COMPACTING_LINE;
}

/**
 * The line a finished compaction leaves, from a frame payload
 * ({status, tokens_before, tokens_after, message}) or the POST answer
 * mapped to the same names. `sev` picks the system row's glyph.
 */
function compactionResultLine(p) {
  const status = String((p && p.status) || '');
  const before = Number(p && p.tokens_before);
  const after = Number(p && p.tokens_after);
  const said = String((p && p.message) || '').trim().replace(/[.!?\s]+$/, '');
  if (status === 'compacted') {
    return {sev: '', text: before > 0 && after > 0
      ? 'Conversation compacted: ~' + compactTokens(before) + ' → ~' + compactTokens(after) + ' tokens'
      : 'Conversation compacted'};
  }
  if (status === 'noop') return {sev: '', text: 'Nothing to compact: there is no older history that can be safely summarized'};
  if (status === 'busy') return {sev: '', text: 'This chat is already being compacted'};
  if (status === 'cancelled') return {sev: '', text: 'Compaction cancelled. The full history is kept'};
  return {sev: 'warn', text: "Couldn't compact the conversation" + (said ? ': ' + said : '') + '. The full history is kept'};
}

/**
 * Why the manual command is off right now, or '' when it can run. A turn
 * running in the chat would compact under it (the agent queues it, but the
 * person asked for it now); a chat the agent has not saved yet has nothing
 * to compact.
 */
function compactBlockedReason(st) {
  if (!st.supported) return 'This agent cannot compact a conversation';
  if (st.compacting) return 'Already compacting this chat';
  if (st.busy) return 'Wait for the reply to finish';
  if (!st.sessionId || String(st.sessionId).indexOf('waiting-') === 0) return 'Send a message first';
  return '';
}

if (typeof module !== 'undefined') {
  module.exports = {COMPACTING_LINE, HISTORY_TRIMMED_LINE, compactTokens, compactionProgressLine, compactionResultLine, compactBlockedReason};
}
