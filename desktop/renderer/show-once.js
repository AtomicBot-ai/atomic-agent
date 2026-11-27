/* ATO-2401 "Show once" (Settings › Skills): the Record card. main/show-once-ipc.ts records and saves the
   draft; this draws its state and sends Record / Stop / Discard. Shared by the renderer and the Node checks. */
function showOnceSince(startedAt) {
  if (typeof startedAt !== 'number' || !isFinite(startedAt)) return '';
  const d = new Date(startedAt);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
const SHOW_ONCE_KEPT = 'Only clicks, shortcuts and which app is in front are recorded. Never what you type, nothing in '
  + 'password managers, settings or Atomic Agent itself, no screenshots. It stays on this Mac.';
/* ATO-2744: where the saved draft is, for Show in Finder (the path is never the card's text). */
function showOnceDraftPath(s) {
  const last = s && s.last;
  if (!last || last.kind !== 'saved' || !last.id || !s.draftsDir) return '';
  const dir = String(s.draftsDir);
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + last.id;
}
const SHOW_ONCE_NO_INPUT = 'If you did click and type, check that Atomic Agent is allowed in System Settings › Privacy & Security › Input Monitoring, then record again.';
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
    const where = showOnceDraftPath(s);
    note = '<div class="tk-notice tk-notice--blue set-softnote show-once-last"><span class="grow">Saved ' + esc(last.name) + ' ('
      + last.steps + (last.steps === 1 ? ' step' : ' steps') + ') as a draft under Pending review: Show reads it, Approve turns it on, '
      + 'Discard deletes it.</span>'
      + (where ? '<button class="btn btn-s sm" data-act="skills:showOnce:reveal" title="' + esc(where) + '">' + esc(opts.reveal || 'Show in Finder') + '</button>' : '')
      + '</div>';
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
    + '<button class="btn btn-s sm" data-act="skills:showOnce:start">Record</button></div>' + note;
}
function createShowOnceController(deps) {
  const st = {s: null, subscribed: false, busy: false};
  const api = () => deps.api() || {};
  function apply(p) {
    if (!p || typeof p !== 'object') return;
    const before = st.s && st.s.last && st.s.last.kind === 'saved' ? st.s.last.id : null;
    st.s = p;
    if (p.last && p.last.kind === 'saved' && p.last.id !== before && deps.changed) deps.changed();
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
    const draft = showOnceDraftPath(st.s);
    const reveal = draft && typeof br.openPath === 'function' ? () => br.openPath(draft) : undefined;
    const inputMonitoring = typeof br.privacyOpen === 'function' ? () => br.privacyOpen('inputMonitoring') : undefined;
    const call = {start: br.showOnceStart, stop: br.showOnceStop, cancel: br.showOnceCancel, accessibility: br.showOnceOpenAccessibility, reveal, inputMonitoring}[verb];
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
if (typeof module !== 'undefined') module.exports = {showOnceCardHTML, showOnceSince, showOnceDraftPath, createShowOnceController, SHOW_ONCE_KEPT, SHOW_ONCE_NO_INPUT};
