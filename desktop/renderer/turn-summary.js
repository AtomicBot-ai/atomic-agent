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
/* ATO-1145: the replies whose "Auto-approved N actions" list is open. */
const TURN_AUTO_OPEN = new Set();

function stepsAlwaysSet(on) {
  STEPS.always = !!on;
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(STEPS_KEY, on ? '1' : '0'); } catch (e) { /* no storage: the choice lasts this launch */ }
}

/** ATO-1145: the approvals of one call that the agent let through by
    itself: a saved rule, a grant from earlier in the chat, or the risk
    check. Read from the stored call's approval records (`verdict:
    "auto-approved"`, `via`, `reason`). Approvals by level are not recorded,
    so they are not here either. */
function autoApprovedOf(approvals) {
  if (!Array.isArray(approvals)) return [];
  return approvals.filter((a) => a && a.verdict === 'auto-approved').map((a) => ({
    via: a.via === 'rule' || a.via === 'grant' || a.via === 'risk-review' ? a.via : null,
    reason: typeof a.reason === 'string' ? a.reason : '',
    category: typeof a.category === 'string' ? a.category : '',
    at: Number.isFinite(a.at) ? a.at : null,
  }));
}

/** How it got through, in words. */
function autoViaText(via) {
  return via === 'rule' ? 'your rule' : via === 'grant' ? 'allowed earlier in this chat' : via === 'risk-review' ? 'risk check' : 'automatic';
}

/** A row the summary line may hold. */
function turnFoldable(m) {
  if (!m) return false;
  if (m.k === 'reason' || m.k === 'tool') return true;
  /* Answered by the person. One still asking stays in sight, and so does one
     the run left unanswered (its card reads "Not answered"): that is
     news about how the turn ended, not a receipt. */
  return m.k === 'approval' && (m.state === 'approved' || m.state === 'denied');
}

/** The folds of `log`: Map from the index of a turn's first foldable row to
    {at, replyId, replyAt, rows: [indices], tools, reasons, approvals, failed}.
    opts.runningId: the reply still streaming (its turn is left alone).
    opts.always: Always show steps (nothing folds).
    opts.failedOf: whether a call failed, as its card says (renderer.js passes
    toolState === 'err'). Without it, a call that came back not ok and was
    neither denied nor left unrun: a Deny is the person's answer, not a failure. */
function turnFoldsOf(log, opts) {
  const o = opts || {};
  const out = new Map();
  if (o.always || !Array.isArray(log)) return out;
  const failedOf = typeof o.failedOf === 'function' ? o.failedOf
    : (m) => m.ok === false && m.outcome !== 'denied' && m.outcome !== 'notrun';
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
        at: rows[0], replyId: reply.id, replyAt: j, rows,
        tools: tools.length,
        reasons: rows.filter((x) => log[x].k === 'reason').length,
        approvals: rows.filter((x) => log[x].k === 'approval').length,
        failed: tools.filter((x) => failedOf(log[x])).length,
        // ATO-1145: each call the agent allowed by itself, with the row it belongs to.
        auto: tools.flatMap((x) => (Array.isArray(log[x].autoApproved) ? log[x].autoApproved : []).map((a) => Object.assign({row: log[x]}, a))),
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

/** ATO-1145: "Auto-approved N actions" under the summary line, and when
    opened the list: what ran, how it got through, the agent's reason.
    Nothing at all when the turn had none. deps.autoWhat(row): what the
    call did (html); without it, the tool's name. */
function turnAutoHTML(f, deps) {
  const {esc, ic} = deps;
  const list = Array.isArray(f.auto) ? f.auto : [];
  if (!list.length) return '';
  const open = TURN_AUTO_OPEN.has(f.replyId);
  const what = (a) => deps.autoWhat && a.row ? deps.autoWhat(a.row) : esc((a.row && a.row.name) || 'a tool call');
  return '<div class="ts-auto">'
    + '<button class="turnsum" data-tsauto="' + esc(f.replyId) + '" aria-expanded="' + open + '"'
      + ' title="' + (open ? 'Hide what was auto-approved' : 'Show what was auto-approved') + '">'
      + ic(open ? 'chevD' : 'chevR')
      + '<span class="ts-l">Auto-approved ' + list.length + ' action' + (list.length === 1 ? '' : 's') + '</span>'
    + '</button>'
    + (open ? '<div class="discbody ts-autolist">' + list.map((a) => '<div class="ts-autorow">' + what(a)
        + ' \u00b7 ' + esc(autoViaText(a.via)) + (a.reason ? ' \u00b7 <span class="ts-autowhy">' + esc(a.reason) + '</span>' : '') + '</div>').join('') + '</div>' : '')
    + '</div>';
}

/** The summary row. `open`: its steps are drawn under it. `ms`: how long the
    turn worked, or null to print nothing (never a made-up zero).
    deps: {esc, ic, dur, autoWhat?}. */
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
    + '</button>' + turnAutoHTML(f, deps) + '</div></div>';
}

if (typeof module !== 'undefined') module.exports = {STEPS_KEY, STEPS, TURN_OPEN, TURN_AUTO_OPEN, stepsAlwaysSet, autoApprovedOf, autoViaText, turnFoldable, turnFoldsOf, turnSumLabel, turnAutoHTML, turnSumHTML};
