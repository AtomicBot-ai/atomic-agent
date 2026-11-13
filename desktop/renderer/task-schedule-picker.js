/* ATO-590 — the Tasks tab's schedule management, beside renderer.js:

   - a visual time picker for the create form: how often (hourly, daily,
     weekdays, weekly, monthly), the hour and minute as buttons, the days
     of the week as toggles. It writes the cron expression the form
     already sends (`atag task create --cron`); the raw Cron field stays
     under it for anything the buttons cannot say.
   - the schedule in words ("every weekday at 9:00"), our own small code:
     no cronstrue. A cron the buttons cannot build reads as null and the
     window shows the expression as before.
   - Pause / Resume and the task's past runs on its page, through
     main/task-controls-ipc.ts. An agent from before those routes answers
     "unsupported" and both stay hidden.

   Plain script loaded from index.html; the pure part is exported for the
   unit suite at the bottom. renderer.js owns TK and calls in here. */

const TSP_FREQS = ['hourly', 'daily', 'weekdays', 'weekly', 'monthly'];
const TSP_FREQ_LABEL = {hourly: 'Every hour', daily: 'Every day', weekdays: 'Weekdays', weekly: 'Weekly', monthly: 'Monthly'};
const TSP_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/* Monday first, as a person reads a week; cron counts Sunday as 0. */
const TSP_WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const TSP_MINUTES = [0, 15, 30, 45];

function tspDefault() {
  return {freq: 'daily', hour: 9, minute: 0, days: [1], dom: 1};
}

function tspInt(text, min, max) {
  if (!/^\d{1,2}$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

/* The days field of a cron the picker can show: `*`, `1-5`, or a list of
   single days (7 is Sunday too). Returns the sorted days, or null. */
function tspDays(field) {
  if (field === '*') return [0, 1, 2, 3, 4, 5, 6];
  if (field === '1-5') return [1, 2, 3, 4, 5];
  const parts = field.split(',');
  const days = [];
  for (const p of parts) {
    const d = tspInt(p, 0, 7);
    if (d === null) return null;
    const day = d === 7 ? 0 : d;
    if (!days.includes(day)) days.push(day);
  }
  return days.sort((a, b) => a - b);
}

/** The picker's state as a 5-field cron expression. */
function pickerToCron(p) {
  const minute = Math.max(0, Math.min(59, Math.trunc(Number(p.minute) || 0)));
  const hour = Math.max(0, Math.min(23, Math.trunc(Number(p.hour) || 0)));
  if (p.freq === 'hourly') return minute + ' * * * *';
  if (p.freq === 'weekdays') return minute + ' ' + hour + ' * * 1-5';
  if (p.freq === 'weekly') {
    const days = (Array.isArray(p.days) && p.days.length ? p.days : [1]).slice().sort((a, b) => a - b);
    return minute + ' ' + hour + ' * * ' + days.join(',');
  }
  if (p.freq === 'monthly') {
    const dom = Math.max(1, Math.min(31, Math.trunc(Number(p.dom) || 1)));
    return minute + ' ' + hour + ' ' + dom + ' * *';
  }
  return minute + ' ' + hour + ' * * *';
}

/** A cron expression the picker can show, as its state; null for any other. */
function cronToPicker(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [mi, ho, dom, mon, dow] = f;
  const minute = tspInt(mi, 0, 59);
  if (minute === null || mon !== '*') return null;
  if (ho === '*') {
    return dom === '*' && dow === '*' ? {freq: 'hourly', hour: 9, minute, days: [1], dom: 1} : null;
  }
  const hour = tspInt(ho, 0, 23);
  if (hour === null) return null;
  if (dom !== '*') {
    const d = tspInt(dom, 1, 31);
    return d !== null && dow === '*' ? {freq: 'monthly', hour, minute, days: [1], dom: d} : null;
  }
  const days = tspDays(dow);
  if (!days) return null;
  if (days.length === 7) return {freq: 'daily', hour, minute, days: [1], dom: 1};
  if (days.join(',') === '1,2,3,4,5') return {freq: 'weekdays', hour, minute, days: [1, 2, 3, 4, 5], dom: 1};
  return {freq: 'weekly', hour, minute, days, dom: 1};
}

function tspClock(hour, minute) {
  return hour + ':' + String(minute).padStart(2, '0');
}

function tspList(words) {
  if (words.length <= 1) return words.join('');
  return words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
}

/** A cron expression in words ("every weekday at 9:00"); null when we cannot say it. */
function cronPhrase(expr) {
  const text = String(expr || '').trim();
  const p = cronToPicker(text);
  if (p) {
    const at = ' at ' + tspClock(p.hour, p.minute);
    if (p.freq === 'hourly') return p.minute === 0 ? 'every hour, on the hour' : 'every hour at :' + String(p.minute).padStart(2, '0');
    if (p.freq === 'daily') return 'every day' + at;
    if (p.freq === 'weekdays') return 'every weekday' + at;
    if (p.freq === 'weekly') {
      const ordered = TSP_WEEK_ORDER.filter((d) => p.days.includes(d));
      if (ordered.join(',') === '6,0') return 'every weekend day' + at;
      return 'every ' + tspList(ordered.map((d) => TSP_DAY_NAMES[d])) + at;
    }
    return 'on day ' + p.dom + ' of every month' + at;
  }
  const f = text.split(/\s+/);
  if (f.length !== 5) return null;
  if (f.join(' ') === '* * * * *') return 'every minute';
  const rest = f.slice(1).join(' ');
  const everyMin = /^\*\/(\d{1,2})$/.exec(f[0]);
  if (everyMin && rest === '* * * *') return Number(everyMin[1]) === 1 ? 'every minute' : 'every ' + Number(everyMin[1]) + ' minutes';
  const everyHour = /^\*\/(\d{1,2})$/.exec(f[1]);
  const m = tspInt(f[0], 0, 59);
  if (everyHour && m !== null && f.slice(2).join(' ') === '* * *') {
    const n = Number(everyHour[1]);
    return (n === 1 ? 'every hour' : 'every ' + n + ' hours') + (m === 0 ? '' : ' at :' + String(m).padStart(2, '0'));
  }
  return null;
}

function tspEvery(ms) {
  const units = [[86_400_000, 'day'], [3_600_000, 'hour'], [60_000, 'minute'], [1_000, 'second']];
  for (const [size, name] of units) {
    if (ms >= size && ms % size === 0) {
      const n = ms / size;
      return n === 1 ? 'every ' + name : 'every ' + n + ' ' + name + 's';
    }
  }
  return null;
}

/** A task's schedule (as GET /api/tasks gives it) in words, or null. */
function schedulePhrase(schedule) {
  if (!schedule || typeof schedule !== 'object') return null;
  if (schedule.kind === 'cron') {
    const words = cronPhrase(schedule.expression);
    return words && schedule.tz ? words + ' (' + schedule.tz + ')' : words;
  }
  if (schedule.kind === 'interval') return typeof schedule.everyMs === 'number' ? tspEvery(schedule.everyMs) : null;
  return null;
}

/* One button press on the picker: `key` is freq / hour / minute / day / dom,
   `value` its argument. Writes form.cronExpression and returns it. */
function taskPickerApply(form, key, value) {
  const p = cronToPicker(form.cronExpression) || tspDefault();
  if (key === 'freq' && TSP_FREQS.includes(value)) {
    p.freq = value;
    if (value === 'weekly' && (!p.days.length || p.days.length === 5)) p.days = [1];
  } else if (key === 'hour') {
    const h = tspInt(String(value), 0, 23); if (h !== null) p.hour = h;
  } else if (key === 'minute') {
    const m = tspInt(String(value), 0, 59); if (m !== null) p.minute = m;
  } else if (key === 'day') {
    const d = tspInt(String(value), 0, 6);
    if (d !== null) {
      p.freq = 'weekly';
      const has = p.days.includes(d);
      // A week with no day would never fire: the last one stays.
      if (has && p.days.length > 1) p.days = p.days.filter((x) => x !== d);
      else if (!has) p.days = p.days.concat(d);
    }
  } else if (key === 'dom') {
    const step = value === '-' ? -1 : value === '+' ? 1 : 0;
    p.dom = Math.max(1, Math.min(31, p.dom + step));
  }
  form.cronExpression = pickerToCron(p);
  return form.cronExpression;
}

function tspEsc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

function tspBtn(key, value, label, on, extra) {
  return '<button class="tsp-b' + (on ? ' on' : '') + '" data-act="tasks:pick:' + key + ':' + tspEsc(value) + '" aria-pressed="' + !!on + '"'
    + (extra || '') + '>' + tspEsc(label) + '</button>';
}

/** The picker over the create form's Cron field (kind cron only). */
function taskPickerHTML(form) {
  const expr = String(form.cronExpression || '').trim();
  const p = cronToPicker(expr);
  const row = (label, inner) => '<div class="tk-field tkrow tsp-row"><span class="tk-lbl">' + tspEsc(label) + '</span>' + inner + '</div>';
  let html = row('Repeat', '<div class="tk-seg tsp-freq" role="group" aria-label="Repeat">'
    + TSP_FREQS.map((f) => tspBtn('freq', f, TSP_FREQ_LABEL[f], p && p.freq === f)).join('') + '</div>');
  if (!p) {
    html += '<p class="set-cap tsp-note">' + (expr ? 'A custom schedule: change it in the Cron field below, or pick how often above.' : 'Pick how often, then the time.') + '</p>';
    return '<div class="tsp">' + html + '</div>';
  }
  if (p.freq === 'weekly') {
    html += row('Days', '<div class="tsp-grid tsp-days" role="group" aria-label="Days">'
      + TSP_WEEK_ORDER.map((d) => tspBtn('day', d, TSP_DAY_NAMES[d].slice(0, 3), p.days.includes(d))).join('') + '</div>');
  }
  if (p.freq === 'monthly') {
    html += row('Day of month', '<div class="tsp-grid tsp-dom">' + tspBtn('dom', '-', '−', false, ' aria-label="Earlier day"')
      + '<span class="tsp-v mono">' + p.dom + '</span>' + tspBtn('dom', '+', '+', false, ' aria-label="Later day"') + '</div>');
  }
  if (p.freq !== 'hourly') {
    let hours = '';
    for (let h = 0; h < 24; h += 1) hours += tspBtn('hour', h, String(h).padStart(2, '0'), p.hour === h);
    html += row('Hour', '<div class="tsp-grid tsp-hours" role="group" aria-label="Hour">' + hours + '</div>');
  }
  const minutes = TSP_MINUTES.includes(p.minute) ? TSP_MINUTES : TSP_MINUTES.concat(p.minute).sort((a, b) => a - b);
  html += row(p.freq === 'hourly' ? 'Minute past' : 'Minute', '<div class="tsp-grid tsp-mins" role="group" aria-label="Minute">'
    + minutes.map((m) => tspBtn('minute', m, ':' + String(m).padStart(2, '0'), p.minute === m)).join('') + '</div>');
  const words = cronPhrase(expr);
  if (words) html += '<p class="set-cap tsp-note">Runs ' + tspEsc(words) + '.</p>';
  return '<div class="tsp">' + html + '</div>';
}

/* ---------- a task's page: Pause / Resume and its past runs ---------- */

const TSP_OUTCOME = {
  completed: 'done', failed: 'failed', retry: 'failed, retried', blocked: 'blocked',
  cancelled: 'cancelled', interrupted: 'stopped', unknown: 'ended',
};

function runOutcomeLabel(outcome) {
  return outcome === null || outcome === undefined ? 'running' : (TSP_OUTCOME[outcome] || String(outcome));
}

function tspDuration(ms) {
  if (!(ms >= 0)) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}

/* The Past runs section. `state` is TASK_RUNS for this task; `fmt` formats
   a Unix ms (renderer.js passes formatUnixMs). Empty for an agent without
   the route, so nothing is drawn. */
function taskRunsHTML(state, fmt) {
  if (!state || state.unsupported) return '';
  const head = '<div class="set-prevh tsp-runs-h"><b>Past runs</b></div>';
  if (state.error) return '<div class="set-wellcard tsp-runs">' + head + '<div class="tuierr tk-help tk-help--err">' + tspEsc(state.error) + '</div></div>';
  if (state.loading && !state.runs.length) return '<div class="set-wellcard tsp-runs">' + head + '<div class="set-cap">Loading…</div></div>';
  if (state.available === false) return '<div class="set-wellcard tsp-runs">' + head + '<div class="set-cap">This agent keeps no run history on its tasks file.</div></div>';
  if (!state.runs.length) return '<div class="set-wellcard tsp-runs">' + head + '<div class="set-cap">No runs yet.</div></div>';
  const tone = {completed: 'tk-chip--green', failed: 'tk-chip--red', retry: 'tk-chip--amber', blocked: 'tk-chip--amber', cancelled: 'tk-chip--line', interrupted: 'tk-chip--line'};
  return '<div class="set-wellcard tsp-runs">' + head + '<ul class="tsp-runlist">'
    + state.runs.map((r) => '<li class="tsp-run">'
      + '<span class="tk-chip tk-chip--sm ' + (tone[r.outcome] || (r.outcome == null ? 'tk-chip--blue' : '')) + '">' + tspEsc(runOutcomeLabel(r.outcome)) + '</span>'
      + '<span class="mono">' + tspEsc(fmt(r.startedAt)) + '</span>'
      + (typeof r.endedAt === 'number' ? '<span class="set-meta mono">' + tspEsc(tspDuration(r.endedAt - r.startedAt)) + '</span>' : '')
      + '<span class="set-meta mono">attempt ' + tspEsc(r.attempt) + '</span>'
      + (r.error ? '<span class="tsp-err mono" title="' + tspEsc(r.error) + '">' + tspEsc(r.error) + '</span>' : '')
      + '</li>').join('')
    + '</ul></div>';
}

/** Which of Pause / Resume a task's page offers, or null for neither. */
function taskPauseAction(row, state) {
  if (!row || (state && state.unsupported)) return null;
  if (row.status === 'paused') return 'resume';
  if (row.status === 'pending') return 'pause';
  return null;
}

/* The runs of the task on screen, reloaded on each visit to its page. */
const TASK_RUNS = {id: null, loading: false, unsupported: false, available: true, runs: [], error: null};

async function taskRunsLoad(id, repaint) {
  const api = typeof window !== 'undefined' ? window.atomic : null;
  if (!api || !api.taskRuns || !id) return;
  if (TASK_RUNS.id !== id) Object.assign(TASK_RUNS, {id, runs: [], error: null, available: true});
  TASK_RUNS.loading = true;
  const res = await api.taskRuns(id);
  if (TASK_RUNS.id !== id) return;
  TASK_RUNS.loading = false;
  if (res && res.ok) {
    const data = res.data || {};
    TASK_RUNS.runs = Array.isArray(data.runs) ? data.runs : [];
    TASK_RUNS.available = data.available !== false;
    TASK_RUNS.error = null;
  } else if (res && res.unsupported) {
    TASK_RUNS.unsupported = true;
  } else {
    TASK_RUNS.error = 'past runs: ' + ((res && res.error) || 'unknown error');
  }
  if (repaint) repaint();
}

/* Pause or resume; answers the line the tab shows. */
async function taskPauseToggle(id, verb) {
  const api = typeof window !== 'undefined' ? window.atomic : null;
  if (!api || !api.pauseTask) return 'pause is not available';
  const res = verb === 'resume' ? await api.resumeTask(id) : await api.pauseTask(id);
  if (res && res.ok) {
    const status = res.data && res.data.status;
    return status === 'paused' ? 'task ' + id + ' paused: it will not run until resumed'
      : 'task ' + id + ' resumed' + (status && status !== 'pending' ? ' (status=' + status + ')' : '');
  }
  if (res && res.unsupported) { TASK_RUNS.unsupported = true; return 'This agent version cannot pause tasks. Update Atomic Agent.'; }
  return verb + ' ' + id + ' failed: ' + ((res && res.error) || 'unknown error');
}

/* The line after Run now. It runs a paused task once and the pause stays. */
function taskRunNowLine(id, task) {
  if (!task) return 'task ' + id + ' skipped (already claimed or vanished)';
  if (task.status === 'paused') return 'task ' + id + ' ran once and is still paused: resume it to put it back on its schedule';
  return 'task ' + id + ' run complete (status=' + task.status + ')';
}

if (typeof module !== 'undefined') {
  module.exports = {pickerToCron, cronToPicker, cronPhrase, schedulePhrase, taskPickerApply, taskPickerHTML,
    runOutcomeLabel, taskRunsHTML, taskPauseAction, taskRunNowLine};
}
