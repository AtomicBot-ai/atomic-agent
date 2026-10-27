/* ---------------- ATO-455: renaming a chat ----------------
   Loaded before renderer.js; declares only.

   A chat is called by its truncated first prompt until the agent names it,
   and the operator could not fix either. Rename (the row's "…" menu), a
   double-click on the row or on the toolbar's title opens an inline box
   over the name: Enter or a click outside saves, Escape cancels.

   The box is drawn on the overlay layer (S.overlay === 'rename'), not in the
   row: the row is a <button> and the sidebar is rebuilt on every render,
   while renderOverlays keeps a focused field's value and caret across a
   repaint. Saving is optimistic: the row and the title change at once, and
   a refused PATCH /api/sessions/{id} puts the old name back with a toast.

   The agent stamps the title as the operator's, so its own namer never
   replaces it (src/session/session-title-user.ts). The rules below mirror
   validateUserSessionTitle there, so a name the box accepts is one the
   agent stores as typed. */

const RENAME_MAX_CHARS = 120;

/* What the box holds, checked as the agent will check it:
   {ok:true, title} to send, {ok:true, same:true} when nothing changed (the
   box just closes), {ok:false, error} to say why it was not sent. */
function renameTitleCheck(raw, current) {
  const title = String(raw == null ? '' : raw).trim();
  if (!title) return {ok: false, error: 'A chat name cannot be empty'};
  if (/[\r\n\u2028\u2029]/.test(title)) return {ok: false, error: 'A chat name is one line'};
  if ([...title].length > RENAME_MAX_CHARS) return {ok: false, error: 'A chat name is at most ' + RENAME_MAX_CHARS + ' characters'};
  if (current != null && title === String(current).trim()) return {ok: true, same: true, title};
  return {ok: true, title};
}

/* Put `title` on chat `id` in `rows` (SESSIONS) as the agent's own name
   would sit there (applySessions: `titled` keeps it over the first prompt).
   Returns what to restore if the save is refused, or null for no such row. */
function renameApply(rows, id, title) {
  const row = (rows || []).find((x) => x && x.id === id);
  if (!row) return null;
  const was = {t: row.t, titled: !!row.titled, named: !!row.named};
  row.t = title; row.titled = true; row.named = true;
  return was;
}

/* Undo renameApply, unless the row already shows a newer name. */
function renameRevert(rows, id, title, was) {
  const row = (rows || []).find((x) => x && x.id === id);
  if (!row || !was || row.t !== title) return false;
  row.t = was.t; row.titled = was.titled; row.named = was.named;
  return true;
}

/* An agent from before the route answers "no route" (404): say what it
   means instead of echoing the router. */
function renameErrorText(error) {
  const msg = String(error || '');
  if (/no route/i.test(msg)) return 'This agent version cannot rename chats. Update Atomic Agent.';
  return msg.replace(/^Error:\s*/, '');
}

/* ---- renderer side (globals from renderer.js, read at call time) ---- */

const RENAME = {id: null, where: 'row', initial: '', draft: '', rect: null};

/** Open the box over chat `id`'s name: in its row, or in the toolbar's title.
    ATO-1034: `where === 'folder'` opens it over folder `id`'s name instead
    (chat-folders.js); saving then renames the folder, nothing is sent. */
function renameStart(id, where) {
  if (where === 'folder') {
    const f = typeof folderById === 'function' ? folderById(FOLDERS.state, id) : null;
    if (!f) return;
    RENAME.id = id; RENAME.where = 'folder'; RENAME.initial = f.name; RENAME.draft = f.name; RENAME.rect = null;
    S.overlay = 'rename';
    render();
    const fbox = document.getElementById('chat-rename');
    if (!fbox) { RENAME.id = null; RENAME.draft = ''; S.overlay = null; render(); return; }
    fbox.focus(); fbox.select();
    return;
  }
  const row = typeof SESSIONS !== 'undefined' ? SESSIONS.find((x) => x.id === id) : null;
  if (!row) {
    // A new chat's stand-in has no stored session yet (item 27): nothing to rename.
    if (typeof PENDING_CHATS !== 'undefined' && PENDING_CHATS.has(id)) toast('This chat is still starting', 'It can be renamed once its first reply is in');
    return;
  }
  if (where === 'row') revealChatRow(id);
  RENAME.id = id; RENAME.where = where === 'title' ? 'title' : 'row'; RENAME.initial = row.t || ''; RENAME.draft = RENAME.initial; RENAME.rect = null;
  S.overlay = 'rename';
  render();
  let box = document.getElementById('chat-rename');
  // The sidebar as a rail draws no name to edit over: the open chat's toolbar title does.
  if (!box && RENAME.where === 'row' && S.room === 'chat' && S.sessionId === id) {
    RENAME.where = 'title'; render(); box = document.getElementById('chat-rename');
  }
  if (!box) {
    RENAME.id = null; RENAME.draft = ''; S.overlay = null; render();
    toast('Open the sidebar to rename this chat', '');
    return;
  }
  box.focus(); box.select();
}

/* The row has to be on screen to draw the box over it: a chat opened from
   the palette may be scrolled out of the list. */
function revealChatRow(id) {
  const el = renameAnchor(id, 'row');
  if (el && el.scrollIntoView) el.scrollIntoView({block: 'nearest'});
}

function renameAnchor(id, where) {
  if (where === 'title') return document.querySelector('#toolbar .tb-title b');
  const sel = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
  if (where === 'folder') return document.querySelector('#sidebar .sb-folder[data-folder="' + sel + '"] .sb-fname');
  return document.querySelector('#sidebar .sesrow[data-ses="' + sel + '"] .t1');
}

/** The box, drawn by overlaysHTML while S.overlay === 'rename'. */
function renameHTML() {
  if (!RENAME.id) return '';
  const a = renameAnchor(RENAME.id, RENAME.where);
  const live = a ? a.getBoundingClientRect() : null;
  // A repaint that drops the anchor for a frame keeps the box where it was.
  if (live && live.width > 0) RENAME.rect = {left: live.left, top: live.top, width: live.width, height: live.height};
  const r = RENAME.rect;
  if (!r) return '';
  const w = Math.max(160, Math.min(RENAME.where === 'title' ? 420 : r.width + 28, window.innerWidth - r.left - 8));
  const h = Math.max(24, Math.round(r.height) + 6);
  return '<div class="scrim rename-scrim" style="background:transparent">'
    + '<input id="chat-rename" class="chat-rename' + (RENAME.where === 'title' ? ' chat-rename--title' : '') + '"'
      + ' type="text" maxlength="' + (RENAME.where === 'folder' ? FOLDER_NAME_MAX : RENAME_MAX_CHARS) + '" spellcheck="false" autocomplete="off"'
      + ' aria-label="' + (RENAME.where === 'folder' ? 'Folder name' : 'Chat name') + '" value="' + esc(RENAME.draft) + '"'
      + ' style="position:fixed;left:' + Math.round(r.left - 4) + 'px;top:' + Math.round(r.top + r.height / 2 - h / 2) + 'px;width:' + Math.round(w) + 'px;height:' + h + 'px">'
    + '</div>';
}

/** Close the box without saving. */
function renameCancel() {
  const id = RENAME.id;
  RENAME.id = null; RENAME.draft = ''; RENAME.rect = null;
  if (S.overlay === 'rename') S.overlay = null;
  render();
  if (id) renameFocusBack(id);
}

function renameFocusBack(id) {
  const sel = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
  const row = document.querySelector('#sidebar .sesrow[data-ses="' + sel + '"]')
    || document.querySelector('#sidebar .sb-fhead[data-ftoggle="' + sel + '"]');
  if (row) row.focus({preventScroll: true});
}

/** Save what the box holds: optimistic, rolled back with a toast if refused. */
function renameCommit() {
  if (!RENAME.id) return;
  const id = RENAME.id;
  const box = document.getElementById('chat-rename');
  if (RENAME.where === 'folder') {
    // ATO-1034: a folder lives in chat-folders.json only; nothing goes to the agent.
    const named = folderNameCheck(box ? box.value : RENAME.draft);
    if (!named.ok) { toast('Could not rename the folder', named.error, 'bad'); if (box) box.focus(); return; }
    if (named.name !== RENAME.initial && folderRename(FOLDERS.state, id, named.name)) saveFolders();
    renameCancel();
    return;
  }
  const checked = renameTitleCheck(box ? box.value : RENAME.draft, RENAME.initial);
  if (!checked.ok) { toast('Could not rename the chat', checked.error, 'bad'); if (box) box.focus(); return; }
  if (checked.same) { renameCancel(); return; }
  if (!BR || !BR.renameSession) { toast('Could not rename the chat', 'Not connected to the agent', 'bad'); return; }
  const was = renameApply(SESSIONS, id, checked.title);
  renameCancel();   // closes the box and repaints the row with the new name
  BR.renameSession(id, checked.title).then((res) => {
    // A list read that left before the rename landed may have put the old name back: read it again.
    if (res && res.ok) { refreshSessions(); return; }
    if (renameRevert(SESSIONS, id, checked.title, was)) render();
    toast('Could not rename the chat', renameErrorText(res && res.error), 'bad');
  }, (e) => {
    if (renameRevert(SESSIONS, id, checked.title, was)) render();
    toast('Could not rename the chat', renameErrorText(e), 'bad');
  });
}

if (typeof window !== 'undefined') {
  // --smoke: open, read and drive the box.
  window.__renameChat = (id, where) => renameStart(id, where || 'row');
  window.__renameState = () => ({id: RENAME.id, where: RENAME.where, open: S.overlay === 'rename' && !!document.getElementById('chat-rename')});
}

if (typeof module !== 'undefined') module.exports = {RENAME_MAX_CHARS, renameTitleCheck, renameApply, renameRevert, renameErrorText};
