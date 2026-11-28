/* ATO-2401 "Show once" (Settings › Skills): the Record card. main/show-once-ipc.ts records and saves the
   draft; this draws its state and sends Record / Stop / Discard. Shared by the renderer and the Node checks.
   ATO-2499: two switches under Record (tidy the draft with the chat model; a picture of the window after
   each step), the tidy pass's progress on the saved line, and "To review" for the drafts' section. */
function showOnceSince(startedAt) {
  if (typeof startedAt !== 'number' || !isFinite(startedAt)) return '';
  const d = new Date(startedAt);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
const SHOW_ONCE_KEPT = 'Only clicks, shortcuts, menu commands and which app and window are in front are recorded. Never what you type, '
  + 'nothing in password managers, settings or Atomic Agent itself. It stays on this Mac unless you tidy it with a cloud model.';
/* ATO-2744: where the saved draft is, for Show in Finder (the path is never the card's text). */
function showOnceDraftPath(s) {
  const last = s && s.last;
  if (!last || last.kind !== 'saved' || !last.id || !s.draftsDir) return '';
  const dir = String(s.draftsDir);
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + last.id;
}
const SHOW_ONCE_NO_INPUT = 'If you did click and type, check that Atomic Agent is allowed in System Settings › Privacy & Security › Input Monitoring, then record again.';
const SHOW_ONCE_TIDY_HINT = 'After you stop, the model you chat with names the routine and lists what to ask for each time. '
  + 'It gets the steps as text (button names, menu paths, window titles), never pictures. If that model is in the cloud, '
  + 'this text leaves this Mac. The steps themselves stay as recorded.';
const SHOW_ONCE_SNAP_HINT = 'A picture of the window after each step, to check the draft against. Never of browsers or protected apps. '
  + 'Kept on this Mac with the draft and deleted when you approve or discard it. Never sent to a model.';
function showOnceSwitchHTML(key, on, label, hint, esc) {
  return '<div class="tkrow show-once-opt"><button class="tk-switch' + (on ? ' on' : '') + '" role="switch" aria-checked="' + !!on
    + '" aria-label="' + esc(label) + '" data-act="skills:showOnce:opt:' + key + '"></button>'
    + '<span class="grow"><span class="tk-lbl">' + esc(label) + '</span><span class="set-cap d">' + esc(hint) + '</span></span></div>';
}
function showOnceOptionsHTML(s, esc) {
  const o = s.options || {};
  let out = showOnceSwitchHTML('tidy', o.tidy !== false, 'Tidy the draft with your chat model', SHOW_ONCE_TIDY_HINT, esc)
    + showOnceSwitchHTML('snapshots', !!o.snapshots, 'Save a picture of the window after each step', SHOW_ONCE_SNAP_HINT, esc);
  if (o.snapshots && !s.screenAllowed) {
    out += '<div class="tk-notice set-softnote"><span class="grow">Pictures need Screen Recording for Atomic Agent. Until it is allowed, '
      + 'recordings are saved without them.</span><button class="btn btn-s sm" data-act="skills:showOnce:screen">Open Screen Recording settings</button></div>';
  }
  return '<div class="show-once-opts">' + out + '</div>';
}
function showOnceTidyLine(last, esc) {
  if (last.tidy === 'running') return '<span class="tk-spin"></span> The agent is tidying its title, description and what to ask for. ';
  if (last.tidy === 'done') return 'Tidied by the agent: check its title, description and what it asks for. ';
  if (last.tidy === 'failed') return esc(last.tidyError || 'The chat model could not tidy the draft, so it is saved as recorded.') + ' ';
  return '';
}
/* ATO-2744: the drafts folder is a Show in Finder button (its path only on hover), never the note's text. */
function showOnceSavedHTML(s, last, esc, opts) {
  const n = last.steps + (last.steps === 1 ? ' step' : ' steps');
  const pics = last.pictures ? ', ' + last.pictures + (last.pictures === 1 ? ' picture' : ' pictures') : '';
  const where = showOnceDraftPath(s);
  return '<div class="tk-notice tk-notice--blue set-softnote show-once-last"><span class="grow">Saved ' + esc(last.name) + ' (' + n + pics
    + ') under To review. ' + showOnceTidyLine(last, esc) + 'Show reads it, Approve turns it on, Discard deletes it.</span>'
    + (where ? '<button class="btn btn-s sm" data-act="skills:showOnce:reveal" title="' + esc(where) + '">' + esc((opts && opts.reveal) || 'Show in Finder') + '</button>' : '')
    + '</div>';
}
/* `o`: {reveal, platform, privacy}: the app's "Show in Finder" label (fileManagerName), process.platform's
   word, and whether the bridge can open Input Monitoring (privacy:open). */
function showOnceCardHTML(s, esc, o) {
  const opts = o || {};
  if (!s || !s.available) return '';
  const head = '<b>Show once</b>: ';
  if (s.recording || s.saving) {
    const steps = (s.steps || 0) + (s.steps === 1 ? ' step' : ' steps');
    const where = s.app ? ' · last in ' + esc(s.app) : '';
    const since = showOnceSince(s.startedAt);
    if (s.saving) return '<div class="tk-notice tk-notice--blue set-softnote show-once" role="status"><span class="grow">' + head + 'saving the draft…</span></div>';
    return '<div class="tk-notice tk-notice--red set-softnote show-once" role="status" aria-live="polite">'
      + '<span class="grow"><span class="show-once-dot" aria-hidden="true">●</span> ' + head + 'recording, ' + steps + where
      + (since ? ' · since ' + since : '') + '. Do the routine in its app, then click Stop here or on "● Recording steps" in the menu bar.</span>'
      + '<button class="btn btn-blue sm" data-act="skills:showOnce:stop">Stop and save</button>'
      + '<button class="btn btn-s sm" data-act="skills:showOnce:cancel">Discard</button></div>';
  }
  const last = s.last;
  let note = '';
  if (last && last.kind === 'saved') {
    note = showOnceSavedHTML(s, last, esc, opts);
  } else if (last && last.kind === 'empty') {
    // Show once records Mac apps only; the Input Monitoring line is for macOS, where a missing grant hears nothing.
    const mac = (opts.platform || 'darwin') === 'darwin';
    note = '<div class="tk-notice set-softnote show-once-last"><span class="grow">Nothing was saved: no clicks or keys were recorded outside Atomic Agent.'
      + (mac ? ' ' + esc(SHOW_ONCE_NO_INPUT) : '') + '</span>'
      + (mac && opts.privacy ? '<button class="btn btn-s sm" data-act="skills:showOnce:inputMonitoring">Open Input Monitoring settings</button>' : '')
      + '</div>';
  } else if (last && last.kind === 'error') {
    note = '<div class="tuierr tk-notice tk-notice--red show-once-last"><span class="grow">' + esc(last.error) + '</span>'
      + (last.permission ? '<button class="btn btn-s sm" data-act="skills:showOnce:accessibility">Open Accessibility settings</button>' : '') + '</div>';
  }
  return '<div class="tk-notice set-softnote show-once"><span class="grow">' + head + 'record a routine you do in a Mac app once, '
    + 'and it becomes a skill draft the agent can repeat. ' + SHOW_ONCE_KEPT + '</span>'
    + '<button class="btn btn-s sm" data-act="skills:showOnce:start">Record</button></div>' + showOnceOptionsHTML(s, esc) + note;
}
function createShowOnceController(deps) {
  const st = {s: null, subscribed: false, busy: false};
  const api = () => deps.api() || {};
  function apply(p) {
    if (!p || typeof p !== 'object') return;
    const lastOf = x => (x && x.last && x.last.kind === 'saved' ? x.last.id + ':' + x.last.tidy : null);
    const before = lastOf(st.s);
    st.s = p;
    // A new draft, and the same draft again once the agent has tidied it: To review reads it anew.
    if (lastOf(p) && lastOf(p) !== before && deps.changed) deps.changed();
    deps.paint();
  }
  function ensure() {
    const br = api();
    if (st.subscribed || !br.showOnceState || !br.onShowOnceState) return;
    st.subscribed = true;
    br.onShowOnceState(apply);
    Promise.resolve().then(() => br.showOnceState()).then(apply, () => {});
  }
  async function act(verb) {
    const br = api();
    if (st.busy) return;
    if (verb.indexOf('opt:') === 0) {
      const key = verb.slice(4), o = (st.s && st.s.options) || {};
      if ((key !== 'tidy' && key !== 'snapshots') || typeof br.showOnceSetOption !== 'function') return;
      const now = key === 'tidy' ? o.tidy !== false : !!o.snapshots;
      try { await br.showOnceSetOption(key, !now); } catch (e) { /* the pushed state stays the truth */ }
      return;
    }
    const draft = showOnceDraftPath(st.s);
    const reveal = draft && typeof br.openPath === 'function' ? () => br.openPath(draft) : undefined;
    const inputMonitoring = typeof br.privacyOpen === 'function' ? () => br.privacyOpen('inputMonitoring') : undefined;
    const call = {start: br.showOnceStart, stop: br.showOnceStop, cancel: br.showOnceCancel,
      accessibility: br.showOnceOpenAccessibility, screen: br.showOnceOpenScreenRecording, reveal, inputMonitoring}[verb];
    if (typeof call !== 'function') return;
    st.busy = true;
    let res = null;
    try { res = await call(); } catch (e) { res = null; }
    st.busy = false;
    // stop and cancel answer with the new state; start's state comes on the push.
    if (res && typeof res === 'object' && 'available' in res) apply(res);
  }
  const cardOpts = () => ({
    reveal: typeof fileManagerName === 'function' ? fileManagerName() : 'Show in Finder',
    platform: typeof PLATFORM !== 'undefined' ? PLATFORM : 'darwin',
    privacy: typeof api().privacyOpen === 'function',
  });
  return {state: st, ensure, act, cardHTML: esc => { ensure(); return showOnceCardHTML(st.s, esc, cardOpts()); }};
}
if (typeof module !== 'undefined') module.exports = {showOnceCardHTML, showOnceSince, showOnceDraftPath, createShowOnceController, SHOW_ONCE_KEPT,
  SHOW_ONCE_NO_INPUT, SHOW_ONCE_TIDY_HINT, showOnceOptionsHTML, showOnceTidyLine};
