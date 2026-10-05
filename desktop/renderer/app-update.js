/* ---------------- app updates (ATO-229) ----------------
   Loaded before renderer.js; declares only. renderer.js calls appUpdBoot()
   once at boot, updToastSync() from renderToasts(), appUpdAct() for every
   `appupd:*` act, and appUpdRowsHTML() inside Settings › General.

   Main decides everything (main/updater.ts) and pushes its state on
   `updates:state`; this file only draws it and sends the clicks back.
   Nothing here downloads or installs: Update and Restart are the only two
   ways in, and each is a click.

   The toast lives in #toasts with the others (top right, under the
   toolbar) but is not one of S.toasts: it has no 6 s timer, Esc does not pop
   it, and renderToasts leaves it alone. */

const UPD = {state:null, busy:false};

function updState() { return UPD.state; }

/** Main's state, as pushed or answered. */
function appUpdApply(st) {
  if (!st || typeof st !== 'object') return;
  UPD.state = st;
  updToastSync();
  updSettingsPatch();
}

function appUpdBoot() {
  if (!BR || !BR.updateState) return;
  if (BR.onUpdateState) BR.onUpdateState(appUpdApply);
  BR.updateState().then(appUpdApply).catch(() => {});
}

/* ---- the toast ---- */

function updRestartLabel(st) {
  return st.turnRunning ? 'Restart when the answer finishes' : 'Restart';
}

function updToastHTML(st) {
  const v = esc(st.version || '');
  const ico = (name) => '<span class="tk-ico tk-ico--sm tk-ico--blue">' + ic(name) + '</span>';
  const body = (title, sub, acts, extra, after) => '<span class="toast-body">'
      + '<span class="toast-t">' + title + '</span>'
      + (sub ? '<span class="toast-s">' + sub + '</span>' : '')
      + (extra || '')
      + (acts ? '<span class="upd-acts">' + acts + '</span>' : '')
      + (after || '')
    + '</span>';
  const btn = (cls, act, label, more) => '<button class="btn ' + cls + ' sm" data-act="appupd:' + act + '"' + (more || '') + '>' + esc(label) + '</button>';

  if (st.phase === 'downloading') {
    const pct = Math.max(0, Math.min(100, st.percent || 0));
    return ico('download') + body('Downloading Atomic Agent ' + v + '…',
      '<span class="upd-pct">' + pct + '%</span>',
      btn('btn-s', 'cancel', 'Cancel'),
      '<span class="tk-prog upd-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + pct + '%"></i></span>');
  }
  if (st.phase === 'ready') {
    return ico('refresh') + body('Atomic Agent ' + v + ' is ready',
      st.downloadError ? esc(st.downloadError) : 'Restart to update. Your chats stay where they are.',
      btn('btn-p', 'install', updRestartLabel(st)) + btn('btn-s', 'later', 'Later'));
  }
  if (st.phase === 'waiting') {
    return ico('clock') + body('Restarting when the answer finishes',
      'Atomic Agent ' + v + ' installs as soon as the running turn ends.',
      btn('btn-s', 'later', 'Later'));
  }
  if (st.phase === 'installing') {
    // The fake installs nothing, so its toast has a way out; a real one ends with the app.
    return ico('refresh') + body(st.fake ? 'Test mode: the app would restart now' : 'Restarting to update…',
      st.fake ? 'Atomic Agent ' + v + ' would be installed. Nothing was changed.' : 'Atomic Agent ' + v + ' is being installed.',
      st.fake ? btn('btn-s', 'later', 'Close') : '');
  }
  // available
  return ico('download') + body('Atomic Agent ' + v + ' is available',
    st.downloadError ? esc(st.downloadError) : (st.notes ? esc(st.notes) : ''),
    btn('btn-p', 'update', st.downloadError ? 'Try again' : 'Update') + btn('btn-s', 'notnow', 'Not now'),
    '', '<button class="set-link upd-skip" data-act="appupd:skip">Skip this version</button>');
}

/* The toast, keyed: built once, patched in place while only the percentage
   moves (a rebuild under the pointer would eat a press on Cancel). */
function updToastSync(boxIn) {
  const box = boxIn || (typeof document !== 'undefined' ? document.getElementById('toasts') : null);
  if (!box) return;
  const st = UPD.state;
  let n = box.querySelector(':scope > .toast-upd:not(.out)');
  const show = !!(st && st.toast && st.version);
  if (!show) {
    if (n) {
      n.classList.add('out');
      n.style.pointerEvents = 'none';
      const gone = () => { if (n.parentNode) n.remove(); };
      if (Element.prototype.animate && !reducedMotion()) {
        const a = n.animate([{opacity: 1, transform: 'translateX(0)'}, {opacity: 0, transform: 'translateX(24px)'}],
          {duration: TOAST_OUT_MS, easing: OVM.EASE_OUT, fill: 'forwards'});
        a.onfinish = gone; setTimeout(gone, TOAST_OUT_MS + 200);
      } else gone();
    }
    return;
  }
  const key = [st.phase, st.version, st.notes, st.downloadError, st.turnRunning, st.fake].join('|');
  if (!n) {
    n = document.createElement('div');
    n.className = 'toast toast-upd';
    n.dataset.upd = '1';
    n.setAttribute('role', 'status');
    n.innerHTML = updToastHTML(st);
    n._updKey = key;
    // First in the column: the top right corner, above any passing toast.
    box.insertBefore(n, box.firstChild);
    if (Element.prototype.animate) n.animate(reducedMotion() ? [{opacity: 0}, {opacity: 1}]
      : [{opacity: 0, transform: 'translateX(24px)'}, {opacity: 1, transform: 'translateX(0)'}],
      {duration: TOAST_IN_MS, easing: OVM.EASE_OUT});
    return;
  }
  if (n._updKey !== key) {
    n.innerHTML = updToastHTML(st);
    n._updKey = key;
    return;
  }
  if (st.phase === 'downloading') {
    const pct = Math.max(0, Math.min(100, st.percent || 0));
    const bar = n.querySelector('.upd-prog');
    const fill = n.querySelector('.upd-prog > i');
    const word = n.querySelector('.upd-pct');
    if (fill) fill.style.width = pct + '%';
    if (bar) bar.setAttribute('aria-valuenow', String(pct));
    if (word) word.textContent = pct + '%';
  }
}

/* ---- Settings › General ---- */

function updResultLine(st) {
  if (!st.enabled) return {text: st.disabledText || 'Updates are not set up for this build.', tone: ''};
  if (st.downloadError && (st.phase === 'available' || st.phase === 'ready')) return {text: st.downloadError, tone: 'warn'};
  if (st.manualChecking) return {text: 'Checking…', tone: ''};
  if (st.phase === 'downloading') return {text: 'Downloading version ' + st.version + '… ' + (st.percent || 0) + '%', tone: ''};
  if (st.phase === 'ready') return {text: 'Version ' + st.version + ' is downloaded. Restart to update.', tone: 'ok'};
  if (st.phase === 'waiting') return {text: 'Restarting when the answer finishes.', tone: ''};
  if (st.phase === 'installing') return {text: st.fake ? 'Test mode: the app would restart and install ' + st.version + ' now.' : 'Restarting to update…', tone: ''};
  const r = st.manualCheck && st.manualCheck.result;
  if (r && r.kind === 'error') return {text: r.message, tone: 'warn'};
  if (st.phase === 'available' && st.version) return {text: 'Version ' + st.version + ' is available', tone: 'ok'};
  if (r && r.kind === 'up-to-date') return {text: 'You’re up to date — ' + st.currentVersion, tone: 'ok'};
  return {text: '', tone: ''};
}

function updVersionButtons(st) {
  if (!st.enabled) return '<button class="btn btn-s sm" data-act="appupd:check" disabled>Check now</button>';
  const b = (cls, act, label, dis) => '<button class="btn ' + cls + ' sm" data-act="appupd:' + act + '"' + (dis ? ' disabled' : '') + '>' + esc(label) + '</button>';
  if (st.phase === 'available') return b('btn-p', 'update', 'Update') + b('btn-s', 'check', 'Check now', st.manualChecking);
  if (st.phase === 'downloading') return b('btn-s', 'cancel', 'Cancel');
  if (st.phase === 'ready') return b('btn-p', 'install', updRestartLabel(st));
  if (st.phase === 'waiting') return b('btn-s', 'later', 'Don’t restart');
  if (st.phase === 'installing') return '';
  return b('btn-s', 'check', st.manualChecking ? 'Checking…' : 'Check now', st.manualChecking || st.phase === 'checking');
}

function updAutoRowHTML(st) {
  const on = !!(st && st.autoCheck);
  const enabled = !!(st && st.enabled);
  return '<div class="tk-setrow" id="set-upd-auto">'
      + '<div class="body"><div class="t">Check for updates automatically</div>'
        + '<div class="d">When Atomic Agent starts and every 6 hours. Nothing is downloaded until you click Update.</div>'
      + '</div>'
      + setSwitchHTML({on, busy: !st, disabled: !st || !enabled || UPD.busy, act: 'appupd:auto',
        label: 'Check for updates automatically', title: 'Automatic update checks ' + (on ? 'off' : 'on')})
    + '</div>';
}

function updVersionRowHTML(st) {
  const line = st ? updResultLine(st) : {text: '', tone: ''};
  return '<div class="tk-setrow" id="set-upd-ver">'
      + '<div class="body"><div class="t">Version</div>'
        + '<div class="d">Atomic Agent <span class="mono">' + esc(st ? st.currentVersion : (BUILD ? BUILD.version : '')) + '</span></div>'
        + (line.text ? '<div class="tk-help upd-result' + (line.tone ? ' tk-help--' + line.tone : '') + '" role="status">' + esc(line.text) + '</div>' : '')
      + '</div>'
      + (st ? updVersionButtons(st) : '')
    + '</div>';
}

/** The two rows General draws. */
function appUpdRowsHTML() {
  const st = UPD.state;
  return updAutoRowHTML(st) + updVersionRowHTML(st);
}

/** A state change while General is open: just these two rows, not the whole pane. */
function updSettingsPatch() {
  if (typeof document === 'undefined') return;
  const st = UPD.state;
  const auto = document.getElementById('set-upd-auto');
  const ver = document.getElementById('set-upd-ver');
  if (auto) auto.outerHTML = updAutoRowHTML(st);
  if (ver) ver.outerHTML = updVersionRowHTML(st);
}

/* ---- the clicks ---- */

async function appUpdAct(v) {
  if (!BR || !BR.updateState) return;
  const call = {
    update: BR.updateDownload, notnow: BR.updateDismiss, skip: BR.updateSkip, cancel: BR.updateCancel,
    install: BR.updateInstall, later: BR.updateLater, check: BR.updateCheck,
  }[v];
  if (v === 'auto') {
    if (UPD.busy || !UPD.state) return;
    UPD.busy = true; updSettingsPatch();
    try { appUpdApply(await BR.updateSetAuto(!UPD.state.autoCheck)); } catch (e) { /* the switch stays as it was */ }
    UPD.busy = false; updSettingsPatch();
    return;
  }
  if (!call) return;
  try { appUpdApply(await call()); } catch (e) { /* main pushes its state anyway */ }
}

if (typeof window !== 'undefined') {
  // --smoke (t65): the state as drawn, and the toast's place and words.
  window.__updState = () => UPD.state;
  window.__updToast = () => {
    const n = document.querySelector('#toasts > .toast-upd:not(.out)');
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return {text: n.textContent, top: r.top, right: r.right, left: r.left, bottom: r.bottom,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      buttons: [...n.querySelectorAll('[data-act]')].map((b) => b.textContent)};
  };
  window.__updSettings = () => {
    const ver = document.getElementById('set-upd-ver');
    const auto = document.getElementById('set-upd-auto');
    return ver ? {result: (ver.querySelector('.upd-result') || {}).textContent || '',
      buttons: [...ver.querySelectorAll('[data-act]')].map((b) => b.textContent),
      switchOn: !!(auto && auto.querySelector('.tk-switch.on'))} : null;
  };
}
