/* ---------------- ATO-2383: My apps ----------------
   Loaded BEFORE renderer.js, so it only declares: everything it touches
   (BR, S, esc, ic, render, toast, settingsPaneId, paneRepaintKeepFocus,
   CHAT_ART) is read when a function runs, never at load time.

   An artifact card's bar (chat-artifact.js) gets "Save as app": the page on
   screen is kept by main in <stateDir>/apps/<id>/ (main/my-apps-ipc.ts,
   my-apps-store.ts) and listed in Settings › My apps, beside My files. Open
   runs it in a window of its own, with no chat, no model and no network;
   it works after a restart and offline. Rename changes its name; Delete
   moves its folder to the Trash.

   Like Goose apps (pages kept in a folder, each opened in a sandboxed
   window) and Claude Desktop's "install an artifact as an app". */

const MA = {
  apps: null,      // MyAppManifest[] once read
  err: null,       // the last call's error text
  msg: null,       // a short note after a rename or delete
  loading: false,
  saving: null,    // artifact key a save runs for
  busy: null,      // app id a call runs for
  renaming: null,  // app id whose name is being edited
  confirm: null,   // app id whose Delete waits for a second click
};

const MA_INTRO = 'Pages you saved from a chat with Save as app. Each opens in its own window and keeps working offline, without the agent.';

const MA_REASONS = {
  'empty': 'This page is empty, so there is nothing to save.',
  'too-large': 'This page is larger than 4 MB, too large to keep as an app.',
  'bad-id': 'That app could not be found.',
  'not-found': 'That app is gone. It may have been deleted on disk.',
  'write-failed': 'The app could not be written to disk.',
  'not-main-window': 'Only the main window can do this.',
};

/* ---- pure helpers (exported for test/my-apps.test.mjs) ---- */

function maReasonText(reason) {
  return MA_REASONS[reason] || 'Something went wrong. Try again.';
}

/** The bar's button for artifact `key`; '' for a key that is not one. */
function myAppsSaveButtonHTML(key, escape) {
  if (!key) return '';
  const e = typeof escape === 'function' ? escape : (s) => String(s);
  const busy = MA.saving === key;
  return '<button class="chat-art-expand chat-art-saveapp" data-act="myapps:save:' + e(key) + '"' + (busy ? ' disabled aria-busy="true"' : '')
    + ' title="Keep this page as an app of its own. Open it later from Settings, My apps, in its own window.">'
    + (typeof ic === 'function' ? ic('plus') : '') + '<span>Save as app</span></button>';
}

/** What a save sends for artifact `key` of `arts` (CHAT_ART), or null when its page is not on screen. */
function maSaveInput(key, arts, chatId) {
  const st = arts && typeof arts.get === 'function' ? arts.get(key) : null;
  if (!st || st.state !== 'ok' || typeof st.html !== 'string' || !st.html.trim()) return null;
  const input = {name: String(st.title || '').trim() || 'Untitled app', html: st.html};
  if (typeof chatId === 'string' && chatId) input.chatId = chatId;
  return input;
}

/** `rename:abc-12f` → {verb:'rename', arg:'abc-12f'}; the arg keeps any colons (an artifact key has them). */
function maParseAct(what) {
  const s = String(what || '');
  const i = s.indexOf(':');
  return i === -1 ? {verb: s, arg: ''} : {verb: s.slice(0, i), arg: s.slice(i + 1)};
}

/** A row's second line: "Saved 27 Nov 2026". */
function maSavedText(app, locale) {
  const t = app ? Date.parse(app.createdAt) : NaN;
  if (!Number.isFinite(t)) return '';
  try { return 'Saved ' + new Date(t).toLocaleDateString(locale, {day: 'numeric', month: 'short', year: 'numeric'}); }
  catch (e) { return 'Saved ' + new Date(t).toISOString().slice(0, 10); }
}

/* ---- reading and writing ---- */

function maBridge() { return typeof BR !== 'undefined' && BR && typeof BR.appsList === 'function' ? BR : null; }

function maVisible() {
  return typeof S !== 'undefined' && !!S.settings && typeof settingsPaneId === 'function' && settingsPaneId(S.settingsPane) === 'myapps';
}

function maRepaint() {
  if (!maVisible()) return;
  if (typeof paneRepaintKeepFocus === 'function') paneRepaintKeepFocus(myAppsTab()); else render();
}

async function maRefresh() {
  const br = maBridge();
  if (!br) { MA.err = 'My apps needs the desktop app.'; maRepaint(); return; }
  if (MA.loading) return;
  MA.loading = true;
  try {
    const r = await br.appsList();
    if (r && r.ok) { MA.apps = Array.isArray(r.apps) ? r.apps : []; MA.err = null; }
    else MA.err = maReasonText(r && r.reason);
  } catch (e) {
    MA.err = String((e && e.message) || e);
  } finally {
    MA.loading = false;
  }
  maRepaint();
}

function myAppsTabEntered() {
  MA.confirm = null; MA.renaming = null; MA.msg = null;
  maRefresh();
}

async function maSave(key) {
  const br = maBridge();
  if (!br || MA.saving) return;
  const input = maSaveInput(key, typeof CHAT_ART !== 'undefined' ? CHAT_ART : null, typeof S !== 'undefined' ? S.sessionId : '');
  if (!input) { toast('Could not save the app', maReasonText('empty'), 'bad'); return; }
  MA.saving = key;
  if (typeof artChanged === 'function') artChanged(key);
  try {
    const r = await br.appsSave(input);
    if (r && r.ok) {
      toast('Saved to My apps', r.app.name + '. Open it any time from Settings, My apps.');
      if (MA.apps) MA.apps = [r.app].concat(MA.apps.filter((a) => a.id !== r.app.id));
    } else toast('Could not save the app', maReasonText(r && r.reason), 'bad');
  } catch (e) {
    toast('Could not save the app', String((e && e.message) || e), 'bad');
  } finally {
    MA.saving = null;
    if (typeof artChanged === 'function') artChanged(key);
  }
}

async function maCall(id, run, done) {
  if (!maBridge() || MA.busy) return;
  MA.busy = id; MA.err = null; MA.msg = null; maRepaint();
  try {
    const r = await run();
    if (r && r.ok) done(r); else MA.err = maReasonText(r && r.reason);
  } catch (e) {
    MA.err = String((e && e.message) || e);
  } finally {
    MA.busy = null;
  }
  maRepaint();
}

function maFind(id) { return (MA.apps || []).find((a) => a.id === id) || null; }

function maRenameSave(id) {
  const box = typeof document !== 'undefined' ? document.querySelector('[data-maname="' + id + '"]') : null;
  const name = box ? String(box.value || '').trim() : '';
  if (!name) { MA.renaming = null; maRepaint(); return; }
  maCall(id, () => BR.appsRename(id, name), (r) => {
    MA.renaming = null;
    MA.apps = (MA.apps || []).map((a) => (a.id === id ? r.app : a));
  });
}

function myAppsAct(what) {
  const {verb, arg} = maParseAct(what);
  if (verb === 'save') { maSave(arg); return; }
  if (verb === 'refresh') { maRefresh(); return; }
  // Every other verb names an app by its id, a slug (main checks it again).
  if (!/^(?:rename|delete)Cancel$/.test(verb) && !/^[a-z0-9-]{1,64}$/.test(arg)) return;
  if (verb === 'open') {
    maCall(arg, () => BR.appsOpen(arg), () => {});
    return;
  }
  if (verb === 'rename') {
    MA.renaming = arg; MA.confirm = null; maRepaint();
    setTimeout(() => { const box = document.querySelector('[data-maname="' + arg + '"]'); if (box) { box.focus(); box.select(); } }, 0);
    return;
  }
  if (verb === 'renameCancel') { MA.renaming = null; maRepaint(); return; }
  if (verb === 'renameSave') { maRenameSave(arg); return; }
  if (verb === 'delete') { MA.confirm = arg; MA.renaming = null; maRepaint(); return; }
  if (verb === 'deleteCancel') { MA.confirm = null; maRepaint(); return; }
  if (verb === 'deleteConfirm') {
    const app = maFind(arg);
    MA.confirm = null;
    maCall(arg, () => BR.appsDelete(arg), () => {
      MA.apps = (MA.apps || []).filter((a) => a.id !== arg);
      MA.msg = (app ? app.name : 'The app') + ' was moved to the Trash.';
    });
  }
}

/* Enter saves a new name, Escape leaves it. */
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('keydown', (ev) => {
    const t = ev.target;
    const id = t && t.dataset ? t.dataset.maname : '';
    if (!id) return;
    if (ev.key === 'Enter') { ev.preventDefault(); myAppsAct('renameSave:' + id); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); myAppsAct('renameCancel'); }
  }, true);
}

/* ---- drawing ---- */

function maRowHTML(app) {
  const id = app.id;
  const busy = MA.busy === id;
  let actions;
  if (busy) actions = '<span class="tk-spin" aria-hidden="true"></span>';
  else if (MA.renaming === id) {
    actions = '<span class="mf-confirm"><button class="btn btn-s sm" data-act="myapps:renameCancel">Cancel</button>'
      + '<button class="btn btn-p sm" data-act="myapps:renameSave:' + esc(id) + '">Save</button></span>';
  } else if (MA.confirm === id) {
    actions = '<span class="mf-confirm"><span class="mf-ask">Move to the Trash?</span>'
      + '<button class="btn btn-s sm" data-act="myapps:deleteCancel">Keep</button>'
      + '<button class="btn btn-df sm" data-act="myapps:deleteConfirm:' + esc(id) + '">Delete</button></span>';
  } else {
    const off = MA.busy ? ' disabled' : '';
    actions = '<button class="btn btn-p sm" data-act="myapps:open:' + esc(id) + '"' + off + ' aria-label="Open ' + esc(app.name) + '">Open</button>'
      + '<button class="btn btn-s sm" data-act="myapps:rename:' + esc(id) + '"' + off + ' aria-label="Rename ' + esc(app.name) + '">Rename</button>'
      + '<button class="btn btn-s sm" data-act="myapps:delete:' + esc(id) + '"' + off + ' aria-label="Delete ' + esc(app.name) + '">Delete</button>';
  }
  const name = MA.renaming === id
    ? '<input class="mf-name ma-name-input" data-maname="' + esc(id) + '" value="' + esc(app.name) + '" maxlength="80" aria-label="New name">'
    : '<span class="mf-name">' + esc(app.name) + '</span>';
  return '<div class="tk-li mf-row ma-row">'
    + '<span class="mf-ic" aria-hidden="true">' + ic('window') + '</span>'
    + '<span class="mf-main">' + name + '<span class="mf-path">' + esc(maSavedText(app)) + '</span></span>'
    + actions + '</div>';
}

function myAppsTab() {
  const about = '<div class="mf-about"><p class="mf-intro">' + esc(MA_INTRO) + '</p></div>';
  const rows = MA.apps || [];
  const head = '<div class="set-sechead mf-head">'
    + '<h4 class="set-plgtitle">Apps</h4>'
    + (rows.length ? '<span class="set-counts">' + rows.length + (rows.length === 1 ? ' app' : ' apps') + '</span>' : '')
    + '<span class="grow"></span>'
    + '<button class="iconbtn sm" data-act="myapps:refresh" title="Refresh" aria-label="Refresh"' + (MA.loading ? ' disabled aria-busy="true"><span class="tk-spin"></span>' : '>' + ic('refresh')) + '</button>'
    + '</div>';
  const msg = MA.msg ? '<div class="tk-notice tk-notice--blue mf-note">' + ic('info') + '<span class="grow">' + esc(MA.msg) + '</span></div>' : '';
  const err = MA.err ? '<div class="tuierr tk-notice tk-notice--red mf-note">' + ic('alert') + '<span class="grow">' + esc(MA.err) + '</span></div>' : '';
  let body;
  if (!MA.apps) body = MA.err ? '' : '<div class="tk-empty set-empty mf-empty"><span class="tk-spin"></span><p>reading apps…</p></div>';
  else if (!rows.length) {
    body = '<div class="tk-empty set-empty mf-empty"><span class="tk-ico tk-ico--lg">' + ic('window') + '</span><h4>No apps yet</h4>'
      + '<p>When the agent makes a page in a chat (a calculator, a tracker, a small game), click Save as app on it to keep it here.</p></div>';
  } else body = '<div class="tk-list mf-list">' + rows.map(maRowHTML).join('') + '</div>';
  return '<div class="set-pane mf-pane ma-pane">' + about + head + err + msg + body + '</div>';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {MA, MA_INTRO, maReasonText, myAppsSaveButtonHTML, maSaveInput, maParseAct, maSavedText, myAppsAct, myAppsTab};
}
