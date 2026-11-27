/* ---------------- ATO-2745: Save report for support, one way everywhere ----------------
   Loaded BEFORE renderer.js, so it only declares. Shared by the renderer and
   the Node checks (test/support-report.test.mjs).

   The report (agent.log tail and the settings with every key taken out,
   main's `app:debugBundle`) was saved three ways: Settings › Diagnostics and
   Help › Save report for support (act 'dump') opened the .txt in the text
   editor, said nothing while it was written, and wrote a second report on a
   double click; Help › Report an Issue (helpReport, bug-report.js) saved it
   silently with the file's path in a toast. Now every place calls
   saveSupportReport: one report at a time, "Saving the report…" while it is
   written, then the file shown selected in Finder / File Explorer (the way
   VS Code's "Open Logs Folder" and Chrome's downloads reveal a file rather
   than open it), through the file preview's reveal (app:filePreviewAction),
   with the folder itself opened as the fallback. */

/* `deps`: {bridge() → BR, toast(title, line, kind), repaint()}. `kind`: 'dump' (Diagnostics, Help) or
   'report' (beside an issue). Answers a promise of {ok, path?} once the report is written, or null
   when one is already being written (a double click writes one report). */
function createSupportReport(deps) {
  const st = {busy: false};
  const say = (t, s, kind) => { if (typeof deps.toast === 'function') deps.toast(t, s, kind); };
  const paint = () => { if (typeof deps.repaint === 'function') deps.repaint(); };
  const fileName = (p) => String(p || '').split(/[\\/]/).pop();
  const folderOf = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '');

  async function reveal(br, path) {
    try {
      const r = typeof br.filePreviewAction === 'function' ? await br.filePreviewAction(path, 'reveal') : null;
      if (r && r.ok) return;
    } catch (e) { /* the folder below */ }
    if (typeof br.openPath === 'function') { try { await br.openPath(folderOf(path)); } catch (e) { /* the toast still names the file */ } }
  }

  async function save(kind) {
    if (st.busy) return null;
    const br = deps.bridge();
    if (!br || typeof br.debugBundle !== 'function') {
      say('Could not save the report', 'Saving a report is not available in this version of the app.', 'bad');
      return {ok: false};
    }
    st.busy = true; paint();
    say('Saving the report…', 'The agent log and your settings, with keys and tokens taken out.', 'info');
    let res = null;
    try { res = await br.debugBundle(kind === 'report' ? 'report' : 'dump'); } catch (e) { res = {ok: false, error: String((e && e.message) || e)}; }
    st.busy = false; paint();
    if (!res || !res.ok || !res.path) {
      if (res && res.error && typeof console !== 'undefined') console.warn('[report] not saved:', res.error);
      say('Could not save the report', 'Check that your Downloads folder exists and has free space, then try again.', 'bad');
      return {ok: false};
    }
    say('Report saved', 'In your Downloads folder as ' + fileName(res.path) + '.' + (kind === 'report' ? ' Attach it to the issue if you want to.' : ''));
    await reveal(br, res.path);
    return {ok: true, path: res.path};
  }

  return {state: st, save, busy: () => st.busy};
}

/* The window's one instance, on renderer.js globals at call time (BR, toast, render). */
const SUPPORT_REPORT = createSupportReport({
  bridge: () => (typeof BR !== 'undefined' ? BR : null),
  toast: (t, s, kind) => { if (typeof toast === 'function') toast(t, s, kind); },
  repaint: () => { if (typeof render === 'function') render(); },
});
function saveSupportReport(kind) { return SUPPORT_REPORT.save(kind); }
/* The Diagnostics buttons: disabled while a report is written. */
function supportReportBusyAttr() { return SUPPORT_REPORT.busy() ? ' disabled' : ''; }

if (typeof module !== 'undefined') {
  module.exports = {createSupportReport, saveSupportReport, supportReportBusyAttr, SUPPORT_REPORT};
}
