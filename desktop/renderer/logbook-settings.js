/* ATO-2526: Settings › Logbook. The on/off switch, how often a note is
   written, how long notes are kept, apps never captured, apps noted by
   window title only (no screenshot, no model), and the morning standup
   (off unless turned on). Open the timeline shows one day's notes, where
   they can be deleted (logbook-timeline.js).

   It writes the same <stateDir>/logbook/settings.json as
   `atomic-agent logbook` through the running agent (PATCH
   /api/logbook/settings, main/logbook-timeline-ipc.ts). Loaded before
   renderer.js; it uses that file's globals (esc, ic, render, S,
   settingsPaneId, paneRepaintKeepFocus) only at run time. */

const LBS = {view: null, loading: false, saving: '', err: null, msg: null, details: false, loaded: false};
const LBS_INTERVALS = [1, 2, 5, 10, 15, 30, 60];

const LBS_INTRO = 'Every few minutes Atomic Agent writes a short note of what you are doing, from a screenshot that a model on this computer describes. '
  + 'Ask the agent "what did I do yesterday?" or for a standup. Password managers, login and lock screens are never captured.';

function lbsBridge() { return typeof BR !== 'undefined' && BR && typeof BR.logbookSave === 'function' ? BR : null; }

function lbsVisible() {
  return typeof S !== 'undefined' && !!S.settings && typeof settingsPaneId === 'function' && settingsPaneId(S.settingsPane) === 'logbook';
}

function lbsRepaint() {
  if (!lbsVisible()) return;
  if (typeof paneRepaintKeepFocus === 'function') paneRepaintKeepFocus(logbookTab()); else render();
}

function lbsFail(title, error) { LBS.err = {title, details: String(error || 'No answer.')}; LBS.details = false; }

async function lbsRefresh() {
  const br = lbsBridge();
  if (!br) { lbsFail('The logbook needs the desktop app.', ''); lbsRepaint(); return; }
  if (LBS.loading) return;
  LBS.loading = true;
  try {
    const r = await br.logbookRefresh();
    if (r && r.ok) { LBS.view = r.view; LBS.err = null; } else lbsFail('Could not read the logbook settings.', r && r.error);
  } catch (e) {
    lbsFail('Could not read the logbook settings.', e && e.message);
  } finally {
    LBS.loading = false;
    LBS.loaded = true;
  }
  lbsRepaint();
}

function logbookTabEntered() { LBS.msg = null; LBS.err = null; lbsRefresh(); }

/** The lines of a list box: one app per line. */
function lbsLines(text) { return String(text || '').split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean); }

/** What Save sends, read from the pane's fields. */
function lbsReadForm(doc) {
  const val = (sel) => { const el = doc.querySelector(sel); return el ? el.value : ''; };
  const checked = (sel) => { const el = doc.querySelector(sel); return !!(el && el.checked); };
  return {
    intervalMinutes: Number(val('[data-lbs="interval"]')),
    retentionDays: Number(val('[data-lbs="keep"]')),
    excludeApps: lbsLines(val('[data-lbs="exclude"]')),
    titleOnlyApps: lbsLines(val('[data-lbs="titleonly"]')),
    standupAt: checked('[data-lbs="standup"]') ? (val('[data-lbs="standupAt"]') || '09:00') : null,
  };
}

async function lbsSave(input, what, done) {
  const br = lbsBridge();
  if (!br || LBS.saving) return;
  LBS.saving = what; LBS.err = null; LBS.msg = null; lbsRepaint();
  try {
    const r = await br.logbookSave(input);
    if (r && r.ok) { LBS.view = r.view; LBS.msg = done; }
    else lbsFail(what === 'toggle' ? 'Could not change the logbook.' : 'Could not save the logbook settings.', r && r.error);
  } catch (e) {
    lbsFail('Could not save the logbook settings.', e && e.message);
  } finally {
    LBS.saving = '';
  }
  lbsRepaint();
}

function logbookAct(what) {
  const v = LBS.view;
  if (what === 'refresh') { lbsRefresh(); return; }
  if (what === 'details') { LBS.details = !LBS.details; lbsRepaint(); return; }
  if (what === 'timeline') { if (typeof logbookTimelineOpen === 'function') logbookTimelineOpen(); return; }
  if (what === 'toggle' && v) {
    const on = v.state !== 'off';
    lbsSave({action: on ? 'stop' : 'start'}, 'toggle', on ? 'The logbook is off. Nothing more is captured.' : 'The logbook is on.');
    return;
  }
  if (what === 'save' && typeof document !== 'undefined') lbsSave(lbsReadForm(document), 'save', 'Saved.');
}

function lbsOption(n, cur) {
  return '<option value="' + n + '"' + (n === cur ? ' selected' : '') + '>' + (n === 1 ? 'Every minute' : 'Every ' + n + ' minutes') + '</option>';
}

function lbsFormHTML(v) {
  const dis = LBS.saving ? ' disabled' : '';
  const intervals = LBS_INTERVALS.indexOf(v.intervalMinutes) >= 0 ? LBS_INTERVALS : LBS_INTERVALS.concat([v.intervalMinutes]).sort((a, b) => a - b);
  const standupOn = !!v.standupAt;
  return '<div class="lbs-form">'
    + '<label class="lbs-row"><span class="lbs-label">How often</span><select data-lbs="interval"' + dis + '>'
      + intervals.map((n) => lbsOption(n, v.intervalMinutes)).join('') + '</select></label>'
    + '<label class="lbs-row"><span class="lbs-label">Keep notes for</span><span><input type="number" min="1" max="365" step="1" data-lbs="keep" value="' + v.retentionDays + '"' + dis + '> days</span></label>'
    + '<label class="lbs-block"><span class="lbs-label">Never capture these apps</span>'
      + '<span class="lbs-help">One app name per line, like Slack or com.tinyspeck.slackmacgap.</span>'
      + '<textarea rows="3" data-lbs="exclude"' + dis + '>' + esc(v.excludeApps.join('\n')) + '</textarea></label>'
    + '<label class="lbs-block"><span class="lbs-label">Note these apps by window title only</span>'
      + '<span class="lbs-help">No screenshot and no model for them, just the app and its window title.</span>'
      + '<textarea rows="3" data-lbs="titleonly"' + dis + '>' + esc(v.titleOnlyApps.join('\n')) + '</textarea></label>'
    + '<label class="lbs-row"><span class="lbs-label"><input type="checkbox" data-lbs="standup"' + (standupOn ? ' checked' : '') + dis + '> Write my standup every morning at</span>'
      + '<input type="time" data-lbs="standupAt" value="' + esc(v.standupAt || '09:00') + '"' + dis + '></label>'
    + '<p class="lbs-help">The standup runs as a scheduled task from yesterday\'s notes and shows up in its own chat. It needs Atomic Agent running at that time.</p>'
    + '<div class="lbs-actions"><button class="btn btn-p sm" data-act="logbook:save"' + dis + '>' + (LBS.saving === 'save' ? 'Saving...' : 'Save') + '</button>'
      + '<button class="btn btn-s sm" data-act="logbook:timeline">Open the timeline</button></div>'
    + '</div>';
}

function logbookTab() {
  const v = LBS.view;
  const about = '<div class="mf-about"><p class="mf-intro">' + esc(LBS_INTRO) + '</p></div>';
  const head = '<div class="set-sechead mf-head"><h4 class="set-plgtitle">Logbook</h4><span class="grow"></span>'
    + '<button class="iconbtn sm" data-act="logbook:refresh" title="Refresh" aria-label="Refresh"' + (LBS.loading ? ' disabled aria-busy="true"><span class="tk-spin"></span>' : '>' + ic('refresh')) + '</button></div>';
  const err = LBS.err
    ? '<div class="tuierr tk-notice tk-notice--red mf-note">' + ic('alert') + '<span class="grow">' + esc(LBS.err.title)
      + (LBS.err.details ? ' <button class="lbklink" data-act="logbook:details">' + (LBS.details ? 'Hide details' : 'Details') + '</button>'
        + (LBS.details ? '<span class="lbkdetails">' + esc(LBS.err.details) + '</span>' : '') : '') + '</span></div>'
    : '';
  const msg = LBS.msg ? '<div class="tk-notice tk-notice--blue mf-note">' + ic('info') + '<span class="grow">' + esc(LBS.msg) + '</span></div>' : '';
  let body = '';
  if (!v) {
    body = LBS.err ? '' : !LBS.loaded || LBS.loading
      ? '<div class="tk-empty set-empty mf-empty"><span class="tk-spin"></span><p>Reading the logbook settings...</p></div>'
      : '<div class="tk-empty set-empty mf-empty"><h4>No logbook here</h4><p>This version of the agent has no logbook. Update Atomic Agent to use it.</p></div>';
  } else if (!v.supported) {
    body = '<div class="tk-notice tk-notice--amber mf-note">' + ic('info') + '<span class="grow">' + esc(v.reason || 'The logbook cannot run on this computer.') + '</span></div>';
  } else {
    const on = v.state !== 'off';
    const line = v.state === 'paused' ? 'Paused for now. Resume from the Logbook chip or the menu bar.' : on ? 'On. The Logbook chip and the menu bar icon show while it is.' : 'Off. Nothing is captured.';
    body = '<div class="lbs-row lbs-switch"><span><b>Logbook</b><span class="lbs-help">' + esc(line) + '</span></span>'
      + '<button class="btn ' + (on ? 'btn-s' : 'btn-p') + ' sm" role="switch" aria-checked="' + on + '" data-act="logbook:toggle"' + (LBS.saving ? ' disabled' : '') + '>'
      + (LBS.saving === 'toggle' ? 'Working...' : on ? 'Turn off' : 'Turn on') + '</button></div>'
      + lbsFormHTML(v);
  }
  return '<div class="set-pane mf-pane lbs-pane">' + about + head + err + msg + body + '</div>';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {LBS, LBS_INTRO, logbookTab, logbookAct, logbookTabEntered, lbsReadForm, lbsLines};
}
