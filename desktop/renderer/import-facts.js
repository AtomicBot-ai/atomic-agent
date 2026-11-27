/* ---------------- "Here is what I learned about you" (ATO-1629, ATO-1061) ----------------
   Loaded before renderer.js. Self-contained, as overnight.js is: it draws only
   into its own #import-facts layer (index.html), listens for its own
   `data-ifact` clicks, and reads renderer.js globals (BR, esc, ic, toast) only
   at run time, guarded, so the Node tests can load it.

   Two ways in:
   - After the chats of a Claude export are moved in (Settings › Import, source
     Claude), renderer.js calls ifactAfterImport(path, caps): the same export
     is read again for facts about the person.
   - "Move from ChatGPT" (onboarding's import step and Settings › Import):
     ChatGPT chats are not imported as chats yet, so this asks for the ChatGPT
     data export .zip and runs only this step.

   The step: which model reads (the local one by default; a cloud model only
   with this run's tick, whose words say the chats go to that provider),
   "Reading part N of M" with Stop, then the facts found, each with its short
   quote and a tick (all ticked), Save, and "Saved N, skipped M (already
   known)". Nothing is saved without a tick. Main talks to the agent
   (main/import-facts.ts → /api/import/facts/*); an agent on another computer
   is refused there, because the export is a file on this one.

   The job is polled every 500 ms, only while this step is on screen and the
   window is not hidden. */

const IFACT_POLL_MS = 500;
const IFACT_CLOUD_WARNING = 'Use a cloud model instead of the local one. The text of your chats will be sent to the provider you picked.';
const IFACT_CHATGPT_HINT = 'In ChatGPT, open Settings › Data controls › Export data. ChatGPT emails you a link to a .zip: choose that file here.';
const IFACT_SOURCE_NAMES = {claude: 'Claude', chatgpt: 'ChatGPT'};
/* ATO-2740: per-step titles, the close question, error words and the pick buttons live in
   import-facts-steps.js (loaded first, index.html); the Node tests require it. */
const IFS = typeof ifactStepTitle === 'function'
  ? {ifactStepTitle, ifactCloseNeedsAsk, ifactCloseAsk, ifactCloseAskHTML, ifactErrorView, ifactErrorHTML, ifactPickButtonsHTML}
  : require('./import-facts-steps.js');

const IFACT = {
  open: false,
  stage: 'closed',   // pick · choose · running · review · saving · done · error
  source: 'claude', path: '', afterImport: false,
  info: null,        // {supported, remote, cloud:[{id,label}]} from main
  cloudOn: false, cloudProvider: '',
  job: null, ticks: {}, result: null, error: null, busy: false, stopping: false,
  errorDetail: null,  // {for, text}: the raw words behind `error`, shown under Details (ATO-2740)
  asking: false,      // the "Stop importing?" / "Close without saving?" question is up (ATO-2740)
  timer: null,
};

/* ---------- pure helpers (test/import-facts.test.mjs) ---------- */

/** `/api/capabilities` → `agent.importFacts`: an older agent has no step to offer. */
function ifactSupported(caps) {
  return !!(caps && caps.agent && caps.agent.importFacts === true);
}
function ifactEnded(job) { return !!job && (job.state === 'done' || job.state === 'stopped' || job.state === 'failed'); }
/** Which screen a job's state belongs on. */
function ifactStageFor(job) {
  if (!job) return 'choose';
  if (job.state === 'failed') return 'error';
  if (job.state === 'done' || job.state === 'stopped') return 'review';
  return 'running';
}
/** "Reading part 3 of 12"; before the export is open, what it is doing. */
function ifactProgressLine(job) {
  if (!job || job.state === 'reading') return 'Opening your export…';
  const total = Number(job.chunksTotal) || 0;
  if (!total) return 'Reading your chats…';
  const n = Math.min(total, (Number(job.chunksDone) || 0) + 1);
  return 'Reading part ' + n + ' of ' + total;
}
/** 0..100 for the bar. */
function ifactProgressPct(job) {
  const total = job ? Number(job.chunksTotal) || 0 : 0;
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round(((Number(job.chunksDone) || 0) / total) * 100)));
}
function ifactCloudLabel(info, id) {
  const hit = info && Array.isArray(info.cloud) ? info.cloud.find((c) => c.id === id) : null;
  return hit ? hit.label : (id || 'the cloud model');
}
/** Which model reads, in words, for the running and the review screens. */
function ifactModelLine(job, info) {
  if (!job) return '';
  return job.local ? 'The local model is reading your chats. They are not sent to a cloud provider.'
    : ifactCloudLabel(info, job.providerId) + ' is reading your chats in the cloud.';
}
/** Every candidate ticked: the default. */
function ifactTicksFor(candidates) {
  const t = {};
  (candidates || []).forEach((c) => { t[c.id] = true; });
  return t;
}
function ifactToggle(ticks, id) {
  const t = Object.assign({}, ticks);
  t[id] = !t[id];
  return t;
}
function ifactSetAll(candidates, on) {
  const t = {};
  (candidates || []).forEach((c) => { t[c.id] = !!on; });
  return t;
}
/** The ids to save, in the list's order. */
function ifactApproved(candidates, ticks) {
  return (candidates || []).filter((c) => ticks && ticks[c.id] === true).map((c) => c.id);
}
/** "Saved 4, skipped 2 (already known)", then anything that did not go in. */
function ifactResultLine(r) {
  if (!r) return '';
  let s = 'Saved ' + (r.saved || 0) + ', skipped ' + (r.skipped || 0) + ' (already known)';
  if (r.conflicts > 0) s += ', ' + r.conflicts + ' left as they were (you already have a different answer)';
  if (r.failed > 0) s += ', ' + r.failed + ' could not be saved';
  return s + '.';
}
/** Poll only while the step is on screen, running, and the window can be seen. */
function ifactShouldPoll(st, hidden) {
  return !!st && st.open && st.stage === 'running' && !!st.job && !ifactEnded(st.job) && !hidden;
}
/** "work_role" → "Work role": a profile key in plain words. */
function ifactKeyWords(key) {
  const k = String(key || '').replace(/[._-]+/g, ' ').trim();
  return k ? k.charAt(0).toUpperCase() + k.slice(1) : '';
}
/** "Try again" after a failed run (ATO-1655): back to the model choice (or the file pick),
   with the cloud box unticked. The tick is consent for one run; a new run starts without it,
   the way ifactOpen starts every entry to the step. */
function ifactRetryState(st) {
  return {job: null, error: null, errorDetail: null, asking: false, cloudOn: false, stage: st && st.path ? 'choose' : 'pick'};
}
/** What start sends: the cloud object only with this run's tick. */
function ifactStartInput(st) {
  const input = {source: st.source, path: st.path};
  if (st.cloudOn && st.cloudProvider) input.cloud = {provider: st.cloudProvider, consent: true};
  return input;
}

/* ---------- drawing ---------- */

/** The "Move from ChatGPT" card for Settings › Import and the onboarding import step; '' on an agent without the step. */
function ifactEntryHTML(caps, where) {
  if (!ifactSupported(caps)) return '';
  const h = ifactHelpers();
  const ob = where === 'ob';
  return '<div class="ifact-entry' + (ob ? ' ifact-entry--ob' : ' tk-card') + '">'
    + '<div class="ifact-entry-body"><div class="ifact-entry-t">Move from ChatGPT</div>'
    + '<div class="ifact-entry-d">Bring in what ChatGPT knows about you: the agent reads your ChatGPT data export and shows the facts it found. You pick which to keep.</div></div>'
    + '<button class="btn ' + (ob ? 'btn-s' : 'btn-s sm') + '" type="button" data-ifact="open:chatgpt">' + h.ic('arrowR') + 'Move from ChatGPT</button></div>';
}

function ifactBodyHTML(st, h) {
  const esc = h.esc;
  const name = IFACT_SOURCE_NAMES[st.source] || st.source;
  const info = st.info || {cloud: []};
  const err = IFS.ifactErrorHTML(st, esc);
  let body = '', foot = '';
  const close = (label) => '<button class="btn sm" type="button" data-ifact="close">' + esc(label || 'Not now') + '</button>';
  if (st.stage === 'pick') {
    body = '<p class="tk-help">The agent reads your own messages in the export and lists facts about you, such as your work or what you like. Nothing is saved until you pick.</p>'
      + '<div class="tk-field"><span class="tk-lbl">ChatGPT export</span>'
      + '<div class="ifact-file"><span class="ifact-path" title="' + esc(st.path) + '">' + esc(st.path || 'No file chosen') + '</span>'
      + IFS.ifactPickButtonsHTML(h.platform) + '</div>'
      + '<span class="tk-help">' + esc(IFACT_CHATGPT_HINT) + '</span></div>'
      + '<p class="tk-help">Your ChatGPT chats are not moved in as chats yet: only the facts about you.</p>' + err;
    foot = close() + '<button class="btn btn-p sm" type="button" data-ifact="next"' + (st.path ? '' : ' disabled') + '>Continue</button>';
  } else if (st.stage === 'choose') {
    const cloud = info.cloud || [];
    const pickRow = !st.cloudOn ? ''
      : cloud.length > 1
        ? '<label class="tk-field ifact-prov"><span class="tk-lbl">Provider</span><select class="tk-inp" data-ifact-field="provider">'
          + cloud.map((c) => '<option value="' + esc(c.id) + '"' + (c.id === st.cloudProvider ? ' selected' : '') + '>' + esc(c.label) + '</option>').join('') + '</select></label>'
        : '<p class="tk-help ifact-prov">Provider: <b>' + esc(ifactCloudLabel(info, st.cloudProvider)) + '</b></p>';
    body = '<p class="tk-help">' + (st.afterImport ? 'Your ' + esc(name) + ' chats are here. ' : '')
      + 'Now the agent can read your own messages in the ' + esc(name) + ' export and list facts about you, such as your work or what you like. '
      + 'You see each one with the words it came from, and pick which to keep.</p>'
      + '<div class="ifact-model">' + h.ic(st.cloudOn ? 'cloud' : 'laptop') + '<span>' + (st.cloudOn
        ? esc(ifactCloudLabel(info, st.cloudProvider)) + ' reads your chats in the cloud.'
        : 'The local model reads your chats. They are not sent to a cloud provider.') + '</span></div>'
      + (cloud.length
        ? '<label class="ifact-check"><input type="checkbox" data-ifact-field="cloud"' + (st.cloudOn ? ' checked' : '') + '><span>' + esc(IFACT_CLOUD_WARNING) + '</span></label>' + pickRow
        : '')
      + err;
    foot = close() + '<button class="btn btn-p sm" type="button" data-ifact="start"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? 'Starting…' : 'Read my chats') + '</button>';
  } else if (st.stage === 'running') {
    body = '<p class="ifact-progress" role="status">' + esc(ifactProgressLine(st.job)) + '</p>'
      + '<div class="ifact-bar"><i style="width:' + ifactProgressPct(st.job) + '%"></i></div>'
      + '<p class="tk-help">' + esc(ifactModelLine(st.job, info)) + ' A large export takes a while; you can stop and keep what was found so far.</p>' + err;
    foot = '<span class="grow"></span><button class="btn sm" type="button" data-ifact="stop"' + (st.stopping ? ' disabled' : '') + '>' + (st.stopping ? 'Stopping…' : 'Stop') + '</button>';
  } else if (st.stage === 'review' || st.stage === 'saving') {
    const list = (st.job && st.job.candidates) || [];
    const picked = ifactApproved(list, st.ticks).length;
    const lead = st.job && st.job.state === 'stopped' ? 'Stopped early. These are the facts from the parts read so far.' : '';
    const failed = st.job && st.job.failedChunks > 0 ? 'The model did not answer for ' + st.job.failedChunks + (st.job.failedChunks === 1 ? ' part' : ' parts') + ' of your chats.' : '';
    body = (lead || failed ? '<p class="tk-help">' + esc([lead, failed].filter(Boolean).join(' ')) + '</p>' : '')
      + (list.length
        ? '<div class="ifact-listhead"><span>' + list.length + (list.length === 1 ? ' fact' : ' facts') + ' found. Untick any you do not want saved.</span>'
          + '<button class="btn xs" type="button" data-ifact="all:' + (picked === list.length ? 'off' : 'on') + '">' + (picked === list.length ? 'Untick all' : 'Tick all') + '</button></div>'
          + '<div class="ifact-list" role="list">' + list.map((c) => '<label class="ifact-row" role="listitem">'
            + '<input type="checkbox" data-ifact-tick="' + esc(c.id) + '"' + (st.ticks[c.id] ? ' checked' : '') + (st.stage === 'saving' ? ' disabled' : '') + '>'
            + '<span class="ifact-main">'
              + (c.kind === 'profile' && c.key ? '<span class="ifact-key">' + esc(ifactKeyWords(c.key)) + '</span>' : '<span class="ifact-key">Note</span>')
              + '<span class="ifact-val">' + esc(c.value) + '</span>'
              + (c.quote ? '<span class="ifact-quote">“' + esc(c.quote) + '”</span>' : '')
            + '</span></label>').join('') + '</div>'
        : '<p class="ifact-empty">Nothing new about you was found in these chats.</p>')
      + err;
    foot = list.length
      ? '<button class="btn sm" type="button" data-ifact="close">Skip</button>'
        + '<button class="btn btn-p sm" type="button" data-ifact="save"' + (st.stage === 'saving' || !picked ? ' disabled' : '') + '>'
        + (st.stage === 'saving' ? 'Saving…' : 'Save ' + picked) + '</button>'
      : '<span class="grow"></span>' + close('Done');
  } else if (st.stage === 'done') {
    body = '<p class="ifact-result" role="status">' + h.ic('check') + '<span>' + esc(ifactResultLine(st.result)) + '</span></p>'
      + '<p class="tk-help">The agent uses these from now on. You can see and change them in Settings › Memory.</p>';
    foot = '<span class="grow"></span><button class="btn btn-p sm" type="button" data-ifact="close">Done</button>';
  } else {
    body = IFS.ifactErrorHTML(st.error ? st : Object.assign({}, st, {error: 'Something went wrong.'}), esc);
    foot = '<span class="grow"></span>' + close('Close')
      + (st.info && st.info.supported && !st.info.remote ? '<button class="btn btn-p sm" type="button" data-ifact="retry">Try again</button>' : '');
  }
  // ATO-2740: closing now would drop the run or its found facts, so the sheet asks first.
  const ask = st.asking ? IFS.ifactCloseAsk(st, ifactApproved((st.job && st.job.candidates) || [], st.ticks).length) : null;
  if (ask) ({body, foot} = IFS.ifactCloseAskHTML(ask, esc));
  const title = ask ? ask.title : IFS.ifactStepTitle(st);
  return '<div class="sheetwrap ifact-wrap" data-ifact="backdrop"><div class="sheet ifact-sheet" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">'
    + '<div class="sheethead"><span class="ttl">' + esc(title) + '</span>'
      + '<button class="iconbtn" type="button" data-ifact="close" aria-label="Close" title="Close">' + h.ic('x') + '</button></div>'
    + '<div class="ifact-body">' + body + '</div>'
    + '<div class="sheetfoot">' + foot + '</div>'
  + '</div></div>';
}

/* ---------- the window ---------- */

function ifactHelpers() {
  return {
    esc: typeof esc === 'function' ? esc : (s) => String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]),
    ic: typeof ic === 'function' ? ic : () => '',
    platform: (typeof BR !== 'undefined' && BR && BR.platform) || 'darwin',
  };
}
function ifactBridge() { return typeof BR !== 'undefined' && BR && BR.importFactsStart ? BR : null; }

function ifactPaint() {
  const host = typeof document !== 'undefined' && document.getElementById('import-facts');
  if (!host) return;
  const list = host.querySelector('.ifact-list');
  const top = list ? list.scrollTop : 0;
  const had = document.activeElement && host.contains(document.activeElement) ? document.activeElement.getAttribute('data-ifact') : null;
  host.innerHTML = IFACT.open ? ifactBodyHTML(IFACT, ifactHelpers()) : '';
  const again = host.querySelector('.ifact-list');
  if (again) again.scrollTop = top;
  // A poll repaints every 500 ms: the focused button stays focused; the question starts on its default.
  const back = IFACT.asking && !(had && had.startsWith('ask:')) ? host.querySelector('[data-ifact="ask:keep"]')
    : had ? host.querySelector('[data-ifact="' + had + '"]') : null;
  if (back) back.focus();
}
/** The plain words on screen, and the raw ones for Details (import-facts-steps.js ifactErrorView). */
function ifactSetError(message, kind, raw) {
  const v = IFS.ifactErrorView(message, kind, raw);
  IFACT.error = v.text;
  IFACT.errorDetail = v.detail ? {for: v.text, text: v.detail} : null;
}
const ifactThrown = (e) => ({ok: false, raw: true, error: e && e.message ? e.message : String(e)});

/** Opens the step. `path` is the export when it is already known (after a Claude import). */
async function ifactOpen(source, path, afterImport) {
  const br = ifactBridge();
  if (!br) { if (typeof toast === 'function') toast('This needs a newer app build', '', 'bad'); return; }
  if (IFACT.open && IFACT.job && !ifactEnded(IFACT.job)) return;   // one run at a time
  Object.assign(IFACT, {open: true, source: source === 'chatgpt' ? 'chatgpt' : 'claude', path: path || '', afterImport: !!afterImport,
    stage: path ? 'choose' : 'pick', info: null, cloudOn: false, cloudProvider: '', job: null, ticks: {}, result: null, error: null, busy: true, stopping: false,
    errorDetail: null, asking: false});
  ifactPaint();
  const info = await br.importFactsInfo().catch(ifactThrown);
  if (!IFACT.open) return;
  IFACT.busy = false;
  if (!info || !info.ok) { IFACT.stage = 'error'; ifactSetError(info && info.error, 'info', info && info.raw); ifactPaint(); return; }
  IFACT.info = info;
  if (info.remote) {
    IFACT.stage = 'error';
    IFACT.error = 'The agent runs on another computer, so it cannot read an export file from this one. Connect to the agent on this computer to bring in facts about you.';
  } else if (!info.supported) {
    IFACT.stage = 'error';
    IFACT.error = 'This agent cannot read facts from an export yet. Update Atomic Agent and try again.';
  } else {
    IFACT.cloudProvider = (info.cloud && info.cloud[0] && info.cloud[0].id) || '';
  }
  ifactPaint();
}
/** After a Claude import was applied: the same export, read for facts. */
function ifactAfterImport(path, caps) {
  if (!ifactSupported(caps) || !path) return;
  void ifactOpen('claude', path, true);
}

/** `force` is the question's Discard; without it, a close that would drop the run or its facts asks first (ATO-2740). */
async function ifactClose(force) {
  const br = ifactBridge();
  const job = IFACT.job;
  if (IFACT.stage === 'saving') return;
  if (!force && IFS.ifactCloseNeedsAsk(IFACT)) { IFACT.asking = true; ifactPaint(); return; }
  IFACT.open = false; IFACT.stage = 'closed'; IFACT.asking = false;
  ifactStopTimer();
  ifactPaint();
  if (br && job) {
    if (!ifactEnded(job)) await br.importFactsStop(job.id).catch(() => null);
    // The candidates are the person's own words: the agent drops them now, not at its TTL.
    await br.importFactsForget(job.id).catch(() => null);
  }
  IFACT.job = null; IFACT.ticks = {};
}

/** `kind`: 'file' or 'folder' on Windows and Linux, whose dialog takes one or the other; macOS sends none. */
async function ifactPick(kind) {
  const br = ifactBridge();
  if (!br) return;
  const res = await br.importFactsPick(IFACT.source, kind).catch(() => null);
  if (res && res.ok && res.path && IFACT.open) { IFACT.path = res.path; IFACT.error = null; ifactPaint(); }
}

async function ifactStart() {
  const br = ifactBridge();
  if (!br || IFACT.busy) return;
  IFACT.busy = true; IFACT.error = null; ifactPaint();
  const res = await br.importFactsStart(ifactStartInput(IFACT)).catch(ifactThrown);
  IFACT.busy = false;
  if (!IFACT.open) { if (res && res.ok && res.job) void br.importFactsForget(res.job.id).catch(() => null); return; }
  if (!res || !res.ok || !res.job) { ifactSetError(res && res.error, 'start', res && res.raw); ifactPaint(); return; }
  ifactTake(res.job);
}

/** A fresh view of the job: its screen, and the ticks once the facts are in. */
function ifactTake(job) {
  const was = IFACT.stage;
  IFACT.job = job;
  IFACT.stage = ifactStageFor(job);
  if (IFACT.stage === 'review' && was !== 'review') IFACT.ticks = ifactTicksFor(job.candidates);
  if (IFACT.stage === 'error') ifactSetError(job.error, 'job', true);
  if (IFACT.asking && !IFS.ifactCloseNeedsAsk(IFACT)) IFACT.asking = false;
  ifactPaint();
  ifactSchedule();
}

function ifactHidden() { return typeof document !== 'undefined' && document.visibilityState === 'hidden'; }
function ifactStopTimer() { if (IFACT.timer) { clearTimeout(IFACT.timer); IFACT.timer = null; } }
function ifactSchedule() {
  ifactStopTimer();
  if (!ifactShouldPoll(IFACT, ifactHidden())) return;
  IFACT.timer = setTimeout(ifactPoll, IFACT_POLL_MS);
}
async function ifactPoll() {
  IFACT.timer = null;
  const br = ifactBridge();
  if (!br || !ifactShouldPoll(IFACT, ifactHidden())) return;
  const id = IFACT.job.id;
  const res = await br.importFactsJob(id).catch(() => null);
  if (!IFACT.open || !IFACT.job || IFACT.job.id !== id) return;
  if (res && res.ok && res.job) { ifactTake(res.job); return; }
  if (res && res.remote) { IFACT.stage = 'error'; IFACT.asking = false; ifactSetError(res.error, 'poll'); ifactPaint(); return; }
  // A missed answer: try again on the next tick, with the reason under the bar.
  if (res && res.error) ifactSetError(res.error, 'poll'); else { IFACT.error = null; IFACT.errorDetail = null; }
  ifactPaint();
  ifactSchedule();
}

async function ifactStop() {
  const br = ifactBridge();
  if (!br || !IFACT.job || IFACT.stopping) return;
  IFACT.stopping = true; ifactPaint();
  const res = await br.importFactsStop(IFACT.job.id).catch(() => null);
  IFACT.stopping = false;
  if (!res || !res.ok) ifactSetError(res && res.error, 'stop');
  ifactPaint();
  ifactSchedule();
}

async function ifactSave() {
  const br = ifactBridge();
  if (!br || !IFACT.job || IFACT.stage !== 'review') return;
  const ids = ifactApproved(IFACT.job.candidates, IFACT.ticks);
  if (!ids.length) return;
  IFACT.stage = 'saving'; IFACT.error = null; ifactPaint();
  const res = await br.importFactsSave(IFACT.job.id, ids).catch(ifactThrown);
  if (!res || !res.ok) { IFACT.stage = 'review'; ifactSetError(res && res.error, 'save', res && res.raw); ifactPaint(); return; }
  IFACT.result = res.result; IFACT.stage = 'done';
  const id = IFACT.job.id;
  ifactPaint();
  void br.importFactsForget(id).catch(() => null);
  IFACT.job = null;
  if (typeof toast === 'function') toast('Saved what you picked', ifactResultLine(res.result));
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const el = t.closest('[data-ifact]');
    if (!el) return;
    const act = el.getAttribute('data-ifact');
    if (act === 'backdrop') { if (t === el && ['pick', 'choose', 'done', 'error'].includes(IFACT.stage)) { e.preventDefault(); void ifactClose(); } return; }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (act === 'open:chatgpt') void ifactOpen('chatgpt', '', false);
    else if (act === 'close') void ifactClose();
    else if (act === 'pick') void ifactPick();
    else if (act === 'pick:file' || act === 'pick:folder') void ifactPick(act.slice(5));
    else if (act === 'ask:keep') { IFACT.asking = false; ifactPaint(); }
    else if (act === 'ask:discard') void ifactClose(true);
    else if (act === 'ask:review') { IFACT.asking = false; void ifactStop(); }
    else if (act === 'ask:save') { IFACT.asking = false; void ifactSave(); }
    else if (act === 'next') { if (IFACT.path) { IFACT.stage = 'choose'; IFACT.error = null; ifactPaint(); } }
    else if (act === 'start') void ifactStart();
    else if (act === 'stop') void ifactStop();
    else if (act === 'save') void ifactSave();
    else if (act === 'retry') { Object.assign(IFACT, ifactRetryState(IFACT)); ifactPaint(); }
    else if (act === 'all:on' || act === 'all:off') {
      IFACT.ticks = ifactSetAll(IFACT.job && IFACT.job.candidates, act === 'all:on'); ifactPaint();
    }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.getAttribute || !IFACT.open) return;
    const tick = t.getAttribute('data-ifact-tick');
    if (tick) { IFACT.ticks = Object.assign({}, IFACT.ticks, {[tick]: t.checked}); ifactPaint(); return; }
    const field = t.getAttribute('data-ifact-field');
    if (field === 'cloud') { IFACT.cloudOn = t.checked; IFACT.error = null; ifactPaint(); }
    else if (field === 'provider') { IFACT.cloudProvider = t.value; }
  });
  // While the step is open, keys stay in it: the settings pane and the setup screen behind do not see them.
  window.addEventListener('keydown', (e) => {
    if (!IFACT.open) return;
    e.stopImmediatePropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (IFACT.asking) { IFACT.asking = false; ifactPaint(); }   // Escape answers the question with its default
      else if (['pick', 'choose', 'done', 'error'].includes(IFACT.stage)) void ifactClose();
    }
  }, true);
  document.addEventListener('visibilitychange', () => { if (IFACT.open) ifactSchedule(); });
}

if (typeof module !== 'undefined') {
  module.exports = {IFACT_POLL_MS, IFACT_CLOUD_WARNING, IFACT_CHATGPT_HINT, ifactSupported, ifactEnded, ifactStageFor, ifactProgressLine,
    ifactProgressPct, ifactModelLine, ifactTicksFor, ifactToggle, ifactSetAll, ifactApproved, ifactResultLine, ifactShouldPoll,
    ifactKeyWords, ifactRetryState, ifactStartInput, ifactEntryHTML, ifactBodyHTML};
}
