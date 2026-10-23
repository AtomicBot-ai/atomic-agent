/* ---------------- ATO-464 (U-42): a finished turn folds into one line ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/turn-summary.test.mjs).

   "Create a file" left four "Reasoning" rows, three tool lines and two
   "Approved" notes above a "Done!" that sank to the bottom. The owner chose
   variant B of the UX audit (15.10): while a turn runs its steps are drawn
   live, exactly as before; once it has finished, its reasoning rows, tool
   calls and answered approvals fold into one quiet line ("Used 4 tools ·
   12 s") that opens in place on a click. Settings › General › "Always show
   steps" keeps every finished turn open, as it used to be (off by default).

   What folds: the `reason`, `tool` and answered `approval` rows between the
   message that started the turn (a steer does not start one) and the reply
   that closes it. Words stay on screen: progress notes (`interim`), system
   rows, an approval still waiting for an answer and one the run left
   unanswered are never folded. A turn
   whose reply is still streaming (`runningId`), and steps with no reply
   under them yet, are drawn as they are. One reasoning row alone stays a
   row: folding it would trade one line for another. */

/* Per viewer, like the theme: a display preference, nothing the agent reads. */
const STEPS_KEY = 'atag.alwaysShowSteps';
const STEPS = {always: (() => {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(STEPS_KEY) === '1'; } catch (e) { return false; }
})()};
/* The replies (by id) whose folded turn was opened by a click. */
const TURN_OPEN = new Set();

function stepsAlwaysSet(on) {
  STEPS.always = !!on;
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(STEPS_KEY, on ? '1' : '0'); } catch (e) { /* no storage: the choice lasts this launch */ }
}

/** A row the summary line may hold. */
function turnFoldable(m) {
  if (!m) return false;
  if (m.k === 'reason' || m.k === 'tool') return true;
  /* Answered by the person. One still asking stays in sight, and so does one
     the run left unanswered ("Not answered — the run was stopped"): that is
     news about how the turn ended, not a receipt. */
  return m.k === 'approval' && (m.state === 'approved' || m.state === 'denied');
}

/** The folds of `log`: Map from the index of a turn's first foldable row to
    {at, replyId, rows: [indices], tools, reasons, approvals, failed}.
    opts.runningId: the reply still streaming (its turn is left alone).
    opts.always: Always show steps (nothing folds). */
function turnFoldsOf(log, opts) {
  const o = opts || {};
  const out = new Map();
  if (o.always || !Array.isArray(log)) return out;
  for (let i = 0; i < log.length; i++) {
    const u = log[i];
    if (!u || u.k !== 'user' || u.steered) continue;
    let j = i + 1;
    while (j < log.length && log[j] && log[j].k !== 'assistant' && !(log[j].k === 'user' && !log[j].steered)) j++;
    const reply = log[j];
    if (!reply || reply.k !== 'assistant' || (o.runningId && reply.id === o.runningId)) { i = j - 1; continue; }
    const rows = [];
    for (let x = i + 1; x < j; x++) if (turnFoldable(log[x])) rows.push(x);
    const tools = rows.filter((x) => log[x].k === 'tool');
    if (tools.length || rows.length >= 2) {
      out.set(rows[0], {
        at: rows[0], replyId: reply.id, rows,
        tools: tools.length,
        reasons: rows.filter((x) => log[x].k === 'reason').length,
        approvals: rows.filter((x) => log[x].k === 'approval').length,
        failed: tools.filter((x) => log[x].ok === false).length,
      });
    }
    i = j - 1;
  }
  return out;
}

/** The line's words: "Used 4 tools", or for thinking alone "Reasoned in 3 steps". */
function turnSumLabel(f) {
  if (f.tools) return 'Used ' + f.tools + ' tool' + (f.tools === 1 ? '' : 's');
  return 'Reasoned in ' + f.reasons + ' step' + (f.reasons === 1 ? '' : 's');
}

/** The summary row. `open`: its steps are drawn under it. `ms`: how long the
    turn worked, or null to print nothing (never a made-up zero).
    deps: {esc, ic, dur}. */
function turnSumHTML(f, open, ms, deps) {
  const {esc, ic, dur} = deps;
  const label = turnSumLabel(f);
  const time = ms != null && Number.isFinite(ms) && ms > 0 ? dur(ms) : '';
  return '<div class="turn tk-step tk-turnsum" id="turnsum-' + esc(f.replyId) + '"><div></div><div>'
    + '<button class="turnsum" data-turnsum="' + esc(f.replyId) + '" aria-expanded="' + !!open + '"'
      + ' title="' + (open ? 'Hide the steps' : 'Show the steps') + '">'
      + ic(open ? 'chevD' : 'chevR')
      + '<span class="ts-l">' + esc(label) + '</span>'
      + (f.failed ? '<span class="ts-sep" aria-hidden="true">·</span><span class="ts-bad">' + f.failed + ' failed</span>' : '')
      + (time ? '<span class="ts-sep" aria-hidden="true">·</span><span class="ts-du tnum">' + esc(time) + '</span>' : '')
    + '</button></div></div>';
}

if (typeof module !== 'undefined') module.exports = {STEPS_KEY, STEPS, TURN_OPEN, stepsAlwaysSet, turnFoldable, turnFoldsOf, turnSumLabel, turnSumHTML};
