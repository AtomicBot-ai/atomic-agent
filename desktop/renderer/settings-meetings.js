/* ---------------- ATO-2514: Settings, Meetings ----------------
   Loaded BEFORE renderer.js, so it only declares: everything it touches
   (BR, S, esc, ic, render, toast, settingsPaneId, paneRepaintKeepFocus,
   setSwitchHTML) is read when a function runs, never at load time.

   Where Record a meeting saves its transcripts (the default is
   Documents/Atomic Agent/Meetings; Change picks another folder), the two
   switches (the other side of the call, speakers by voice, with the
   speaker model's size, licences, Download and Remove), and the meetings
   saved in that folder: Open, Notes when the meeting-notes skill wrote
   them, Show in folder, and Delete, which asks first and moves the
   transcript and its notes to the Trash.

   Like Granola's and Otter's meeting library and Zoom's recording folder
   setting. Routes: main/meeting-library-ipc.ts; the speaker model:
   main/meeting-voices-ipc.ts. */

const MS = {
  prefs: null,         // {folder, systemAudio, voices}
  folder: '',          // where transcripts go now
  defaultFolder: '',
  items: null,         // [{name, startedAt, bytes, notes}]
  voices: null,        // meeting:voices-status
  download: null,      // 0..1 while the speaker model downloads
  err: null,
  msg: null,
  loading: false,
  busy: null,          // what a call runs for
  confirm: null,       // the transcript whose Delete waits for a second click
  listening: false,
};

const MS_INTRO = 'Recordings made with Record a meeting. The audio stays on this computer only until it is turned into text; each meeting is saved as a plain text file in the folder below.';

const MS_REASONS = {
  'not-found': 'That file is gone. It may have been moved or deleted.',
  'open-failed': 'No app on this computer opened that file.',
  'trash-failed': 'The file could not be moved to the Trash.',
  'notes-trash-failed': 'The transcript was moved to the Trash, but its notes could not be. They are still in the folder; an app may have them open.',
  'write-failed': 'The setting could not be saved.',
};

/* ---- pure helpers (exported for test/settings-meetings.test.mjs) ---- */

function msReasonText(reason) {
  return MS_REASONS[reason] || 'Something went wrong. Try again.';
}

/** `trash:Meeting 2026-11-27 14-05 transcript.txt` → {verb, arg}. */
function msParseAct(what) {
  const s = String(what || '');
  const i = s.indexOf(':');
  return i === -1 ? {verb: s, arg: ''} : {verb: s.slice(0, i), arg: s.slice(i + 1)};
}

/** A row's title: "Meeting, 27 Nov 2026, 14:05". */
function msTitle(item, locale) {
  const t = item ? item.startedAt : NaN;
  if (!Number.isFinite(t)) return item ? String(item.name || '') : '';
  try {
    return 'Meeting, ' + new Date(t).toLocaleString(locale, {day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false});
  } catch (e) {
    return 'Meeting, ' + new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** "12 KB" / "1.4 MB". */
function msSizeText(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function msMB(bytes) { return Math.max(1, Math.round((Number(bytes) || 0) / 1_000_000)); }

/** The line under "Tell speakers apart by voice". */
function msVoicesText(st, download) {
  if (typeof download === 'number') return 'Downloading the speaker model, ' + Math.round(download * 100) + '%.';
  if (!st) return 'Checking the speaker model…';
  if (!st.known) return 'This needs a newer Atomic Agent. Until then speakers are told apart by pauses.';
  if (!st.supported) return 'Not available on this computer. Speakers are told apart by pauses instead.';
  const what = 'sherpa-onnx (Apache-2.0) with pyannote segmentation (MIT) and 3D-Speaker CAM++ (Apache-2.0).';
  if (st.installed) return 'The speaker model is on this computer. ' + what;
  const size = st.downloadBytes ? 'about ' + msMB(st.downloadBytes) + ' MB' : 'a one-time download';
  return 'Downloaded once, ' + size + ', the first time you record a meeting, then runs on this computer. ' + what;
}

/* ---- reading and writing ---- */

function msBridge() { return typeof BR !== 'undefined' && BR && typeof BR.meetingSettingsGet === 'function' ? BR : null; }

function msVisible() {
  return typeof S !== 'undefined' && !!S.settings && typeof settingsPaneId === 'function' && settingsPaneId(S.settingsPane) === 'meetings';
}

function msRepaint() {
  if (!msVisible()) return;
  if (typeof paneRepaintKeepFocus === 'function') paneRepaintKeepFocus(meetingsTab()); else render();
}

function msTake(r) {
  if (!r || !r.ok) return false;
  MS.prefs = r.prefs; MS.folder = r.folder || ''; MS.defaultFolder = r.defaultFolder || '';
  return true;
}

function msListen() {
  if (MS.listening || !msBridge() || typeof BR.onMeeting !== 'function') return;
  MS.listening = true;
  BR.onMeeting((ev) => {
    if (!ev || ev.type !== 'voices') return;
    if (ev.state === 'downloading') MS.download = typeof ev.fraction === 'number' ? ev.fraction : 0;
    else { MS.download = null; msVoicesRefresh(); }
    msRepaint();
  });
}

async function msVoicesRefresh() {
  if (!msBridge() || typeof BR.meetingVoicesStatus !== 'function') return;
  try { MS.voices = await BR.meetingVoicesStatus(); } catch (e) { MS.voices = {known: false}; }
  if (MS.voices && !MS.voices.downloading) MS.download = null;
  else if (MS.voices && MS.voices.downloading && MS.download === null) MS.download = 0;
  msRepaint();
}

async function msRefresh() {
  const br = msBridge();
  if (!br) { MS.err = 'Meetings needs the desktop app.'; msRepaint(); return; }
  if (MS.loading) return;
  MS.loading = true;
  try {
    const [s, l] = await Promise.all([br.meetingSettingsGet(), br.meetingList()]);
    msTake(s);
    MS.items = l && l.ok && Array.isArray(l.items) ? l.items : [];
    MS.err = null;
  } catch (e) {
    MS.err = 'The meetings could not be read. Try again.';
  } finally {
    MS.loading = false;
  }
  msRepaint();
  msVoicesRefresh();
}

function meetingsTabEntered() {
  MS.confirm = null; MS.msg = null; MS.err = null;
  msListen();
  msRefresh();
}

async function msCall(key, run, done) {
  if (!msBridge() || MS.busy) return;
  MS.busy = key; MS.err = null; MS.msg = null; msRepaint();
  let r = null;
  try { r = await run(); } catch (e) { r = null; }
  MS.busy = null;
  if (r && r.ok) done(r);
  else if (!(r && r.error === 'cancelled')) {
    MS.err = msReasonText(r && r.error);
    if (typeof toast === 'function') toast('That did not work', MS.err, 'bad');
  }
  msRepaint();
}

function msItem(name) { return (MS.items || []).find((x) => x.name === name) || null; }

function meetingsAct(what) {
  const {verb, arg} = msParseAct(what);
  if (verb === 'refresh') { msRefresh(); return; }
  if (verb === 'folder') { msCall('folder', () => BR.meetingChooseFolder(), (r) => { msTake(r); msRefresh(); }); return; }
  if (verb === 'folderReset') { msCall('folder', () => BR.meetingSettingsSet({folder: null}), (r) => { msTake(r); msRefresh(); }); return; }
  if (verb === 'systemAudio' || verb === 'voices') {
    const on = !(MS.prefs && MS.prefs[verb]);
    msCall(verb, () => BR.meetingSettingsSet({[verb]: on}), (r) => { msTake(r); if (verb === 'voices') msVoicesRefresh(); });
    return;
  }
  if (verb === 'voicesGet') {
    // Download (also the after-recording offer) means "tell voices apart": the switch goes on with it.
    if (!(MS.prefs && MS.prefs.voices)) BR.meetingSettingsSet({voices: true}).then((r) => { msTake(r); msRepaint(); }, () => {});
    MS.download = 0; msRepaint(); BR.meetingVoicesInstall().then(() => msVoicesRefresh(), () => msVoicesRefresh()); return;
  }
  if (verb === 'voicesCancel') { BR.meetingVoicesCancel().catch(() => {}); return; }
  if (verb === 'voicesRemove') { msCall('voices', () => BR.meetingVoicesRemove(), () => { MS.msg = 'The speaker model was removed. It downloads again the next time you record.'; msVoicesRefresh(); }); return; }
  if (verb === 'deleteCancel') { MS.confirm = null; msRepaint(); return; }
  const item = msItem(arg);
  if (!item) return;
  if (verb === 'open') msCall(arg, () => BR.meetingOpen(arg), () => {});
  else if (verb === 'notes') msCall(arg, () => BR.meetingOpen(arg, 'notes'), () => {});
  else if (verb === 'show') msCall(arg, () => BR.meetingShow(arg), () => {});
  else if (verb === 'delete') { MS.confirm = arg; msRepaint(); }
  else if (verb === 'deleteConfirm') {
    MS.confirm = null;
    const drop = () => { MS.items = (MS.items || []).filter((x) => x.name !== arg); };
    // notes-trash-failed: the transcript is gone, its notes stayed; the row goes, the red line says so.
    const run = () => BR.meetingTrash(arg).then((r) => { if (r && r.error === 'notes-trash-failed') drop(); return r; });
    msCall(arg, run, () => {
      drop();
      MS.msg = msTitle(item) + (item.notes ? ' and its notes were' : ' was') + ' moved to the Trash.';
    });
  }
}

/* ---- drawing ---- */

function msSwitchRow(key, title, sub) {
  const on = !!(MS.prefs && MS.prefs[key]);
  return '<div class="tk-setrow ms-row"><div class="body"><div class="t">' + esc(title) + '</div>'
    + '<div class="d">' + esc(sub) + '</div></div>'
    + setSwitchHTML({on, label: title, act: 'meetings:' + key, busy: MS.busy === key, disabled: !MS.prefs, title: on ? 'Turn off' : 'Turn on'}) + '</div>';
}

function msVoicesActions() {
  const st = MS.voices;
  if (typeof MS.download === 'number') return '<button class="btn btn-s sm" data-act="meetings:voicesCancel">Cancel</button>';
  if (!st || !st.known || !st.supported) return '';
  return st.installed
    ? '<button class="btn btn-s sm" data-act="meetings:voicesRemove"' + (MS.busy ? ' disabled' : '') + '>Remove</button>'
    : '<button class="btn btn-s sm" data-act="meetings:voicesGet"' + (MS.busy ? ' disabled' : '') + '>Download now</button>';
}

function msItemHTML(item) {
  const n = esc(item.name);
  let actions;
  if (MS.busy === item.name) actions = '<span class="tk-spin" aria-hidden="true"></span>';
  else if (MS.confirm === item.name) {
    actions = '<span class="mf-confirm"><span class="mf-ask">' + (item.notes ? 'Move it and its notes to the Trash?' : 'Move to the Trash?') + '</span>'
      + '<button class="btn btn-s sm" data-act="meetings:deleteCancel">Keep</button>'
      + '<button class="btn btn-df sm" data-act="meetings:deleteConfirm:' + n + '">Delete</button></span>';
  } else {
    const off = MS.busy ? ' disabled' : '';
    actions = '<button class="btn btn-p sm" data-act="meetings:open:' + n + '"' + off + '>Open</button>'
      + (item.notes ? '<button class="btn btn-s sm" data-act="meetings:notes:' + n + '"' + off + '>Notes</button>' : '')
      + '<button class="btn btn-s sm" data-act="meetings:show:' + n + '"' + off + '>Show in folder</button>'
      + '<button class="btn btn-s sm" data-act="meetings:delete:' + n + '"' + off + '>Delete</button>';
  }
  return '<div class="tk-li mf-row ms-item">'
    + '<span class="mf-ic" aria-hidden="true">' + ic('mic') + '</span>'
    + '<span class="mf-main"><span class="mf-name">' + esc(msTitle(item)) + '</span>'
    + '<span class="mf-path">' + esc(msSizeText(item.bytes) + (item.notes ? ', with notes' : '')) + '</span></span>'
    + actions + '</div>';
}

function meetingsTab() {
  const about = '<div class="mf-about"><p class="mf-intro">' + esc(MS_INTRO) + '</p></div>';
  const custom = MS.prefs && MS.prefs.folder;
  const folder = '<div class="tk-setrow ms-row"><div class="body"><div class="t">Save transcripts in</div>'
    + '<div class="d"><span class="mono set-path" title="' + esc(MS.folder) + '">' + esc(MS.folder || 'Documents, Atomic Agent, Meetings') + '</span></div></div>'
    + (custom ? '<button class="btn btn-s sm" data-act="meetings:folderReset"' + (MS.busy ? ' disabled' : '') + '>Use default</button>' : '')
    + '<button class="btn btn-s sm" data-act="meetings:folder"' + (MS.busy ? ' disabled' : '') + '>Change…</button></div>';
  const sys = msSwitchRow('systemAudio', 'Record the other side of the call', 'Your microphone is Me, the sound of the call is Them. On a Mac this asks for Screen and System Audio Recording once.');
  const voices = msSwitchRow('voices', 'Tell speakers apart by voice', msVoicesText(MS.voices, MS.download));
  const va = msVoicesActions();
  // Shown with the switch off too: Download for the after-recording offer, Remove for a model already here.
  const vrow = va ? '<div class="ms-vacts">' + va + '</div>' : '';
  const rows = MS.items || [];
  const head = '<div class="set-sechead mf-head"><h4 class="set-plgtitle">Saved meetings</h4>'
    + (rows.length ? '<span class="set-counts">' + rows.length + (rows.length === 1 ? ' meeting' : ' meetings') + '</span>' : '')
    + '<span class="grow"></span>'
    + '<button class="iconbtn sm" data-act="meetings:refresh" title="Refresh" aria-label="Refresh"' + (MS.loading ? ' disabled aria-busy="true"><span class="tk-spin"></span>' : '>' + ic('refresh')) + '</button></div>';
  const msg = MS.msg ? '<div class="tk-notice tk-notice--blue mf-note">' + ic('info') + '<span class="grow">' + esc(MS.msg) + '</span></div>' : '';
  const err = MS.err ? '<div class="tuierr tk-notice tk-notice--red mf-note">' + ic('alert') + '<span class="grow">' + esc(MS.err) + '</span></div>' : '';
  let body;
  if (!MS.items) body = MS.err ? '' : '<div class="tk-empty set-empty mf-empty"><span class="tk-spin"></span><p>reading meetings…</p></div>';
  else if (!rows.length) {
    body = '<div class="tk-empty set-empty mf-empty"><span class="tk-ico tk-ico--lg">' + ic('mic') + '</span><h4>No meetings yet</h4>'
      + '<p>Start one with Record a meeting. When you click Make notes, the transcript is saved here.</p></div>';
  } else body = '<div class="tk-list mf-list">' + rows.map(msItemHTML).join('') + '</div>';
  return '<div class="set-pane mf-pane ms-pane">' + about + folder + sys + voices + vrow + head + err + msg + body + '</div>';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {MS, msReasonText, msParseAct, msTitle, msSizeText, msVoicesText, meetingsAct, meetingsTab};
}
