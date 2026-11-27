/* ---------------- Model servers running here (ATO-2489) ----------------
   Loaded before renderer.js; declares only and reads renderer.js globals
   (BR, OB, OB_CHOICES, KIND_ROWS, esc, ic, render, llmRepaint, ...) at run
   time, guarded, so the Node tests can load it (test/local-servers.test.mjs).

   What it shows: the model servers already running on this computer, from
   the core's own probe (`atag local-servers --json`, main/local-servers-ipc.ts):
   Ollama on 11434, LM Studio on 1234, the Llama app or a llama-server on 9931.

   Two places draw it:
   - Settings › Local: a "Running on this Mac" list. Each server says how many
     models it has and how many are loaded; Use connects it the way the app
     already connects that kind (the Ollama / LM Studio presets, or the
     External llama-server address for the Llama app).
   - Setup: the Custom card says what it found, the cursor starts on it, and
     picking it opens a step of its own that lists what runs (a choice when
     several do), with "Something else" for the full Custom list.

   ATO-2490: Manage on an Ollama or LM Studio row opens its models: Load,
   Unload, Free memory, Download, Delete (Ollama) and Use here, and the
   section offers Start for the one that is installed but not running.

   Precedent: OpenClaw finds the Llama app on 9931 and offers it first in
   onboarding; Continue, Open WebUI and Jan pick up a running Ollama or LM
   Studio; Cline shows what Ollama has in memory. */

const LSV = {
  /** idle | loading | ready | error | hidden (no route, or chats run on another computer). */
  phase: 'idle',
  servers: [],
  error: null,
  askedAt: 0,
  /** Setup: the server picked on the found step, for the closing line. */
  obPicked: null,
  /** Setup: the cursor was put on Custom once for this run of setup. */
  obCursorSet: false,
  /* ATO-2490: the Manage panel. */
  /** The kind whose model list is open ('ollama' | 'lmstudio'), or null. */
  open: null,
  /** The running action {action, kind, model, all, key}, or null. */
  act: null,
  /** A download's last step {status, completed, total}. */
  progress: null,
  /** The last action's outcome {kind, ok, text, detail}. */
  note: null,
  /** A model key waiting for "Yes, delete". */
  confirm: null,
  /** What is typed in each Download field, kept across repaints. */
  pull: {ollama: '', lmstudio: ''},
  unsub: null,
};

/** A Settings visit asks again when the last answer is older than this. */
const LSV_STALE_MS = 30000;

/* ---------- pure helpers ---------- */

/** "3 models, 1 loaded" (the core's describeDetectedServer words). */
function lsvFacts(server) {
  const n = (server && server.models ? server.models.length : 0);
  const parts = [n === 1 ? '1 model' : n + ' models'];
  const loaded = server && server.loaded ? server.loaded.length : 0;
  if (loaded > 0) parts.push(loaded + ' loaded');
  return parts.join(', ');
}

/** The short name a person knows the server by. */
function lsvName(server) {
  if (!server) return '';
  if (server.kind === 'llama-app') return 'Llama app';
  if (server.kind === 'lmstudio') return 'LM Studio';
  if (server.kind === 'ollama') return 'Ollama';
  return String(server.label || server.kind || '');
}

/** "127.0.0.1:11434". */
function lsvHost(url) {
  try { return new URL(url).host; } catch (e) { return String(url || ''); }
}

/** Two addresses of one server: localhost and 127.0.0.1 alike, a trailing / or /v1 ignored. */
function lsvSameUrl(a, b) {
  const norm = (u) => {
    try {
      const x = new URL(String(u || ''));
      const host = x.hostname === 'localhost' || x.hostname === '[::1]' ? '127.0.0.1' : x.hostname;
      return x.protocol + '//' + host + ':' + (x.port || (x.protocol === 'https:' ? '443' : '80'));
    } catch (e) { return ''; }
  };
  const na = norm(a);
  return !!na && na === norm(b);
}

/** "Found running here: Llama app, Ollama." for the setup's Custom card, '' when nothing. */
function lsvFoundSentence(servers) {
  const list = Array.isArray(servers) ? servers : [];
  if (!list.length) return '';
  return 'Found running here: ' + list.map(lsvName).join(', ') + '.';
}

/** The models line under a server: loaded ones first and marked, at most `max`. */
function lsvModelsLine(server, max) {
  const models = server && Array.isArray(server.models) ? server.models : [];
  if (!models.length) return '';
  const loaded = new Set(server.loaded || []);
  const ordered = models.filter((m) => loaded.has(m)).concat(models.filter((m) => !loaded.has(m)));
  const cap = max || 4;
  const shown = ordered.slice(0, cap).map((m) => loaded.has(m) ? m + ' (loaded)' : m);
  return shown.join(', ') + (ordered.length > cap ? ', and ' + (ordered.length - cap) + ' more' : '');
}

/**
 * Where a server stands in this app: 'in-use' (chats run on it now), 'added'
 * (set up, not in use) or 'new'. `ctx` is what renderer.js knows:
 * {activeId, providers: ids, localMode, localUrl}.
 */
function lsvStanding(server, ctx) {
  const c = ctx || {};
  if (server.presetId) {
    if (c.activeId === server.presetId) return 'in-use';
    return (c.providers || []).includes(server.presetId) ? 'added' : 'new';
  }
  const ours = c.localMode === 'external' && lsvSameUrl(c.localUrl, server.baseUrl);
  if (ours && c.activeId === 'local-llama') return 'in-use';
  return ours ? 'added' : 'new';
}

/* ---------- detection ---------- */

function lsvBridge() { return typeof BR !== 'undefined' && BR && typeof BR.localServersDetect === 'function' ? BR : null; }
function lsvRepaint() {
  if (typeof OB !== 'undefined' && OB && OB.open) { if (typeof render === 'function') render(); return; }
  if (typeof llmRepaint === 'function') llmRepaint();
}

/** Ask the agent what runs here. `force`: Check again, or a fresh visit. */
async function lsvDetect(force) {
  const br = lsvBridge();
  if (!br) { LSV.phase = 'hidden'; return; }
  if (LSV.phase === 'loading') return;
  if (!force && LSV.phase !== 'idle' && Date.now() - LSV.askedAt < LSV_STALE_MS) return;
  LSV.phase = 'loading'; LSV.error = null; LSV.askedAt = Date.now();
  // Only a click repaints now: the other callers are render paths, which draw "loading" themselves.
  if (force) lsvRepaint();
  const res = await Promise.resolve().then(() => br.localServersDetect()).catch(() => null);
  if (res && res.ok && Array.isArray(res.servers)) {
    LSV.servers = res.servers; LSV.phase = 'ready';
  } else if (res && (res.unsupported || res.remote)) {
    LSV.servers = []; LSV.phase = 'hidden';
  } else {
    LSV.phase = 'error';
    LSV.error = 'Could not look for running model servers.';
  }
  LSV.askedAt = Date.now();
  lsvAfterDetect();
  lsvRepaint();
}

/* ---------- Settings › Local ---------- */

/** What renderer.js knows about the active route, for lsvStanding. */
function lsvContext() {
  const ctx = {activeId: null, providers: [], localMode: null, localUrl: null};
  try {
    if (typeof llmActiveTextId === 'function') ctx.activeId = llmActiveTextId();
    if (typeof llmProviders === 'function') ctx.providers = llmProviders().map((p) => p.id);
    if (typeof llmLocalModels === 'function') { const lm = llmLocalModels(); ctx.localMode = lm.mode || null; ctx.localUrl = lm.url || null; }
  } catch (e) { /* the pane draws the rows as new */ }
  return ctx;
}

function lsvMark(server, size) {
  const key = server.kind === 'llama-app' ? 'llamacpp' : server.kind;
  const logo = typeof logoHTML === 'function' ? logoHTML(key, size) : '';
  return logo || (typeof markFallbackHTML === 'function' ? markFallbackHTML('server', size) : '');
}

/** One server's row. `h` = {esc, ctx, busy}. */
function lsvRowHTML(server, i, h) {
  const e = h.esc;
  const standing = lsvStanding(server, h.ctx);
  const models = lsvModelsLine(server, 4);
  const empty = !(server.models && server.models.length);
  const action = standing === 'in-use'
    ? '<span class="ann lit">In use</span>'
    : '<button class="btn btn-s sm" type="button" data-lsv="use:' + i + '"' + (h.busy ? ' disabled' : '') + '>'
      + (standing === 'added' ? 'Switch to it' : 'Use') + '</button>';
  const manageable = lsvManageable(server) && !!h.canAct;
  const open = manageable && h.st && h.st.open === server.kind;
  const manage = manageable
    ? '<button class="btn btn-g sm" type="button" data-lsv="manage:' + i + '" aria-expanded="' + (open ? 'true' : 'false') + '">'
      + (open ? 'Close' : 'Manage') + '</button>'
    : '';
  return '<div class="tuirow tk-li llm-row lsv-row" data-lsv-kind="' + e(server.kind) + '" title="' + e(server.baseUrl) + '">'
    + lsvMark(server, '')
    + '<span class="body"><span class="t"><span class="llm-name">' + e(lsvName(server)) + '</span>'
    + '<span class="ann lit lsv-on">Running</span></span>'
    + '<span class="d">' + e(lsvFacts(server) + ' · ' + lsvHost(server.baseUrl)) + '</span>'
    + (models ? '<span class="d lsv-models">' + e(models) + '</span>' : '')
    + (empty ? '<span class="d lsv-models">' + e(lsvEmptyServerWords(server)) + '</span>' : '')
    + '</span>' + manage + action + '</div>'
    + (open ? lsvManageHTML(server, i, h) : '');
}

/** A server that answers but has no model yet. */
function lsvEmptyServerWords(server) {
  if (server.kind === 'ollama') return 'No models yet. Pull one in Ollama, for example: ollama pull qwen3:8b';
  if (server.kind === 'lmstudio') return 'No models yet. Download one in LM Studio first.';
  return 'No model loaded yet. Load one in the Llama app first.';
}

/** The section: loading, error, empty and the list are one card shape. */
function lsvSectionHTML(st, h) {
  if (st.phase === 'hidden' || st.phase === 'idle') return '';
  const e = h.esc;
  const machine = h.machine || 'this computer';
  const loading = st.phase === 'loading';
  let body;
  if (loading && !st.servers.length) {
    body = '<p class="llm-note lsv-note"><span class="tk-spin"></span>Looking for Ollama, LM Studio and the Llama app…</p>';
  } else if (st.phase === 'error') {
    body = '<p class="llm-note lsv-note fit-err" role="alert">' + e(st.error || 'Could not look for running model servers.') + ' Press Check again.</p>';
  } else if (!st.servers.length) {
    body = '<p class="llm-note lsv-note">Nothing is running right now. Start Ollama, LM Studio or the Llama app, then press Check again.</p>';
  } else {
    const hs = Object.assign({}, h, {st: st});
    body = '<div class="tk-list llm-list">' + st.servers.map((s, i) => lsvRowHTML(s, i, hs)).join('') + '</div>';
  }
  if (st.phase !== 'error' && !(loading && !st.servers.length)) body += lsvStartHTML(st, h);
  return '<section class="llm-section lsv-sec" aria-busy="' + (loading ? 'true' : 'false') + '">'
    + '<div class="tk-sh llm-sh"><span class="llm-sh-t">Running on ' + e(machine) + '</span><span class="grow"></span>'
    + '<button class="btn btn-g sm" type="button" data-lsv="recheck"' + (loading ? ' disabled' : '') + '>'
    + (loading ? '<span class="tk-spin"></span>Checking…' : 'Check again') + '</button></div>'
    + '<p class="llm-note llm-sec-note">Model apps already running here. Use one without downloading anything.</p>'
    + body + '</section>';
}

/** renderer.js llmLocalHTML: the section, asked again on a fresh visit. */
function localServersPaneHTML() {
  if (!lsvBridge()) return '';
  if (LSV.phase !== 'loading' && Date.now() - LSV.askedAt >= LSV_STALE_MS) void lsvDetect(false);
  return lsvSectionHTML(LSV, {
    esc: typeof esc === 'function' ? esc : String,
    ctx: lsvContext(),
    busy: typeof LLMP !== 'undefined' && LLMP && !!LLMP.busy,
    machine: typeof THIS_MACHINE === 'string' ? THIS_MACHINE : 'this computer',
    canAct: lsvCanAct(),
  });
}

/** Use: the same paths the app's own Add buttons and address field take. */
function lsvUse(i) {
  const server = LSV.servers[i];
  if (!server) return;
  const standing = lsvStanding(server, lsvContext());
  if (server.presetId) {
    if (standing === 'added' && typeof llmSwitchProvider === 'function') { void llmSwitchProvider(server.presetId); return; }
    if (typeof llmAddApp === 'function') llmAddApp(server.presetId);
    return;
  }
  // The Llama app is the External llama-server, at the address that answered.
  if (typeof llmExternalSave !== 'function' || typeof LLMP === 'undefined') return;
  if (typeof llmSetMode === 'function') llmSetMode('external');
  LLMP.externalDraft = server.baseUrl;
  const field = typeof document !== 'undefined' ? document.getElementById('llm-url') : null;
  if (field) field.value = server.baseUrl;
  void llmExternalSave();
}

/* ---------- Manage: start, load, unload, download, delete, use here (ATO-2490) ----------
   The core does the work (`atag local-servers <action> ... --json`,
   main/local-servers-ipc.ts): Ollama through its own API (unload is
   keep_alive 0), LM Studio through its `lms` tool. "Use here" adds the
   model's file to Atomic Agent's local models without a new download, then
   switches to it through the app's own model pick (llmUseLocalModel).
   Precedent: LM Studio's My Models and Ollama's own menu; Gollama links
   Ollama's files for LM Studio the same way. */

const LSV_APPS = [{kind: 'ollama', name: 'Ollama'}, {kind: 'lmstudio', name: 'LM Studio'}];

function lsvCanAct() { return typeof BR !== 'undefined' && !!BR && typeof BR.localServersAct === 'function'; }

/** Ollama and LM Studio are managed from here; the Llama app manages its own models. */
function lsvManageable(server) { return !!server && (server.kind === 'ollama' || server.kind === 'lmstudio'); }

/** "2.1 of 5.0 GB (42%)", or the step's own words. */
function lsvProgressWords(p) {
  if (!p) return '';
  if (p.total && p.completed !== null && p.completed !== undefined) {
    const pct = Math.min(100, Math.floor((p.completed / p.total) * 100));
    return (p.completed / 1e9).toFixed(1) + ' of ' + (p.total / 1e9).toFixed(1) + ' GB (' + pct + '%)';
  }
  return String(p.status || '');
}

/** The sentence after an action worked. */
function lsvDoneWords(a) {
  const app = lsvName({kind: a.kind});
  switch (a.action) {
    case 'start': return app + ' is running.';
    case 'load': return a.model + ' is loaded in ' + app + '.';
    case 'unload': return a.all ? app + ' freed the memory of every model.' : a.model + ' is unloaded. Its memory is free.';
    case 'pull': return a.model + ' is downloaded in ' + app + '.';
    case 'rm': return a.model + ' is deleted from ' + app + '.';
    case 'adopt': return a.model + ' is added to Atomic Agent’s local models. No new download.';
    default: return 'Done.';
  }
}

/** The outcome line: a sentence, the app's own words behind Details. */
function lsvNoteHTML(note, e) {
  if (!note) return '';
  const detail = note.detail
    ? '<details class="lsv-detail"><summary>Details</summary><pre>' + e(note.detail) + '</pre></details>'
    : '';
  return '<div class="llm-note lsv-note' + (note.ok ? '' : ' fit-err') + '" role="' + (note.ok ? 'status' : 'alert') + '">'
    + e(note.text) + detail + '</div>';
}

/** One model under an open server. `j` its index in server.models. */
function lsvModelRowHTML(server, i, j, h) {
  const e = h.esc;
  const st = h.st || LSV;
  const m = server.models[j];
  const loaded = (server.loaded || []).includes(m);
  const key = server.kind + ':' + m;
  const act = st.act;
  const off = act || h.busy ? ' disabled' : '';
  const spin = (name) => act && act.key === key && act.action === name ? '<span class="tk-spin"></span>' : '';
  const btn = (name, label, cls, title) => '<button class="btn ' + (cls || 'btn-g') + ' sm" type="button" data-lsv="' + name + ':' + i + ':' + j + '"'
    + (title ? ' title="' + e(title) + '"' : '') + off + '>' + spin(name) + e(label) + '</button>';
  let acts;
  if (st.confirm === key) {
    acts = '<span class="lsv-ask">Delete ' + e(m) + ' from ' + e(lsvName(server)) + '?</span>'
      + btn('rmyes', 'Yes, delete', 'btn-danger') + '<button class="btn btn-g sm" type="button" data-lsv="rmno"' + off + '>Cancel</button>';
  } else {
    acts = (loaded ? btn('unload', 'Unload', '', 'Free its memory now') : btn('load', 'Load', '', 'Load it into memory now'))
      + btn('adopt', 'Use here', 'btn-s', 'Run it on Atomic Agent’s own engine, without downloading it again')
      + (server.kind === 'ollama' ? btn('rm', 'Delete', '', 'Delete it from Ollama') : '');
  }
  return '<div class="lsv-model"><span class="lsv-model-n">' + e(m) + (loaded ? ' <span class="ann lit">Loaded</span>' : '') + '</span>'
    + '<span class="lsv-acts">' + acts + '</span></div>';
}

/** The open server's panel: its models, Free memory, Download, and the last outcome. */
function lsvManageHTML(server, i, h) {
  const e = h.esc;
  const st = h.st || LSV;
  const act = st.act;
  const off = act || h.busy ? ' disabled' : '';
  const models = server.models || [];
  const loadedCount = (server.loaded || []).length;
  const pulling = act && act.action === 'pull' && act.kind === server.kind;
  const draft = (st.pull && st.pull[server.kind]) || '';
  const example = server.kind === 'ollama' ? 'qwen3:8b' : 'qwen/qwen3-8b';
  const list = models.length
    ? models.map((_, j) => lsvModelRowHTML(server, i, j, h)).join('')
    : '<p class="llm-note">No models yet. Download one below.</p>';
  const free = loadedCount
    ? '<button class="btn btn-g sm" type="button" data-lsv="freeall:' + i + '"' + off + '>'
      + (act && act.action === 'unload' && act.all && act.kind === server.kind ? '<span class="tk-spin"></span>' : '') + 'Free memory</button>'
    : '';
  const pull = pulling
    ? '<div class="lsv-pull" role="status"><span class="tk-spin"></span><span class="grow">Downloading ' + e(act.model) + '… '
      + e(lsvProgressWords(st.progress)) + '</span><button class="btn btn-g sm" type="button" data-lsv="stop">Stop</button></div>'
    : '<div class="lsv-pull"><input class="tk-inp mono lsv-pull-in" type="text" spellcheck="false" autocomplete="off" data-lsv-pull="' + e(server.kind) + '"'
      + ' aria-label="' + e('Model to download in ' + lsvName(server)) + '" placeholder="' + e('Model to download, for example ' + example) + '"'
      + ' value="' + e(draft) + '"' + off + '>'
      + '<button class="btn btn-s sm" type="button" data-lsv="pull:' + i + '"' + off + '>Download</button></div>';
  const note = st.note && st.note.kind === server.kind ? lsvNoteHTML(st.note, e) : '';
  return '<div class="lsv-manage" data-lsv-panel="' + e(server.kind) + '">'
    + '<div class="lsv-manage-h"><span class="grow">' + e(lsvName(server) + ' models') + '</span>' + free + '</div>'
    + list + pull + note + '</div>';
}

/** "Installed but not running?" with Start buttons for the apps that did not answer. */
function lsvStartHTML(st, h) {
  if (!h.canAct) return '';
  const e = h.esc;
  const missing = LSV_APPS.filter((a) => !st.servers.some((s) => s.kind === a.kind));
  if (!missing.length) return '';
  const act = st.act;
  const off = act || h.busy ? ' disabled' : '';
  const note = st.note && missing.some((a) => a.kind === st.note.kind) ? lsvNoteHTML(st.note, e) : '';
  return '<div class="lsv-start"><span class="llm-note">Installed but not running?</span>'
    + missing.map((a) => '<button class="btn btn-g sm" type="button" data-lsv="start:' + a.kind + '"' + off + '>'
      + (act && act.action === 'start' && act.kind === a.kind ? '<span class="tk-spin"></span>Starting…' : 'Start ' + e(a.name)) + '</button>').join('')
    + '</div>' + note;
}

/** Run one action, show its outcome, then look again. */
async function lsvAct(input) {
  const br = typeof BR !== 'undefined' ? BR : null;
  if (!br || typeof br.localServersAct !== 'function' || LSV.act) return null;
  if (typeof LLMP !== 'undefined' && LLMP && LLMP.busy) return null;
  const a = {action: input.action, kind: input.kind, model: input.model || null, all: input.all === true};
  LSV.act = Object.assign({key: a.model ? a.kind + ':' + a.model : a.kind}, a);
  LSV.note = null; LSV.progress = null; LSV.confirm = null;
  if (!LSV.unsub && typeof br.onLocalServersProgress === 'function') {
    LSV.unsub = br.onLocalServersProgress((p) => {
      if (!LSV.act || !p || p.kind !== LSV.act.kind) return;
      LSV.progress = p; lsvRepaint();
    });
  }
  lsvRepaint();
  let res = null;
  try { res = await br.localServersAct(a); } catch (err) { res = null; }
  LSV.act = null; LSV.progress = null;
  if (res && res.ok) {
    LSV.note = {kind: a.kind, ok: true, text: lsvDoneWords(a), detail: null};
    if (a.action === 'pull') LSV.pull[a.kind] = '';
  } else {
    LSV.note = {kind: a.kind, ok: false, text: (res && res.error) || 'Could not reach the agent.', detail: (res && res.detail) || null};
  }
  lsvRepaint();
  if (res && res.ok && a.action === 'adopt' && typeof res.id === 'string') {
    // The app's own pick: the composer locks for the restart and a running turn is refused, not cut off.
    if (typeof llmUseLocalModel === 'function') await llmUseLocalModel(res.id);
    else if (typeof llmRefresh === 'function') llmRefresh();
  }
  if (a.action !== 'adopt') void lsvDetect(true);
  return res;
}

/** A click on a [data-lsv] control of the Manage panel or the Start row. True when it was one. */
function lsvManageClick(act) {
  const parts = String(act).split(':');
  const name = parts[0];
  if (name === 'manage') {
    const s = LSV.servers[Number(parts[1])];
    if (!s) return true;
    LSV.open = LSV.open === s.kind ? null : s.kind; LSV.confirm = null;
    lsvRepaint(); return true;
  }
  if (name === 'start') { void lsvAct({action: 'start', kind: parts[1]}); return true; }
  if (name === 'stop') { if (typeof BR !== 'undefined' && BR && BR.localServersCancel) void BR.localServersCancel(); return true; }
  if (name === 'rmno') { LSV.confirm = null; lsvRepaint(); return true; }
  const s = LSV.servers[Number(parts[1])];
  if (!['load', 'unload', 'adopt', 'rm', 'rmyes', 'freeall', 'pull'].includes(name)) return false;
  if (!lsvManageable(s)) return true;
  if (name === 'freeall') { void lsvAct({action: 'unload', kind: s.kind, all: true}); return true; }
  if (name === 'pull') {
    const typed = String((LSV.pull && LSV.pull[s.kind]) || '').trim();
    if (!typed) { LSV.note = {kind: s.kind, ok: false, text: 'Type the name of a model to download first.', detail: null}; lsvRepaint(); return true; }
    void lsvAct({action: 'pull', kind: s.kind, model: typed}); return true;
  }
  const m = (s.models || [])[Number(parts[2])];
  if (!m) return true;
  if (name === 'rm') { LSV.confirm = s.kind + ':' + m; lsvRepaint(); return true; }
  void lsvAct({action: name === 'rmyes' ? 'rm' : name, kind: s.kind, model: m});
  return true;
}

/* ---------- setup ---------- */

/** After an answer: setup's cursor goes to Custom once, as the TUI's choice screen does (PR #1872). */
function lsvAfterDetect() {
  if (typeof OB === 'undefined' || !OB || !OB.open || OB.step !== 'choose') return;
  if (LSV.obCursorSet || !LSV.servers.length || OB.cursor !== 0) return;
  const at = typeof OB_CHOICES !== 'undefined' ? OB_CHOICES.findIndex((c) => c.id === 'custom') : -1;
  if (at < 0 || typeof obDispatch !== 'function') return;
  LSV.obCursorSet = true;
  obDispatch({type: 'onboarding_cursor_set', cursor: at});
}

/** renderer.js obChooseHTML: the Custom card's line when something runs here, else ''. Starts the probe. */
function lsvChoiceDetail(choice) {
  if (LSV.phase === 'idle') void lsvDetect(false);
  if (!choice || choice.id !== 'custom' || LSV.phase !== 'ready') return '';
  return lsvFoundSentence(LSV.servers);
}

/** renderer.js obPickBackend('custom'): the found step instead of the full list, when something runs. */
function lsvObOffer() {
  if (LSV.phase !== 'ready' || !LSV.servers.length || typeof obDispatch !== 'function') return false;
  LSV.obPicked = null;
  obDispatch({type: 'onboarding_step_set', step: 'found_server'});
  return true;
}

/** The found step's rows: every server, then the full Custom list. */
function lsvObRows() {
  return LSV.servers.map((s) => ({kind: 'server', server: s})).concat([{kind: 'other'}]);
}

function lsvObHTML() {
  const e = typeof esc === 'function' ? esc : String;
  const rows = lsvObRows();
  const machine = typeof THIS_MACHINE === 'string' ? THIS_MACHINE : 'this computer';
  const tick = typeof obTickHTML === 'function' ? obTickHTML() : '';
  const list = rows.map((r, i) => {
    const on = OB.cursor === i;
    if (r.kind === 'other') {
      return obRow(i, on, e('Something else'), e('Another app, your own llama.cpp server or any address'), '',
        ' title="' + e('Something else · press ' + (i + 1)) + '"',
        '<span class="tk-ico tk-ico--lg tk-ico--blue">' + ic('server') + '</span>', on ? tick : '');
    }
    const s = r.server;
    const models = lsvModelsLine(s, 3);
    return obRow(i, on, e(lsvName(s)) + ' <span class="ann lit lsv-on">Running</span>',
      e(lsvFacts(s) + ' · ' + lsvHost(s.baseUrl)) + (models ? '<br>' + e(models) : ''), '',
      ' title="' + e(lsvName(s) + ' · press ' + (i + 1)) + '"', lsvMark(s, 'lg'), on ? tick : '');
  }).join('');
  return '<div class="ob-explain">' + e((LSV.servers.length > 1 ? 'These are' : 'This is') + ' already running on ' + machine
      + '. Pick ' + (LSV.servers.length > 1 ? 'one' : 'it') + ' to use it. Nothing to download.') + '</div>'
    + '<div class="ob-list ob-routes lsv-ob">' + list + '</div>'
    + '<div class="ob-foot ob-actions">' + obBtn('nav:back', 'Back', 'btn-g', false, 'chevL')
    + '<span class="grow"></span>' + obBtn('nav:go', 'Continue', 'btn-p', false, '', 'arrowR') + '</div>';
}

/** One row picked: the server's own setup path, or the full Custom list. */
function lsvObPick(index) {
  const row = lsvObRows()[index];
  if (!row) return;
  if (typeof obOpenCloudWizard !== 'function') return;
  if (row.kind === 'other') {
    LSV.obPicked = null;
    obOpenCloudWizard('custom');
    obDispatch({type: 'onboarding_step_set', step: 'cloud'});
    return;
  }
  const server = row.server;
  LSV.obPicked = server;
  if (!server.presetId) {
    // The Llama app: the llama.cpp address step, its address filled in (the TUI does the same).
    OB_WIZ_ROUTE = 'custom';
    obDispatch({type: 'onboarding_step_set', step: 'custom_chat_url'});
    obDispatch({type: 'onboarding_url_changed', field: 'chat', value: server.baseUrl});
    return;
  }
  // Ollama / LM Studio: their row on the Custom list, opened as Enter opens it, then
  // checked at once like Settings' Add (a server on this computer needs no key).
  obOpenCloudWizard('custom');
  obDispatch({type: 'onboarding_step_set', step: 'cloud'});
  const rows = obWizRows();
  const at = rows.findIndex((r) => r.k && r.k.id === server.presetId);
  if (at < 0) return;
  WIZ.cur = at;
  obCloudKey('', {return: true});
  if (WIZ.phase === 'configure' && WIZ.row && WIZ.row.local && typeof wizNext === 'function') void wizNext();
}

/** renderer.js obKey 'found_server'. */
function lsvObKey(input, key) {
  const rows = lsvObRows();
  if (key.ctrl && input === 'c') return false;
  if (key.escape) { LSV.obPicked = null; obDispatch({type: 'onboarding_step_set', step: 'choose'}); return true; }
  if (key.upArrow || input === 'k') { obDispatch({type: 'onboarding_cursor_moved', delta: -1, length: rows.length}); return true; }
  if (key.downArrow || input === 'j') { obDispatch({type: 'onboarding_cursor_moved', delta: 1, length: rows.length}); return true; }
  if (key.return) { lsvObPick(OB.cursor); return true; }
  const digit = parseInt(input, 10);
  if (Number.isInteger(digit) && digit >= 1 && digit <= rows.length) {
    obDispatch({type: 'onboarding_cursor_set', cursor: digit - 1});
    lsvObPick(digit - 1);
    return true;
  }
  return true;
}

/**
 * renderer.js obConfiguredLabel: "Ollama connected" when setup ended on the
 * server picked from the found step, '' otherwise (the usual line).
 */
function lsvObConfiguredLabel(outcome) {
  const s = LSV.obPicked;
  if (!s) return '';
  if (s.presetId) {
    const saved = typeof WIZ !== 'undefined' && WIZ && (WIZ.savedId === s.presetId || (WIZ.row && WIZ.row.id === s.presetId));
    return outcome === 'cloud' && saved ? lsvName(s) + ' connected' : '';
  }
  return outcome === 'custom' && typeof OB !== 'undefined' && lsvSameUrl(OB.chatUrl, s.baseUrl) ? lsvName(s) + ' connected' : '';
}

/** renderer.js obWizardHTML: a "Running" badge on an Ollama / LM Studio row of the Custom list. */
function lsvRunningBadge(presetId) {
  if (LSV.phase !== 'ready' || !LSV.servers.some((s) => s.presetId === presetId)) return '';
  return '<span class="ann lit">Running</span>';
}

/** A new run of setup asks again and may move the cursor again. */
function lsvObReset() {
  LSV.obPicked = null; LSV.obCursorSet = false;
  if (LSV.phase !== 'loading') LSV.phase = lsvBridge() ? 'idle' : 'hidden';
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!t || !t.closest) return;
    const el = t.closest('[data-lsv]');
    if (!el) return;
    ev.preventDefault();
    const act = el.getAttribute('data-lsv');
    if (act === 'recheck') void lsvDetect(true);
    else if (act.indexOf('use:') === 0) lsvUse(Number(act.slice(4)));
    else lsvManageClick(act);
  });
  // The Download field keeps what is typed across repaints.
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    const kind = t && t.getAttribute ? t.getAttribute('data-lsv-pull') : null;
    if (kind === 'ollama' || kind === 'lmstudio') LSV.pull[kind] = String(t.value || '');
  });
  document.addEventListener('keydown', (ev) => {
    const t = ev.target;
    const kind = t && t.getAttribute ? t.getAttribute('data-lsv-pull') : null;
    if (ev.key !== 'Enter' || !kind) return;
    const i = LSV.servers.findIndex((s) => s.kind === kind);
    if (i >= 0) { ev.preventDefault(); lsvManageClick('pull:' + i); }
  });
}

if (typeof module !== 'undefined') {
  module.exports = {
    LSV, lsvFacts, lsvName, lsvHost, lsvSameUrl, lsvFoundSentence, lsvModelsLine, lsvStanding,
    lsvSectionHTML, lsvRowHTML, lsvObRows, lsvObConfiguredLabel, lsvRunningBadge, lsvDetect,
    lsvChoiceDetail, lsvObOffer, lsvObReset,
    lsvManageable, lsvProgressWords, lsvDoneWords, lsvNoteHTML, lsvManageHTML, lsvStartHTML, lsvAct, lsvManageClick,
  };
}
