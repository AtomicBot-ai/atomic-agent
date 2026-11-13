/* ---------------- ATO-1040: goal mode in the composer ----------------
   Loaded before renderer.js; the pure half is shared with the Node checks
   (test/goal-card.test.mjs).

   The TUI's /goal for the window. A goal is an acceptance list the agent
   works on, round after round, until a judge marks every item met, an item
   is blocked on the person, or the round limit is reached. The agent keeps
   it on the chat (GET /api/sessions/{id} `goal`, GET .../goal) and sends
   every change of a running goal as the stream frame `goal_progress`
   ({session_id, goal}).

   Composer: the flag button opens the goal form (one criterion per line,
   or split by `;`, and the round limit). Start stores the goal
   (POST .../goal {action:"set"}) and sends the message the agent answers
   with, as the TUI sends it; the agent then runs that turn as goal rounds.

   Card, above the composer: the status, criteria met of all, the round of
   the limit, each criterion's mark (met / open / blocked) with the judge's
   reason, and Pause / Resume / Clear. A running goal pauses or clears after
   its current round, as /goal pause does. No goal, no card. An agent
   without the routes never stores one, so neither ever shows. */

/* The newest goal per chat (session id), from the stream or the store. */
const GOALS = new Map();
/* Chats whose card the person folded. */
const GOAL_FOLD = new Set();
/* Chats where pause / clear was asked of a running goal: it lands after the round. */
const GOAL_PENDING = new Map();
/* The composer's goal form. */
const GOAL_FORM = {open: false, text: '', rounds: '', busy: false, error: ''};

const GOAL_STATUSES = new Set(['active', 'paused', 'blocked', 'complete', 'budget_limited']);
const GOAL_MARKS = new Set(['pending', 'met', 'not_met', 'blocked']);
/* The agent's bounds (src/agent/goal/goal-types.ts). */
const GOAL_MAX_CRITERIA = 20;
const GOAL_MAX_ROUNDS = 50;

/** A goal as the agent sent or stored it, checked; null when there is none or it is unusable. */
function goalRead(raw) {
  if (!raw || typeof raw !== 'object' || !GOAL_STATUSES.has(raw.status) || !Array.isArray(raw.criteria)) return null;
  const criteria = [];
  for (const c of raw.criteria) {
    if (!c || typeof c !== 'object' || typeof c.text !== 'string' || !GOAL_MARKS.has(c.mark)) continue;
    criteria.push({text: c.text, mark: c.mark, reason: typeof c.reason === 'string' ? c.reason : ''});
  }
  if (!criteria.length) return null;
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    status: raw.status,
    criteria,
    maxRounds: num(raw.maxRounds, 10),
    roundsUsed: num(raw.roundsUsed, 0),
    statusReason: typeof raw.statusReason === 'string' ? raw.statusReason : '',
    updatedAt: num(raw.updatedAt, 0),
  };
}

function goalSame(a, b) {
  if (!a || !b) return a === b;
  return a.status === b.status && a.roundsUsed === b.roundsUsed && a.maxRounds === b.maxRounds
    && a.statusReason === b.statusReason && a.criteria.length === b.criteria.length
    && a.criteria.every((c, i) => c.text === b.criteria[i].text && c.mark === b.criteria[i].mark && c.reason === b.criteria[i].reason);
}

/** A goal for chat `sid` (a frame, an action's answer; null = none). Answers whether the card changed. */
function goalSet(sid, raw) {
  if (!sid) return false;
  const next = goalRead(raw);
  const prev = GOALS.get(sid) || null;
  // A stopped goal has done what was asked of it.
  if (!next || next.status !== 'active') GOAL_PENDING.delete(sid);
  if (goalSame(prev, next)) return false;
  if (next) GOALS.set(sid, next); else GOALS.delete(sid);
  return true;
}

/**
 * The goal the store holds for chat `sid`, read when the chat is opened.
 * While its turn runs the store is behind the stream, so a goal the stream
 * brought is kept unless the stored one is newer (plan-bar.js, the same way).
 */
function goalRestore(sid, raw, live) {
  if (!sid) return false;
  const stored = goalRead(raw);
  const known = GOALS.get(sid) || null;
  if (live && known && !(stored && stored.updatedAt > known.updatedAt)) return false;
  return goalSet(sid, raw);
}

function goalOf(sid) { return (sid && GOALS.get(sid)) || null; }

/** The TUI's words for a status (src/agent/goal/goal-state.ts statusLabel), capitalised. */
function goalStatusLabel(status) {
  const word = status === 'budget_limited' ? 'round limit reached' : String(status || '');
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** met / open / blocked: the judge's `not_met` and a not yet judged item are both open. */
function goalMarkWord(mark) {
  return mark === 'met' ? 'met' : mark === 'blocked' ? 'blocked' : 'open';
}

/** "2/5 met · round 3/10", the TUI's goal line in the card's words. */
function goalSummary(goal) {
  const met = goal.criteria.filter((c) => c.mark === 'met').length;
  return met + '/' + goal.criteria.length + ' met · round ' + goal.roundsUsed + '/' + goal.maxRounds;
}

/** The buttons a goal offers, as /goal pause, resume and clear allow them. */
function goalActions(goal, busy) {
  if (!goal) return [];
  const out = [];
  if (goal.status === 'active') out.push('pause');
  // Resume starts a turn: not while one runs, never for a finished goal.
  else if (goal.status !== 'complete') out.push(busy ? 'resume-wait' : 'resume');
  out.push('clear');
  return out;
}

/**
 * The form's text as criteria: one per line, or split by `;` on one line,
 * list markers dropped (the TUI's splitGoalItems). `check:` items are the
 * TUI's shell checks; the window cannot set those, so they are refused.
 */
function goalParseForm(text, rounds) {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items = (lines.length > 1 ? lines : raw.split(';'))
    .map((it) => it.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
  if (items.some((it) => /^check\s*:/i.test(it))) {
    return {ok: false, error: 'Shell checks are set in the terminal (/goal check add). Leave them out here.'};
  }
  const criteria = items.filter((it, i) => items.indexOf(it) === i);
  if (!criteria.length) return {ok: false, error: 'Write at least one criterion: what must be true when the goal is done.'};
  if (criteria.length > GOAL_MAX_CRITERIA) return {ok: false, error: 'At most ' + GOAL_MAX_CRITERIA + ' criteria.'};
  const r = String(rounds == null ? '' : rounds).trim();
  if (!r) return {ok: true, criteria};
  if (!/^\d+$/.test(r) || +r < 1 || +r > GOAL_MAX_ROUNDS) return {ok: false, error: 'Rounds: a whole number from 1 to ' + GOAL_MAX_ROUNDS + '.'};
  return {ok: true, criteria, maxRounds: +r};
}

const GOAL_BTN = {
  pause: ['pause', 'Pause', 'Stop after the current round'],
  resume: ['play', 'Resume', 'Work on the open items again'],
  'resume-wait': ['play', 'Resume', 'Wait for the reply to finish'],
  clear: ['x', 'Clear', 'Remove the goal from this chat'],
};

/** The card for chat `sid`, or '' when it has no goal. deps: {esc, ic, busy}. */
function goalCardHTML(sid, deps) {
  const goal = goalOf(sid);
  if (!goal) return '';
  const {esc, ic} = deps;
  const folded = GOAL_FOLD.has(sid);
  const pending = GOAL_PENDING.get(sid);
  const head = '<button class="goalchip is-' + goal.status.replace('_', '-') + '" data-goal-fold="' + esc(sid) + '"'
    + ' aria-expanded="' + !folded + '" title="' + (folded ? 'Show the goal' : 'Fold the goal') + '">'
    + ic(folded ? 'chevR' : 'chevD') + ic('flag')
    + '<span class="gl-l">Goal · ' + esc(goalStatusLabel(goal.status)) + '</span>'
    + '<span class="gl-sum tnum">' + esc(goalSummary(goal)) + '</span></button>';
  const buttons = goalActions(goal, !!deps.busy).map((a) => {
    const [icon, word, tip] = GOAL_BTN[a];
    const off = a === 'resume-wait' || !!pending;
    return '<button class="btn btn-g xs" data-goal-act="' + (a === 'resume-wait' ? 'resume' : a) + '"' + (off ? ' disabled' : '')
      + ' title="' + esc(tip) + '">' + ic(icon) + esc(word) + '</button>';
  }).join('');
  const note = pending ? '<span class="gl-note">' + (pending === 'pause' ? 'Pausing after this round' : 'Clearing after this round') + '</span>' : '';
  const top = '<div class="gl-top">' + head + '<span class="gl-grow"></span>' + note + buttons + '</div>';
  if (folded) return '<div class="goalcard is-folded">' + top + '</div>';
  const reason = goal.statusReason && goal.status !== 'active'
    ? '<p class="gl-why">' + esc(goal.statusReason) + '</p>' : '';
  const list = goal.criteria.map((c) => {
    const word = goalMarkWord(c.mark);
    return '<li class="gl-it gl-' + word + '">'
      + '<span class="gl-mk" aria-hidden="true">' + (word === 'met' ? ic('check') : word === 'blocked' ? ic('alert') : '<span class="gl-ring"></span>') + '</span>'
      + '<span class="gl-tx">' + esc(c.text) + (c.reason ? '<span class="gl-rs">' + esc(c.reason) + '</span>' : '') + '</span>'
      + '<span class="gl-sr"> (' + word + ')</span></li>';
  }).join('');
  return '<div class="goalcard">' + top + reason + '<ol class="gl-list" aria-label="Goal criteria">' + list + '</ol></div>';
}

/** The composer's goal form, or '' while it is closed. deps: {esc, ic}. */
function goalFormHTML(deps) {
  if (!GOAL_FORM.open) return '';
  const {esc, ic} = deps;
  return '<div class="goalform" role="group" aria-label="Set a goal">'
    + '<div class="gf-top">' + ic('flag') + '<span class="gf-l">Goal</span>'
    + '<span class="gf-hint">The agent works in rounds until every item is met, or it needs you.</span></div>'
    + '<textarea id="goal-criteria" rows="3" placeholder="One criterion per line, e.g.&#10;the tests pass&#10;the README explains the new flag">'
    + esc(GOAL_FORM.text) + '</textarea>'
    + '<div class="gf-row"><label class="gf-rounds">Rounds <input id="goal-rounds" inputmode="numeric" placeholder="10" value="' + esc(GOAL_FORM.rounds) + '"></label>'
    + (GOAL_FORM.error ? '<span class="gf-err">' + esc(GOAL_FORM.error) + '</span>' : '')
    + '<span class="gl-grow"></span>'
    + '<button class="btn btn-g xs" data-goal-form="cancel">Cancel</button>'
    + '<button class="btn xs" data-goal-form="start"' + (GOAL_FORM.busy ? ' disabled' : '') + '>Start goal</button></div></div>';
}

/** The composer's flag button. */
function goalButtonHTML(deps) {
  return '<button class="attbtn goalbtn' + (GOAL_FORM.open ? ' is-open' : '') + '" data-goal-open="1"'
    + ' title="Set a goal: the agent keeps working until its criteria are met" aria-label="Set a goal">' + deps.ic('flag') + '</button>';
}

if (typeof module !== 'undefined') {
  module.exports = {GOALS, GOAL_FOLD, GOAL_PENDING, GOAL_FORM, goalRead, goalSame, goalSet, goalRestore, goalOf, goalStatusLabel, goalMarkWord, goalSummary, goalActions, goalParseForm, goalCardHTML, goalFormHTML, goalButtonHTML};
}
