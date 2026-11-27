/* ---------------- ATO-523: the global hotkey's main-window half ----------------
   Loaded before renderer.js; declares only. The pure half is shared with the
   Node checks (test/quick-entry-settings.test.mjs); the renderer half reads
   renderer.js globals (BR, S, $, act, submit, render, autosize, IS_MAC) at
   call time, as handoff.js does.

   - The text typed in the box (main/quick-entry-window.ts) starts a NEW chat
     here and is sent the way a message typed in the composer is (submit).
     main only says a text is waiting; the page takes it once, and asks once
     at boot as well, for a window opened again from closed by the hotkey.
   - Settings › General: the switch, and Change… which records the next key
     combination pressed. While it records, main lets go of the old combo so
     pressing it does not open the box. */

/** KeyboardEvent.code → the key's name in Electron's accelerator grammar (letters, digits, F-keys apart). */
const QE_CODE_KEYS = {
  Space: 'Space', Enter: 'Return', NumpadEnter: 'Return', Tab: 'Tab', Backspace: 'Backspace',
  Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
  Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  NumpadDecimal: 'numdec', NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv',
};

/**
 * A keydown as an accelerator ("Command+Shift+Space"), or null while only
 * modifiers are down. The physical key (`code`), so Option on a Mac does not
 * turn the letter into a symbol. main checks the result (quick-entry.ts
 * normalizeAccelerator), so a combo with no real modifier is refused there.
 */
function qeAcceleratorFromKey(ev, isMac) {
  if (!ev) return null;
  const code = String(ev.code || '');
  let key = null;
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) key = m[1];
  else if ((m = /^Digit([0-9])$/.exec(code))) key = m[1];
  else if ((m = /^Numpad([0-9])$/.exec(code))) key = 'num' + m[1];
  else if ((m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code))) key = 'F' + m[1];
  else if (Object.prototype.hasOwnProperty.call(QE_CODE_KEYS, code)) key = QE_CODE_KEYS[code];
  if (!key) return null;
  const mods = [];
  if (isMac && ev.metaKey) mods.push('Command');
  if (ev.ctrlKey) mods.push('Control');
  if (ev.altKey) mods.push('Alt');
  if (ev.shiftKey) mods.push('Shift');
  if (!isMac && ev.metaKey) mods.push('Super');
  return mods.concat(key).join('+');
}

/** The Settings row. `info` is main's answer (app:quickEntryGet); `h` has esc and setSwitchHTML. */
function quickEntryRowHTML(st, h) {
  const info = st.info;
  const on = !!(info && info.enabled);
  const label = info && info.label ? info.label : '';
  const desc = st.recording
    ? 'Press the new combination now. Esc cancels.'
    : on && label
      ? 'Press ' + h.esc(label) + ' in any app to open a small chat window that stays in front. It starts a new chat; Esc closes it.'
      : 'A key combination that opens a small chat window over any app. It starts a new chat.';
  const err = st.error || (info && info.error) || '';
  return '<div class="tk-setrow">'
    + '<div class="body"><div class="t">Quick entry shortcut</div>'
      + '<div class="d">' + desc + '</div>'
      + (err ? '<div class="tk-help tk-help--warn" role="status">' + h.esc(err) + '</div>' : '')
    + '</div>'
    + (st.recording
      ? '<button class="btn btn-s sm" data-act="quickentry:cancel">Cancel</button>'
      : '<button class="btn btn-s sm" data-act="quickentry:record"' + (info && !st.busy ? '' : ' disabled') + ' title="Choose another key combination">'
        + (label ? h.esc(label) + ' · Change…' : 'Change…') + '</button>')
    + h.setSwitchHTML({on, busy: st.busy, disabled: !info || st.busy || st.recording, act: 'quickentry:toggle',
      label: 'Quick entry shortcut', title: 'Turn the quick entry shortcut ' + (on ? 'off' : 'on')})
  + '</div>'
  + ('sel' in st ? qeSelectionRowHTML(st.sel, st.selBusy, h) : '');
}

/** ATO-985: the "Use selected text" row under it. `sel` is main's answer (app:selectedTextGet). */
function qeSelectionRowHTML(sel, busy, h) {
  const on = !!(sel && sel.on);
  const warn = (sel && (sel.error || sel.hint)) || '';
  return '<div class="tk-setrow">'
    + '<div class="body"><div class="t">Use selected text</div>'
      + '<div class="d">When the shortcut opens the mini chat, the text selected in the app in front comes with it, with Rewrite, Translate, Explain and Summarize. Atomic Agent copies it and puts your clipboard back.</div>'
      + (warn ? '<div class="tk-help tk-help--warn" role="status">' + h.esc(warn) + '</div>' : '')
    + '</div>'
    // ATO-2736: macOS's Accessibility pane, the one Show once opens (main/show-once-ipc.ts).
    + (sel && sel.openAccessibility ? '<button class="btn btn-s sm" data-act="quickentry:accessibility">Open Accessibility settings</button>' : '')
    + h.setSwitchHTML({on, busy, disabled: !sel || busy, act: 'quickentry:selection',
      label: 'Use selected text', title: 'Turn selected text ' + (on ? 'off' : 'on')})
  + '</div>';
}

/* ---- renderer side (globals from renderer.js, read at call time) ---- */

const QE = {info: null, busy: false, recording: false, error: null, asked: false, sel: null, selBusy: false};

function qeApply(r) {
  if (r && typeof r === 'object' && 'enabled' in r) QE.info = r;
  QE.error = r && r.ok === false && r.error ? r.error : null;
}

/** Settings › General was entered: read the state once a visit. */
function quickEntryRefresh() {
  if (typeof BR === 'undefined' || !BR || !BR.quickEntryGet) return;
  BR.quickEntryGet().then((r) => { qeApply(r); render(); }).catch(() => {});
  if (BR.selectedTextGet) BR.selectedTextGet().then((r) => { QE.sel = r; render(); }).catch(() => {});
}

function qeStopRecording() {
  QE.recording = false;
  window.removeEventListener('keydown', qeOnKey, true);
  window.removeEventListener('blur', qeOnBlur);
}

function qeCancel() {
  if (!QE.recording) return;
  qeStopRecording();
  if (BR && BR.quickEntryPause) BR.quickEntryPause(false).then((r) => { qeApply(r); render(); }).catch(() => {});
  render();
}

function qeOnBlur() { qeCancel(); }

function qeOnKey(e) {
  // The window's own shortcuts (⌘N, ⌘,) do not run while a combination is recorded.
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) { qeCancel(); return; }
  const acc = qeAcceleratorFromKey(e, typeof IS_MAC !== 'undefined' && IS_MAC);
  if (!acc) return;   // only modifiers so far
  qeStopRecording();
  QE.busy = true; render();
  BR.quickEntrySet({accelerator: acc, enabled: true})
    .then((r) => { QE.busy = false; qeApply(r); render(); })
    .catch(() => { QE.busy = false; QE.error = 'The shortcut could not be changed.'; render(); });
}

/** The row's acts: `toggle`, `record`, `cancel`. */
function quickEntryAct(v) {
  if (!BR || !BR.quickEntrySet) return;
  if (v === 'cancel') { qeCancel(); return; }
  if (v === 'accessibility') { if (BR.showOnceOpenAccessibility) BR.showOnceOpenAccessibility().catch(() => {}); return; }
  if (v === 'selection') {
    if (!QE.sel || QE.selBusy || !BR.selectedTextSet) return;
    QE.selBusy = true; render();
    BR.selectedTextSet({use: !QE.sel.on})
      .then((r) => { QE.selBusy = false; QE.sel = r; render(); })
      .catch(() => { QE.selBusy = false; QE.sel = Object.assign({}, QE.sel, {error: 'The setting could not be saved.'}); render(); });
    return;
  }
  if (v === 'toggle') {
    if (!QE.info || QE.busy) return;
    QE.busy = true; render();
    BR.quickEntrySet({enabled: !QE.info.enabled})
      .then((r) => { QE.busy = false; qeApply(r); render(); })
      .catch(() => { QE.busy = false; QE.error = 'The setting could not be saved.'; render(); });
    return;
  }
  if (v === 'record') {
    if (QE.recording || QE.busy) return;
    QE.recording = true; QE.error = null;
    window.addEventListener('keydown', qeOnKey, true);
    window.addEventListener('blur', qeOnBlur);
    if (BR.quickEntryPause) BR.quickEntryPause(true).catch(() => {});
    render();
  }
}

/** A text from the box is waiting in main: a new chat, the text in its composer, sent as Enter sends it. */
async function quickEntryDeliver() {
  if (typeof BR === 'undefined' || !BR || !BR.quickEntryTake) return;
  const got = await BR.quickEntryTake().catch(() => null);
  const text = got && typeof got.text === 'string' ? got.text.trim() : '';
  if (!text) return;
  act('session:new');
  S.draft = text;
  const e = $('#entry');
  if (e) { e.value = text; autosize(e); }
  /* `plain`: the box's words go alone, without chips still waiting in the
     composer. Everything else is submit's: a chat still loading, the agent
     not up yet or the model downloading keep the text in the box and say so. */
  submit(undefined, {plain: true});
}

/**
 * ATO-2736: the window came back to the front (from System Settings, say):
 * main asks macOS again, so the Accessibility hint goes away without a
 * restart once the permission is given. Only while the row is on screen.
 */
function qeRecheckTrust(br, onScreen, apply) {
  if (!br || !br.selectedTextGet || !QE.sel || !onScreen()) return false;
  br.selectedTextGet().then((r) => {
    if (!r || typeof r !== 'object') return;
    const changed = !QE.sel || r.hint !== QE.sel.hint || r.on !== QE.sel.on;
    QE.sel = r;
    if (changed) apply();
  }).catch(() => {});
  return true;
}

/** Called once at boot (renderer.js, beside BR.onMenu). */
function quickEntryBoot() {
  if (typeof BR === 'undefined' || !BR) return;
  window.addEventListener('focus', () => qeRecheckTrust(BR, () => !!(S.settings && settingsPaneId(S.settingsPane) === 'general'), render));
  if (!BR.onQuickEntry) return;
  BR.onQuickEntry(() => { void quickEntryDeliver(); });
  void quickEntryDeliver();
}

if (typeof module !== 'undefined') module.exports = {QE, QE_CODE_KEYS, qeAcceleratorFromKey, quickEntryRowHTML, qeSelectionRowHTML, qeRecheckTrust};
