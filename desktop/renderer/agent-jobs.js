/* ---------------- ATO-2485: the agent's jobs in the terminal panel ----------------
   Draws #agentjobs itself (render() never does), so a repaint of the chat
   never takes the caret out of the field. Reads renderer.js globals: BR, S,
   toast. Logic in agent-jobs-logic.js.

   Folded, it is one chip over the composer while the open chat has agent
   jobs ("Agent job running"). Open, it is a drawer with one tab per job
   ("Agent job: npm init"), the job's screen, and under it Take over: a
   field whose Enter types into the job, Hide typing for a secret (switched
   on by itself at a password prompt), and Stop job. An ended job keeps its
   last screen until its tab is closed.

   Like Claude Code's background shells view and Cursor's "take over" on
   the agent's terminal: the agent started the program, the person answers
   the step only they can answer. What they type never enters the chat. */

const AJ = {
  sid: null, jobs: [], closed: {}, selected: null, open: false, taking: false, hide: false,
  raw: {}, next: {}, dropped: {}, asked: {}, unsupported: false, busy: false, err: '', timer: null,
};
/** Set when the field should take the caret on the next paint. */
let ajWantFocus = false;
const AJ_LIST_FAST_MS = 1500;
const AJ_LIST_IDLE_MS = 5000;
const AJ_OUTPUT_MS = 500;
const AJ_UNSUPPORTED_MS = 60_000;

function ajBridge() { return typeof BR !== 'undefined' && BR && typeof BR.agentJobsList === 'function' ? BR : null; }
function ajHost() { return typeof document !== 'undefined' ? document.getElementById('agentjobs') : null; }
function ajChatSession() { return typeof S !== 'undefined' && S && S.agentSession ? S.agentSession : null; }
function ajSelectedJob() { return AJ.jobs.find((j) => j.id === AJ.selected) || null; }

function ajReset(sid) {
  Object.assign(AJ, {sid, jobs: [], closed: {}, selected: null, open: false, taking: false, hide: false,
    raw: {}, next: {}, dropped: {}, asked: {}, err: ''});
}

/* ---- polling ---- */

function ajSchedule(ms) {
  if (AJ.timer) clearTimeout(AJ.timer);
  AJ.timer = setTimeout(ajTick, ms);
}

async function ajTick() {
  const bridge = ajBridge();
  if (!bridge) return;
  const sid = ajChatSession();
  if (sid !== AJ.sid) ajReset(sid);
  if (!sid) {
    ajPaint();
    ajSchedule(AJ_LIST_IDLE_MS);
    return;
  }
  const res = await Promise.resolve(bridge.agentJobsList(sid)).catch(() => null);
  if (sid !== AJ.sid) return ajSchedule(0);
  // An agent from before the routes is asked again only after a minute (it may have been updated).
  AJ.unsupported = !!(res && !res.ok && res.unsupported);
  if (res && res.ok) AJ.jobs = ajMergeJobs(AJ.jobs, ajJobsFrom(res.data), AJ.closed);
  if (AJ.selected == null || !ajSelectedJob()) AJ.selected = AJ.jobs.length ? AJ.jobs[AJ.jobs.length - 1].id : null;
  await ajPullOutputs(bridge, sid);
  ajPaint();
  const live = AJ.jobs.some(ajIsLive);
  const fast = live && (AJ.open || AJ.jobs.some((j) => j.interactive));
  ajSchedule(AJ.unsupported ? AJ_UNSUPPORTED_MS : fast ? (AJ.open ? AJ_OUTPUT_MS : AJ_LIST_FAST_MS)
    : (typeof S !== 'undefined' && S.busy) ? AJ_LIST_FAST_MS : AJ_LIST_IDLE_MS);
}

/** New output of every live interactive job (to spot a prompt) and of the open tab. */
async function ajPullOutputs(bridge, sid) {
  // Live interactive jobs are read even folded, to spot a password prompt; an
  // ended one once, when its tab is first shown.
  const wanted = AJ.jobs.filter((j) => (ajIsLive(j) && j.interactive)
    || (AJ.open && j.id === AJ.selected && (ajIsLive(j) || AJ.next[j.id] === undefined)));
  for (const job of wanted) {
    const res = await Promise.resolve(bridge.agentJobOutput(sid, job.id, AJ.next[job.id] || 0)).catch(() => null);
    if (sid !== AJ.sid) return;
    if (!res || !res.ok || !res.data) { AJ.next[job.id] = AJ.next[job.id] || 0; continue; }
    const d = res.data;
    if (typeof d.text === 'string' && d.text) AJ.raw[job.id] = ajAppendRaw(AJ.raw[job.id], d.text);
    if (typeof d.next === 'number') AJ.next[job.id] = d.next;
    if (d.dropped) AJ.dropped[job.id] = true;
    if (d.job && typeof d.job.id === 'number') AJ.jobs = AJ.jobs.map((j) => j.id === d.job.id ? d.job : j);
    ajNoticePrompt(job.id);
  }
}

/** A job asking for a password: open its tab with typing hidden, once per prompt. */
function ajNoticePrompt(id) {
  const job = AJ.jobs.find((j) => j.id === id);
  if (!job || !job.interactive || !ajIsLive(job)) return;
  const secret = ajLooksSecret(ajScreenText(AJ.raw[id]));
  const at = AJ.next[id] || 0;
  if (!secret || AJ.asked[id] === at) return;
  AJ.asked[id] = at;
  Object.assign(AJ, {open: true, selected: id, taking: true, hide: true});
  if (typeof toast === 'function') toast('The agent’s command is asking you', 'Type it in the terminal panel. It goes to the command only, not to the chat.');
  ajWantFocus = true;
}

/* ---- actions ---- */

async function ajSend(eof) {
  const bridge = ajBridge();
  const job = ajSelectedJob();
  const field = ajHost() && ajHost().querySelector('.aj-input');
  if (!bridge || !job || !field || AJ.busy) return;
  const text = eof ? '' : ajInputText(field.value, true);
  AJ.busy = true;
  AJ.err = '';
  const res = await Promise.resolve(bridge.agentJobInput(AJ.sid, job.id, text, !!eof)).catch(() => null);
  AJ.busy = false;
  if (res && res.ok) field.value = '';
  else AJ.err = (res && res.error) || 'The agent did not answer. Try again.';
  // A secret is never kept in the field after it was sent or refused.
  if (AJ.hide) field.value = '';
  ajPaint();
  ajSchedule(0);
}

async function ajStop() {
  const bridge = ajBridge();
  const job = ajSelectedJob();
  if (!bridge || !job || AJ.busy) return;
  AJ.busy = true;
  const res = await Promise.resolve(bridge.agentJobStop(AJ.sid, job.id)).catch(() => null);
  AJ.busy = false;
  AJ.err = res && res.ok ? '' : (res && res.error) || 'Couldn’t stop the job. Try again.';
  ajSchedule(0);
}

function ajAct(what, arg) {
  if (what === 'open') { AJ.open = true; ajWantFocus = AJ.taking; }
  else if (what === 'fold') { AJ.open = false; }
  else if (what === 'tab') { AJ.selected = Number(arg); AJ.taking = false; AJ.err = ''; }
  else if (what === 'take') { AJ.taking = true; ajWantFocus = true; }
  else if (what === 'send') { void ajSend(false); return; }
  else if (what === 'eof') { void ajSend(true); return; }
  else if (what === 'stop') { void ajStop(); return; }
  else if (what === 'close') {
    const id = Number(arg);
    AJ.closed[id] = true;
    AJ.jobs = AJ.jobs.filter((j) => j.id !== id);
    if (AJ.selected === id) AJ.selected = AJ.jobs.length ? AJ.jobs[AJ.jobs.length - 1].id : null;
    if (!AJ.jobs.length) AJ.open = false;
  }
  ajPaint();
  ajSchedule(0);
}

/* ---- drawing ---- */

function ajSkeleton(host) {
  host.innerHTML = '<div class="aj-panel" role="region" aria-label="Agent terminal">'
    + '<div class="aj-head"><div class="aj-tabs" role="tablist"></div><span class="aj-grow"></span>'
    + '<button type="button" class="btn btn-s sm" data-aj="fold">Hide</button></div>'
    + '<div class="aj-dropped" hidden>Earlier output is not shown.</div>'
    + '<pre class="aj-screen" tabindex="0"></pre>'
    + '<div class="aj-foot"><span class="aj-state"></span><span class="aj-grow"></span>'
    + '<button type="button" class="btn btn-s sm" data-aj="take">Take over</button>'
    + '<button type="button" class="btn btn-s sm" data-aj="stop">Stop job</button>'
    + '<button type="button" class="btn btn-s sm" data-aj="close">Close tab</button></div>'
    + '<div class="aj-take" hidden><input class="aj-input" type="text" autocomplete="off" spellcheck="false" aria-label="Type into the job">'
    + '<label class="aj-hide"><input type="checkbox" class="aj-hidebox"> Hide typing</label>'
    + '<button type="button" class="btn btn-p sm" data-aj="send">Send</button>'
    + '<button type="button" class="btn btn-s sm" data-aj="eof" title="Tell the command there is no more input">End input</button></div>'
    + '<div class="aj-err" role="status" aria-live="polite"></div></div>';
}

function ajPaint() {
  const host = ajHost();
  if (!host) return;
  if (!AJ.jobs.length) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  if (!AJ.open) {
    const secret = AJ.jobs.some((j) => ajIsLive(j) && j.interactive && ajLooksSecret(ajScreenText(AJ.raw[j.id])));
    host.innerHTML = '<button type="button" class="aj-chip' + (secret ? ' aj-chip--ask' : '') + '" data-aj="open">'
      + '<span class="aj-dot' + (AJ.jobs.some(ajIsLive) ? ' aj-dot--live' : '') + '"></span>' + ajEsc(ajChipText(AJ.jobs, secret)) + '</button>';
    return;
  }
  if (!host.querySelector('.aj-panel')) ajSkeleton(host);
  const job = ajSelectedJob();
  host.querySelector('.aj-tabs').innerHTML = AJ.jobs.map((j) => '<button type="button" role="tab" class="aj-tab'
    + (j.id === AJ.selected ? ' aj-tab--on' : '') + '" aria-selected="' + (j.id === AJ.selected) + '" data-aj="tab" data-aj-id="' + j.id + '" title="' + ajEsc(j.commandLine) + '">'
    + '<span class="aj-dot' + (ajIsLive(j) ? ' aj-dot--live' : '') + '"></span>' + ajEsc(ajTabLabel(j)) + '</button>').join('');
  const screen = host.querySelector('.aj-screen');
  const atBottom = screen.scrollTop + screen.clientHeight >= screen.scrollHeight - 4;
  const text = job ? ajScreenText(AJ.raw[job.id]) : '';
  if (screen.textContent !== text) {
    screen.textContent = text || (job && ajIsLive(job) ? 'Waiting for output…' : 'No output.');
    if (atBottom) screen.scrollTop = screen.scrollHeight;
  }
  host.querySelector('.aj-dropped').hidden = !(job && AJ.dropped[job.id]);
  host.querySelector('.aj-state').textContent = ajStateLine(job);
  const live = ajIsLive(job);
  const canType = live && !!job.interactive;
  host.querySelector('[data-aj="take"]').hidden = !canType || AJ.taking;
  host.querySelector('[data-aj="stop"]').hidden = !live;
  const close = host.querySelector('[data-aj="close"]');
  close.hidden = live;
  if (job) close.setAttribute('data-aj-id', String(job.id));
  const take = host.querySelector('.aj-take');
  take.hidden = !(canType && AJ.taking);
  const field = host.querySelector('.aj-input');
  field.type = AJ.hide ? 'password' : 'text';
  host.querySelector('.aj-hidebox').checked = AJ.hide;
  host.querySelector('.aj-err').textContent = AJ.err;
  if (ajWantFocus && !take.hidden) { ajWantFocus = false; field.focus(); }
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  document.addEventListener('click', (e) => {
    const el = e.target && e.target.closest && e.target.closest('#agentjobs [data-aj]');
    if (!el) return;
    e.preventDefault();
    ajAct(el.getAttribute('data-aj'), el.getAttribute('data-aj-id'));
  });
  document.addEventListener('change', (e) => {
    if (!e.target || !e.target.classList || !e.target.classList.contains('aj-hidebox')) return;
    AJ.hide = !!e.target.checked;
    ajPaint();
  });
  document.addEventListener('keydown', (e) => {
    if (!e.target || !e.target.classList || !e.target.classList.contains('aj-input')) return;
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); void ajSend(false); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); AJ.taking = false; e.target.value = ''; ajPaint(); }
  }, true);
  window.addEventListener('DOMContentLoaded', () => ajSchedule(1000));
}
