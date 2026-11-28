/* ---------------- ATO-2459: My apps, versions and Install ----------------
   Loaded BEFORE my-apps.js and renderer.js, so it only declares: MA, maCall,
   maRepaint, maRefresh, maReasonText, BR, IS_MAC, IS_WIN, esc, ic are read
   when a function runs.

   Each row in Settings › My apps gets:
   - Install / Uninstall: a launcher in the OS app menu (Launchpad and
     Spotlight on a Mac, the Start menu on Windows, the app menu on Linux)
     that opens the app in its own window (main/my-apps-install.ts). Like
     Chrome's "Install app". Shown only when this build can do it.
   - Versions: the pages the app had before an edit (the agent's
     app.update, or a restore here), each with Restore. The page a restore
     replaces is kept as a version too, so nothing is lost. Like Claude
     artifacts' versions and Google Docs' version history. */

const MAV = {
  open: null,      // app id whose versions are shown
  list: null,      // that app's versions once read
  loading: false,
  err: null,
  confirm: null,   // version number whose Restore waits for a second click
};

/** The words for a refusal (my-apps.js MA_REASONS holds them all). */
function maxReasonText(reason) {
  return typeof maReasonText === 'function' ? maReasonText(reason) : 'Something went wrong. Try again.';
}

/** Where an installed app shows up, in this OS's words. */
function maxInstalledWhere(platform) {
  if (platform === 'darwin') return 'Find it in Launchpad or Spotlight.';
  if (platform === 'win32') return 'Find it in the Start menu.';
  return 'Find it in your app menu.';
}

/** "Version 3 · 27 Nov 2026, 14:05 · 12 KB" */
function maxVersionText(v, locale) {
  const t = Date.parse(v && v.savedAt);
  let when = '';
  if (Number.isFinite(t)) {
    try { when = new Date(t).toLocaleString(locale, {day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'}); }
    catch (e) { when = new Date(t).toISOString().slice(0, 16).replace('T', ' '); }
  }
  const kb = Math.max(1, Math.round(((v && v.bytes) || 0) / 1024)) + ' KB';
  return ['Version ' + v.version, when, kb].filter(Boolean).join(' · ');
}

/* ---- the row's extra buttons and the versions panel ---- */

function maxRowButtonsHTML(app, off) {
  const id = esc(app.id);
  let h = '';
  if (MA.installSupported) {
    h += app.installed
      ? '<button class="btn btn-s sm" data-act="myapps:uninstall:' + id + '"' + off + ' aria-label="Uninstall ' + esc(app.name) + '" title="Remove it from your apps. It stays in My apps.">Uninstall</button>'
      : '<button class="btn btn-s sm" data-act="myapps:install:' + id + '"' + off + ' aria-label="Install ' + esc(app.name) + '" title="Add it to your apps, to open it without opening a chat.">Install</button>';
  }
  if (app.versions > 0) {
    const shown = MAV.open === app.id;
    h += '<button class="btn btn-s sm" data-act="myapps:versions:' + id + '"' + off + ' aria-expanded="' + shown + '" aria-label="Versions of ' + esc(app.name) + '">Versions</button>';
  }
  return h;
}

function maxVersionsHTML(app) {
  if (MAV.open !== app.id) return '';
  let body;
  if (MAV.loading) body = '<div class="ma-vrow ma-vnote"><span class="tk-spin" aria-hidden="true"></span><span>Reading versions…</span></div>';
  else if (MAV.err) body = '<div class="ma-vrow ma-vnote tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(MAV.err) + '</span></div>';
  else if (!MAV.list || !MAV.list.length) body = '<div class="ma-vrow ma-vnote">No earlier versions. Each change to the page keeps the one before it here.</div>';
  else {
    body = MAV.list.map((v) => {
      const act = MAV.confirm === v.version
        ? '<span class="mf-confirm"><span class="mf-ask">Put this version back? The current page is kept as a version.</span>'
          + '<button class="btn btn-s sm" data-act="myapps:restoreCancel">Keep</button>'
          + '<button class="btn btn-p sm" data-act="myapps:restoreConfirm:' + esc(app.id) + ':' + v.version + '">Restore</button></span>'
        : '<button class="btn btn-s sm" data-act="myapps:restore:' + esc(app.id) + ':' + v.version + '"' + (MA.busy ? ' disabled' : '') + '>Restore</button>';
      return '<div class="ma-vrow"><span class="ma-vtext">' + esc(maxVersionText(v)) + '</span>' + act + '</div>';
    }).join('');
  }
  return '<div class="ma-versions" role="group" aria-label="Versions of ' + esc(app.name) + '">' + body + '</div>';
}

/* ---- verbs (my-apps.js hands every verb here first) ---- */

async function maxLoadVersions(id) {
  MAV.open = id; MAV.list = null; MAV.err = null; MAV.loading = true; MAV.confirm = null;
  maRepaint();
  try {
    const r = await BR.appsVersions(id);
    if (MAV.open !== id) return;
    if (r && r.ok) MAV.list = Array.isArray(r.versions) ? r.versions : [];
    else MAV.err = maxReasonText(r && r.reason);
  } catch (e) {
    if (MAV.open === id) MAV.err = 'The versions could not be read.';
  } finally {
    if (MAV.open === id) MAV.loading = false;
  }
  maRepaint();
}

function maxSetApp(id, patch) {
  MA.apps = (MA.apps || []).map((a) => (a.id === id ? Object.assign({}, a, patch) : a));
}

/** True when the verb is one of these (my-apps.js then stops). */
function myAppsMoreAct(verb, arg) {
  const slug = /^[a-z0-9-]{1,64}$/;
  if (verb === 'restoreCancel') { MAV.confirm = null; maRepaint(); return true; }
  if (verb === 'restore' || verb === 'restoreConfirm') {
    const m = /^([a-z0-9-]{1,64}):([1-9]\d{0,8})$/.exec(String(arg || ''));
    if (!m) return true;
    const id = m[1], n = Number(m[2]);
    if (verb === 'restore') { MAV.confirm = n; maRepaint(); return true; }
    MAV.confirm = null;
    maCall(id, () => BR.appsRestore(id, n), (r) => {
      const app = (MA.apps || []).find((a) => a.id === id);
      MA.msg = 'Version ' + n + ' of ' + (app ? app.name : 'the app') + ' is back. The page it replaced is kept as a version.';
      maxSetApp(id, {updatedAt: r.app && r.app.updatedAt, versions: ((app && app.versions) || 0) + (r.kept ? 1 : 0)});
      maxLoadVersions(id);
    });
    return true;
  }
  if (!['versions', 'install', 'uninstall'].includes(verb)) return false;
  if (!slug.test(String(arg || ''))) return true;
  if (verb === 'versions') {
    if (MAV.open === arg) { MAV.open = null; MAV.list = null; MAV.confirm = null; maRepaint(); return true; }
    maxLoadVersions(arg);
    return true;
  }
  const install = verb === 'install';
  maCall(arg, () => (install ? BR.appsInstall(arg) : BR.appsUninstall(arg)), () => {
    const app = (MA.apps || []).find((a) => a.id === arg);
    const name = app ? app.name : 'The app';
    maxSetApp(arg, {installed: install});
    const platform = typeof PLATFORM !== 'undefined' ? PLATFORM : 'darwin';
    MA.msg = install ? name + ' is installed. ' + maxInstalledWhere(platform) : name + ' was removed from your apps. It is still in My apps.';
  });
  return true;
}

/** Leaving the tab closes the panel. */
function myAppsMoreReset() {
  MAV.open = null; MAV.list = null; MAV.err = null; MAV.loading = false; MAV.confirm = null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {MAV, maxReasonText, maxInstalledWhere, maxVersionText, maxRowButtonsHTML, maxVersionsHTML, myAppsMoreAct, myAppsMoreReset};
}
