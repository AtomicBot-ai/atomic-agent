/* ---------------- ATO-2005: a reply after the loop guard's stop ----------------
   Loaded before renderer.js. The loop guard (src/agent/progress/loop-notices.ts
   formatForcedLoopReply) used to end a turn with a canned reply and nothing
   else:

     (stopped: `os.web.fetch` hit the limit on different arguments within
     recent tool calls ... which was not run). Here is my best answer with the
     information gathered so far ... the task may be incomplete.

   That reply alone is drawn as the yellow warning row (`.sysrow.warn`). Since
   ATO-2004 the model gets one last step to write a real answer from what it
   gathered. A real answer is a normal message: when it still opens with the
   guard's parenthesis, the parenthesis and the canned sentences come off,
   the answer is drawn as prose, and a dim line above it says the guard
   stopped the turn (Claude Code draws a wrap-up the same way: the message,
   with a dim status line). Only a reply that is nothing but the canned text
   collapses into the warning row.

   The pure part is exported for test/stopped-reply.test.mjs. */

/* The guard's opening parenthesis, every wording the agent has shipped.
   Each gives the warning row's sentence. */
const STOPPED_CAUSES = [
  // v0.6.5: "(stopped: stuck in a no-progress loop on `tool` after N blocked attempts)".
  [/^\(stopped: stuck in a no-progress loop on `([^`]+)` after (\d+) blocked attempts\)/,
    (mt) => 'Stopped: the agent kept repeating the same step without getting anywhere (' + mt[2] + ' tries). The task may be incomplete.'],
  // v0.6.6+: "(stopped: `tool` kept returning the same no-progress outcome, and the
  // same call was refused N times in a row, counting this one)" or "... and this call was not run)".
  [/^\(stopped: `([^`]+)` kept returning the same no-progress outcome(?:, and the same call was refused (\d+) times? in a row)?[^)]*\)/,
    (mt) => 'Stopped: the agent kept repeating the same step without getting anywhere' + (mt[2] ? ' (' + mt[2] + ' tries)' : '') + '. The task may be incomplete.'],
  // The wandering stop: "(stopped: `tool` hit the limit on different arguments ...)".
  [/^\(stopped: `([^`]+)` hit the limit on different arguments[^)]*\)/,
    () => 'Stopped: the agent kept trying variations of the same step. The task may be incomplete.'],
];

/* The canned sentences that follow the parenthesis. None of them is an
   answer, so a reply made only of these is the bare stop. */
const STOPPED_FILLERS = [
  /^I could not make further progress[^.…]*(?:\.|…)/,
  /^Here is my best answer with the information gathered so far[^.]*\./,
];

/** `{sentence, body}` for a reply that opens with the guard's parenthesis,
    `null` for any other text. `body` is what is left once the parenthesis
    and the canned sentences come off: '' for the bare stop. */
function stoppedReplyParts(text) {
  const t = String(text == null ? '' : text).trim();
  for (const [re, say] of STOPPED_CAUSES) {
    const mt = re.exec(t);
    if (!mt) continue;
    let rest = t.slice(mt[0].length).replace(/^\.?\s*/, '');
    for (let changed = true; changed;) {
      changed = false;
      for (const f of STOPPED_FILLERS) {
        const fm = f.exec(rest);
        if (fm) { rest = rest.slice(fm[0].length).replace(/^\s+/, ''); changed = true; }
      }
    }
    return {sentence: say(mt), body: rest.trim()};
  }
  return null;
}

/** The warning row's sentence when the reply is the bare canned stop, else ''.
    A placeholder or a non-assistant row is never a stop. */
function stoppedSentence(m) {
  if (!m || m.k !== 'assistant' || m.placeholder) return '';
  const p = stoppedReplyParts(m.text);
  return p && !p.body ? p.sentence : '';
}

/** The text a normal assistant message draws: the answer without the guard's
    canned parenthesis, or the reply unchanged. */
function stoppedReplyBody(m) {
  const p = m && m.k === 'assistant' && !m.placeholder ? stoppedReplyParts(m.text) : null;
  return p && p.body ? p.body : String((m && m.text) || '');
}

/** ATO-2005: an `event: loop_stopped` frame (agent with ATO-2004) says the
    loop guard stopped this turn. Since ATO-2004 the reply after it is the
    model's own summary and opens with the answer, not with the guard's
    parenthesis, so the note is keyed on this mark, not on the text. True
    when the streaming reply `item` was marked. */
function markLoopStopped(item, payload) {
  if (!item || item.k !== 'assistant') return false;
  item.loopStopped = true;
  if (payload && typeof payload.tool === 'string' && payload.tool) item.loopStoppedTool = payload.tool;
  return true;
}

/** The dim line above a real answer written after the guard's stop, else ''.
    Shown when the turn's `loop_stopped` frame marked the reply, or when the
    reply still opens with the guard's parenthesis (an older agent). The
    canned text, or what the guard stopped, stays in its tooltip. */
function stoppedNoteHTML(m, esc) {
  if (!m || m.k !== 'assistant' || m.placeholder) return '';
  const p = stoppedReplyParts(m.text);
  if (p && !p.body) return '';          // the bare canned stop: the warning row says it
  let tip = '';
  if (p) {
    const t = String(m.text).trim();
    tip = t.slice(0, t.length - p.body.length).trim();
  } else if (m.loopStopped && String(m.text || '').trim()) {
    tip = 'The loop guard stopped further tool calls' + (m.loopStoppedTool ? ' (' + m.loopStoppedTool + ')' : '') + ', and the agent summarized what it found.';
  } else {
    return '';
  }
  return '<div class="turn tk-stopnote"><div></div><div class="tk-stopnote-t" title="' + esc(tip) + '">Stopped by the loop guard</div></div>';
}

if (typeof module !== 'undefined') module.exports = {stoppedReplyParts, stoppedSentence, stoppedReplyBody, stoppedNoteHTML, markLoopStopped};
