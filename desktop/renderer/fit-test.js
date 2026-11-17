/* ---------------- Find the best model for my tasks (ATO-1091) ----------------
   Loaded before renderer.js; declares only, reads renderer.js globals (BR, LLMP,
   esc, ic, toast, modelWord, llmManaged, llmLocalActive, llmUseLocalModel,
   llmTurnsRunning, llmRefresh, llmRepaint) at run time, guarded,
   so the Node tests can load it (test/fit-test.test.mjs).

   Settings › Models › Local models gets one more card under the list: the
   agent runs the person's last few tasks on 2 or 3 of their downloaded local
   models, a judge model grades the answers, and the result says which model
   got the most right, how fast each was and how much memory it needed, with
   "Switch to this model" on each row. The agent does all of that
   (`atag models fit-test`, ATO-1090); main runs it (fit-test-ipc.ts) and reads
   its JSON (fit-test.ts, which has the contract). The card only shows when
   the agent has the subcommand.

   The run, its progress and the result draw into this file's own #fittest
   layer, so a progress tick never repaints the models page. Switch is the
   page's own Use (llmUseLocalModel): the model written, the server restarted
   on it. */

const FIT_MAX_MODELS = 3;
const FIT_REPROBE_MS = 60000;

const FIT = {
  supported: null, probedAt: 0, probing: false,
  phase: 'idle',       // idle | running | cancelling
  progress: null, result: null, error: null, note: null,
  open: false, switching: null, unsub: null,
  judges: [], judge: null,   // who grades: the person picks one (the judge reads their tasks)
};

/* ---------- pure helpers ---------- */

/** "80%" from 0..1, '' for nothing. */
function fitPercent(a) {
  return typeof a === 'number' && Number.isFinite(a) ? Math.round(Math.max(0, Math.min(1, a)) * 100) + '%' : '';
}
/** "8 of 10" when the counts are known, else the percent, else "Not measured". */
function fitRightWords(m) {
  if (m && typeof m.passed === 'number' && typeof m.total === 'number' && m.total > 0) return m.passed + ' of ' + m.total;
  return fitPercent(m && m.accuracy) || 'Not measured';
}
/** "12 s per task", "1 min 5 s per task", "25 tokens a second", or "Not measured". */
function fitSpeedWords(m) {
  const s = m && typeof m.avgSeconds === 'number' && m.avgSeconds >= 0 ? m.avgSeconds : null;
  if (s !== null) {
    if (s < 10) return (Math.round(s * 10) / 10) + ' s per task';
    const r = Math.round(s);
    if (r < 60) return r + ' s per task';
    const min = Math.floor(r / 60), sec = r % 60;
    return min + ' min' + (sec ? ' ' + sec + ' s' : '') + ' per task';
  }
  const t = m && typeof m.tokensPerSec === 'number' && m.tokensPerSec > 0 ? m.tokensPerSec : null;
  return t !== null ? Math.round(t) + ' tokens a second' : 'Not measured';
}
/** "5.2 GB", "12 GB", "640 MB", or "Not measured". */
function fitMemoryWords(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return 'Not measured';
  const gb = bytes / 1024 ** 3;
  if (gb < 1) return Math.max(1, Math.round(bytes / 1024 ** 2)) + ' MB';
  return (gb < 10 ? Math.round(gb * 10) / 10 : Math.round(gb)) + ' GB';
}
function fitFinished(m) { return !!m && !m.error && typeof m.accuracy === 'number'; }
/** Best first: finished before unfinished, most right answers, then faster, then less memory. */
function fitRank(models) {
  const list = Array.isArray(models) ? models.slice() : [];
  const val = (v) => (typeof v === 'number' ? v : Infinity);
  return list.sort((a, b) => (fitFinished(b) - fitFinished(a))
    || ((b.accuracy || 0) - (a.accuracy || 0))
    || (val(a.avgSeconds) - val(b.avgSeconds))
    || (val(a.peakMemoryBytes) - val(b.peakMemoryBytes)));
}
/** The agent's winner when that model finished, else the best ranked one that did, else null. */
function fitWinnerId(result) {
  const models = result && Array.isArray(result.models) ? result.models : [];
  const said = models.find((m) => m.id === (result && result.winner));
  if (fitFinished(said)) return said.id;
  const top = fitRank(models)[0];
  return fitFinished(top) ? top.id : null;
}
/** The one line over the table. */
function fitSummary(result, nameOf, currentId) {
  const id = fitWinnerId(result);
  if (!id) return 'No model finished the test, so there is nothing to compare.';
  const m = result.models.find((x) => x.id === id);
  const name = nameOf(m);
  return name + ' did best on your tasks: ' + fitRightWords(m) + ' right, ' + fitSpeedWords(m) + ', '
    + fitMemoryWords(m.peakMemoryBytes) + ' of memory.'
    + (id === currentId ? ' It is the model you use now.' : '');
}
/** What the run is doing now. */
function fitProgressLine(p, nameOf) {
  if (!p) return 'Starting the test…';
  if (p.phase === 'collecting') return 'Collecting your recent tasks…';
  const name = p.model ? nameOf({id: p.model}) : 'the next model';
  const which = typeof p.modelIndex === 'number' && typeof p.models === 'number' ? ' (model ' + p.modelIndex + ' of ' + p.models + ')' : '';
  if (p.phase === 'loading') return 'Loading ' + name + which + '…';
  if (p.phase === 'judging') return 'Checking the answers of ' + name + which + '…';
  const task = typeof p.task === 'number' && typeof p.tasks === 'number' ? ': task ' + p.task + ' of ' + p.tasks : '';
  return 'Testing ' + name + which + task + '…';
}
/** 0..1 for the bar, null when the agent has not said how far it is. */
function fitProgressFraction(p) {
  if (!p || typeof p.modelIndex !== 'number' || typeof p.models !== 'number' || p.models <= 0) return null;
  const inModel = typeof p.task === 'number' && typeof p.tasks === 'number' && p.tasks > 0
    ? Math.max(0, Math.min(1, (p.task - 1) / p.tasks)) : 0;
  return Math.max(0, Math.min(1, (Math.max(1, p.modelIndex) - 1 + inModel) / p.models));
}
/** The models to test: the one in use first, then the other downloaded ones in the page's order, up to 3. */
function fitPickModels(local, currentId) {
  const ids = (Array.isArray(local) ? local : []).filter((m) => m && m.downloaded && typeof m.id === 'string').map((m) => m.id);
  const ordered = currentId && ids.includes(currentId) ? [currentId].concat(ids.filter((id) => id !== currentId)) : ids;
  return ordered.slice(0, FIT_MAX_MODELS);
}

/** The line under the judge picker: where the tasks go. */
function fitJudgeNote(judge, word) {
  if (!judge) return 'The judge reads your tasks and the replies to grade them, so you choose who it is.';
  return judge.local
    ? 'Your tasks and the replies stay on this computer: ' + word + ' grades them.'
    : 'Your recent tasks and the models\u2019 replies are sent to ' + word + ' to be graded.';
}
function fitJudgeHTML(st, ctx, h) {
  const esc = h.esc;
  const judges = Array.isArray(st.judges) ? st.judges : [];
  if (!judges.length) return '<p class="llm-note">To grade the answers, add a cloud provider, or an app like Ollama or LM Studio under Custom.</p>';
  const picked = judges.find((j) => j.id === st.judge) || null;
  return '<label class="fit-judge"><span class="tk-lbl">Who grades the answers</span>'
    + '<select class="tk-inp" data-fit-judge aria-label="Who grades the answers">'
    + '<option value=""' + (picked ? '' : ' selected') + '>Choose…</option>'
    + judges.map((j) => '<option value="' + esc(j.id) + '"' + (picked && picked.id === j.id ? ' selected' : '') + '>'
      + esc(ctx.judgeWord(j.id) + ' \u00b7 ' + j.model + (j.local ? ' (on this computer)' : '')) + '</option>').join('')
    + '</select></label>'
    + '<p class="llm-note">' + esc(fitJudgeNote(picked, picked ? ctx.judgeWord(picked.id) : '')) + '</p>';
}

function fitEntryHTML(st, downloaded, ctx, h) {
  if (st.supported !== true) return '';
  const esc = h.esc;
  const running = st.phase !== 'idle';
  let body;
  if (running) {
    body = '<p class="fit-line"><span class="tk-spin"></span>' + esc(fitProgressLine(st.progress, ctx.nameOf)) + '</p>'
      + '<div class="fit-acts"><button class="btn btn-s sm" type="button" data-fit="open">Show progress</button>'
      + '<button class="btn sm" type="button" data-fit="cancel"' + (st.phase === 'cancelling' ? ' disabled' : '') + '>'
      + (st.phase === 'cancelling' ? 'Stopping…' : 'Cancel') + '</button></div>';
  } else {
    const few = downloaded < 2;
    const noJudge = !(Array.isArray(st.judges) && st.judges.some((j) => j.id === st.judge));
    body = (st.result ? '<p class="fit-line">' + esc(fitSummary(st.result, ctx.nameOf, ctx.currentId)) + '</p>' : '')
      + fitJudgeHTML(st, ctx, h)
      + '<div class="fit-acts">'
      + (st.result ? '<button class="btn btn-s sm" type="button" data-fit="open">Show results</button>' : '')
      + '<button class="btn ' + (st.result ? 'sm' : 'btn-p sm') + '" type="button" data-fit="start"' + (few || noJudge ? ' disabled' : '') + '>'
      + (st.result ? 'Run again' : 'Find the best model') + '</button></div>'
      + (few ? '<p class="llm-note">Download at least two local models to compare them.</p>' : '');
  }
  return '<section class="llm-section fit-entry"><div class="tk-sh llm-sh"><span class="llm-sh-t">Find the best model for my tasks</span></div>'
    + '<div class="fit-card">'
    + '<p class="llm-note">Runs your last 10 tasks on up to ' + FIT_MAX_MODELS + ' of your downloaded models, one at a time, and shows which one gets the most right, how fast it is and how much memory it needs. Local chats pause while it runs, and anything a task would change outside is refused.</p>'
    + body
    + (st.error ? '<p class="llm-note fit-err" role="alert">' + esc(st.error) + '</p>' : '')
    + (st.note ? '<p class="llm-note">' + esc(st.note) + '</p>' : '')
    + '</div></section>';
}

function fitRowHTML(m, ctx, winner, switching, h) {
  const esc = h.esc;
  const name = ctx.nameOf(m);
  const current = m.id === ctx.currentId;
  let act;
  if (current) act = '<span class="fit-chip">In use</span>';
  else if (!fitFinished(m)) act = '';
  else if (switching === m.id) act = '<button class="btn sm" type="button" disabled>Switching…</button>';
  else act = '<button class="btn ' + (m.id === winner ? 'btn-p ' : '') + 'sm" type="button" data-fit="use:' + esc(m.id) + '"'
    + (switching ? ' disabled' : '') + '>Switch to this model</button>';
  const cells = fitFinished(m)
    ? '<td>' + esc(fitRightWords(m)) + '</td><td>' + esc(fitSpeedWords(m)) + '</td><td>' + esc(fitMemoryWords(m.peakMemoryBytes)) + '</td>'
    : '<td colspan="3" class="fit-dnf">Did not finish' + (m.error ? ': ' + esc(m.error) : '') + '</td>';
  return '<tr' + (m.id === winner ? ' class="is-best"' : '') + '><th scope="row"><span class="fit-name">' + esc(name) + '</span>'
    + (m.id === winner ? '<span class="fit-chip fit-chip--best">Best fit</span>' : '') + '</th>'
    + cells + '<td class="fit-act">' + act + '</td></tr>';
}

function fitDialogHTML(st, ctx, h) {
  if (!st.open) return '';
  const esc = h.esc;
  const running = st.phase !== 'idle';
  let body, foot;
  if (running) {
    const f = fitProgressFraction(st.progress);
    body = '<p class="fit-line"><span class="tk-spin"></span>' + esc(fitProgressLine(st.progress, ctx.nameOf)) + '</p>'
      + (f === null ? '' : '<div class="fit-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(f * 100) + '"><span style="width:' + Math.round(f * 100) + '%"></span></div>')
      + '<p class="tk-help">This takes a few minutes per model. You can close this window; the test keeps running.</p>';
    foot = '<button class="btn sm" type="button" data-fit="close">Close</button>'
      + '<button class="btn sm" type="button" data-fit="cancel"' + (st.phase === 'cancelling' ? ' disabled' : '') + '>' + (st.phase === 'cancelling' ? 'Stopping…' : 'Cancel test') + '</button>';
  } else if (st.result) {
    const winner = fitWinnerId(st.result);
    body = '<p class="fit-line">' + esc(fitSummary(st.result, ctx.nameOf, ctx.currentId)) + '</p>'
      + '<div class="fit-tablewrap"><table class="fit-table"><thead><tr><th scope="col">Model</th><th scope="col">Right answers</th>'
      + '<th scope="col">Speed</th><th scope="col">Memory</th><th scope="col" aria-label="Switch"></th></tr></thead><tbody>'
      + fitRank(st.result.models).map((m) => fitRowHTML(m, ctx, winner, st.switching, h)).join('')
      + '</tbody></table></div>'
      + '<p class="tk-help">Right answers: tasks the judge scored 4 or 5 out of 5. Speed: how long one task took on average. Memory: the most the model used while it ran.</p>'
      + (st.error ? '<p class="tk-help tk-help--err" role="alert">' + esc(st.error) + '</p>' : '');
    foot = '<button class="btn sm" type="button" data-fit="close">Close</button>'
      + '<button class="btn sm" type="button" data-fit="start">Run again</button>';
  } else {
    body = '<p class="tk-help">' + esc(st.error || st.note || 'No result yet.') + '</p>';
    foot = '<button class="btn sm" type="button" data-fit="close">Close</button>';
  }
  return '<div class="sheetwrap fit-wrap" data-fit="backdrop"><div class="sheet fit-sheet" role="dialog" aria-modal="true" aria-label="Best model for your tasks">'
    + '<div class="sheethead"><span class="ttl">Best model for your tasks</span>'
      + '<button class="iconbtn" type="button" data-fit="close" aria-label="Close" title="Close">' + h.ic('x') + '</button></div>'
    + '<div class="fit-body">' + body + '</div>'
    + '<div class="sheetfoot">' + foot + '</div>'
    + '</div></div>';
}

/* ---------- the window ---------- */

function fitHelpers() {
  return {
    esc: typeof esc === 'function' ? esc : (s) => String(s),
    ic: typeof ic === 'function' ? ic : () => '',
  };
}
function fitBridge() { return typeof BR !== 'undefined' && BR && BR.fitTestSupported ? BR : null; }
function fitCurrentId() {
  if (typeof llmLocalActive === 'function' && !llmLocalActive()) return null;
  const m = typeof llmManaged === 'function' ? llmManaged() : null;
  return m && typeof m.modelId === 'string' ? m.modelId : null;
}
function fitCtx() {
  const local = typeof LLMP !== 'undefined' && Array.isArray(LLMP.local) ? LLMP.local : [];
  return {
    currentId: fitCurrentId(),
    judgeWord: (id) => (typeof providerWord === 'function' ? providerWord(id) : String(id)),
    nameOf: (m) => {
      if (m && m.name) return m.name;
      const row = local.find((x) => x && x.id === (m && m.id));
      if (row && row.name) return row.name;
      return typeof modelWord === 'function' ? modelWord(m && m.id) : String(m && m.id);
    },
  };
}
function fitDownloaded() {
  const local = typeof LLMP !== 'undefined' && Array.isArray(LLMP.local) ? LLMP.local : [];
  return local.filter((m) => m && m.downloaded).length;
}
function fitRepaintPane() { if (typeof llmRepaint === 'function') llmRepaint(); }

/** renderer.js llmLocalHTML: the card, '' while the agent has no fit-test. Asks the agent once a minute at most. */
function fitModelsPaneHTML() {
  if (!FIT.probing && Date.now() - FIT.probedAt > FIT_REPROBE_MS) void fitProbe();
  return fitEntryHTML(FIT, fitDownloaded(), fitCtx(), fitHelpers());
}
async function fitProbe() {
  const br = fitBridge();
  if (!br) { FIT.supported = false; FIT.probedAt = Date.now(); return; }
  FIT.probing = true;
  const yes = await br.fitTestSupported().catch(() => false);
  FIT.probing = false; FIT.probedAt = Date.now();
  const was = FIT.supported;
  // A run started on an agent that had it stays visible until it ends.
  FIT.supported = yes === true || FIT.phase !== 'idle';
  if (FIT.supported && br.fitTestJudges) {
    const judges = await br.fitTestJudges().catch(() => []);
    const before = JSON.stringify(FIT.judges);
    FIT.judges = Array.isArray(judges) ? judges : [];
    if (FIT.judge && !FIT.judges.some((j) => j.id === FIT.judge)) FIT.judge = null;
    if (before !== JSON.stringify(FIT.judges)) { fitRepaintPane(); return; }
  }
  if (was !== FIT.supported) fitRepaintPane();
}

function fitPaint() {
  const host = typeof document !== 'undefined' && document.getElementById('fittest');
  if (host) host.innerHTML = fitDialogHTML(FIT, fitCtx(), fitHelpers());
}
function fitPaintAll() { fitPaint(); fitRepaintPane(); }

async function fitStart() {
  const br = fitBridge();
  if (!br || FIT.phase !== 'idle') return;
  FIT.error = null; FIT.note = null;
  // The test loads other models on the local server: a turn it is answering would end.
  const held = typeof llmTurnsRunning === 'function' ? await llmTurnsRunning().catch(() => null) : null;
  if (held) {
    FIT.error = 'Not while the agent is answering: the test needs the local model server. Try again when the reply is done.';
    fitPaintAll();
    return;
  }
  const models = fitPickModels(typeof LLMP !== 'undefined' ? LLMP.local : [], fitCurrentId());
  FIT.phase = 'running'; FIT.progress = null; FIT.open = true; FIT.switching = null;
  if (!FIT.unsub && br.onFitTestProgress) FIT.unsub = br.onFitTestProgress((p) => { FIT.progress = p; fitPaintAll(); });
  fitPaintAll();
  const res = await br.fitTestStart({models, judge: FIT.judge}).catch((e) => ({ok: false, error: e && e.message ? e.message : String(e)}));
  FIT.phase = 'idle'; FIT.progress = null;
  if (res && res.ok && res.result) FIT.result = res.result;
  else if (res && res.cancelled) FIT.note = 'Test stopped. Your chats use the same model as before.';
  else FIT.error = (res && res.error) || 'The model test did not finish.';
  if (!(res && res.ok)) FIT.open = false;
  fitPaintAll();
  // The test moved the local server between models: the page reads where it is now.
  if (typeof llmRefresh === 'function') void llmRefresh();
  if (res && res.ok && !FIT.open && typeof toast === 'function') toast('Model test finished', 'Open Settings › Models to see the results.');
}
/* While a test runs, the local model server is the test's: it stops it and
   loads other models on it, so a chat message on the local model would go to
   a test model or to a stopped server. Send holds it in the box, the way the
   starter model's download does (starter-chat.js starterHoldsSend), until the
   run is over, a cancel's put-back included. A chat on a cloud model, or on
   the person's own server (custom), does not use that server and goes through. */
const FIT_HOLD_TITLE = 'A model test is running';
const FIT_HOLD_TEXT = 'Chat is back when it ends or you cancel it. Your message stays in the box.';
function fitHoldsSendFor(phase, backend) {
  return phase !== 'idle' && backend !== 'cloud' && backend !== 'custom';
}
/** renderer submit: is Send held by a running fit-test? */
function fitHoldsSend() {
  return fitHoldsSendFor(FIT.phase, typeof selBackend === 'function' ? selBackend() : null);
}
async function fitCancel() {
  const br = fitBridge();
  if (!br || FIT.phase !== 'running') return;
  FIT.phase = 'cancelling'; fitPaintAll();
  await br.fitTestCancel().catch(() => null);
}
async function fitUse(id) {
  if (FIT.switching || typeof llmUseLocalModel !== 'function') return;
  FIT.switching = id; FIT.error = null; fitPaint();
  const ok = await llmUseLocalModel(id).catch(() => false);
  // Use refreshes the page without waiting; the table's "In use" reads the config it brings back.
  if (ok && typeof llmRefresh === 'function') await Promise.resolve(llmRefresh()).catch(() => null);
  FIT.switching = null;
  const name = fitCtx().nameOf({id});
  if (!ok) FIT.error = 'Could not switch to ' + name + '. The reason is at the top of Settings › Models.';
  else if (typeof toast === 'function') toast(name + ' answers chats now.', '');
  fitPaintAll();
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const el = t.closest('[data-fit]');
    if (!el) return;
    const act = el.getAttribute('data-fit');
    if (act === 'backdrop') { if (t === el) { e.preventDefault(); FIT.open = false; fitPaint(); } return; }
    e.preventDefault();
    if (act === 'open') { FIT.open = true; fitPaint(); }
    else if (act === 'close') { FIT.open = false; fitPaint(); }
    else if (act === 'start') void fitStart();
    else if (act === 'cancel') void fitCancel();
    else if (act.startsWith('use:')) void fitUse(act.slice(4));
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.hasAttribute || !t.hasAttribute('data-fit-judge')) return;
    FIT.judge = t.value || null;
    fitRepaintPane();
  });
  document.addEventListener('keydown', (e) => {
    if (!FIT.open || e.key !== 'Escape') return;
    e.preventDefault(); e.stopImmediatePropagation();
    FIT.open = false; fitPaint();
  }, true);
}

if (typeof module !== 'undefined') {
  module.exports = {FIT_MAX_MODELS, fitPercent, fitRightWords, fitSpeedWords, fitMemoryWords, fitFinished, fitRank, fitWinnerId,
    fitSummary, fitProgressLine, fitJudgeNote, fitJudgeHTML, fitProgressFraction, fitPickModels, fitEntryHTML, fitDialogHTML,
    FIT_HOLD_TITLE, FIT_HOLD_TEXT, fitHoldsSendFor, fitHoldsSend, fitStart, fitCancel};
}
