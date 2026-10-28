/* ---------------- ATO-1034: folders for chats ----------------
   Loaded before renderer.js; declares only. The pure half is shared with the
   Node checks (test/chat-folders.test.mjs); the renderer half reads
   renderer.js globals at call time, as chat-rename.js does.

   The owner's words (25.10): "I miss folders. Neither creating them nor on
   import. If I imported chats, the import should come with folders, and the
   ones already imported should move into folders too."

   So: folders in the sidebar (New folder, rename, delete — the chats stay —,
   drag a chat onto a folder or pick one from the row's menu, fold and
   unfold), kept in ~/.atomic-agent/chat-folders.json (main/chat-folders.ts),
   the state directory the terminal shares, not Electron's userData.

   Imported chats sort themselves: a chat whose id says where it came from
   (`claude-code:…`, `codex:…`, `hermes:…`, `openclaw:…`, `pi:…`,
   `oh-my-pi:…`) goes into a folder named after that app, the first time the
   sidebar sees it — chats imported before this change too. A chat the person
   moved (out of a folder too) is theirs and never sorted again; Settings ›
   Import's "Put imported chats into folders" turns the sorting off.

   ATO-1253: Claude Code chats go into a folder per PROJECT instead, the
   folder that Claude Code session ran in (its last path segment; a second
   project with the same name gets its parent's name too: "app (client)").
   `projects` remembers which folder belongs to which project path, so a
   renamed folder keeps its chats; `auto` marks the chats the sorting placed
   (and may move again), so a re-run moves them to their project's folder
   and never touches one the person placed. Chats sorted into the one
   "Claude Code" folder before this change move once (`projectSort` off in
   an older file), and that folder goes when nothing is left in it. */

const FOLDER_NAME_MAX = 80;
const FOLDER_SOURCES = {
  'claude-code': 'Claude Code', codex: 'Codex', hermes: 'Hermes', openclaw: 'OpenClaw', pi: 'Pi', 'oh-my-pi': 'Oh My Pi',
};

function foldersEmpty() {
  return {version: 1, folders: [], chats: {}, autoSort: true, projects: {}, auto: {}, projectSort: true};
}

/** Whatever main sent (or nothing), as a value this file can edit. */
function foldersCoerce(raw) {
  const out = foldersEmpty();
  if (!raw || typeof raw !== 'object') return out;
  const ids = new Set();
  for (const f of Array.isArray(raw.folders) ? raw.folders : []) {
    if (!f || typeof f.id !== 'string' || typeof f.name !== 'string' || ids.has(f.id) || !f.name.trim()) continue;
    ids.add(f.id);
    out.folders.push({id: f.id, name: f.name.trim().slice(0, FOLDER_NAME_MAX), collapsed: f.collapsed === true});
  }
  const chats = raw.chats && typeof raw.chats === 'object' ? raw.chats : {};
  for (const sid of Object.keys(chats)) {
    const fid = chats[sid];
    if (fid === null || (typeof fid === 'string' && ids.has(fid))) out.chats[sid] = fid;
  }
  out.autoSort = raw.autoSort !== false;
  const projects = raw.projects && typeof raw.projects === 'object' ? raw.projects : {};
  for (const fid of Object.keys(projects)) if (ids.has(fid) && typeof projects[fid] === 'string' && projects[fid]) out.projects[fid] = projects[fid];
  const auto = raw.auto && typeof raw.auto === 'object' ? raw.auto : {};
  for (const sid of Object.keys(auto)) if (auto[sid] === true && typeof out.chats[sid] === 'string') out.auto[sid] = true;
  // A file from before ATO-1253 has no `projectSort`: its Claude Code chats move to their project's folder once.
  out.projectSort = raw.projectSort === true;
  return out;
}

/** The app an imported chat came from, by its id's prefix, or null. */
function folderImportSource(sessionId) {
  const m = /^([a-z-]+):/.exec(String(sessionId || ''));
  return m && FOLDER_SOURCES[m[1]] ? m[1] : null;
}

/** A folder name as typed: {ok, name} or {ok:false, error}. */
function folderNameCheck(raw) {
  const name = String(raw == null ? '' : raw).replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim();
  if (!name) return {ok: false, error: 'A folder name cannot be empty'};
  if ([...name].length > FOLDER_NAME_MAX) return {ok: false, error: 'A folder name is at most ' + FOLDER_NAME_MAX + ' characters'};
  return {ok: true, name};
}

function folderNewId(state) {
  const taken = new Set(state.folders.map((f) => f.id));
  let id;
  do { id = 'f' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); } while (taken.has(id));
  return id;
}

/** "New folder", or "New folder 2" when that is taken. */
function folderFreeName(state, base) {
  const names = new Set(state.folders.map((f) => f.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!names.has((base + ' ' + n).toLowerCase())) return base + ' ' + n;
}

/** Add a folder at the top of the list; returns its id. */
function folderAdd(state, name) {
  const id = folderNewId(state);
  state.folders.unshift({id, name: folderFreeName(state, name || 'New folder'), collapsed: false});
  return id;
}

function folderById(state, id) {
  return state.folders.find((f) => f.id === id) || null;
}

function folderRename(state, id, name) {
  const f = folderById(state, id);
  const checked = folderNameCheck(name);
  if (!f || !checked.ok) return false;
  f.name = checked.name;
  return true;
}

/** Remove a folder. Its chats stay, out of every folder, and are not sorted back in. */
function folderRemove(state, id) {
  const i = state.folders.findIndex((f) => f.id === id);
  if (i < 0) return false;
  state.folders.splice(i, 1);
  for (const sid of Object.keys(state.chats)) if (state.chats[sid] === id) { state.chats[sid] = null; delete state.auto[sid]; }
  delete state.projects[id];
  return true;
}

/** Put chat `sid` in folder `fid` (null: in no folder). The person's choice: never sorted again. */
function folderPut(state, sid, fid) {
  if (!sid) return false;
  if (fid && !folderById(state, fid)) return false;
  state.chats[sid] = fid || null;
  delete state.auto[sid];
  return true;
}

/** The folder chat `sid` is in, or null. */
function folderOf(state, sid) {
  const fid = state.chats[sid];
  return fid ? folderById(state, fid) : null;
}

/** A deleted chat leaves the file. */
function folderForget(state, sid) {
  if (!(sid in state.chats)) return false;
  delete state.chats[sid];
  delete state.auto[sid];
  return true;
}

/** Each folder with its rows (in `rows` order), and the rows in no folder. */
function folderGroups(state, rows) {
  const by = new Map(state.folders.map((f) => [f.id, []]));
  const loose = [];
  for (const r of rows || []) {
    const fid = r && state.chats[r.id];
    if (fid && by.has(fid)) by.get(fid).push(r); else loose.push(r);
  }
  return {groups: state.folders.map((f) => ({folder: f, rows: by.get(f.id)})), loose};
}

/** A project path's segments, either slash: "/Users/me/src/app/" → ["Users", "me", "src", "app"]. */
function folderPathParts(dir) {
  return String(dir || '').split(/[\\/]+/).filter(Boolean);
}

/**
 * The folder for one Claude Code project: the one already kept for this path,
 * else a folder of that name nobody's project holds yet, else a new one —
 * "app", then "app (parent)" for a second project called app.
 */
function folderForProject(state, dir) {
  const parts = folderPathParts(dir);
  const key = parts.join('/');
  for (const fid of Object.keys(state.projects)) {
    if (folderPathParts(state.projects[fid]).join('/') === key && folderById(state, fid)) return folderById(state, fid);
  }
  const base = (parts[parts.length - 1] || String(dir)).slice(0, FOLDER_NAME_MAX);
  const named = state.folders.find((f) => f.name.toLowerCase() === base.toLowerCase());
  let name = base;
  if (named && !(named.id in state.projects) && !Object.values(FOLDER_SOURCES).includes(named.name)) {
    state.projects[named.id] = dir;
    return named;
  }
  if (named) name = folderFreeName(state, parts.length > 1 ? base + ' (' + parts[parts.length - 2] + ')' : base);
  const f = {id: folderNewId(state), name: name.slice(0, FOLDER_NAME_MAX), collapsed: false};
  state.folders.push(f);
  state.projects[f.id] = dir;
  return f;
}

function folderForApp(state, src) {
  const name = FOLDER_SOURCES[src];
  let f = state.folders.find((x) => x.name === name && !(x.id in state.projects));
  if (!f) { f = {id: folderNewId(state), name, collapsed: false}; state.folders.push(f); }
  return f;
}

/**
 * Sort imported chats into folders: Claude Code chats by project (the
 * session's `workingDir`), the other apps' by app. Chats nobody placed yet,
 * and chats this sorting placed before, which move when their folder should
 * change. Returns how many changed.
 */
function folderAutoSort(state, sessions) {
  if (!state.autoSort) return 0;
  const legacy = !state.projectSort;
  const oldFolder = legacy ? state.folders.find((f) => f.name === FOLDER_SOURCES['claude-code'] && !(f.id in state.projects)) : null;
  let moved = 0;
  // Every Claude Code chat the old sorting filed there counts as sorted, also one the list does not carry today (past its 200 rows).
  if (oldFolder) for (const sid of Object.keys(state.chats)) if (state.chats[sid] === oldFolder.id && folderImportSource(sid) === 'claude-code') state.auto[sid] = true;
  for (const s of sessions || []) {
    if (!s || !s.id) continue;
    const src = folderImportSource(s.id);
    if (!src) continue;
    const placed = s.id in state.chats;
    if (placed && state.auto[s.id] !== true) continue;
    const f = src === 'claude-code' && typeof s.workingDir === 'string' && folderPathParts(s.workingDir).length
      ? folderForProject(state, s.workingDir) : folderForApp(state, src);
    if (state.chats[s.id] !== f.id || state.auto[s.id] !== true) moved++;
    state.chats[s.id] = f.id;
    state.auto[s.id] = true;
  }
  if (legacy) {
    state.projectSort = true;
    moved++;
    // The one "Claude Code" folder the old sorting made goes once its chats have moved out.
    if (oldFolder && !Object.values(state.chats).includes(oldFolder.id)) folderRemove(state, oldFolder.id);
  }
  return moved;
}

/* ---- renderer side (globals from renderer.js, read at call time) ---- */

const FOLDERS = {state: foldersEmpty(), loaded: false};
/* The folder menu (S.overlay === 'fmenu') and the chat's folder picker
   (S.overlay === 'fpick'): which folder or chat, and where it opened. */
const FMENU = {id: null, point: null};

async function loadFolders() {
  if (typeof BR === 'undefined' || !BR || !BR.foldersGet) { FOLDERS.loaded = true; return; }
  let res = null;
  try { res = await BR.foldersGet(); } catch (e) { res = null; }
  if (res && res.ok) FOLDERS.state = foldersCoerce(res.data);
  FOLDERS.loaded = true;
  foldersAfterSessions();
  render();
}

function saveFolders() {
  if (typeof BR === 'undefined' || !BR || !BR.foldersSet) return;
  BR.foldersSet(JSON.parse(JSON.stringify(FOLDERS.state))).then((res) => {
    if (res && res.ok === false) toast('Could not save the folders', res.error || '', 'bad');
  }, () => {});
}

/** Called each time the chat list lands (applySessions): imported chats find their folder. */
function foldersAfterSessions() {
  if (!FOLDERS.loaded || typeof SESSIONS === 'undefined') return;
  if (folderAutoSort(FOLDERS.state, SESSIONS)) saveFolders();
}

/** New folder: added at the top, its name box open at once. */
function folderCreate(thenPut) {
  const id = folderAdd(FOLDERS.state, 'New folder');
  if (thenPut) folderPut(FOLDERS.state, thenPut, id);
  saveFolders();
  render();
  if (typeof renameStart === 'function') renameStart(id, 'folder');
  return id;
}

function folderMenuOpen(kind, id, anchor) {
  const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  FMENU.id = id; FMENU.point = r && r.width > 0 ? {x: r.left, y: r.bottom + 4} : {x: 60, y: 60};
  S.overlay = kind;
  render();
  if (typeof focusChatMenu === 'function') focusChatMenu(0);
}

/** The folder's menu and the chat's "Move to folder" list, on the overlay layer. */
function folderMenuHTML() {
  let items = [], label = '';
  if (S.overlay === 'fmenu') {
    const f = folderById(FOLDERS.state, FMENU.id);
    if (!f) return '';
    label = 'Folder actions: ' + f.name;
    items = [
      {act: 'frename:' + f.id, label: 'Rename', icon: 'edit'},
      {act: 'fdel:' + f.id, label: 'Delete folder', icon: 'trash', danger: true},
    ];
  } else {
    const sid = FMENU.id;
    const here = FOLDERS.state.chats[sid] || '';
    label = 'Move to folder';
    items = FOLDERS.state.folders.map((f) => ({act: 'fput:' + f.id + ':' + sid, label: f.name, icon: 'folder', on: f.id === here}))
      .concat(here ? [{act: 'fput::' + sid, label: 'No folder', icon: 'x'}] : [])
      .concat([{act: 'fnew:' + sid, label: 'New folder…', icon: 'plus', sep: FOLDERS.state.folders.length > 0}]);
  }
  const w = typeof SESMENU_W === 'number' ? SESMENU_W : 220;
  const h = items.length * 34 + 21;
  const at = chatMenuPlace(FMENU.point.x, FMENU.point.y, w, h, window.innerWidth, window.innerHeight);
  return '<div class="scrim" data-close="1" style="background:transparent">'
    + '<div class="popover sesmenu tk-pop" role="menu" aria-label="' + esc(label) + '"'
      + ' style="position:fixed;left:' + at.left + 'px;top:' + at.top + 'px;right:auto;bottom:auto;width:' + w + 'px;transform-origin:0 0">'
    + items.map((it) => ((it.danger || it.sep) ? '<div class="sesmenu-sep" role="separator"></div>' : '')
        + '<button class="tk-mi sesmenu-item' + (it.danger ? ' tk-mi--danger' : '') + (it.on ? ' on' : '') + '" role="menuitem" tabindex="-1"'
        + (it.on ? ' aria-current="true"' : '') + ' data-act="' + esc(it.act) + '">'
        + ic(it.icon) + '<span class="body"><span class="t">' + esc(it.label) + '</span></span></button>').join('')
    + '</div></div>';
}

/** The folders block of the sidebar: a header with New folder, then each folder and its chats. */
function foldersSidebarHTML(groups) {
  // No folders yet: nothing drawn here; New folder sits on the Chats heading then (renderSidebar).
  if (!groups.length) return '';
  return '<div class="sb-list sb-folders" data-list="folders">'
    + '<div class="sb-list-head micro"><span>Folders</span>'
      + '<button class="iconbtn sb-add" data-act="fnew:" title="New folder" aria-label="New folder">' + ic('plus') + '</button></div>'
    + groups.map((g) => {
      const f = g.folder;
      return '<div class="sb-folder' + (f.collapsed ? ' collapsed' : '') + '" data-folder="' + esc(f.id) + '">'
        + '<button class="sb-fhead" data-ftoggle="' + esc(f.id) + '" data-fdrop="' + esc(f.id) + '" aria-expanded="' + !f.collapsed + '"'
          + ' title="' + esc(f.name + ' · ' + g.rows.length + (g.rows.length === 1 ? ' chat' : ' chats')) + '">'
          + '<span class="sb-fchev">' + ic(f.collapsed ? 'chevR' : 'chevD') + '</span>'
          + '<span class="sb-fic">' + ic('folder') + '</span>'
          + '<span class="sb-fname">' + esc(f.name) + '</span>'
          + (g.rows.length ? '<span class="ct tnum">' + g.rows.length + '</span>' : '')
          + '<span class="sesmore iconbtn" data-fmenu="' + esc(f.id) + '" title="Folder actions" aria-label="Folder actions"'
            + ' aria-haspopup="menu" role="button" tabindex="0">' + ic('dots') + '</span>'
        + '</button>'
        + (f.collapsed ? '' : g.rows.length ? g.rows.map(chatRow).join('') : '<div class="sb-empty sb-fempty">Drag a chat here</div>')
        + '</div>';
    }).join('')
    + '</div>';
}

/** A folder's name in the ⌘K palette's context line ("Chat · Work · read"), or ''. */
function folderPaletteWord(sid) {
  const f = folderOf(FOLDERS.state, sid);
  return f ? f.name + ' · ' : '';
}

/* Drag a chat row onto a folder's header (or onto "Chats" to take it out of
   its folder). A custom type, so the file drop (attachments.js, which looks
   for Files) never sees it. */
const FOLDER_DRAG_TYPE = 'application/x-atomic-chat';
if (typeof document !== 'undefined') {
  document.addEventListener('dragstart', (e) => {
    const row = e.target && e.target.closest ? e.target.closest('#sidebar .sesrow[data-ses]') : null;
    if (!row || !e.dataTransfer) return;
    e.dataTransfer.setData(FOLDER_DRAG_TYPE, row.dataset.ses);
    e.dataTransfer.effectAllowed = 'move';
  });
  const target = (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes(FOLDER_DRAG_TYPE)) return null;
    return e.target && e.target.closest ? e.target.closest('#sidebar [data-fdrop]') : null;
  };
  document.addEventListener('dragover', (e) => {
    const t = target(e);
    if (!t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('#sidebar .fdrop-on').forEach((n) => { if (n !== t) n.classList.remove('fdrop-on'); });
    t.classList.add('fdrop-on');
  });
  document.addEventListener('dragleave', (e) => {
    const t = target(e);
    if (t && !t.contains(e.relatedTarget)) t.classList.remove('fdrop-on');
  });
  document.addEventListener('drop', (e) => {
    const t = target(e);
    document.querySelectorAll('#sidebar .fdrop-on').forEach((n) => n.classList.remove('fdrop-on'));
    if (!t) return;
    e.preventDefault();
    const sid = e.dataTransfer.getData(FOLDER_DRAG_TYPE);
    if (sid) act('fput:' + (t.dataset.fdrop || '') + ':' + sid);
  });
  document.addEventListener('dragend', () => {
    document.querySelectorAll('#sidebar .fdrop-on').forEach((n) => n.classList.remove('fdrop-on'));
  });
}

if (typeof module !== 'undefined') {
  module.exports = {FOLDER_SOURCES, foldersEmpty, foldersCoerce, folderImportSource, folderNameCheck, folderAdd, folderById,
    folderRename, folderRemove, folderPut, folderOf, folderForget, folderGroups, folderAutoSort, folderFreeName, folderForProject};
}
