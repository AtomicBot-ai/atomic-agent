/* ---------------- ATO-486: the live plan above the composer ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/plan-bar.test.mjs).

   The agent keeps a checklist for multi-step work (`plan.update`): it sends
   the WHOLE plan each time, every step `pending`, `in_progress` or `done`.
   Each change reaches the window as the named stream frame `plan_updated`
   ({session_id, plan:{items, updatedAt}}); `items: []` means the plan was
   cleared. The agent stores the newest plan on the session (`plan` in
   GET /api/sessions/{id}), so a reopened chat draws it again.

   The bar sits above the composer: "Plan 3/7" and the step in progress,
   with the checklist under it (ticks on finished steps). A click folds it
   to the "Plan 3/7" chip and back. A finished plan starts folded. No plan,
   no bar. An agent without the tool never sends the frame and never stores
   the field, so the bar simply never appears. */

/* The newest plan per chat (session id), from the stream or the store. */
const PLANS = new Map();
/* Chats whose bar the person folded (or unfolded, for a finished plan). */
const PLAN_FOLD = new Map();
/* Rows the open bar lists before counting the rest. */
const PLAN_BAR_MAX_ROWS = 8;

const PLAN_STATUSES = new Set(['pending', 'in_progress', 'done']);

/** A plan as the agent sent or stored it, checked; null when unusable or empty. */
function planRead(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return null;
  const items = [];
  for (const it of raw.items) {
    if (!it || typeof it !== 'object') continue;
    const step = typeof it.step === 'string' ? it.step.replace(/\s+/g, ' ').trim() : '';
    if (!step || !PLAN_STATUSES.has(it.status)) continue;
    items.push({step, status: it.status});
  }
  if (!items.length) return null;
  return {items, updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0};
}

/** Same checklist (the time ignored). */
function planSame(a, b) {
  const x = (a && a.items) || [];
  const y = (b && b.items) || [];
  return x.length === y.length && x.every((it, i) => it.step === y[i].step && it.status === y[i].status);
}

/** A `plan_updated` frame for chat `sid`. Answers whether what the bar draws changed. */
function planSet(sid, raw) {
  if (!sid) return false;
  const next = planRead(raw);
  const prev = PLANS.get(sid) || null;
  if (planSame(prev, next)) { if (next) PLANS.set(sid, next); return false; }
  if (next) PLANS.set(sid, next); else PLANS.delete(sid);
  return true;
}

/**
 * The plan the store holds for chat `sid`, read when the chat is opened.
 * While a turn of that chat is running the store is behind the stream (the
 * agent saves a session when its turn ends), so a plan the stream already
 * brought is kept unless the stored one is newer.
 */
function planRestore(sid, raw, live) {
  if (!sid) return false;
  const stored = planRead(raw);
  const known = PLANS.get(sid) || null;
  if (live && known && !(stored && stored.updatedAt > known.updatedAt)) return false;
  return planSet(sid, stored);
}

function planOf(sid) { return (sid && PLANS.get(sid)) || null; }

/** done / total and the step in progress (or the first one not done). */
function planProgress(plan) {
  const items = (plan && plan.items) || [];
  const done = items.filter((it) => it.status === 'done').length;
  const cur = items.find((it) => it.status === 'in_progress') || items.find((it) => it.status !== 'done');
  return {done, total: items.length, current: cur ? cur.step : null};
}

/** Whether chat `sid`'s bar is folded to its chip. A finished plan starts folded. */
function planFolded(sid) {
  const plan = planOf(sid);
  if (PLAN_FOLD.has(sid)) return PLAN_FOLD.get(sid);
  const {done, total} = planProgress(plan);
  return total > 0 && done === total;
}

function planToggle(sid) {
  if (!sid) return;
  PLAN_FOLD.set(sid, !planFolded(sid));
}

/** The chip's words: "Plan 3/7". */
function planChipLabel(plan) {
  const {done, total} = planProgress(plan);
  return 'Plan ' + done + '/' + total;
}

/** The rows the open bar lists: the step in progress in view, one finished step above it. */
function planBarRows(plan, max) {
  const items = plan.items;
  const limit = Math.max(1, max || PLAN_BAR_MAX_ROWS);
  if (items.length <= limit) return {rows: items.map((it, i) => ({it, i})), above: 0, below: 0};
  const active = items.findIndex((it) => it.status === 'in_progress');
  const open = items.findIndex((it) => it.status !== 'done');
  const anchor = active !== -1 ? active : open !== -1 ? open : items.length - 1;
  const start = Math.max(0, Math.min(anchor - 1, items.length - limit));
  const end = start + limit;
  return {rows: items.slice(start, end).map((it, k) => ({it, i: start + k})), above: start, below: items.length - end};
}

/**
 * The bar for chat `sid`, or '' when it has no plan. deps: {esc, ic}.
 * Folded: one chip. Open: the chip's line with the step in progress, and the
 * checklist under it.
 */
function planBarHTML(sid, deps) {
  const plan = planOf(sid);
  if (!plan) return '';
  const {esc, ic} = deps;
  const folded = planFolded(sid);
  const {done, total, current} = planProgress(plan);
  const finished = done === total;
  const head = '<button class="planchip' + (finished ? ' is-done' : '') + '" data-plan-toggle="' + esc(sid) + '"'
    + ' aria-expanded="' + !folded + '" title="' + (folded ? 'Show the plan' : 'Fold the plan') + '">'
    + ic(folded ? 'chevR' : 'chevD')
    + '<span class="pl-l tnum">' + esc(planChipLabel(plan)) + '</span>'
    + (current && !finished ? '<span class="pl-sep" aria-hidden="true">·</span><span class="pl-cur">' + esc(current) + '</span>' : '')
    + '</button>';
  if (folded) return '<div class="planbar is-folded">' + head + '</div>';
  const {rows, above, below} = planBarRows(plan);
  const list = rows.map(({it}) => '<li class="pl-it pl-' + it.status.replace('_', '-') + '">'
      + '<span class="pl-mk" aria-hidden="true">' + (it.status === 'done' ? ic('check') : it.status === 'in_progress' ? '<span class="pl-dot"></span>' : '<span class="pl-ring"></span>') + '</span>'
      + '<span class="pl-tx">' + esc(it.step) + '</span>'
      + '<span class="pl-sr">' + (it.status === 'done' ? ' (done)' : it.status === 'in_progress' ? ' (in progress)' : '') + '</span>'
    + '</li>').join('');
  return '<div class="planbar">' + head
    + '<ol class="pl-list" aria-label="Plan">'
      + (above ? '<li class="pl-more">' + above + ' earlier step' + (above === 1 ? '' : 's') + '</li>' : '')
      + list
      + (below ? '<li class="pl-more">' + below + ' more</li>' : '')
    + '</ol></div>';
}

if (typeof module !== 'undefined') module.exports = {PLANS, PLAN_FOLD, PLAN_BAR_MAX_ROWS, planRead, planSame, planSet, planRestore, planOf, planProgress, planFolded, planToggle, planChipLabel, planBarRows, planBarHTML};
