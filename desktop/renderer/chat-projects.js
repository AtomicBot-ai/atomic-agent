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
   is drawn: no row, no heading.

   W2 QA (16.11), the owner: "Folders and Projects, what is the difference?"
   One kind of group now, Projects, as in Claude. A project may have a folder
   on disk (the projects store, above) or none: a chat folder (ATO-1034,
   chat-folders.js), which import and the sorting make too and which is drawn
   here the same way, with the same Edit and Remove, its own instructions
   (main reads them for each turn, chat-folders.ts folderForTurn) and chats
   dragged in. The Folders section is gone. New project opens a sheet: a
   name, a folder on disk if you want one, instructions. */

const PROJECTS = {state: {projects: [], chats: {}}, loaded: false, collapsed: new Set(), newFor: null, edit: null, create: null,
  fileTurns: new Map(), showAll: false};
const PROJECT_INSTRUCTIONS_MAX = 16000;
const PROJECT_NAME_MAX = 80;
const PROJECTS_COLLAPSED_KEY = 'atomic.projects.collapsed';
/* Projects this window has already drawn. One that shows up from elsewhere
   (an import brings dozens at once) starts folded, the way Claude lists its
   projects; one made here with New project opens (projectCreate). */
const PROJECTS_KNOWN_KEY = 'atomic.projects.known';
const PROJECTS_KNOWN = new Set();
let PROJECTS_KNOWN_READ = false;

try {
  const raw = typeof localStorage !== 'undefined' ? JSON.parse(localStorage.getItem(PROJECTS_COLLAPSED_KEY) || '[]') : [];
  if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string') PROJECTS.collapsed.add(id);
  const known = typeof localStorage !== 'undefined' ? localStorage.getItem(PROJECTS_KNOWN_KEY) : null;
  if (known !== null) {
    PROJECTS_KNOWN_READ = true;
    const ids = JSON.parse(known);
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') PROJECTS_KNOWN.add(id);
  }
} catch (e) { /* a per-window convenience only */ }

function projectsSaveFolds() {
  try {
    localStorage.setItem(PROJECTS_COLLAPSED_KEY, JSON.stringify([...PROJECTS.collapsed]));
    localStorage.setItem(PROJECTS_KNOWN_KEY, JSON.stringify([...PROJECTS_KNOWN]));
  } catch (e) { /* kept for this run */ }
}

/* Fold every project not seen before. The very first read of a window that
   never stored the list (an update from a build without it) only records
   what is there, so projects someone already had open stay open. */
function projectsFoldNew(projects) {
  let changed = false;
  for (const p of projects) {
    if (PROJECTS_KNOWN.has(p.id)) continue;
    PROJECTS_KNOWN.add(p.id);
    if (PROJECTS_KNOWN_READ) PROJECTS.collapsed.add(p.id);
    changed = true;
  }
  PROJECTS_KNOWN_READ = true;
  if (changed) projectsSaveFolds();
}

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
  if (res && typeof res === 'object' && res.ok !== false) {
    PROJECTS.state = projectsCoerce('data' in res ? res.data : res);
    projectsFoldNew(PROJECTS.state.projects);
  }
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
  projectsSaveFolds();
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
  if (PROJECTS.state.projects.some((p) => p.id === n.id)) return n.id;
  return typeof FOLDERS !== 'undefined' && folderById(FOLDERS.state, n.id) ? n.id : undefined;
}

/* A new chat New project opened in a project with no disk folder: main reads
   that project's instructions for the first turn by its id, and the chat is
   filed in it here once the turn says its session id (renderer.js). */
function projectNoteTurn(turnId, pid) {
  if (turnId && typeof pid === 'string' && pid[0] === 'f') PROJECTS.fileTurns.set(turnId, pid);
}

function projectFileNewChat(turnId, sid) {
  const fid = PROJECTS.fileTurns.get(turnId);
  if (!fid) return;
  PROJECTS.fileTurns.delete(turnId);
  if (sid && typeof FOLDERS !== 'undefined' && folderPut(FOLDERS.state, sid, fid)) saveFolders();
}

/* New project (W2 QA): a sheet with a name, a folder on disk if wanted, and
   instructions. With a folder it is the projects store's, and a new chat
   opens there; without, it is a chat folder. Opened from a chat's "Move to
   project" list (`put`), the chat goes into it and no new chat opens. */
function projectCreateOpen(put) {
  if (!projectsApi()) return;
  PROJECTS.create = {name: '', folder: '', instructions: '', shownName: '', shownInstructions: '', error: null, saving: false, put: put || null};
  S.overlay = 'pnew';
  render();
  const f = typeof document !== 'undefined' && document.getElementById('pnew-name');
  if (f) f.focus();
}

function projectCreateRedraw(patch) {
  const c = PROJECTS.create;
  if (!c) return;
  Object.assign(c, patch, {shownName: c.name, shownInstructions: c.instructions});
  S.overlay = 'pnew';
  render();
}

async function projectCreatePick() {
  const c = PROJECTS.create;
  if (!c || c.saving || typeof BR === 'undefined' || !BR || typeof BR.overnightPickFolder !== 'function') return;
  let dir = null;
  try { dir = await BR.overnightPickFolder(c.folder || (typeof WORKSPACE === 'string' ? WORKSPACE : ''), 'project'); } catch (e) { dir = null; }
  if (PROJECTS.create !== c || typeof dir !== 'string' || !dir) return;
  projectCreateRedraw({folder: dir, name: c.name.trim() ? c.name : projectNameFromDir(dir), error: null});
}

/* Put chat `sid` in project `pid` (a store id `p…` or a folder id `f…`), or in none (''). */
function projectPutChat(sid, pid) {
  if (!sid) return false;
  if (pid && pid[0] === 'p') {
    const api = projectsApi();
    if (!api || typeof api.projectsAssign !== 'function' || !PROJECTS.state.projects.some((p) => p.id === pid)) return false;
    PROJECTS.state.chats[sid] = pid;
    api.projectsAssign({sessionId: sid, projectId: pid}).then((res) => {
      if (res && res.ok === false) toast('Could not move the chat', res.error || '', 'bad');
    }, () => {});
    // A chat folder wins over a project by path in the sidebar: it leaves the folder.
    if (folderPut(FOLDERS.state, sid, null)) saveFolders();
    return true;
  }
  if (!folderPut(FOLDERS.state, sid, pid || null)) return false;
  saveFolders();
  if (!pid && PROJECTS.state.chats[sid]) {
    delete PROJECTS.state.chats[sid];
    const api = projectsApi();
    if (api && typeof api.projectsAssign === 'function') api.projectsAssign({sessionId: sid, projectId: null}).then(() => {}, () => {});
  }
  return true;
}

async function projectCreateSave() {
  const c = PROJECTS.create, api = projectsApi();
  if (!c || !api || c.saving) return;
  const name = String(c.name || '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (!name) { projectCreateRedraw({error: 'Give the project a name'}); return; }
  if ([...name].length > PROJECT_NAME_MAX) { projectCreateRedraw({error: 'A project name is at most ' + PROJECT_NAME_MAX + ' characters'}); return; }
  if (c.instructions.length > PROJECT_INSTRUCTIONS_MAX) { projectCreateRedraw({error: 'Instructions are at most ' + PROJECT_INSTRUCTIONS_MAX + ' characters'}); return; }
  // As the workspace chip: no new chat opens over a chat that runs a turn.
  if (!c.put && S.busy) { if (typeof restartRefusedToast === 'function') restartRefusedToast({here: true, title: ''}); return; }
  let id;
  if (c.folder) {
    let p = projectForFolder(PROJECTS.state, c.folder);
    if (!p) {
      projectCreateRedraw({saving: true, error: null});
      let saved = null;
      try { saved = await api.projectsSave({name, folder: c.folder, instructions: c.instructions}); } catch (e) { saved = {ok: false, error: String(e && e.message || e)}; }
      if (PROJECTS.create !== c) return;   // closed meanwhile
      p = projectFromSave(saved);
      if (!p) { projectCreateRedraw({saving: false, error: (saved && saved.error) || 'The project was not created'}); return; }
      PROJECTS.state.projects.unshift(p);   // the store lists newest first
    }
    id = p.id;
    PROJECTS.collapsed.delete(id);
    PROJECTS_KNOWN.add(id);
    projectsSaveFolds();
  } else {
    id = folderAdd(FOLDERS.state, name);
    const f = folderById(FOLDERS.state, id);
    if (f && c.instructions.trim()) f.instructions = c.instructions.trim();
    saveFolders();
  }
  PROJECTS.create = null;
  if (S.overlay === 'pnew') S.overlay = null;
  if (c.put) {
    projectPutChat(c.put, id);
    if (PREFS.pinned.includes(c.put)) { PREFS.pinned = PREFS.pinned.filter((x) => x !== c.put); savePrefs(); }
    toast('Project created', 'The chat is in “' + name + '” now');
    render();
    return;
  }
  act('session:new');
  PROJECTS.newFor = {id, log: S.log};
  render();
}

/** The New project sheet (S.overlay === 'pnew'). */
function projectCreateHTML() {
  const c = PROJECTS.create;
  if (!c) return '';
  const off = c.saving ? ' disabled' : '';
  const body = '<label class="sd-cap" for="pnew-name">Name</label>'
    + '<input id="pnew-name" class="tk-inp" maxlength="' + PROJECT_NAME_MAX + '" placeholder="For example: Marketing" value="' + esc(c.shownName) + '"' + off + '>'
    + '<label class="sd-cap">Folder on your computer <span class="sd-opt">optional</span></label>'
    + '<div class="sd-pnew-folder">'
      + (c.folder
        ? '<span class="mono grow" title="' + esc(c.folder) + '">' + esc(c.folder) + '</span>'
          + '<button class="btn btn-s sm" data-act="pnewpick:"' + off + '>Change</button>'
          + '<button class="btn btn-s sm" data-act="pnewclear:"' + off + '>Remove</button>'
        : '<span class="grow sd-cap">None. Chats in this project work in the folder the window shows.</span>'
          + '<button class="btn btn-s sm" data-act="pnewpick:"' + off + '>Choose folder…</button>')
    + '</div>'
    + '<label class="sd-cap" for="pnew-instr">Instructions for every chat in this project <span class="sd-opt">optional</span></label>'
    + '<textarea id="pnew-instr" class="tk-inp sd-json" rows="6" maxlength="' + PROJECT_INSTRUCTIONS_MAX + '"'
      + ' placeholder="For example: answer in English, run the tests before you say it works."' + off + '>' + esc(c.shownInstructions) + '</textarea>'
    + (c.error ? '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(c.error) + '</span></div>' : '');
  return sheet('New project', body,
    '<span class="grow"></span><button class="btn btn-s sm" data-act="close">Cancel</button>'
    + '<button class="btn btn-p sm" data-act="pnewsave:"' + off + '>' + (c.saving ? '<span class="tk-spin"></span>' : '') + 'Create project</button>',
    'sheet-project');
}

/** Remove a project from the sidebar. Its chats stay, under Chats. */
function projectRemove(id) {
  if (id && id[0] === 'f') {
    if (folderRemove(FOLDERS.state, id)) { saveFolders(); toast('Project removed', 'Its chats are kept, under Chats'); }
    render();
    return;
  }
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
/* A project by its id: the store's (`p…`) or a chat folder (`f…`), as {id, name, folder, instructions}. */
function projectAny(id) {
  if (id && id[0] === 'f') {
    const f = typeof FOLDERS !== 'undefined' ? folderById(FOLDERS.state, id) : null;
    return f ? {id: f.id, name: f.name, folder: '', instructions: f.instructions || ''} : null;
  }
  return PROJECTS.state.projects.find((x) => x.id === id) || null;
}

function projectEditOpen(id) {
  const p = projectAny(id);
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
  if (e.id[0] === 'f') {
    const f = folderById(FOLDERS.state, e.id);
    if (!f || !folderRename(FOLDERS.state, e.id, name)) { projectEditRedraw({error: 'The project was not saved'}); return; }
    const text = e.instructions.trim();
    if (text) f.instructions = text; else delete f.instructions;
    saveFolders();
    PROJECTS.edit = null;
    if (S.overlay === 'pedit') S.overlay = null;
    render();
    return;
  }
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
  const p = projectAny(e.id);
  const body = '<label class="sd-cap" for="pedit-name">Name</label>'
    + '<input id="pedit-name" class="tk-inp" maxlength="' + PROJECT_NAME_MAX + '" value="' + esc(e.shownName) + '"' + (e.saving ? ' disabled' : '') + '>'
    + (p && p.folder ? '<p class="sd-cap mono" title="' + esc(p.folder) + '">' + esc(p.folder) + '</p>' : '')
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
    const e = PROJECTS.edit, c = PROJECTS.create, t = ev.target;
    if (!t) return;
    if (c && t.id === 'pnew-name') c.name = t.value;
    else if (c && t.id === 'pnew-instr') c.instructions = t.value;
    if (!e) return;
    if (t.id === 'pedit-name') e.name = t.value;
    else if (t.id === 'pedit-instr') e.instructions = t.value;
  });
}

/** The act verbs this file owns (renderer.js act() hands them over). */
function projectAct(k, v) {
  if (k === 'pnew') { projectCreateOpen(v || null); return true; }
  if (k === 'pnewpick') { projectCreatePick(); return true; }
  if (k === 'pnewclear') { projectCreateRedraw({folder: ''}); return true; }
  if (k === 'pnewsave') { projectCreateSave(); return true; }
  if (k === 'ptoggle') { projectToggle(v); render(); if (typeof nameVisibleSessions === 'function') nameVisibleSessions(); return true; }
  if (k === 'pmore') { PROJECTS.showAll = PROJECTS.showAll !== true; render(); if (typeof nameVisibleSessions === 'function') nameVisibleSessions(); return true; }
  if (k === 'pdelask') {
    const p = projectAny(v);
    if (!p) return true;
    S.alert = {title: 'Remove project “' + p.name + '”?', msg: p.folder ? 'Its chats stay, under Chats. The folder on disk is not touched.' : 'Its chats stay, under Chats.', ok: 'Remove', act: 'pdel:' + v};
    render(); return true;
  }
  if (k === 'pdel') { projectRemove(v); return true; }
  if (k === 'pedit') { projectEditOpen(v); return true; }
  if (k === 'psave') { projectEditSave(); return true; }
  return false;
}

/** The Projects block of the sidebar: each project and its chats.
    W2: "New project" left the rows under New chat and is this header's small
    button, so the header is drawn whenever the projects store is there, with
    no projects too (the rail hides an empty block, shell.css).
    W2 QA (16.11): the chat folders are listed here too, as projects with no
    disk folder (projectItems orders both by their latest chat); past the
    first few, "Show N more projects" (folderListCut), the one holding the
    open chat always shown. A project's header takes a dragged chat. */
function projectsSidebarHTML(groups, folders) {
  if (!projectsSupported()) return '';
  const items = projectItems(groups || [], folders || []);
  const openSid = typeof S !== 'undefined' && S ? S.sessionId : null;
  const cut = folderListCut(items, openSid, PROJECTS.showAll === true);
  const toggle = cut.hidden > 0
    ? '<button class="loadmore" data-act="pmore:">Show ' + cut.hidden + ' more ' + (cut.hidden === 1 ? 'project' : 'projects') + '</button>'
    : PROJECTS.showAll === true && items.length > FOLDERS_SHOWN ? '<button class="loadmore" data-act="pmore:">Show fewer projects</button>' : '';
  const plus = typeof lucideIcon === 'function' ? lucideIcon('folderPlus') : ic('folder');
  return '<div class="sb-list sb-folders sb-projects' + (items.length ? '' : ' sb-projects-empty') + '" data-list="projects">'
    + '<div class="sb-list-head micro"><span>Projects</span>'
      + '<button class="iconbtn sb-add sb-pnew" data-act="pnew:" title="New project" aria-label="New project">' + plus + '</button></div>'
    + cut.shown.map((g) => {
      const folder = g.kind === 'folder';
      const shut = folder ? g.item.collapsed : projectCollapsed(g.id);
      const where = folder ? '' : ' · ' + g.item.folder;
      const head = folder
        ? '<button class="sb-fhead" data-act="ftoggle:' + esc(g.id) + '" data-fdrop="' + esc(g.id) + '" aria-expanded="' + !shut + '"'
        : '<button class="sb-fhead" data-act="ptoggle:' + esc(g.id) + '" data-fdrop="' + esc(g.id) + '" aria-expanded="' + !shut + '"';
      return '<div class="sb-folder sb-project' + (shut ? ' collapsed' : '') + '" ' + (folder ? 'data-folder' : 'data-project') + '="' + esc(g.id) + '">'
        + head
          + ' title="' + esc(g.name + where + ' · ' + g.rows.length + (g.rows.length === 1 ? ' chat' : ' chats')) + '">'
          + '<span class="sb-fchev">' + ic(shut ? 'chevR' : 'chevD') + '</span>'
          + '<span class="sb-fic">' + ic('folder') + '</span>'
          + '<span class="sb-fname">' + esc(g.name) + '</span>'
          + (g.rows.length ? '<span class="ct tnum">' + g.rows.length + '</span>' : '')
          + '<span class="sesmore iconbtn" data-act="pedit:' + esc(g.id) + '" title="Edit project" aria-label="Edit project" role="button">' + ic('edit') + '</span>'
          + '<span class="sesmore iconbtn" data-act="pdelask:' + esc(g.id) + '" title="Remove project" aria-label="Remove project" role="button">' + ic('x') + '</span>'
        + '</button>'
        + (shut ? '' : g.rows.length ? g.rows.map(chatRow).join('') : '<div class="sb-empty sb-fempty">No chats yet. Drag a chat here</div>')
        + '</div>';
    }).join('')
    + toggle
    + '</div>';
}

/** The chat's "Move to project" list (S.overlay === 'fpick'): every project, then No project and New project. */
function projectPickItems(sid) {
  const here = (FOLDERS.state.chats[sid]) || PROJECTS.state.chats[sid] || '';
  const items = projectItems(PROJECTS.state.projects.map((p) => ({project: p, rows: []})),
    FOLDERS.state.folders.map((f) => ({folder: f, rows: []})));
  return items.map((g) => ({act: 'fput:' + g.id + ':' + sid, label: g.name, icon: 'folder', on: g.id === here}))
    .concat(here ? [{act: 'fput::' + sid, label: 'No project', icon: 'x'}] : [])
    .concat([{act: 'pnew:' + sid, label: 'New project…', icon: 'plus', sep: items.length > 0}]);
}
