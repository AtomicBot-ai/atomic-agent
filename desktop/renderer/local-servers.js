/* ---------------- Model servers running here (ATO-2489) ----------------
   Loaded before renderer.js; declares only and reads renderer.js globals
   (BR, OB, OB_CHOICES, KIND_ROWS, esc, ic, render, llmRepaint, ...) at run
   time, guarded, so the Node tests can load it (test/local-servers.test.mjs).

   What it shows: the model servers already running on this computer, from
   the core's own probe (`atag local-servers --json`, main/local-servers-ipc.ts):
   Ollama on 11434, LM Studio on 1234, the Llama app or a llama-server on 9931.

   Two places draw it (this file: shared state, the probe and Settings;
   local-servers-setup.js: the setup step):
   - Settings › Local: a "Running on this Mac" list. Each server says how many
     models it has and how many are loaded; Use connects it the way the app
     already connects that kind (the Ollama / LM Studio presets, or the
     External llama-server address for the Llama app).
   - Setup: the Custom card says what it found, the cursor starts on it, and
     picking it opens a step of its own that lists what runs (a choice when
     several do), with "Something else" for the full Custom list.

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
  if (typeof lsvAfterDetect === 'function') lsvAfterDetect();
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
  return '<div class="tuirow tk-li llm-row lsv-row" data-lsv-kind="' + e(server.kind) + '" title="' + e(server.baseUrl) + '">'
    + lsvMark(server, '')
    + '<span class="body"><span class="t"><span class="llm-name">' + e(lsvName(server)) + '</span>'
    + '<span class="ann lit lsv-on">Running</span></span>'
    + '<span class="d">' + e(lsvFacts(server) + ' · ' + lsvHost(server.baseUrl)) + '</span>'
    + (models ? '<span class="d lsv-models">' + e(models) + '</span>' : '')
    + (empty ? '<span class="d lsv-models">' + e(lsvEmptyServerWords(server)) + '</span>' : '')
    + '</span>' + action + '</div>';
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
    body = '<div class="tk-list llm-list">' + st.servers.map((s, i) => lsvRowHTML(s, i, h)).join('') + '</div>';
  }
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
  });
}

if (typeof module !== 'undefined') {
  module.exports = {
    LSV, lsvFacts, lsvName, lsvHost, lsvSameUrl, lsvFoundSentence, lsvModelsLine, lsvStanding,
    lsvSectionHTML, lsvRowHTML, lsvDetect, lsvMark,
  };
}
