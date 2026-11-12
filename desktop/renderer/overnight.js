/* ---------------- Run overnight (ATO-1113, desktop half) ----------------
   Loaded before renderer.js. Self-contained: it draws only into its own
   #overnight layer (index.html), listens for its own `data-ovn` clicks, and
   reads renderer.js globals (BR, WORKSPACE, selBackend, ic, esc, toast,
   openSession) only at run time, guarded, so the Node tests can load it.

   The composer's "+" menu has a "Run overnight" row (attachments.js). It
   opens a small dialog: the task, the folder (default: the chat's folder),
   a money budget (default `agent.task.maxCostUsd`, empty = no cap; hidden
   for local models, which cost $0), a time limit in hours (default 8) and
   "Send the report to Telegram when it finishes" (only when Telegram is paired).
   Start sends it to main (`overnight:start`), which creates a durable task
   on the agent in that folder (overnight-ipc.ts → POST /api/tasks).

   With a remote agent the folder row has no picker: the run works in that
   agent's own folder, which main reads from the agent.

   The run then shows as a small card in the corner: elapsed time, spend so
   far when the agent reports it (`spentUsd`), and Stop (the Tasks tab's own
   cancel route). The card keeps the runs this window started in
   localStorage, so it survives a reload. The task also appears in the
   sidebar's Tasks list like any other task.

   The time limit is sent to the agent as `maxDurationMs`. An agent that does
   not echo it back (one from before the budget fields) is stopped by this
   window when the time is up, while the app is open. */

const OVN_DEFAULT_HOURS = 8;
const OVN_POLL_MS = 15000;
const OVN_STORE_KEY = 'atag.overnightRuns';
const OVN_TERMINAL = ['completed', 'failed', 'blocked', 'cancelled'];

const OVN = {
  open: false, busy: false, error: null, local: false, fusion: false, tgPaired: false, remote: false,
  form: {message: '', folder: '', budget: '', hours: String(OVN_DEFAULT_HOURS), notify: false},
  runs: [],   // {id, title, sessionId, startedAt, limitMs, budget, task, stopping}
  timer: null,
};

/* ---------- pure helpers (test/overnight.test.mjs) ---------- */

/** "45m", "2h 05m": elapsed time in the card. */
function ovnElapsed(ms) {
  const m = Math.max(0, Math.floor((Number(ms) || 0) / 60000));
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60), r = m % 60;
  return h + 'h ' + (r < 10 ? '0' : '') + r + 'm';
}
/** "$1.24 of $5.00", "$1.24", or '' while the agent reports no spend. */
function ovnSpendLine(spent, budget) {
  if (typeof spent !== 'number' || !Number.isFinite(spent)) return '';
  const s = '$' + spent.toFixed(2);
  return typeof budget === 'number' && budget > 0 ? s + ' of $' + budget.toFixed(2) : s;
}
/** The budget field's text as dollars, null for no cap, NaN for nonsense. */
function ovnBudgetValue(text) {
  const t = String(text == null ? '' : text).replace(/^\s*\$/, '').trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return n > 0 ? n : null;
}
/** Local models cost nothing, so the dialog hides the budget for them. */
function ovnIsLocal(backend) { return backend === 'local' || backend === 'custom'; }
/** Paired: the agent has a Telegram owner and the channel is not turned off. */
function ovnTelegramPaired(cfg) {
  return !!cfg && typeof cfg === 'object' && cfg.ownerUserId !== undefined && cfg.ownerUserId !== null && cfg.enabled !== false;
}
function ovnFinished(task) { return !!task && OVN_TERMINAL.includes(task.status); }
/** The window stops the run itself only when the agent did not take the limit. */
function ovnOverTime(run, task, now) {
  if (!run || !task || ovnFinished(task)) return false;
  if (typeof task.maxDurationMs === 'number' && task.maxDurationMs > 0) return false;
  // The window's own start: the task's startedAt is reset on every retry
  // and every requeue after a restart, which would restart the limit.
  return now - run.startedAt > run.limitMs;
}
/** How a run that the agent cut short reads on the card (the agent's TaskStopCause). */
const OVN_STOP_WORDS = {
  time_ceiling: 'Stopped at the time limit',
  cost_ceiling: 'Stopped at the budget',
  step_ceiling: 'Stopped at the step limit',
  no_progress: 'Stopped, no progress',
  credit_exhausted: 'Stopped, out of credit',
};
/** A capped run ends as `completed` too, so `stopCause` tells it apart. An agent that does not send it reads as Done. */
function ovnFinishedWord(t) {
  if (t.status === 'completed') {
    const cause = typeof t.stopCause === 'string' ? t.stopCause : '';
    if (!cause) return 'Done';
    return Object.prototype.hasOwnProperty.call(OVN_STOP_WORDS, cause) ? OVN_STOP_WORDS[cause] : 'Stopped early';
  }
  return t.status === 'cancelled' ? 'Stopped' : t.status === 'blocked' ? 'Stopped, needs you' : 'Failed';
}
/** One line under a run's title. */
function ovnStatusLine(run, now) {
  const t = run.task || {};
  const start = run.startedAt;
  const spentRaw = typeof t.spentUsd === 'number' ? t.spentUsd : null;
  const spend = ovnSpendLine(spentRaw, run.budget);
  if (ovnFinished(t)) {
    const end = typeof t.completedAt === 'number' ? t.completedAt : now;
    return ovnFinishedWord(t) + ' after ' + ovnElapsed(end - start) + (spend ? ' · ' + spend : '');
  }
  if (run.stopping) return 'Stopping…';
  if (t.status === 'pending' || !t.status) return 'Starting…';
  return 'Running · ' + ovnElapsed(now - start) + ' of ' + ovnElapsed(run.limitMs) + (spend ? ' · ' + spend : '');
}

/** In Fusion the ceiling counts only the planning model: its workers' spend does not reach it. */
function ovnBudgetHelp(fusion) {
  return fusion
    ? 'The run stops when the planning model has spent this much, in dollars. Spend by Fusion workers is not counted. Leave empty for no cap.'
    : 'The run stops when it has spent this much, in dollars. Leave empty for no cap.';
}

function ovnDialogHTML(st, h) {
  const esc = h.esc;
  const f = st.form;
  const budget = st.local
    ? '<p class="tk-help" data-ovn-free>Local models cost $0, so this run has no money cap.</p>'
    : '<label class="tk-field"><span class="tk-lbl">Budget</span>'
      + '<input class="tk-inp" data-ovn-field="budget" inputmode="decimal" placeholder="No cap" value="' + esc(f.budget) + '">'
      + '<span class="tk-help">' + ovnBudgetHelp(st.fusion) + '</span></label>';
  const tg = st.tgPaired
    ? '<button class="ovn-row" type="button" data-ovn="notify" role="switch" aria-checked="' + (f.notify ? 'true' : 'false') + '">'
      + '<span>Send the report to Telegram when it finishes</span><span class="tk-switch' + (f.notify ? ' on' : '') + '" aria-hidden="true"></span></button>'
    : '<div class="ovn-row is-off"><span>Send the report to Telegram when it finishes</span><span class="tk-switch" aria-hidden="true"></span></div>'
      + '<p class="tk-help">Pair Telegram in Settings to get the report there.</p>';
  return '<div class="sheetwrap ovn-wrap" data-ovn="backdrop"><div class="sheet ovn-sheet" role="dialog" aria-modal="true" aria-label="Run overnight">'
    + '<div class="sheethead"><span class="ttl">Run overnight</span>'
      + '<button class="iconbtn" type="button" data-ovn="close" aria-label="Close" title="Close">' + h.ic('x') + '</button></div>'
    + '<div class="ovn-body">'
      + '<p class="tk-help">The agent works on this on its own until it is done or hits a limit. Close the chat if you like; keep the app open.</p>'
      + '<label class="tk-field"><span class="tk-lbl">Task</span>'
        + '<textarea class="tk-inp" data-ovn-field="message" rows="4" placeholder="Fix the failing tests and write down what you changed">' + esc(f.message) + '</textarea></label>'
      + '<div class="tk-field"><span class="tk-lbl">Folder</span>'
        + (st.remote
          ? '<div class="ovn-folder"><span class="ovn-path">The agent\'s own folder on the other computer</span></div></div>'
          : '<div class="ovn-folder"><span class="ovn-path" title="' + esc(f.folder) + '">' + esc(f.folder || 'No folder chosen') + '</span>'
            + '<button class="btn sm" type="button" data-ovn="pick">Change</button></div></div>')
      + budget
      + '<label class="tk-field"><span class="tk-lbl">Time limit, hours</span>'
        + '<input class="tk-inp ovn-hours" data-ovn-field="hours" type="number" min="0.5" max="24" step="0.5" value="' + esc(f.hours) + '"></label>'
      + tg
      + (st.error ? '<p class="tk-help tk-help--err" role="alert">' + esc(st.error) + '</p>' : '')
    + '</div>'
    + '<div class="sheetfoot"><button class="btn sm" type="button" data-ovn="close">Cancel</button>'
      + '<button class="btn btn-p sm" type="button" data-ovn="start"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? 'Starting…' : 'Start') + '</button></div>'
  + '</div></div>';
}

function ovnRunsHTML(runs, now, h) {
  if (!runs.length) return '';
  const esc = h.esc;
  return '<div class="ovn-card" role="region" aria-label="Overnight runs">'
    + runs.map((r) => {
      const done = ovnFinished(r.task);
      return '<div class="ovn-run" data-ovn-run="' + esc(r.id) + '">'
        + '<span class="ovn-ic">' + h.ic('moon') + '</span>'
        + '<span class="ovn-main"><span class="ovn-title" title="' + esc(r.title) + '">' + esc(r.title) + '</span>'
          + '<span class="ovn-meta">' + esc(ovnStatusLine(r, now)) + '</span></span>'
        + (r.sessionId ? '<button class="btn xs" type="button" data-ovn="chat:' + esc(r.id) + '">Open</button>' : '')
        + (done
          ? '<button class="iconbtn sm" type="button" data-ovn="dismiss:' + esc(r.id) + '" aria-label="Dismiss" title="Dismiss">' + h.ic('x') + '</button>'
          : '<button class="btn xs" type="button" data-ovn="stop:' + esc(r.id) + '"' + (r.stopping ? ' disabled' : '') + '>Stop</button>')
        + '</div>';
    }).join('')
    + '</div>';
}

/* ---------- the window ---------- */

function ovnHelpers() {
  return {
    esc: typeof esc === 'function' ? esc : (s) => String(s),
    ic: typeof ic === 'function' ? ic : () => '',
  };
}
function ovnBridge() { return typeof BR !== 'undefined' && BR && BR.overnightStart ? BR : null; }

function ovnLoad() {
  try {
    const raw = JSON.parse(localStorage.getItem(OVN_STORE_KEY) || '[]');
    OVN.runs = Array.isArray(raw) ? raw.filter((r) => r && typeof r.id === 'string') : [];
  } catch (e) { OVN.runs = []; }
}
function ovnSave() {
  try {
    localStorage.setItem(OVN_STORE_KEY, JSON.stringify(OVN.runs.map((r) => ({
      id: r.id, title: r.title, sessionId: r.sessionId || null, startedAt: r.startedAt, limitMs: r.limitMs, budget: r.budget, task: r.task || null,
    }))));
  } catch (e) { /* storage full or off: the card still shows this session */ }
}

function ovnPaint() {
  const host = typeof document !== 'undefined' && document.getElementById('overnight');
  if (!host) return;
  const h = ovnHelpers();
  host.innerHTML = (OVN.open ? ovnDialogHTML(OVN, h) : '') + ovnRunsHTML(OVN.runs, Date.now(), h);
}
function ovnPaintRuns() {
  const host = typeof document !== 'undefined' && document.getElementById('overnight');
  if (!host) return;
  const card = host.querySelector('.ovn-card');
  const html = ovnRunsHTML(OVN.runs, Date.now(), ovnHelpers());
  if (card && html) { const tmp = document.createElement('div'); tmp.innerHTML = html; card.replaceWith(tmp.firstChild); }
  else if (card) card.remove();
  else if (html) host.insertAdjacentHTML('beforeend', html);
}

async function ovnOpen() {
  const br = ovnBridge();
  if (!br) { if (typeof toast === 'function') toast('Run overnight needs a newer app build', '', 'bad'); return; }
  OVN.open = true; OVN.busy = false; OVN.error = null;
  OVN.form = {message: '', folder: typeof WORKSPACE === 'string' ? WORKSPACE : '', budget: '', hours: String(OVN_DEFAULT_HOURS), notify: false};
  const backend = typeof selBackend === 'function' ? selBackend() : null;
  OVN.local = ovnIsLocal(backend);
  OVN.fusion = backend === 'fusion';
  OVN.tgPaired = false;
  OVN.remote = false;
  ovnPaint();
  ovnFocus();
  // The defaults the agent knows: the budget from config, whether Telegram is paired.
  const [budget, tg, remote] = await Promise.all([
    br.configGetKey ? br.configGetKey('agent.task.maxCostUsd').catch(() => null) : null,
    br.configGetKey ? br.configGetKey('telegram').catch(() => null) : null,
    br.remoteGet ? br.remoteGet().catch(() => null) : null,
  ]);
  if (!OVN.open) return;
  OVN.remote = !!(remote && remote.connected);
  if (budget && budget.ok && typeof budget.value === 'number' && budget.value > 0 && !OVN.form.budget) OVN.form.budget = String(budget.value);
  OVN.tgPaired = !!(tg && tg.ok && ovnTelegramPaired(tg.value));
  OVN.form.notify = OVN.tgPaired;
  ovnPaintKeepFocus();
}
function ovnClose() { OVN.open = false; OVN.error = null; ovnPaint(); }
function ovnFocus() {
  const el = document.querySelector('#overnight [data-ovn-field="message"]');
  if (el) el.focus();
}
/** Repaint the dialog without losing the caret in the field being typed in. */
function ovnPaintKeepFocus() {
  const a = document.activeElement;
  const field = a && a.getAttribute ? a.getAttribute('data-ovn-field') : null;
  const sel = field && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
  ovnPaint();
  if (!field) return;
  const el = document.querySelector('#overnight [data-ovn-field="' + field + '"]');
  if (!el) return;
  el.focus();
  if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* number inputs */ }
}

async function ovnPick() {
  const br = ovnBridge();
  if (!br || OVN.remote) return;
  const dir = await br.overnightPickFolder(OVN.form.folder || undefined);
  if (dir) { OVN.form.folder = dir; ovnPaintKeepFocus(); }
}

async function ovnStart() {
  const br = ovnBridge();
  if (!br || OVN.busy) return;
  const f = OVN.form;
  const budget = OVN.local ? null : ovnBudgetValue(f.budget);
  if (Number.isNaN(budget)) { OVN.error = 'The budget must be a number of dollars, or empty for no cap.'; ovnPaintKeepFocus(); return; }
  const hours = Number(f.hours);
  OVN.busy = true; OVN.error = null; ovnPaintKeepFocus();
  const res = await br.overnightStart({message: f.message, folder: f.folder, maxCostUsd: budget, hours, notifyTelegram: OVN.tgPaired && f.notify})
    .catch((e) => ({ok: false, error: e && e.message ? e.message : String(e)}));
  OVN.busy = false;
  if (!res || !res.ok) { OVN.error = (res && res.error) || 'Could not start the run.'; ovnPaintKeepFocus(); return; }
  const task = res.task || {};
  const title = f.message.trim().replace(/\s+/g, ' ');
  OVN.runs.unshift({id: task.id, title: title.length > 80 ? title.slice(0, 79) + '…' : title, sessionId: task.sessionId || null,
    startedAt: Date.now(), limitMs: Math.round(hours * 3600000), budget, task});
  ovnSave();
  OVN.open = false;
  ovnPaint();
  ovnSchedule();
  if (typeof toast === 'function') toast('Overnight run started', 'It shows in the corner and in Tasks.');
}

async function ovnStop(id) {
  const br = ovnBridge();
  const run = OVN.runs.find((r) => r.id === id);
  if (!br || !run || run.stopping) return;
  run.stopping = true; ovnPaintRuns();
  const res = await br.cancelTask(id).catch(() => null);
  run.stopping = false;
  if (res && res.ok && res.data) run.task = res.data;
  else if (typeof toast === 'function') toast('Could not stop the run', (res && res.error) || '', 'bad');
  ovnSave(); ovnPaintRuns();
}

/** Every 15 s: each unfinished run's record, and the window's own time limit. */
async function ovnPoll() {
  const br = ovnBridge();
  if (!br || !br.task) return;
  const now = Date.now();
  for (const run of OVN.runs) {
    if (ovnFinished(run.task)) continue;
    const res = await br.task(run.id).catch(() => null);
    if (res && res.ok && res.data) run.task = res.data;
    if (ovnOverTime(run, run.task, now) && !run.stopping) await ovnStop(run.id);
  }
  ovnSave();
  ovnPaintRuns();
}
function ovnSchedule() {
  const live = OVN.runs.some((r) => !ovnFinished(r.task));
  if (live && !OVN.timer) {
    OVN.timer = setInterval(() => {
      void ovnPoll().then(() => {
        if (!OVN.runs.some((r) => !ovnFinished(r.task))) { clearInterval(OVN.timer); OVN.timer = null; }
      });
    }, OVN_POLL_MS);
    void ovnPoll();
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const el = t.closest('[data-ovn]');
    if (!el) return;
    const act = el.getAttribute('data-ovn');
    if (act === 'backdrop') { if (t === el) { e.preventDefault(); ovnClose(); } return; }
    e.preventDefault();
    if (act === 'open') { if (typeof ATT !== 'undefined' && ATT.menu && typeof attRepaint === 'function') { ATT.menu = false; attRepaint(); } void ovnOpen(); }
    else if (act === 'close') ovnClose();
    else if (act === 'pick') void ovnPick();
    else if (act === 'start') void ovnStart();
    else if (act === 'notify') { OVN.form.notify = !OVN.form.notify; ovnPaintKeepFocus(); }
    else if (act.startsWith('stop:')) void ovnStop(act.slice(5));
    else if (act.startsWith('chat:')) {
      const run = OVN.runs.find((r) => r.id === act.slice(5));
      if (run && run.sessionId && typeof openSession === 'function') void openSession(run.sessionId);
    } else if (act.startsWith('dismiss:')) {
      OVN.runs = OVN.runs.filter((r) => r.id !== act.slice(8)); ovnSave(); ovnPaintRuns();
    }
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    const field = t && t.getAttribute ? t.getAttribute('data-ovn-field') : null;
    if (field && field in OVN.form) OVN.form[field] = t.value;
  });
  document.addEventListener('keydown', (e) => {
    if (!OVN.open) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); ovnClose(); return; }
    // ⌘↩ / Ctrl+↩ starts, as it sends in the composer.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopImmediatePropagation(); void ovnStart(); }
  }, true);
  window.addEventListener('DOMContentLoaded', () => { ovnLoad(); ovnPaint(); ovnSchedule(); });
}

if (typeof module !== 'undefined') {
  module.exports = {OVN_DEFAULT_HOURS, ovnElapsed, ovnSpendLine, ovnBudgetValue, ovnIsLocal, ovnTelegramPaired, ovnFinished,
    ovnOverTime, ovnStatusLine, ovnDialogHTML, ovnRunsHTML};
}
