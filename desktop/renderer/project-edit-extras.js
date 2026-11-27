/* ATO-1012: the rest of a project's settings in the Edit project sheet
   (chat-projects.js draws the sheet and calls the hooks below). For a
   project with a folder on disk (`p…`, the projects store):

   - Folder: Change folder… opens the same picker New project uses. New
     chats open in the new folder; chats already there keep the folder they
     ran in, and stay in the project (they are filed in it by id, since the
     sidebar would otherwise sort them by their folder). Main moves the
     folder's own model along (projects:save → moveProjectModel).
   - Model: the cloud models the composer's switcher lists (its own lists:
     selProviders, selLoadGroups / selLoadModels and their caches) and "Same
     as the app". Saved per folder through BR.setProjectModel, as a pick in
     the switcher is (ATO-1148). A local model is one per agent, so it is
     never offered here, and a remote agent keeps one model for every chat:
     there the row is not drawn.
   - Its AGENTS.md: which instruction file the folder carries (main reads
     it, projects:instructionsFile, never outside the folder), with Open
     through the reply chips' safe open, and the folder's trust when the
     window knows it (renderer.js PT, ATO-1250).

   A chat folder (`f…`, no disk folder; ATO-2411) gets the Folder row too,
   with Choose folder…: a folder picked there shows the model row at once,
   and Save turns the chat folder into a projects-store project
   (project-folder-upgrade.js), its name, instructions and chats kept.
   Loaded after chat-projects.js; reads renderer.js globals at call time. */

const PEX_POLL_MS = 500, PEX_POLL_TICKS = 24;

function pexEsc(s) { return typeof esc === 'function' ? esc(s) : String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c])); }

/* A pick as an <option> value and back. '' is "Same as the app". */
function pexModelValue(pick) {
  return pick && pick.providerId && pick.model ? JSON.stringify([pick.providerId, pick.model]) : '';
}
function pexParseModel(value) {
  if (!value) return null;
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string' && v[0] && v[1] ? {providerId: v[0], model: v[1]} : null;
  } catch (e) { return null; }
}

/* The select's groups: one per cloud provider with a key, its models when
   its list is in (`models` null while it loads). The saved pick is always
   there, even before its list arrives or when the list no longer has it. */
function pexModelGroups(providers, pick) {
  const groups = (providers || []).map((p) => ({id: p.id, title: p.title || p.id, models: Array.isArray(p.models) ? p.models.slice() : null}));
  if (pick) {
    let g = groups.find((x) => x.id === pick.providerId);
    if (!g) { g = {id: pick.providerId, title: pick.providerId, models: []}; groups.push(g); }
    if (!g.models) g.models = [];
    if (g.models.indexOf(pick.model) < 0) g.models.unshift(pick.model);
  }
  return groups;
}
function pexModelSelectHTML(groups, value, disabled) {
  const opt = (v, label, on) => '<option value="' + pexEsc(v) + '"' + (on ? ' selected' : '') + '>' + pexEsc(label) + '</option>';
  return '<select id="pedit-model" class="tk-inp"' + (disabled ? ' disabled' : '') + '>'
    + opt('', 'Same as the app', !value)
    + groups.map((g) => '<optgroup label="' + pexEsc(g.title) + '">'
      + (g.models === null ? '<option disabled>Loading…</option>'
        : g.models.length ? g.models.map((m) => { const v = pexModelValue({providerId: g.id, model: m}); return opt(v, m, v === value); }).join('')
        : '<option disabled>No models listed</option>')
      + '</optgroup>').join('')
    + '</select>';
}

/* The AGENTS.md line: what the folder carries, as words. `file` is main's
   answer ({path, name, exists, head, also}) or null (not read, or a folder
   not on this computer); `pending`: a new folder that is not saved yet. */
function pexInstructionsLine(file, opts) {
  const o = opts || {};
  if (o.pending) return {text: 'The new folder’s AGENTS.md is read once you save.', open: false, title: ''};
  if (!file) return null;
  if (!file.exists) return {text: 'No AGENTS.md in this folder. Add one and every chat here follows it too.', open: false, title: ''};
  const also = Array.isArray(file.also) && file.also.length ? ' (and ' + file.also.join(', ') + ')' : '';
  return {text: 'Also follows ' + file.name + also + ' in this folder', open: true, title: String(file.head || '').slice(0, 600)};
}

/* The chats a project holds only because they ran in its folder: moving
   the project to another folder would drop them from it in the sidebar, so
   they are filed in it by id first. A chat filed elsewhere is left alone,
   and so is one a project nested inside this folder holds (the deepest
   folder wins, as in the sidebar): the check runs over every project,
   with this one still at its old folder. */
function pexChatsToKeep(project, rows, storeChats, folderChats, home, projects) {
  if (!project || typeof projectOf !== 'function') return [];
  const list = (Array.isArray(projects) && projects.length ? projects : [project]).filter((q) => q && q.id !== project.id);
  const all = {projects: [project, ...list], chats: {}};
  const out = [];
  for (const r of rows || []) {
    if (!r || !r.id || (storeChats && storeChats[r.id]) || (folderChats && folderChats[r.id])) continue;
    const owner = projectOf(all, r, home);
    if (owner && owner.id === project.id) out.push(r.id);
  }
  return out;
}

/* ---- the window's half ---- */
function pexWin() { return typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || ''); }
function pexSameFolder(a, b) {
  return typeof projectFolderKey === 'function' ? projectFolderKey(a, pexWin()) === projectFolderKey(b, pexWin()) : a === b;
}
/* The model row is drawn only where a project's model can apply. */
function pexModelShown() {
  return typeof ProjectModels !== 'undefined' && ProjectModels.state.loaded && !ProjectModels.state.remote
    && typeof BR !== 'undefined' && !!BR && typeof BR.setProjectModel === 'function' && typeof selProviders === 'function';
}

/* The switcher's list for a provider, from its caches, or null while it loads. */
function pexListFor(id) {
  if (typeof SEL_LIVE_MODELS !== 'undefined' && SEL_LIVE_MODELS.get(id)) return SEL_LIVE_MODELS.get(id);
  const g = typeof SEL_GROUPS !== 'undefined' ? SEL_GROUPS.get(id) : null;
  if (g && g.models) return g.models;
  if (typeof SEL !== 'undefined' && SEL.modelsFor === id && !SEL.modelsBusy && !SEL.modelsErr) return SEL.models;
  if (g && g.err) return [];
  return null;
}

function pexProviders() {
  const ready = typeof BSW !== 'undefined' && Array.isArray(BSW.readyIds) ? BSW.readyIds : [];
  return selProviders()
    .filter((p) => ready.includes(p.id) && (typeof projectCloudEntry !== 'function' || projectCloudEntry(p)))
    .map((p) => {
      const list = pexListFor(p.id);
      return {id: p.id, title: typeof providerWord === 'function' ? providerWord(p.id) : p.id, models: list ? list.map((m) => m.id) : null};
    });
}

/* Ask for the lists the switcher would: which providers have a key, every
   other group's catalogue, and the current provider's own. Each is asked once. */
function pexLoadModels() {
  if (typeof BSW !== 'undefined' && !BSW.readyLoaded && typeof bswRefreshFacts === 'function') bswRefreshFacts();
  if (typeof selLoadGroups === 'function') selLoadGroups();
  const cur = typeof selActiveProviderId === 'function' ? selActiveProviderId() : null;
  if (cur && typeof SEL !== 'undefined' && !SEL.open && SEL.modelsFor !== cur && !pexListFor(cur)
    && selProviders().some((p) => p.id === cur) && typeof selLoadModels === 'function') selLoadModels(cur);
}

/* Redraw the sheet with what was typed kept, and the caret where it was.
   `apply` puts new data in the sheet's state first. Data that arrives on its
   own (a model list, the AGENTS.md answer) reaches the sheet only this way:
   a plain render() then draws the same HTML and leaves the fields alone.
   Not while the model list is open under the pointer (unless `force`, for
   the person's own clicks): the next tick does it. */
function pexRepaint(e, apply, force) {
  if (PROJECTS.edit !== e) return false;
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  if (!force && a && a.id === 'pedit-model') return false;
  if (apply) apply();
  const id = a && a.id, from = a && a.selectionStart, to = a && a.selectionEnd;
  projectEditRedraw({});
  const el = id && typeof document !== 'undefined' ? document.getElementById(id) : null;
  if (el) { el.focus(); try { el.setSelectionRange(from, to); } catch (err) { /* not a text field */ } }
  return true;
}

/* Brings the switcher's lists into the sheet as they land. */
function pexPoll(e) {
  let ticks = 0;
  const tick = () => {
    if (PROJECTS.edit !== e || !e.x || ++ticks > PEX_POLL_TICKS) return;
    pexLoadModels();
    const groups = pexProviders();
    if (JSON.stringify(groups) !== JSON.stringify(e.x.groups)) pexRepaint(e, () => { e.x.groups = groups; });
    // Until the keys are read and every list is in (or failed), and the sheet shows the latest.
    const keysUnread = typeof BSW !== 'undefined' && !BSW.readyLoaded;
    if (keysUnread || groups.some((g) => g.models === null) || JSON.stringify(groups) !== JSON.stringify(e.x.groups)) setTimeout(tick, PEX_POLL_MS);
  };
  setTimeout(tick, 0);
}

/* The AGENTS.md answer, put in once the sheet may be redrawn. */
function pexApplyFile(e, file, tries) {
  if (PROJECTS.edit !== e || !e.x) return;
  if (!pexRepaint(e, () => { e.x.file = file; }) && (tries || 0) < PEX_POLL_TICKS) setTimeout(() => pexApplyFile(e, file, (tries || 0) + 1), PEX_POLL_MS);
}

/* The sheet's own state, made the first time the sheet draws a project with a folder. */
function pexInit(e, p) {
  if (e.x) return e.x;
  const pick = typeof ProjectModels !== 'undefined' ? ProjectModels.pickFor(p.folder) : null;
  const shown = pexModelShown();
  e.x = {old: p, folder: '', folderErr: null, model: pexModelValue(pick), modelWas: pexModelValue(pick), file: null,
    groups: shown ? pexProviders() : []};
  if (p.folder && typeof BR !== 'undefined' && BR && typeof BR.projectsInstructionsFile === 'function') {
    Promise.resolve().then(() => BR.projectsInstructionsFile(p.id)).then((res) => {
      pexApplyFile(e, res && res.ok && res.file ? res.file : null);
    }, () => {});
  }
  if (shown) pexPoll(e);
  return e.x;
}

function pexTrustText(folder) {
  if (typeof PT === 'undefined' || !PT.state.supported || !PT.state.status || typeof projectTrustSummary !== 'function') return '';
  if (!pexSameFolder(PT.state.status.workingDir, folder)) return '';
  const sum = projectTrustSummary(PT.state.status);
  return sum && sum.state !== 'none' ? sum.text : '';
}

/** The folder row (hook in projectEditHTML): the folder, Change folder…, and a folder picked but not saved yet.
    ATO-2411: a project with no disk folder shows "None" and Choose folder…. */
function projectEditFolderHTML(e, p) {
  if (!p) return '';
  const x = pexInit(e, p), off = e.saving ? ' disabled' : '';
  const shown = x.folder || p.folder;
  const err = x.folderErr ? '<p class="sd-cap tuierr">' + pexEsc(x.folderErr) + '</p>' : '';
  if (!p.folder) {
    return '<label class="sd-cap">Folder</label>'
      + '<div class="sd-pnew-folder">'
        + (shown
          ? '<span class="mono grow" title="' + pexEsc(shown) + '">' + pexEsc(shown) + '</span>'
            + '<button class="btn btn-s sm" data-pex="folderundo"' + off + '>Keep none</button>'
            + '<button class="btn btn-s sm" data-pex="folder"' + off + '>Change folder…</button>'
          : '<span class="grow sd-cap">None. Chats work in the folder the window shows.</span>'
            + '<button class="btn btn-s sm" data-pex="folder"' + off + '>Choose folder…</button>')
      + '</div>'
      + (shown ? '<p class="sd-cap">Saved, new chats open there and the project gets its own model. Its chats stay in it.</p>'
        : '<p class="sd-cap">Choose a folder to give this project its own model and a place for its new chats.</p>')
      + err;
  }
  return '<label class="sd-cap">Folder</label>'
    + '<div class="sd-pnew-folder">'
      + '<span class="mono grow" title="' + pexEsc(shown) + '">' + pexEsc(shown) + '</span>'
      + (x.folder ? '<button class="btn btn-s sm" data-pex="folderundo"' + off + '>Keep the old one</button>' : '')
      + '<button class="btn btn-s sm" data-pex="folder"' + off + '>Change folder…</button>'
    + '</div>'
    + (x.folder ? '<p class="sd-cap">New chats open there; chats you already have keep their folder.</p>' : '')
    + err;
}

/** Under the instructions (hook in projectEditHTML): the folder's AGENTS.md and the project's model.
    Drawn once the project has a folder, saved or just picked (ATO-2411). */
function projectEditMoreHTML(e, p) {
  if (!p || !e.x || (!p.folder && !e.x.folder)) return '';
  const x = e.x;
  const line = pexInstructionsLine(x.file, {pending: !!x.folder});
  const trust = line && line.open ? pexTrustText(p.folder) : '';
  let html = line
    ? '<p class="sd-cap pex-agents"' + (line.title ? ' title="' + pexEsc(line.title) + '"' : '') + '>' + pexEsc(line.text)
      + (line.open ? ' · <a href="#" data-pex="open">Open</a>' : '') + (trust ? '<br>' + pexEsc(trust) : '') + '</p>'
    : '';
  if (pexModelShown()) {
    const groups = pexModelGroups(x.groups, pexParseModel(x.modelWas));
    const note = typeof ProjectModels !== 'undefined' ? ProjectModels.localNote() : 'Local model is shared by all projects';
    const off = typeof liveBackend === 'function' && liveBackend() !== 'cloud' ? ' It applies while the app runs on Cloud.' : '';
    html += '<label class="sd-cap" for="pedit-model">Model for this project</label>'
      + pexModelSelectHTML(groups, x.model, e.saving)
      + (x.modelFromFolder && x.model === x.modelWas ? '<p class="sd-cap">The new folder already has this model, so the project keeps it.</p>' : '')
      + '<p class="sd-cap">Cloud models only. ' + pexEsc(note) + '.' + pexEsc(off) + '</p>';
  }
  return html;
}

/** What projectEditSave sends besides the name and instructions: a new folder. */
function projectEditExtrasFields(e) {
  return e && e.x && e.x.folder ? {folder: e.x.folder} : {};
}

/** After projects:save: keep the project's chats, then save its model (or forget it) for the folder it has now. */
function projectEditExtrasSaved(e, p) {
  const x = e && e.x;
  if (!x || !p || typeof BR === 'undefined' || !BR) return;
  const moved = !!x.folder && !pexSameFolder(x.old.folder, p.folder);
  // A chat folder given its first folder has no chats held by path: project-folder-upgrade.js files its own.
  if (moved && x.old.folder && typeof BR.projectsAssign === 'function') {
    const rows = typeof SESSIONS !== 'undefined' ? SESSIONS : [];
    const home = typeof homeDir === 'function' ? homeDir() : '';
    const folderChats = typeof FOLDERS !== 'undefined' ? FOLDERS.state.chats : {};
    for (const sid of pexChatsToKeep(x.old, rows, PROJECTS.state.chats, folderChats, home, PROJECTS.state.projects)) {
      PROJECTS.state.chats[sid] = p.id;
      BR.projectsAssign({sessionId: sid, projectId: p.id}).then(() => {}, () => {});
    }
  }
  const models = typeof ProjectModels !== 'undefined' ? ProjectModels : null;
  if (!models) return;
  const done = () => models.load(BR).then((ok) => { if (ok && typeof render === 'function') render(); });
  if (!pexModelShown() || x.model === x.modelWas) { if (moved) done(); return; }
  models.set(BR, p.folder, pexParseModel(x.model)).then((res) => {
    if (!res || !res.ok) { if (typeof toast === 'function') toast('The project’s model was not saved', (res && res.error) || '', 'bad'); return; }
    done();
  }, () => {});
}

async function pexPickFolder(e) {
  const p = projectAny(e.id);
  if (!p || !e.x || e.saving) return;
  const dir = await projectPickFolder(e.x.folder || p.folder);
  if (PROJECTS.edit !== e || !dir) return;
  const other = typeof projectForFolder === 'function' ? projectForFolder(PROJECTS.state, dir) : null;
  pexRepaint(e, () => {
    if (other && other.id !== e.id) e.x.folderErr = 'That folder is already the project “' + other.name + '”.';
    else { e.x.folderErr = null; e.x.folder = pexSameFolder(dir, p.folder) ? '' : dir; pexFolderModel(e.x, p); }
  }, true);
}

/* Nadya, 18.11: a project with no model of its own moved to a folder that
   already has one (picked earlier in the composer) keeps that folder's
   model, and the sheet shows it rather than "Same as the app". Nothing is
   written for it on Save: main copies a pick only from a folder that has one.
   A choice the person made in the sheet is never overwritten. */
function pexFolderModel(x, p) {
  if (!x || !p || typeof ProjectModels === 'undefined') return;
  if (x.model !== x.modelWas) return;
  const own = pexModelValue(ProjectModels.pickFor(p.folder));
  if (own) return;
  const there = x.folder ? pexModelValue(ProjectModels.pickFor(x.folder)) : '';
  x.model = x.modelWas = there;
  x.modelFromFolder = !!there;
}

function pexOpen(e) {
  const f = e && e.x && e.x.file;
  if (!f || !f.exists) return;
  const open = typeof openReplyPath === 'function' ? openReplyPath
    : (typeof BR !== 'undefined' && BR && BR.openReplyPath ? BR.openReplyPath : null);
  if (!open) return;
  Promise.resolve(open(f.path)).then((res) => {
    if (res && res.ok === false && typeof toast === 'function') toast('Could not open ' + f.name, res.error || '', 'bad');
  }, () => {});
}

if (typeof document !== 'undefined') {
  document.addEventListener('change', (ev) => {
    const e = PROJECTS.edit, t = ev.target;
    // Drawn at once (the caret kept), so a later repaint never brings back the old choice or old typing.
    if (e && e.x && t && t.id === 'pedit-model') pexRepaint(e, () => { e.x.model = t.value; }, true);
  });
  document.addEventListener('click', (ev) => {
    const e = PROJECTS.edit;
    const b = e && ev.target && ev.target.closest ? ev.target.closest('[data-pex]') : null;
    if (!b || b.disabled) return;
    ev.preventDefault();
    const k = b.getAttribute('data-pex');
    if (k === 'folder') pexPickFolder(e);
    else if (k === 'folderundo' && e.x) pexRepaint(e, () => { e.x.folder = ''; e.x.folderErr = null; }, true);
    else if (k === 'open') pexOpen(e);
  });
}

if (typeof module !== 'undefined') module.exports = {pexModelValue, pexParseModel, pexModelGroups, pexModelSelectHTML, pexInstructionsLine, pexChatsToKeep};
