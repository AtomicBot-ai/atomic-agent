/* ---------------- ATO-1754: Fusion models by role ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/fusion-roles.test.mjs).

   The planner gives each Fusion task a role (plan, build, review, explore,
   utility). The agent runs a role's tasks on `llm.runMode.fusion.roles`
   (role → provider id) with `roleModels` (role → model on it), so one
   provider entry can serve several roles with a model each. A role with no
   provider runs on the workers' model; one with a provider and no model
   runs that provider's default; a llama-server entry serves the model it
   loaded and ignores a name (ATO-1563 shows "Loaded on the server" in the
   composer the same way). `review` is also the judge's model when the judge
   has none of its own; `plan` does not move the planner itself.

   Settings › Models › Fusion draws one row per role under the worker
   reasoning row: a provider list ("Workers' model (default)" first) and a
   model list from the same `providerModels` ask the Cloud list uses
   (llm-model-list.js deadline and cache). Each change is one write through
   main's `cli:fusionRole` (main/fusion-roles-ipc.ts). Precedent: Claude
   Code's and Cursor's per-agent model settings, OpenCode's agent `model`. */

const FZROLE = {
  /** The role a write is in flight for, or null. */
  busy: null,
  /** The last write's sentence (drawn with the restart line), or null. */
  msg: null,
  /** The last failed write: {text, detail}, or null. */
  err: null,
  /** Model lists by provider id: {status: 'loading' | 'ready' | 'error', models, line?, detail?}. */
  lists: {},
  /** Provider ids whose list was asked for in this window. */
  asked: new Set(),
};

const FZROLE_ROLES = [
  {role: 'plan', label: 'Plan', help: 'Tasks that plan or split up work. The planner itself keeps its own model.'},
  {role: 'build', label: 'Build', help: 'Tasks that write or change code and files.'},
  {role: 'review', label: 'Review', help: 'Tasks that check finished work.'},
  {role: 'explore', label: 'Explore', help: 'Tasks that only read and search, such as finding where something lives.'},
  {role: 'utility', label: 'Utility', help: 'Small side jobs, such as renames, formatting or quick lookups.'},
];
const FZROLE_JUDGE_NOTE = ' When the judge is on and has no model of its own, it uses this one too.';
const FZROLE_SERVER_TIP = 'This server runs the model it has loaded. Change the model on the server itself.';

function fzroleEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

function fzroleFusion(cfg) {
  return (cfg && cfg.llm && cfg.llm.runMode && cfg.llm.runMode.fusion) || {};
}
function fzroleProviders(cfg) {
  const list = cfg && cfg.llm && Array.isArray(cfg.llm.providers) ? cfg.llm.providers : [];
  return list.filter((p) => p && typeof p.id === 'string' && p.id);
}
function fzroleMap(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

/** The role's provider and model as the file holds them (main/fusion-roles.ts fusionRoleState). */
function fzroleCurrent(cfg, role) {
  const fz = fzroleFusion(cfg);
  const p = fzroleMap(fz.roles)[role];
  const m = fzroleMap(fz.roleModels)[role];
  const providerId = typeof p === 'string' && p ? p : null;
  return {providerId, model: providerId && typeof m === 'string' && m ? m : null};
}

/** How the model half of a row is drawn for this provider entry (null = no provider). */
function fzroleModelMode(entry) {
  if (!entry) return 'workers';
  if (entry.kind === 'llama-server') return entry.id === 'local-llama' ? 'local' : 'server';
  return 'list';
}

/**
 * One row per role, in the agent's order. `lists` is FZROLE.lists, `word`
 * names a provider id. Pure: the paint and the tests both build from it.
 */
function fzroleRows(cfg, rm, lists, word) {
  const name = typeof word === 'function' ? word : (id) => id;
  const providers = fzroleProviders(cfg);
  const fz = fzroleFusion(cfg);
  const workerModel = (rm && rm.workerModel) || '';
  return FZROLE_ROLES.map((r) => {
    const cur = fzroleCurrent(cfg, r.role);
    const entry = cur.providerId ? providers.find((p) => p.id === cur.providerId) || null : null;
    const providerOptions = [{value: '', label: 'Workers’ model (default)', selected: !cur.providerId}]
      .concat(providers.map((p) => ({value: p.id, label: name(p.id), selected: p.id === cur.providerId})));
    // A pin to an entry that is gone still shows, so the list never claims another value.
    if (cur.providerId && !entry) providerOptions.push({value: cur.providerId, label: name(cur.providerId) + ' (not set up)', selected: true});
    const mode = cur.providerId && !entry ? 'missing' : fzroleModelMode(entry);
    const row = {role: r.role, label: r.label, help: r.help + (r.role === 'review' && !fz.judgeProvider ? FZROLE_JUDGE_NOTE : ''),
      providerId: cur.providerId, model: cur.model, mode, providerOptions, modelOptions: [], status: null, note: ''};
    if (mode === 'workers') row.note = workerModel ? 'Runs on ' + workerModel : 'Runs on the workers’ model';
    else if (mode === 'server') {
      const loaded = entry.defaultChatModel || entry.model || '';
      row.note = loaded ? 'Loaded on the server: ' + loaded : 'Loaded on the server';
    } else if (mode === 'local') row.note = 'The local model loaded now';
    else if (mode === 'missing') row.note = 'Pick a provider that is set up';
    else {
      const list = (lists && lists[entry.id]) || {status: 'loading', models: []};
      const dflt = entry.defaultChatModel || entry.model || '';
      const ids = [];
      (list.models || []).forEach((m) => { if (m && m.id && m.kind !== 'embedding' && !ids.includes(m.id)) ids.push(m.id); });
      // The saved name stays a choice while the list loads, fails or lacks it.
      if (cur.model && !ids.includes(cur.model)) ids.unshift(cur.model);
      row.modelOptions = [{value: '', label: dflt ? 'Default (' + dflt + ')' : 'The provider’s default', selected: !cur.model}]
        .concat(ids.map((id) => ({value: id, label: id, selected: id === cur.model})));
      row.status = list.status;
      if (list.status === 'loading') row.note = 'Loading models…';
      else if (list.status === 'error') { row.note = list.line || 'The model list did not load.'; row.detail = list.detail || ''; }
      else if (!list.models || !list.models.length) row.note = 'This provider listed no models, so its default runs.';
    }
    return row;
  });
}

/** The sentence a saved change leaves, before the restart line. */
function fzroleSavedLine(role, after, word) {
  const name = typeof word === 'function' ? word : (id) => id;
  const r = FZROLE_ROLES.find((x) => x.role === role);
  const label = r ? r.label : role;
  if (!after || !after.providerId) return label + ' now runs on the workers’ model.';
  return label + ': ' + (after.model || 'the default model') + ' on ' + name(after.providerId) + '.';
}

/** What a failed write shows: a plain sentence, the agent's words behind Details. */
function fzroleErrorOf(res) {
  if (res && res.refusal) return {text: res.refusal, detail: ''};
  return {text: 'This role was not saved. Try again.', detail: (res && res.error) || ''};
}

/** The request a provider or model choice sends to main. */
function fzroleRequest(role, providerId, model) {
  const req = {role, providerId: providerId || null};
  if (providerId && model) req.model = model;
  return req;
}

function fzroleSelectHTML(attrs, label, options, disabled) {
  return '<select class="tk-inp fzrole-sel" ' + attrs + ' aria-label="' + fzroleEsc(label) + '"' + (disabled ? ' disabled' : '') + '>'
    + options.map((o) => '<option value="' + fzroleEsc(o.value) + '"' + (o.selected ? ' selected' : '') + '>' + fzroleEsc(o.label) + '</option>').join('')
    + '</select>';
}

/** One role's row, as HTML. `busy` is FZROLE.busy (any write disables every list). */
function fzroleRowHTML(row, busy) {
  const off = !!busy;
  const prov = fzroleSelectHTML('id="fzrole-prov-' + row.role + '" data-fzrole-provider="' + row.role + '"', row.label + ': provider', row.providerOptions, off);
  const model = row.mode === 'list'
    ? fzroleSelectHTML('id="fzrole-model-' + row.role + '" data-fzrole-model="' + row.role + '" data-fzrole-for="' + fzroleEsc(row.providerId) + '"',
      row.label + ': model', row.modelOptions, off || row.status === 'loading')
    : '<span class="fzrole-fixed"' + (row.mode === 'server' ? ' title="' + fzroleEsc(FZROLE_SERVER_TIP) + '"' : '') + '>' + fzroleEsc(row.note) + '</span>';
  // Loading, error and empty read as the same one line under the lists.
  const line = row.mode === 'list' && row.note
    ? '<div class="fzrole-line' + (row.status === 'error' ? ' fzrole-line--err' : '') + '">'
      + (row.status === 'loading' ? '<span class="tk-spin"></span>' : '') + '<span>' + fzroleEsc(row.note) + '</span>'
      + (row.status === 'error' ? ' <button class="llm-link" type="button" data-fzrole-retry="' + fzroleEsc(row.providerId) + '">Try again</button>'
        + (row.detail ? '<details class="fzrole-more"><summary>Details</summary><span>' + fzroleEsc(row.detail) + '</span></details>' : '') : '')
      + '</div>'
    : '';
  return '<div class="fzrole-row" data-fzrole-row="' + row.role + '">'
    + '<span class="fzrole-body"><span class="fzrole-t">' + fzroleEsc(row.label) + (busy === row.role ? ' <span class="tk-spin"></span>' : '') + '</span>'
    + '<span class="tk-help">' + fzroleEsc(row.help) + '</span></span>'
    + '<span class="fzrole-ctl">' + prov + model + '</span>' + line + '</div>';
}

/** The whole block. `restart(text)` draws the saved line; `icon(name)` the alert mark. */
function fzroleSectionHTML(rows, state, restart, icon) {
  const st = state || FZROLE;
  const err = st.err
    ? '<div class="tk-notice tk-notice--red">' + (icon ? icon('alert') : '') + '<span class="grow">' + fzroleEsc(st.err.text)
      + (st.err.detail ? '<details class="fzrole-more"><summary>Details</summary><span>' + fzroleEsc(st.err.detail) + '</span></details>' : '')
      + '</span></div>'
    : st.msg && restart ? restart(st.msg) : '';
  return '<div class="fzrole" role="group" aria-label="Models by role">'
    + '<span class="tk-help"><b>Models by role.</b> The planner gives each task a role. A role set here runs its tasks on that model; the rest run on the workers’ model.</span>'
    + rows.map((r) => fzroleRowHTML(r, st.busy)).join('') + err + '</div>';
}

/* ---------------- the browser half ---------------- */

function fzroleWord(id) { return typeof providerWord === 'function' ? providerWord(id) : id; }

/** Settings › Models › Fusion, under the worker reasoning row; `rm` is the resolved run mode. */
function fzRolesSettingsHTML(rm) {
  const cfg = typeof LIVE_CONFIG !== 'undefined' ? LIVE_CONFIG : null;
  const rows = fzroleRows(cfg, rm, FZROLE.lists, fzroleWord);
  // A list nobody asked for yet is asked for after this paint, never from inside it.
  rows.filter((r) => r.mode === 'list' && !FZROLE.asked.has(r.providerId)).forEach((r) => {
    FZROLE.asked.add(r.providerId);
    const p = fzroleProviders(cfg).find((x) => x.id === r.providerId);
    setTimeout(() => { void fzroleFetch(r.providerId, (p && p.kind) || ''); }, 0);
  });
  return fzroleSectionHTML(rows, FZROLE, typeof restartLine === 'function' ? restartLine : null, typeof ic === 'function' ? ic : null);
}

function fzroleRepaint() {
  if (typeof S !== 'undefined' && S.settings && typeof settingsPaneId === 'function' && settingsPaneId(S.settingsPane) === 'llm'
    && typeof llmRepaint === 'function') llmRepaint();
  else if (typeof render === 'function') render();
}

/** Ask for one provider's model list (the Cloud list's deadline and session cache). */
async function fzroleFetch(id, kind) {
  const word = fzroleWord(id);
  if (typeof BR === 'undefined' || !BR || typeof BR.providerModels !== 'function') {
    FZROLE.lists[id] = {status: 'error', models: [], line: 'This build cannot list the models here.', detail: ''};
    fzroleRepaint();
    return;
  }
  const cached = typeof llmListCacheGet === 'function' ? llmListCacheGet(id) : null;
  if (cached) { FZROLE.lists[id] = {status: 'ready', models: cached}; fzroleRepaint(); return; }
  FZROLE.lists[id] = {status: 'loading', models: []};
  fzroleRepaint();
  const ask = () => BR.providerModels(id, kind, true);
  const res = typeof llmListAsk === 'function' ? await llmListAsk(ask, word)
    : await Promise.resolve().then(ask).catch((err) => ({ok: false, error: String((err && err.message) || err)}));
  if (res && res.ok) {
    FZROLE.lists[id] = {status: 'ready', models: res.models || []};
    if (!res.stale && typeof llmListCachePut === 'function') llmListCachePut(id, res.models);
  } else {
    const why = typeof modelListFailLine === 'function' ? modelListFailLine(res, word) : '';
    FZROLE.lists[id] = {status: 'error', models: [], line: 'The model list from ' + word + ' did not load.',
      detail: [why, res && res.error].filter(Boolean).join(' ')};
  }
  fzroleRepaint();
}

function fzroleRetry(id) {
  if (!id || FZROLE.busy) return;
  delete FZROLE.lists[id];
  const p = fzroleProviders(typeof LIVE_CONFIG !== 'undefined' ? LIVE_CONFIG : null).find((x) => x.id === id);
  void fzroleFetch(id, (p && p.kind) || '');
}

/** Write one role: a provider choice (no model) or a model choice on the role's provider. */
async function fzroleSave(role, providerId, model) {
  if (FZROLE.busy) return {ok: false};
  if (typeof BR === 'undefined' || !BR || typeof BR.fusionRole !== 'function') {
    FZROLE.err = {text: 'This build cannot save models by role.', detail: ''};
    fzroleRepaint();
    return {ok: false};
  }
  FZROLE.busy = role; FZROLE.msg = null; FZROLE.err = null;
  fzroleRepaint();
  const res = await Promise.resolve().then(() => BR.fusionRole(fzroleRequest(role, providerId, model)))
    .catch((err) => ({ok: false, error: String((err && err.message) || err)}));
  if (!res || res.ok !== true) FZROLE.err = fzroleErrorOf(res);
  else {
    // The lists stay disabled until the window holds the new file, so they never flash the old value.
    if (res.changed && typeof refreshLiveConfig === 'function') await Promise.resolve(refreshLiveConfig()).catch(() => null);
    FZROLE.msg = res.changed ? fzroleSavedLine(role, res.after, fzroleWord) : null;
  }
  FZROLE.busy = null;
  fzroleRepaint();
  return res;
}

if (typeof document !== 'undefined') {
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.getAttribute) return;
    const role = t.getAttribute('data-fzrole-provider');
    if (role) { void fzroleSave(role, t.value, ''); return; }
    const mrole = t.getAttribute('data-fzrole-model');
    const pid = t.getAttribute('data-fzrole-for');
    if (mrole && pid) void fzroleSave(mrole, pid, t.value);
  });
  document.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-fzrole-retry]') : null;
    if (!el) return;
    e.preventDefault();
    fzroleRetry(el.getAttribute('data-fzrole-retry'));
  });
}

if (typeof module !== 'undefined') {
  module.exports = {
    FZROLE, FZROLE_ROLES, FZROLE_JUDGE_NOTE, fzroleCurrent, fzroleModelMode, fzroleRows, fzroleSavedLine, fzroleErrorOf,
    fzroleRequest, fzroleRowHTML, fzroleSectionHTML,
  };
}
