/* ---------------- Settings › My files (ATO-1626) ----------------
   Loaded BEFORE renderer.js, so it only declares: everything it touches
   (BR, S, esc, ic, render, settingsPaneId, paneRepaintKeepFocus) is read
   when a function runs, never at load time.

   The folders the agent indexes for `files.search`, and how far the index
   is. Everything goes through main/my-files-ipc.ts (ATO-1624) to the agent's
   /api/files routes: this screen reads no files and keeps no index of its own.

   Where it lives: LM Studio, Jan and AnythingLLM keep document folders as a
   place of their own, apart from chat; ours is a Settings section beside
   Memory, the way Memory and Plugins already are.

   The status is polled every MF_POLL_MS while this pane is open and never
   otherwise: the timer stops itself on the first tick the pane is not shown. */

const MF_POLL_MS = 3000;

const MF = {
  folders: null,       // MyFilesFolder[] once read
  status: null,        // MyFilesStatus once read
  err: null,           // the last call's error text
  unsupported: false,  // the agent has no file index (501, old agent, capabilities without fileIndex)
  remote: false,       // a remote agent: its folders are listed, not added or removed from here
  loading: false,      // a folder list read is running
  adding: false,       // the picker or the add call is running
  busy: null,          // path a remove is running for
  confirm: null,       // index of the folder whose Remove waits for a second click
  msg: null,           // a short note after an add or remove
  timer: null,
  wasRunning: false,
};

const MF_INTRO = 'Add a folder and the agent can search the documents in it, then answer with a link to the file and the page it read.';

/* ---- pure helpers (exported for test/my-files-screen.test.mjs) ---- */

function mfPlural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

/* 0..100, or null when there is nothing to measure yet. */
function mfPercent(st) {
  if (!st || !st.found) return null;
  const done = (st.indexed || 0) + (st.failed || 0) + (st.skipped || 0);
  return Math.max(0, Math.min(100, Math.round((done / st.found) * 100)));
}

/* "Indexing 120 of 480 files", "480 files indexed", or '' before the first answer. */
function mfProgressText(st) {
  if (!st) return '';
  const done = (st.indexed || 0) + (st.failed || 0) + (st.skipped || 0);
  if (st.running) return st.found ? 'Indexing ' + Math.min(done, st.found) + ' of ' + mfPlural(st.found, 'file') : 'Looking for files…';
  if (!st.found) return '';
  const parts = [mfPlural(st.indexed || 0, 'file') + ' indexed'];
  if (st.failed) parts.push(st.failed + ' could not be read');
  if (st.skipped) parts.push(st.skipped + ' skipped');
  return parts.join(' · ');
}

/* A folder row's second line: its path and "12 of 40 files". */
function mfFolderMeta(f) {
  if (!f) return '';
  const count = f.fileCount > 0 && f.indexedCount < f.fileCount
    ? f.indexedCount + ' of ' + mfPlural(f.fileCount, 'file')
    : mfPlural(f.fileCount || 0, 'file');
  return count;
}

/* `remove:3` → {verb:'remove', index:3}. */
function mfParseAct(what) {
  const s = String(what || '');
  const i = s.indexOf(':');
  if (i === -1) return {verb: s, index: null};
  const n = Number(s.slice(i + 1));
  return {verb: s.slice(0, i), index: Number.isInteger(n) && n >= 0 ? n : null};
}

function mfBase(path) {
  const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(path || '');
}

/* ---- reading ---- */

function mfVisible() {
  return typeof S !== 'undefined' && !!S.settings && typeof settingsPaneId === 'function' && settingsPaneId(S.settingsPane) === 'myfiles';
}

function mfRepaint() {
  if (!mfVisible()) return;
  if (typeof paneRepaintKeepFocus === 'function') paneRepaintKeepFocus(myFilesTab()); else render();
}

function mfApplyFailure(res) {
  MF.err = (res && res.error) || 'The agent did not answer.';
  MF.unsupported = !!res && res.reason === 'unsupported';
  if (res && res.reason === 'remote') MF.remote = true;
}

async function mfRefreshFolders() {
  if (typeof BR === 'undefined' || !BR || !BR.filesListFolders) { MF.err = 'My files needs the desktop bridge.'; return; }
  if (MF.loading) return;
  MF.loading = true;
  try {
    const res = await BR.filesListFolders();
    if (res && res.ok) {
      MF.folders = Array.isArray(res.folders) ? res.folders : [];
      MF.remote = !!res.remote;
      MF.unsupported = false;
      MF.err = null;
    } else {
      mfApplyFailure(res);
      if (MF.unsupported) MF.folders = [];
    }
  } catch (e) {
    MF.err = String((e && e.message) || e);
  } finally {
    MF.loading = false;
  }
  mfRepaint();
}

async function mfRefreshStatus() {
  if (typeof BR === 'undefined' || !BR || !BR.filesStatus || MF.unsupported) return;
  let res;
  try { res = await BR.filesStatus(); } catch (e) { return; }
  if (!res || !res.ok) {
    if (res && res.reason === 'unsupported') { mfApplyFailure(res); mfRepaint(); }
    return;
  }
  const was = MF.wasRunning;
  MF.status = res.status;
  MF.wasRunning = !!res.status.running;
  // While it runs the rows' counts move too; once more when it stops, for the final counts.
  if (res.status.running || was) mfRefreshFolders(); else mfRepaint();
}

function mfStopPoll() {
  if (MF.timer) { clearInterval(MF.timer); MF.timer = null; }
}

function mfTick() {
  if (!mfVisible()) { mfStopPoll(); return; }
  mfRefreshStatus();
}

function myFilesTabEntered() {
  mfStopPoll();
  MF.confirm = null;
  MF.msg = null;
  mfRefreshFolders().then(() => mfRefreshStatus());
  MF.timer = setInterval(mfTick, MF_POLL_MS);
}

/* ---- writing ---- */

async function mfAdd() {
  if (MF.adding || MF.remote || MF.unsupported) return;
  MF.adding = true; MF.msg = null; MF.err = null; mfRepaint();
  try {
    const picked = await BR.filesPickFolder();
    if (!picked || !picked.ok) { mfApplyFailure(picked); return; }
    if (!picked.path) return;   // cancelled
    const res = await BR.filesAddFolder(picked.path);
    if (res && res.ok) {
      MF.msg = 'Added ' + ((res.folder && res.folder.name) || mfBase(picked.path)) + '. The agent is indexing it now.';
      MF.wasRunning = true;
    } else mfApplyFailure(res);
  } catch (e) {
    MF.err = String((e && e.message) || e);
  } finally {
    MF.adding = false;
  }
  await mfRefreshFolders();
  mfRefreshStatus();
}

async function mfRemove(index) {
  const f = MF.folders && MF.folders[index];
  if (!f || MF.busy || MF.remote) return;
  MF.busy = f.path; MF.confirm = null; MF.msg = null; MF.err = null; mfRepaint();
  try {
    const res = await BR.filesRemoveFolder(f.path);
    if (res && res.ok) MF.msg = res.removed ? 'Removed ' + f.name + ' from My files. The files themselves are untouched.' : f.name + ' was already removed.';
    else mfApplyFailure(res);
  } catch (e) {
    MF.err = String((e && e.message) || e);
  } finally {
    MF.busy = null;
  }
  await mfRefreshFolders();
  mfRefreshStatus();
}

function myFilesAct(what) {
  const {verb, index} = mfParseAct(what);
  if (verb === 'refresh') { mfRefreshFolders().then(() => mfRefreshStatus()); return; }
  if (verb === 'add') { mfAdd(); return; }
  if (verb === 'remove' && index !== null) { MF.confirm = index; mfRepaint(); return; }
  if (verb === 'removeCancel') { MF.confirm = null; mfRepaint(); return; }
  if (verb === 'removeConfirm' && index !== null) { mfRemove(index); return; }
}

/* ---- drawing ---- */

function mfProgressHTML() {
  const st = MF.status;
  const text = mfProgressText(st);
  if (!text) return '';
  const pct = mfPercent(st);
  const bar = st.running
    ? '<div class="mf-bar" role="progressbar" aria-label="Indexing"' + (pct === null ? '' : ' aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"') + '>'
      + '<span class="mf-fill' + (pct === null ? ' mf-fill--wait' : '') + '" style="width:' + (pct === null ? 100 : pct) + '%"></span></div>'
    : '';
  const cur = st.running && st.current ? '<span class="mf-cur mono" title="' + esc(st.current) + '">' + esc(mfBase(st.current)) + '</span>' : '';
  const last = st.lastError && st.lastError.message
    ? '<p class="mf-lasterr">Could not read <span class="mono" title="' + esc(st.lastError.path || '') + '">' + esc(mfBase(st.lastError.path)) + '</span>: ' + esc(st.lastError.message) + '</p>'
    : '';
  return '<div class="mf-progress' + (st.running ? ' is-running' : '') + '" aria-live="polite">'
    + '<div class="mf-ptext">' + (st.running ? '<span class="tk-spin" aria-hidden="true"></span>' : ic('check')) + '<span class="grow">' + esc(text) + '</span>' + cur + '</div>'
    + bar + last + '</div>';
}

function mfRowHTML(f, i) {
  const busy = MF.busy === f.path;
  const confirming = MF.confirm === i;
  const actions = MF.remote ? ''
    : busy ? '<span class="tk-spin" aria-hidden="true"></span>'
    : confirming
      ? '<span class="mf-confirm"><span class="mf-ask">Remove from My files?</span>'
        + '<button class="btn btn-s sm" data-act="myfiles:removeCancel">Keep</button>'
        + '<button class="btn btn-df sm" data-act="myfiles:removeConfirm:' + i + '">Remove</button></span>'
      : '<button class="btn btn-s sm" data-act="myfiles:remove:' + i + '"' + (MF.busy ? ' disabled' : '') + ' aria-label="Remove ' + esc(f.name) + '">Remove</button>';
  return '<div class="tk-li mf-row">'
    + '<span class="mf-ic" aria-hidden="true">' + ic('folder') + '</span>'
    + '<span class="mf-main"><span class="mf-name">' + esc(f.name) + '</span>'
    + '<span class="mf-path mono" title="' + esc(f.path) + '">' + esc(f.path) + '</span></span>'
    + '<span class="mf-count">' + esc(mfFolderMeta(f)) + '</span>'
    + actions + '</div>';
}

function myFilesTab() {
  const about = '<div class="mf-about"><p class="mf-intro">' + esc(MF_INTRO) + '</p></div>';
  if (MF.unsupported) {
    return '<div class="set-pane mf-pane">' + about
      + '<div class="tk-empty set-empty mf-empty"><span class="tk-ico tk-ico--lg">' + ic('folder') + '</span><h4>My files needs a newer agent</h4>'
      + '<p>This agent cannot index folders yet. Update the agent, then open this screen again.</p></div></div>';
  }
  const rows = MF.folders || [];
  const canAdd = !MF.remote;
  const head = '<div class="set-sechead mf-head">'
    + '<h4 class="set-plgtitle">Folders</h4>'
    + (rows.length ? '<span class="set-counts">' + esc(mfPlural(rows.length, 'folder')) + '</span>' : '')
    + '<span class="grow"></span>'
    + '<button class="iconbtn sm" data-act="myfiles:refresh" title="Refresh" aria-label="Refresh"' + (MF.loading ? ' disabled aria-busy="true"><span class="tk-spin"></span>' : '>' + ic('refresh')) + '</button>'
    + (canAdd ? '<button class="btn btn-p sm" data-act="myfiles:add"' + (MF.adding ? ' disabled aria-busy="true"' : '') + '>Add folder</button>' : '')
    + '</div>';
  const remote = MF.remote ? '<div class="tk-notice tk-notice--blue mf-note">' + ic('info') + '<span class="grow">This app is connected to an agent on another computer. Its folders are shown here; add or remove them on that computer.</span></div>' : '';
  const msg = MF.msg ? '<div class="tk-notice tk-notice--blue mf-note">' + ic('info') + '<span class="grow">' + esc(MF.msg) + '</span></div>' : '';
  const err = MF.err ? '<div class="tuierr tk-notice tk-notice--red mf-note">' + ic('alert') + '<span class="grow">' + esc(MF.err) + '</span></div>' : '';
  let body;
  if (!MF.folders) {
    body = MF.err ? '' : '<div class="tk-empty set-empty mf-empty"><span class="tk-spin"></span><p>reading folders…</p></div>';
  } else if (!rows.length) {
    body = '<div class="tk-empty set-empty mf-empty"><span class="tk-ico tk-ico--lg">' + ic('folder') + '</span><h4>No folders yet</h4>'
      + '<p>' + (canAdd ? 'Add a folder with your documents, and you can ask the agent about them in any chat.' : 'No folders are indexed on the other computer yet.') + '</p></div>';
  } else {
    body = '<div class="tk-list mf-list">' + rows.map(mfRowHTML).join('') + '</div>';
  }
  return '<div class="set-pane mf-pane">' + about + head + remote + err + msg + mfProgressHTML() + body + '</div>';
}

if (typeof module !== 'undefined') module.exports = {mfPercent, mfProgressText, mfFolderMeta, mfParseAct, mfBase, MF_INTRO, MF_POLL_MS};
