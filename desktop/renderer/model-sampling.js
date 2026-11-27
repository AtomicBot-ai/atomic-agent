/* ---------------- ATO-2482: Settings › Models › Sampling ----------------
   Loaded before renderer.js; declares only. One card under Reasoning for the
   model the local server runs: "Sampling: Model default / Custom" (as Jan and
   Goose show per-model settings), and when Custom, the person's own values
   for thinking on and thinking off. The agent owns the data: main runs
   `atag models sampling <id> --json` to read, `--set <json>` / `--reset` to
   write (main/model-sampling-ipc.ts). The second row is the agent's switch
   for the model's own recommended values (`localModels.modelSampling`).
   The pure part is shared with the Node checks (test/model-sampling.test.mjs);
   the pane part at the bottom calls renderer.js helpers at click and paint time. */

const MS_FIELDS = [
  {key: 'temperature', label: 'Temperature', min: 0, max: 5, step: 0.05, int: false, range: 'from 0 to 5'},
  {key: 'topP', label: 'Top P', min: 0, max: 1, step: 0.05, int: false, range: 'above 0, up to 1', above: true},
  {key: 'topK', label: 'Top K', min: 0, max: 1000, step: 1, int: true, range: 'a whole number, 0 or more'},
  {key: 'minP', label: 'Min P', min: 0, max: 1, step: 0.01, int: false, range: 'from 0 to 1'},
];
const MS_MODES = [['thinking', 'Thinking on'], ['noThinking', 'Thinking off']];
/* The agent's built-in values (src/llm/model-sampling-fields.ts BUILT_IN_SAMPLING). */
const MS_BUILT_IN = {temperature: 0.2, topP: 0.95, topK: 40};

/* One mode of a stored set: its own fields over the shared ones. */
function msForMode(set, mode) {
  if (!set || typeof set !== 'object') return {};
  const out = {};
  const sub = set[mode] && typeof set[mode] === 'object' ? set[mode] : {};
  for (const f of MS_FIELDS) {
    const v = sub[f.key] !== undefined ? sub[f.key] : set[f.key];
    if (typeof v === 'number' && Number.isFinite(v)) out[f.key] = v;
  }
  return out;
}

/* What one mode runs with, as the agent decides it: the person's values,
   then the model's own (only when the switch is on), then the built-ins. */
function msShownFor(report, mode) {
  const own = msForMode(report && report.custom, mode);
  const model = report && report.modelSampling
    ? Object.assign({}, report.file || {}, msForMode(report.catalog, mode))
    : {};
  const out = {};
  for (const f of MS_FIELDS) {
    const v = own[f.key] !== undefined ? own[f.key] : model[f.key] !== undefined ? model[f.key] : MS_BUILT_IN[f.key];
    if (v !== undefined) out[f.key] = v;
  }
  return out;
}

/* The editor's boxes: the person's own values only, as text; a box left
   empty keeps the model's value, which its placeholder shows. */
function msDraftFromReport(report) {
  const draft = {};
  for (const [mode] of MS_MODES) {
    const own = msForMode(report && report.custom, mode);
    draft[mode] = {};
    for (const f of MS_FIELDS) draft[mode][f.key] = own[f.key] === undefined ? '' : String(own[f.key]);
  }
  return draft;
}

/* What an empty box falls back to: the value without the person's set. */
function msPlaceholder(report, mode, key) {
  const v = msShownFor(Object.assign({}, report || {}, {custom: null}), mode)[key];
  return v === undefined ? '' : String(v);
}

/* A plain sentence for the first value out of range, or null. */
function msValidate(draft) {
  for (const [mode, modeLabel] of MS_MODES) {
    for (const f of MS_FIELDS) {
      const raw = String((draft && draft[mode] && draft[mode][f.key]) || '').trim();
      if (raw === '') continue;
      const n = Number(raw);
      const bad = !Number.isFinite(n) || n < f.min || n > f.max || (f.int && !Number.isInteger(n)) || (f.above && n <= f.min);
      if (bad) return modeLabel + ': ' + f.label + ' is ' + f.range + '.';
    }
  }
  return null;
}

/* The set `--set` writes: one object per mode, blank fields left out. */
function msSetFromDraft(draft) {
  const out = {};
  for (const [mode] of MS_MODES) {
    const sub = {};
    for (const f of MS_FIELDS) {
      const raw = String((draft && draft[mode] && draft[mode][f.key]) || '').trim();
      if (raw !== '') sub[f.key] = Number(raw);
    }
    if (Object.keys(sub).length) out[mode] = sub;
  }
  return out;
}

/* "temperature 0.7, top P 0.8" for the summary line. */
function msDescribe(values) {
  const parts = MS_FIELDS.filter((f) => values[f.key] !== undefined).map((f) => f.label + ' ' + values[f.key]);
  return parts.length ? parts.join(', ') : 'built-in values';
}

if (typeof module !== 'undefined') {
  module.exports = {MS_FIELDS, MS_BUILT_IN, msForMode, msShownFor, msDraftFromReport, msPlaceholder, msValidate, msSetFromDraft, msDescribe};
}

/* ---- the pane (renderer only; uses renderer.js globals at call time) ---- */

/* status: idle | loading | ready | error | older. */
const MS = {id: null, status: 'idle', report: null, error: null, editing: false, draft: null, busy: false, note: null, invalid: null};

function msModelId() {
  const lm = llmLocalModels();
  return lm.mode === 'managed' && llmManaged().modelId ? String(llmManaged().modelId) : null;
}

async function msLoad(id) {
  if (!BR || !BR.modelSamplingGet) return;
  MS.id = id; MS.status = 'loading'; MS.error = null; MS.editing = false;
  const res = await BR.modelSamplingGet(id);
  if (MS.id !== id) return; // the model changed while it read
  if (res && res.ok && res.report) { MS.status = 'ready'; MS.report = res.report; MS.draft = msDraftFromReport(res.report); }
  else if (res && res.older) MS.status = 'older';
  else { MS.status = 'error'; MS.error = (res && res.error) || 'No answer from the agent.'; }
  llmRepaint();
}

function msInputHTML(mode, f) {
  const v = MS.draft && MS.draft[mode] ? MS.draft[mode][f.key] : '';
  return '<input class="tk-input ms-input" type="number" inputmode="decimal" data-ms="' + mode + ':' + f.key + '"'
    + ' min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" value="' + esc(v) + '"'
    + ' placeholder="' + esc(msPlaceholder(MS.report, mode, f.key)) + '"'
    + ' aria-label="' + esc(f.label + ', ' + (mode === 'thinking' ? 'thinking on' : 'thinking off')) + '"'
    + (MS.busy ? ' disabled' : '') + '>';
}

function msEditorHTML() {
  return '<div class="ms-grid" role="group" aria-label="Your sampling values">'
    + '<span></span>' + MS_MODES.map(([, label]) => '<span class="ms-col">' + esc(label) + '</span>').join('')
    + MS_FIELDS.map((f) => '<span class="ms-row">' + esc(f.label) + '</span>'
        + MS_MODES.map(([mode]) => msInputHTML(mode, f)).join('')).join('')
    + '</div>'
    + (MS.invalid ? '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(MS.invalid) + '</span></div>' : '')
    + '<div class="ms-actions"><span class="tk-help">An empty box keeps the value shown in grey.</span><span class="grow"></span>'
    + (MS.report && MS.report.source === 'custom' ? '' : '<button class="btn btn-g sm" data-act="llm:ms:cancel"' + (MS.busy ? ' disabled' : '') + '>Cancel</button>')
    + '<button class="btn btn-p sm" data-act="llm:ms:save"' + (MS.busy ? ' disabled' : '') + '>Save</button></div>';
}

function msSummaryHTML(report) {
  return MS_MODES.map(([mode, label]) => '<div class="tk-help">' + esc(label) + ': ' + esc(msDescribe(msShownFor(report, mode))) + '</div>').join('');
}

/* Local models › Sampling, under Reasoning. '' when no managed model is picked. */
function msSectionHTML() {
  const id = msModelId();
  if (!id || !BR || !BR.modelSamplingGet) return '';
  if (MS.id !== id) { MS.id = id; MS.status = 'idle'; MS.report = null; MS.note = null; MS.invalid = null; }
  if (MS.status === 'idle') { MS.status = 'loading'; setTimeout(() => msLoad(id), 0); }
  const head = '<section class="llm-section llm-tune"><div class="tk-sh llm-sh"><span class="llm-sh-t">Sampling</span>'
    + (MS.busy || MS.status === 'loading' || MS.status === 'idle' ? '<span class="tk-spin"></span>' : '') + '</div><div class="llm-tune-card">';
  let body;
  if (MS.status === 'loading' || MS.status === 'idle') {
    body = llmTuneRowHTML('Sampling', 'Reading this model’s sampling…', '');
  } else if (MS.status === 'older') {
    body = llmTuneRowHTML('Sampling', 'This agent cannot set sampling per model yet. Update it to choose your own values.', '');
  } else if (MS.status === 'error') {
    body = '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">Couldn’t read this model’s sampling.'
      + '<details class="ms-details"><summary>Details</summary><span class="mono">' + esc(MS.error || '') + '</span></details></span>'
      + '<button class="llm-link" data-act="llm:ms:retry">Try again</button></div>';
  } else {
    const r = MS.report;
    const custom = r.source === 'custom' || MS.editing;
    body = llmTuneRowHTML('Sampling', 'Model default uses the values below. Custom keeps your own values for this model only.',
        msSegHTML(custom ? 'custom' : 'default'))
      + (custom ? msEditorHTML() : msSummaryHTML(r))
      + llmTuneRowHTML('Use the model’s recommended values', 'On, the model runs with the values its authors suggest. Off, it runs with the app’s built-in values (temperature 0.2), which keep tool calls steady. Your own values apply either way.',
        '<span class="tk-seg llm-tuneseg" role="group" aria-label="Use the model’s recommended values">'
          + [['off', 'Off'], ['on', 'On']].map(([v, t]) => {
            const on = (v === 'on') === !!r.modelSampling;
            return '<button class="' + (on ? 'on' : '') + '" aria-pressed="' + on + '" data-act="llm:ms:own:' + v + '"' + (MS.busy ? ' disabled' : '') + '>' + t + '</button>';
          }).join('') + '</span>');
  }
  return head + body + '</div>' + (MS.note ? restartLine(MS.note) : '') + '</section>';
}

function msSegHTML(cur) {
  return '<span class="tk-seg llm-tuneseg" role="group" aria-label="Sampling">'
    + [['default', 'Model default'], ['custom', 'Custom']].map(([v, t]) => '<button class="' + (v === cur ? 'on' : '') + '" aria-pressed="' + (v === cur) + '" data-act="llm:ms:mode:' + v + '"'
      + (MS.busy ? ' disabled' : '') + '>' + t + '</button>').join('') + '</span>';
}

/* Keep what was typed across repaints. */
if (typeof document !== 'undefined') {
  document.addEventListener('input', (e) => {
    const t = e.target;
    const key = t && t.dataset ? t.dataset.ms : null;
    if (!key || !MS.draft) return;
    const [mode, field] = key.split(':');
    if (MS.draft[mode]) MS.draft[mode][field] = t.value;
  });
}

async function msWrite(id, set, said) {
  MS.busy = true; MS.note = null; llmRepaint();
  const res = await BR.modelSamplingSet(id, set);
  MS.busy = false;
  if (!res || !res.ok || !res.report) {
    MS.status = 'error'; MS.error = (res && res.error) || 'The agent did not save it.';
    llmRepaint(); return;
  }
  await refreshLiveConfig();
  MS.report = res.report; MS.status = 'ready'; MS.editing = false; MS.invalid = null;
  MS.draft = msDraftFromReport(res.report);
  MS.note = said;
  llmRepaint();
}

/* `llm:ms:<verb>[:<arg>]` from renderer.js's llm act switch. */
async function msAct(verb, arg) {
  const id = msModelId();
  if (!id || !BR || MS.busy) return;
  if (verb === 'retry') { MS.status = 'idle'; llmRepaint(); return; }
  if (MS.status !== 'ready' || !MS.report) return;
  if (verb === 'mode' && arg === 'custom') {
    if (MS.report.source !== 'custom' && !MS.editing) { MS.editing = true; MS.draft = msDraftFromReport(MS.report); MS.invalid = null; llmRepaint(); }
    return;
  }
  if (verb === 'mode' && arg === 'default') {
    if (MS.editing && MS.report.source !== 'custom') { MS.editing = false; llmRepaint(); return; }
    if (MS.report.source === 'custom') await msWrite(id, null, 'Sampling: model default.');
    return;
  }
  if (verb === 'cancel') { MS.editing = false; MS.invalid = null; llmRepaint(); return; }
  if (verb === 'save') {
    if (!MS.draft) MS.draft = msDraftFromReport(MS.report);
    MS.invalid = msValidate(MS.draft);
    if (MS.invalid) { llmRepaint(); return; }
    const set = msSetFromDraft(MS.draft);
    await msWrite(id, Object.keys(set).length ? set : null, Object.keys(set).length ? 'Sampling: custom.' : 'Sampling: model default.');
    return;
  }
  if (verb === 'own' && (arg === 'on' || arg === 'off')) {
    if ((arg === 'on') === !!MS.report.modelSampling) return;
    MS.busy = true; llmRepaint();
    const res = await BR.configSet('localModels.modelSampling', arg === 'on' ? 'true' : 'false');
    MS.busy = false;
    if (!res || res.ok === false) { MS.status = 'error'; MS.error = llmFail('localModels.modelSampling write failed', res); llmRepaint(); return; }
    await refreshLiveConfig();
    MS.note = 'The model’s recommended values: ' + arg + '.';
    MS.status = 'idle'; // read the report again: what the model runs with changed
    llmRepaint();
  }
}
