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
     named after that folder, and opens a new chat there. The chat's id is
     known once its first turn starts; it is then assigned to the project.
   - The sidebar shows each project with its chats, folding like a chat
     folder. A chat filed in an ATO-1034 chat folder stays in that folder.
   - Removing a project leaves its chats (under Chats) and the folder on disk.

   Without the store (an older main, or ATO-42 not in this build) nothing here
   is drawn: no row, no heading. */

const PROJECTS = {state: {projects: [], chats: {}}, loaded: false, collapsed: new Set(), newFor: null};
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

function projectAssign(sid, pid) {
  const api = projectsApi();
  if (!api || typeof api.projectsAssign !== 'function' || !sid) return;
  PROJECTS.state.chats[sid] = pid;
  api.projectsAssign({sessionId: sid, projectId: pid}).then((res) => {
    if (res && res.ok === false) toast('Could not add the chat to the project', res.error || '', 'bad');
  }, () => {});
}

/* Called from sidebarChats on every draw: the new chat a "New project" opened
   got its id (its first turn started), so it joins the project. Opening a chat
   that was already there first means the person went elsewhere: dropped. */
function projectsNoteNewChat() {
  const n = PROJECTS.newFor;
  if (!n || typeof S === 'undefined' || !S.agentSession) return;
  PROJECTS.newFor = null;
  if (n.known.has(S.agentSession)) return;
  if (!PROJECTS.state.projects.some((p) => p.id === n.id)) return;
  projectAssign(S.agentSession, n.id);
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
      PROJECTS.state.projects.push(p);
    }
    PROJECTS.collapsed.delete(p.id);
    act('session:new');
    const known = new Set((typeof SESSIONS !== 'undefined' ? SESSIONS : []).map((s) => s.id));
    if (typeof PENDING_CHATS !== 'undefined') for (const id of PENDING_CHATS.keys()) known.add(id);
    PROJECTS.newFor = {id: p.id, known};
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
          + '<span class="sesmore iconbtn" data-act="pdelask:' + esc(p.id) + '" title="Remove project" aria-label="Remove project" role="button">' + ic('x') + '</span>'
        + '</button>'
        + (shut ? '' : g.rows.length ? g.rows.map(chatRow).join('') : '<div class="sb-empty sb-fempty">No chats yet</div>')
        + '</div>';
    }).join('')
    + '</div>';
}

