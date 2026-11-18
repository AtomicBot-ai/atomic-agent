/* ---------------- ATO-1064: dictation into any app, Settings › General ----------------
   Loaded before renderer.js, after quick-entry-settings.js (whose
   qeAcceleratorFromKey records the combo); declares only. The renderer half
   reads renderer.js globals (BR, render, IS_MAC) at call time.

   The row: a switch (off until turned on), the combo with Change…, and one
   line when it cannot work here: no dictation backend on this computer
   (ATO-979, the switch is then disabled with the reason), a combo another
   app holds, or, on macOS, the Accessibility the paste needs. While Change…
   records, main lets go of the old combo. */

/** The Settings row. `st.info` is main's answer (app:dictateGet); `h` has esc and setSwitchHTML. */
function dictateAnywhereRowHTML(st, h) {
  const info = st.info;
  const on = !!(info && info.enabled);
  const label = info && info.label ? info.label : '';
  const unavailable = !!(info && info.available === false);
  const desc = st.recording
    ? 'Press the new combination now. Esc cancels.'
    : on && label
      ? 'Press ' + h.esc(label) + ' in any app and speak; press it again to type the words where the cursor is. Esc throws it away. Transcribed on this computer.'
      : 'A key combination that dictates into any app: speak, press it again, and the words are typed where the cursor is. Transcribed on this computer.';
  const warn = st.error || (info && (info.error || (unavailable ? info.reason : null) || (on ? info.hint : null))) || '';
  return '<div class="tk-setrow">'
    + '<div class="body"><div class="t">Dictate into any app</div>'
      + '<div class="d">' + desc + '</div>'
      + (warn ? '<div class="tk-help tk-help--warn" role="status">' + h.esc(warn) + '</div>' : '')
    + '</div>'
    + (st.recording
      ? '<button class="btn btn-s sm" data-act="dictate:cancel">Cancel</button>'
      : '<button class="btn btn-s sm" data-act="dictate:record"' + (info && !st.busy && !unavailable ? '' : ' disabled') + ' title="Choose another key combination">'
        + (label ? h.esc(label) + ' · Change…' : 'Change…') + '</button>')
    + h.setSwitchHTML({on, busy: st.busy, disabled: !info || st.busy || st.recording || (unavailable && !on), act: 'dictate:toggle',
      label: 'Dictate into any app', title: 'Turn dictation into any app ' + (on ? 'off' : 'on')})
  + '</div>';
}

/* ---- renderer side (globals from renderer.js, read at call time) ---- */

const DA = {info: null, busy: false, recording: false, error: null};

function daApply(r) {
  if (r && typeof r === 'object' && 'enabled' in r) DA.info = r;
  DA.error = r && r.ok === false && r.error ? r.error : null;
}

/** Settings › General was entered: read the state once a visit. */
function dictateAnywhereRefresh() {
  if (typeof BR === 'undefined' || !BR || !BR.dictateGet) return;
  BR.dictateGet().then((r) => { daApply(r); render(); }).catch(() => {});
}

function daStopRecording() {
  DA.recording = false;
  window.removeEventListener('keydown', daOnKey, true);
  window.removeEventListener('blur', daCancel);
}

function daCancel() {
  if (!DA.recording) return;
  daStopRecording();
  if (BR && BR.dictatePause) BR.dictatePause(false).then((r) => { daApply(r); render(); }).catch(() => {});
  render();
}

function daOnKey(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) { daCancel(); return; }
  const acc = qeAcceleratorFromKey(e, typeof IS_MAC !== 'undefined' && IS_MAC);
  if (!acc) return;   // only modifiers so far
  daStopRecording();
  DA.busy = true; render();
  BR.dictateSet({accelerator: acc, enabled: true})
    .then((r) => { DA.busy = false; daApply(r); render(); })
    .catch(() => { DA.busy = false; DA.error = 'The shortcut could not be changed.'; render(); });
}

/** The row's acts: `toggle`, `record`, `cancel`. */
function dictateAnywhereAct(v) {
  if (typeof BR === 'undefined' || !BR || !BR.dictateSet) return;
  if (v === 'cancel') { daCancel(); return; }
  if (v === 'toggle') {
    if (!DA.info || DA.busy) return;
    DA.busy = true; render();
    BR.dictateSet({enabled: !DA.info.enabled})
      .then((r) => { DA.busy = false; daApply(r); render(); })
      .catch(() => { DA.busy = false; DA.error = 'The setting could not be saved.'; render(); });
    return;
  }
  if (v === 'record') {
    if (DA.recording || DA.busy) return;
    DA.recording = true; DA.error = null;
    window.addEventListener('keydown', daOnKey, true);
    window.addEventListener('blur', daCancel);
    if (BR.dictatePause) BR.dictatePause(true).catch(() => {});
    render();
  }
}

if (typeof module !== 'undefined') module.exports = {dictateAnywhereRowHTML};
