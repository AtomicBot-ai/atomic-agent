/* ---------------- ATO-1184: change the mode chip while a turn runs ----------------
   Loaded before renderer.js. setCodingMode used to open with
   `if (S.busy) toast('Not while a turn is running')`, so the stance could not
   be moved while the agent worked: someone who watched it ask for every file
   write had to wait for the turn to end (or stop it) to say "go on in Auto".
   Claude and Codex switch modes mid-turn.

   The agent takes the change mid-turn and it counts from the next tool call
   (checked in the agent code, rel/xp-build):
   - POST /api/coding-mode (src/http/route-coding-mode.ts) has no busy check;
     it calls runtime.setApprovalLevel and runtime.setPlanMode and answers.
   - setApprovalLevel moves the approval gate's own level
     (src/approval/approval-gate.ts setLevel), and the gate reads that level
     on every request; tools do not copy it (src/runtime/bootstrap.ts).
   - plan mode is read through a getter on each tool call
     (`isPlanMode: () => planMode`, bootstrap.ts), "observed by the next tool
     call rather than by the next process".
   - a request already waiting is not answered by the change
     (runtime-contract.ts: "pending prompts are not resolved retroactively"):
     its card stays for the person's answer.
   The mode restarts nothing, so the switch lane never held a turn for it
   either. So the block goes, and nothing has to wait for the turn's end
   (the MODE_REASSERT path stays what it was: a reconnect's re-assert).

   The pure part is exported for test/mode-mid-turn.test.mjs. */

/**
 * The line that records a mode change. Mid-turn it also says when it counts,
 * and, under a waiting request, that the request still needs an answer.
 * ctx: {midTurn, cardWaiting}.
 */
function modeChangeNote(summary, ctx) {
  const c = ctx || {};
  const base = String(summary || '');
  if (!c.midTurn) return base;
  return base + (c.cardWaiting
    ? ' (from the agent\'s next action in this turn; the request already waiting still needs your answer)'
    : ' (from the agent\'s next action in this turn)');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {modeChangeNote};
}
