/* ---------------- Model servers running here: Manage (ATO-2490) ----------------
   Loaded after local-servers.js and before renderer.js; declares only. Uses
   local-servers.js (LSV, lsvName, lsvDetect, lsvRepaint) and renderer.js
   globals (BR, LLMP, llmUseLocalModel, ...) at run time, guarded, so the
   Node tests can load it (test/local-server-actions.test.mjs).

   Manage on an Ollama or LM Studio row of Settings › Local opens its
   models: Load, Unload, Free memory, Download, Delete (Ollama) and Use
   here, and the section offers Start for the one that is installed but not
   running. */

/* The core does the work (`atag local-servers <action> ... --json`,
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
    // The id lets a repaint put the focus and caret back (paneFocusKeep) and
    // holds the 5 s poll off while typing (llmTyping in renderer.js).
    : '<div class="lsv-pull"><input class="tk-inp mono lsv-pull-in" id="lsv-pull-' + e(server.kind) + '" type="text" spellcheck="false" autocomplete="off" data-lsv-pull="' + e(server.kind) + '"'
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

if (typeof document !== 'undefined') {
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
    lsvCanAct, lsvManageable, lsvProgressWords, lsvDoneWords, lsvNoteHTML, lsvModelRowHTML, lsvManageHTML,
    lsvStartHTML, lsvAct, lsvManageClick,
  };
}
