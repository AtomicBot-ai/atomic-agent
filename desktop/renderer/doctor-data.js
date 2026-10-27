/* ---------------- ATO-577 / ATO-579: Settings › Diagnostics' Doctor and Data ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/doctor-data.test.mjs).

   Doctor: "Check" runs `atag doctor --json` in main (main/doctor-data.ts)
   and lists each finding as ok / problem, with the fix the CLI offers.
   "Fix" runs `--fix` and lists what is left. Problems with no bounded fix
   carry the command that repairs them, in the CLI's words.

   Data: back up the shared folder to a .tar.gz, restore one, move the
   folder to another disk, reset keeping models. Main asks first in a
   system dialog that says the terminal shares the folder; a restore,
   move or reset reloads the window afterwards, since chats and settings
   changed under it. */

const DOCD = {findings: null, busy: '', note: '', err: '', onChange: null};

const DOCD_TONE = {ok: 'ok', warn: 'warn', fail: 'err'};
const DOCD_WORD = {ok: 'OK', warn: 'Check', fail: 'Problem'};

function doctorDataHTML(st, h) {
  const esc = h.esc;
  const busy = !!st.busy;
  const dis = busy ? ' disabled' : '';
  const list = st.findings
    ? '<div class="tk-list set-setlist set-doclist">' + st.findings.map((f) =>
        '<div class="tk-setrow set-docrow"><div class="t"><span class="set-docmark set-docmark--' + DOCD_TONE[f.status] + '">' + DOCD_WORD[f.status] + '</span> ' + esc(f.check) + '</div>'
        + '<div class="set-diagv">' + esc(f.message) + (f.fix ? '<div class="set-cap">Fix: ' + esc(f.fix) + '</div>' : '') + '</div></div>').join('')
      + '</div>'
    : '';
  const fixable = !!(st.findings && st.findings.some((f) => f.fix));
  return '<h4 class="set-h">Doctor</h4>'
    + '<p class="set-desc">Checks settings, MCP servers, the local engine and model, or your cloud key, and fixes what it safely can. A fix backs up config.json first.</p>'
    + list
    + '<div class="set-diagacts">'
      + '<button class="btn btn-s sm" data-act="doctor:check"' + dis + '>' + (st.busy === 'check' ? 'Checking…' : (st.findings ? 'Check again' : 'Check')) + '</button>'
      + (fixable ? '<button class="btn btn-p sm" data-act="doctor:fix"' + dis + '>' + (st.busy === 'fix' ? 'Fixing…' : 'Fix') + '</button>' : '')
    + '</div>'
    + '<h4 class="set-h">Data</h4>'
    + '<p class="set-desc">Chats, memory, tasks, settings and models live in one folder that the terminal agent (atag) shares. Back it up, restore it, move it to another disk, or start fresh keeping your models. Nothing is deleted: a restore or reset keeps the old folder next to it.</p>'
    + '<div class="set-diagacts">'
      + '<button class="btn btn-s sm" data-act="doctor:backup"' + dis + '>' + (st.busy === 'backup' ? 'Backing up…' : 'Back up') + '</button>'
      + '<button class="btn btn-s sm" data-act="doctor:restore"' + dis + '>Restore…</button>'
      + '<button class="btn btn-s sm" data-act="doctor:move"' + dis + '>Move folder…</button>'
      + '<button class="btn btn-s sm" data-act="doctor:reset"' + dis + '>Reset, keep models…</button>'
    + '</div>'
    + (st.note ? '<p class="set-cap">' + esc(st.note) + '</p>' : '')
    + (st.err ? '<p class="set-cap set-err">' + esc(st.err) + '</p>' : '');
}

const DOCD_CALL = {backup: 'dataBackup', restore: 'dataRestore', move: 'dataMove', reset: 'dataReset'};

/* One verb at a time; `reload` is the window's reload after the folder changed. */
async function doctorDataAct(v, br, reload) {
  if (DOCD.busy || !br) return;
  const paint = () => { if (DOCD.onChange) DOCD.onChange(); };
  DOCD.busy = v; DOCD.err = ''; DOCD.note = ''; paint();
  try {
    if (v === 'check' || v === 'fix') {
      const r = await br.doctorRun(v === 'fix');
      if (r && r.ok) {
        DOCD.findings = r.findings;
        if (v === 'fix') DOCD.note = r.restarted ? 'Fixed what could be fixed; the agent restarted to read the new settings.' : 'Fixed what could be fixed.';
      } else DOCD.err = (r && r.error) || 'The check did not run.';
    } else if (DOCD_CALL[v] && br[DOCD_CALL[v]]) {
      const r = await br[DOCD_CALL[v]]();
      if (r && r.ok) {
        DOCD.note = r.message || 'Done.';
        if (v !== 'backup' && reload) { reload(); return; }
      } else if (!(r && r.cancelled)) DOCD.err = (r && r.error) || 'It did not finish.';
    }
  } catch (e) {
    DOCD.err = String((e && e.message) || e);
  } finally {
    DOCD.busy = '';
    paint();
  }
}

if (typeof module !== 'undefined') module.exports = {DOCD, doctorDataHTML, doctorDataAct};
