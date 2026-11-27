/* ATO-2411: a project with no disk folder (a chat folder, `f…`, ATO-1034)
   gets one. Edit project's Folder row offers Choose folder… on it
   (project-edit-extras.js draws the row and keeps the pick in e.x.folder);
   Save then comes here instead of the plain rename:

   1. The projects store gets a new project with the folder, the name and the
      instructions as typed (projects:save, main/projects-store.ts). A store
      project is what carries a folder: a chat folder cannot (chat-folders.ts
      has no such field), so the project changes its kind and its id.
   2. Each chat the folder held is filed in the new project by id
      (projects:assign), so the sidebar keeps them together whatever folder
      they ran in. Chats already stored keep the folder they run in, as a
      moved project's do (ATO-1012); new chats open in the project's folder.
   3. The chat folder goes (chat-folders.json): its chats are the project's
      now, and a chat folder wins over a project in the sidebar
      (chat-list.js projectGroups), so both cannot stay. Fold state follows.
   4. The model picked in the sheet is saved for the folder, through the
      same hook a moved project uses (projectEditExtrasSaved).

   Nothing is undone when a later step fails: the store project exists from
   step 1, and the person sees the error for what did not follow. The way
   Claude's Projects and Cursor's workspace settings let you add the folder
   to a project made without one. Pure half: folderUpgradePlan. Loaded after
   project-edit-extras.js; reads renderer.js globals at call time. */

/** What the upgrade carries over from chat folder `fid`: {name, instructions, collapsed, chats: [sessionId]} or null. */
function folderUpgradePlan(folders, fid) {
  const f = folders && Array.isArray(folders.folders) ? folders.folders.find((x) => x && x.id === fid) : null;
  if (!f) return null;
  const chats = [];
  const map = folders.chats && typeof folders.chats === 'object' ? folders.chats : {};
  for (const sid of Object.keys(map)) if (map[sid] === fid) chats.push(sid);
  return {name: f.name, instructions: f.instructions || '', collapsed: f.collapsed === true, chats};
}

/* ATO-2745: the store's refusal (projects-store.ts: "at most 200 projects", "project folder must be an
   absolute path") as a sentence with its reason and a period; anything else says what to do. */
function folderUpgradeError(raw) {
  const r = String(raw || '');
  if (/at most \d+ projects/.test(r)) return 'The project was not saved: there are already as many projects as the app keeps. Remove one first.';
  if (/instructions are longer/.test(r)) return 'The project was not saved: its instructions are too long. Shorten them and save again.';
  if (/project folder/.test(r)) return 'The project was not saved: that folder cannot be used. Choose it again.';
  if (/project name/.test(r)) return 'The project was not saved: it needs a name.';
  return 'The project was not saved. Try again in a moment.';
}

/* ---- the window's half ---- */

/** Save of an Edit project sheet on a chat folder with a folder picked (hook in projectEditSave). */
async function projectEditFolderUpgrade(e, name) {
  const api = typeof projectsApi === 'function' ? projectsApi() : null;
  const x = e && e.x;
  if (!api || !x || !x.folder || e.saving) return false;
  const plan = folderUpgradePlan(FOLDERS.state, e.id);
  if (!plan) { projectEditRedraw({error: 'The project was not saved: this chat folder is gone. Close the sheet and open it again.'}); return true; }
  const other = typeof projectForFolder === 'function' ? projectForFolder(PROJECTS.state, x.folder) : null;
  if (other) { projectEditRedraw({error: 'That folder is already the project “' + other.name + '”.'}); return true; }
  projectEditRedraw({saving: true, error: null});
  let saved = null;
  try { saved = await api.projectsSave({name, folder: x.folder, instructions: e.instructions}); } catch (err) { saved = {ok: false, error: String(err && err.message || err)}; }
  if (PROJECTS.edit !== e) return true;   // closed meanwhile
  const p = projectFromSave(saved);
  if (!p) {
    if (saved && saved.error && typeof console !== 'undefined') console.warn('[projects] save refused:', saved.error);
    projectEditRedraw({saving: false, error: folderUpgradeError(saved && saved.error)});
    return true;
  }
  PROJECTS.state.projects.unshift(p);   // the store lists newest first
  // Its chats, by id: the folder they ran in no longer decides.
  const canAssign = typeof api.projectsAssign === 'function';
  for (const sid of plan.chats) {
    PROJECTS.state.chats[sid] = p.id;
    if (canAssign) api.projectsAssign({sessionId: sid, projectId: p.id}).then((res) => {
      if (res && res.ok === false && typeof toast === 'function') toast('Could not move a chat into the project', 'It stays in the sidebar where it was. Drag it into the project to try again.', 'bad');
    }, () => {});
  }
  if (plan.collapsed) PROJECTS.collapsed.add(p.id); else PROJECTS.collapsed.delete(p.id);
  if (typeof PROJECTS_KNOWN !== 'undefined') PROJECTS_KNOWN.add(p.id);
  if (typeof projectsSaveFolds === 'function') projectsSaveFolds();
  // The chat folder goes; folderRemove leaves its chats out of every folder, as putting a chat in a store project does.
  if (folderRemove(FOLDERS.state, e.id)) saveFolders();
  // An empty chat already opened in this project (New project, the plus) opens in the store project now.
  if (PROJECTS.newFor && PROJECTS.newFor.id === e.id) PROJECTS.newFor.id = p.id;
  if (typeof projectEditExtrasSaved === 'function') projectEditExtrasSaved(e, p);   // the model picked in the sheet
  PROJECTS.edit = null;
  if (S.overlay === 'pedit') S.overlay = null;
  if (typeof toast === 'function') toast('Project folder set', 'New chats in “' + p.name + '” open in ' + p.folder + '.');
  render();
  return true;
}

if (typeof module !== 'undefined') module.exports = {folderUpgradePlan, folderUpgradeError};
