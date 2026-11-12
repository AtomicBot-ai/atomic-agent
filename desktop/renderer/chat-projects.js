/* ---------------- ATO-1146: the sidebar by projects ----------------
   Loaded before renderer.js; declares only, and reads renderer.js globals at
   call time, as chat-folders.js does. The grouping itself is pure and lives
   in chat-list.js (projectGroups, unit-tested in test/chat-list.test.mjs).

   Epic ATO-1012, item 3. A project is a work folder plus a name, kept by the
   projects store (ATO-42, main/projects-store.ts, IPC projects:list / save /
   delete / assign and the projects:changed event). This file only draws it:

   - "New project" (a sidebar row, and the plus on the Projects heading) opens
     the system folder picker the workspace chip uses (app:chooseWorkspace,
     for new chats only: the chat on screen keeps its folder), saves a project
     named after that folder, and opens a new chat there. That chat's first
     turn carries the project's id (BR.chat's third argument): main records
     the chat in the project before the turn starts.
   - The sidebar shows each project with its chats, folding like a chat
     folder. A chat filed in an ATO-1034 chat folder stays in that folder.
   - Edit (the pencil on a project's header): its name and its instructions,
     which main hands the agent with every turn of the project's chats.
   - Removing a project leaves its chats (under Chats) and the folder on disk.

   Without the store (an older main, or ATO-42 not in this build) nothing here
   is drawn: no row, no heading. */

const PROJECTS = {state: {projects: [], chats: {}}, loaded: false, collapsed: new Set(), newFor: null, edit: null};
const PROJECT_INSTRUCTIONS_MAX = 16000;
const PROJECT_NAME_MAX = 80;
const PROJECTS_COLLAPSED_KEY = 'atomic.projects.collapsed';

try {
  const raw = typeof localStorage !== 'undefined' ? JSON.parse(localStorage.getItem(PROJECTS_COLLAPSED_KEY) || '[]') : [];
  if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string') PROJECTS.collapsed.add(id);
} catch (e) { /* a per-window convenience only */ }

/** The store's calls, or null when this build has none. */
function projectsApi() {
  if (typeof BR === 'undefined' || !BR) return null;
  if (typeof BR.projectsList !== 'function' || typeof BR.projectsSave !== 'function') return null;
  return BR;
}

function projectsSupported() { return !!projectsApi(); }

async function loadProjects() {
  const api = projectsApi();
  if (!api) { PROJECTS.loaded = true; return; }
  let res = null;
  try { res = await api.projectsList(); } catch (e) { res = null; }
  if (res && typeof res === 'object' && res.ok !== false) PROJECTS.state = projectsCoerce('data' in res ? res.data : res);
  PROJECTS.loaded = true;
  if (typeof render === 'function') render();
}

/* The store says when it changed (any window, any write): read it again. */
if (typeof window !== 'undefined') {
  setTimeout(() => {
    const api = projectsApi();
    if (api && typeof api.onProjectsChanged === 'function') api.onProjectsChanged(() => { loadProjects(); });
  }, 0);
}

function projectCollapsed(id) { return PROJECTS.collapsed.has(id); }

function projectToggle(id) {
  if (PROJECTS.collapsed.has(id)) PROJECTS.collapsed.delete(id); else PROJECTS.collapsed.add(id);
  try { localStorage.setItem(PROJECTS_COLLAPSED_KEY, JSON.stringify([...PROJECTS.collapsed])); } catch (e) { /* kept for this run */ }
}

/* The saved project out of a projects:save answer, or null. */
function projectFromSave(res) {
  if (!res || typeof res !== 'object' || res.ok === false) return null;
  const d = 'data' in res ? res.data : res;
  const p = d && d.project ? d.project : d;
  return projectsCoerce([p]).projects[0] || null;
}

/* The project a brand-new chat's first turn opens in (BR.chat's third
   argument), or undefined. Only the empty chat New project opened: a plain New
   chat or opening another chat since gives that chat a new transcript
   (S.log), so the mark is dropped. Read once. */
function projectForNewTurn() {
  const n = PROJECTS.newFor;
  PROJECTS.newFor = null;
  if (!n || typeof S === 'undefined' || S.agentSession || S.log !== n.log) return undefined;
  return PROJECTS.state.projects.some((p) => p.id === n.id) ? n.id : undefined;
}

/** New project: pick a folder, keep it as a project, open a new chat in it. */
function projectCreate() {
  const api = projectsApi();
  if (!api || typeof BR.chooseWorkspace !== 'function') return;
  // As the workspace chip: the picker stays shut while the chat on screen runs a turn.
  if (S.busy) { if (typeof restartRefusedToast === 'function') restartRefusedToast({here: true, title: ''}); return; }
  BR.chooseWorkspace(null).then(async (res) => {
    if (!res) return;   // cancelled
    const dir = typeof res === 'string' ? res : (res.live ? res.dir : null);
    applyWorkspaceChoice(res);   // the folder change's own messages (refused, busy, moved)
    if (!dir) return;
    let p = projectForFolder(PROJECTS.state, dir);
    if (!p) {
      let saved = null;
      try { saved = await api.projectsSave({name: projectNameFromDir(dir), folder: dir}); } catch (e) { saved = {ok: false, error: String(e && e.message || e)}; }
      p = projectFromSave(saved);
      if (!p) { toast('Could not create the project', (saved && saved.error) || '', 'bad'); return; }
      PROJECTS.state.projects.unshift(p);   // the store lists newest first
    }
    PROJECTS.collapsed.delete(p.id);
    act('session:new');
    PROJECTS.newFor = {id: p.id, log: S.log};
    render();
  });
}

/** Remove a project from the sidebar. Its chats stay, under Chats. */
function projectRemove(id) {
  const api = projectsApi();
  if (!api || typeof api.projectsDelete !== 'function') return;
  api.projectsDelete(id).then((res) => {
    if (res && res.ok === false) { toast('Could not remove the project', res.error || '', 'bad'); return; }
    PROJECTS.state.projects = PROJECTS.state.projects.filter((p) => p.id !== id);
    for (const sid of Object.keys(PROJECTS.state.chats)) if (PROJECTS.state.chats[sid] === id) delete PROJECTS.state.chats[sid];
    toast('Project removed', 'Its chats are kept, under Chats');
    render();
  }, () => {});
}

/* Edit project: a sheet with the name and the instructions. What is typed is
   kept in PROJECTS.edit as it is typed (the listener below), and drawn into
   the fields only when the sheet itself changes (saving, an error), so a
   repaint never throws typing away. */
function projectEditOpen(id) {
  const p = PROJECTS.state.projects.find((x) => x.id === id);
  if (!p) return;
  const instructions = p.instructions || '';
  PROJECTS.edit = {id, name: p.name, instructions, shownName: p.name, shownInstructions: instructions, error: null, saving: false};
  S.overlay = 'pedit';
  render();
  const f = typeof document !== 'undefined' && document.getElementById('pedit-name');
  if (f) f.focus();
}

function projectEditRedraw(patch) {
  const e = PROJECTS.edit;
  if (!e) return;
  Object.assign(e, patch, {shownName: e.name, shownInstructions: e.instructions});
  S.overlay = 'pedit';
  render();
}

async function projectEditSave() {
  const e = PROJECTS.edit, api = projectsApi();
  if (!e || !api || e.saving) return;
  const name = String(e.name || '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (!name) { projectEditRedraw({error: 'A project name cannot be empty'}); return; }
  if ([...name].length > PROJECT_NAME_MAX) { projectEditRedraw({error: 'A project name is at most ' + PROJECT_NAME_MAX + ' characters'}); return; }
  if (e.instructions.length > PROJECT_INSTRUCTIONS_MAX) { projectEditRedraw({error: 'Instructions are at most ' + PROJECT_INSTRUCTIONS_MAX + ' characters'}); return; }
  projectEditRedraw({saving: true, error: null});
  let res = null;
  try { res = await api.projectsSave({id: e.id, name, instructions: e.instructions}); } catch (err) { res = {ok: false, error: String(err && err.message || err)}; }
  if (PROJECTS.edit !== e) return;   // closed meanwhile
  const p = projectFromSave(res);
  if (!p) { projectEditRedraw({saving: false, error: (res && res.error) || 'The project was not saved'}); return; }
  const i = PROJECTS.state.projects.findIndex((x) => x.id === p.id);
  if (i >= 0) PROJECTS.state.projects[i] = p;
  PROJECTS.edit = null;
  if (S.overlay === 'pedit') S.overlay = null;
  render();
}

/** The Edit project sheet (S.overlay === 'pedit'), on the overlay layer. */
function projectEditHTML() {
  const e = PROJECTS.edit;
  if (!e) return '';
  const p = PROJECTS.state.projects.find((x) => x.id === e.id);
  const body = '<label class="sd-cap" for="pedit-name">Name</label>'
    + '<input id="pedit-name" class="tk-inp" maxlength="' + PROJECT_NAME_MAX + '" value="' + esc(e.shownName) + '"' + (e.saving ? ' disabled' : '') + '>'
    + (p ? '<p class="sd-cap mono" title="' + esc(p.folder) + '">' + esc(p.folder) + '</p>' : '')
    + '<label class="sd-cap" for="pedit-instr">Instructions for every chat in this project</label>'
    + '<textarea id="pedit-instr" class="tk-inp sd-json" rows="8" maxlength="' + PROJECT_INSTRUCTIONS_MAX + '"'
      + ' placeholder="For example: answer in English, run the tests before you say it works."' + (e.saving ? ' disabled' : '') + '>' + esc(e.shownInstructions) + '</textarea>'
    + (e.error ? '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(e.error) + '</span></div>' : '');
  return sheet('Edit project', body,
    '<span class="grow"></span><button class="btn btn-s sm" data-act="close">Cancel</button>'
    + '<button class="btn btn-p sm" data-act="psave:"' + (e.saving ? ' disabled' : '') + '>' + (e.saving ? '<span class="tk-spin"></span>' : '') + 'Save</button>',
    'sheet-project');
}

if (typeof document !== 'undefined') {
  document.addEventListener('input', (ev) => {
    const e = PROJECTS.edit, t = ev.target;
    if (!e || !t) return;
    if (t.id === 'pedit-name') e.name = t.value;
    else if (t.id === 'pedit-instr') e.instructions = t.value;
  });
}

/** The act verbs this file owns (renderer.js act() hands them over). */
function projectAct(k, v) {
  if (k === 'pnew') { projectCreate(); return true; }
  if (k === 'ptoggle') { projectToggle(v); render(); if (typeof nameVisibleSessions === 'function') nameVisibleSessions(); return true; }
  if (k === 'pdelask') {
    const p = PROJECTS.state.projects.find((x) => x.id === v);
    if (!p) return true;
    S.alert = {title: 'Remove project “' + p.name + '”?', msg: 'Its chats stay, under Chats. The folder on disk is not touched.', ok: 'Remove', act: 'pdel:' + v};
    render(); return true;
  }
  if (k === 'pdel') { projectRemove(v); return true; }
  if (k === 'pedit') { projectEditOpen(v); return true; }
  if (k === 'psave') { projectEditSave(); return true; }
  return false;
}

/** The Projects block of the sidebar: each project and its chats. Nothing without projects. */
function projectsSidebarHTML(groups) {
  if (!projectsSupported() || !groups || !groups.length) return '';
  return '<div class="sb-list sb-folders sb-projects" data-list="projects">'
    + '<div class="sb-list-head micro"><span>Projects</span>'
      + '<button class="iconbtn sb-add" data-act="pnew:" title="New project" aria-label="New project">' + ic('plus') + '</button></div>'
    + groups.map((g) => {
      const p = g.project, shut = projectCollapsed(p.id);
      return '<div class="sb-folder sb-project' + (shut ? ' collapsed' : '') + '" data-project="' + esc(p.id) + '">'
        + '<button class="sb-fhead" data-act="ptoggle:' + esc(p.id) + '" aria-expanded="' + !shut + '"'
          + ' title="' + esc(p.name + ' · ' + p.folder + ' · ' + g.rows.length + (g.rows.length === 1 ? ' chat' : ' chats')) + '">'
          + '<span class="sb-fchev">' + ic(shut ? 'chevR' : 'chevD') + '</span>'
          + '<span class="sb-fic">' + ic('folder') + '</span>'
          + '<span class="sb-fname">' + esc(p.name) + '</span>'
          + (g.rows.length ? '<span class="ct tnum">' + g.rows.length + '</span>' : '')
          + '<span class="sesmore iconbtn" data-act="pedit:' + esc(p.id) + '" title="Edit project" aria-label="Edit project" role="button">' + ic('edit') + '</span>'
          + '<span class="sesmore iconbtn" data-act="pdelask:' + esc(p.id) + '" title="Remove project" aria-label="Remove project" role="button">' + ic('x') + '</span>'
        + '</button>'
        + (shut ? '' : g.rows.length ? g.rows.map(chatRow).join('') : '<div class="sb-empty sb-fempty">No chats yet</div>')
        + '</div>';
    }).join('')
    + '</div>';
}

