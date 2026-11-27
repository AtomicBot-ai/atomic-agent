/* ---------------- Models folder (ATO-2106) ----------------
   Loaded before renderer.js; declares only, reads renderer.js globals (BR,
   esc, toast, llmRepaint, llmRefresh) at run time, guarded, so the Node
   tests can load it (test/models-folder.test.mjs).

   Settings › Models › Local models gets one more card: where the downloaded
   models are, "Change…" to move them all to another folder (an external
   disk, say), and "Use the default folder" to move them back. LM Studio's
   My Models › Models Directory › Change works the same way. The agent moves
   the files and saves the folder (`atag models dir`); main runs it
   (main/models-folder-ipc.ts) and relays "moving <model> (2/5)". The card
   only shows when the agent answers `models dir`. */

const MDIR = {
  info: null, asked: false,
  phase: 'idle',   // idle | choosing | moving
  progress: null, error: null, note: null, unsub: null,
};

/* ---------- pure helpers ---------- */

/** "Moving qwen-3.5-4b (2 of 5)…", or a plain "Moving…" before the first model. */
function mdirProgressLine(p) {
  if (!p || typeof p.entry !== 'string' || !(p.total > 0)) return 'Moving your models…';
  return 'Moving ' + p.entry + ' (' + p.index + ' of ' + p.total + ')…';
}

/** What a finished move tells the person. */
function mdirDoneNote(res) {
  const left = res && Array.isArray(res.leftovers) ? res.leftovers : [];
  if (left.length) return 'Moved. The old copy could not be deleted, delete it by hand: ' + left.join(', ');
  return 'Moved. New downloads go to this folder too.';
}

function mdirCardHTML(st, h) {
  const info = st.info;
  if (!info || typeof info.dir !== 'string') return '';
  const esc = h.esc;
  const busy = st.phase !== 'idle';
  const body = st.phase === 'moving'
    ? '<p class="fit-line"><span class="tk-spin"></span>' + esc(mdirProgressLine(st.progress)) + '</p>'
      + '<p class="llm-note">Keep the app open. Across disks this copies every model and can take a while.</p>'
    : '<div class="fit-acts">'
      + '<button class="btn btn-s sm" type="button" data-mdir="change"' + (busy ? ' disabled' : '') + '>Change…</button>'
      + (info.custom ? '<button class="btn sm" type="button" data-mdir="reset"' + (busy ? ' disabled' : '') + '>Use the default folder</button>' : '')
      + '</div>';
  return '<section class="llm-section mdir-entry"><div class="tk-sh llm-sh"><span class="llm-sh-t">Models folder</span></div>'
    + '<div class="fit-card">'
    + '<p class="llm-note">Downloaded models are kept in <code data-mdir-dir>' + esc(info.dir) + '</code>. '
    + 'Change moves every model to the folder you pick, for example on an external disk, and the agent uses it from then on.</p>'
    + body
    + (st.error ? '<p class="llm-note fit-err" role="alert">' + esc(st.error) + '</p>' : '')
    + (st.note ? '<p class="llm-note">' + esc(st.note) + '</p>' : '')
    + '</div></section>';
}

/* ---------- wiring ---------- */

function mdirBridge() { return typeof BR !== 'undefined' && BR && BR.modelsFolderInfo ? BR : null; }
function mdirRepaint() { if (typeof llmRepaint === 'function') llmRepaint(); }
function mdirHelpers() { return {esc: typeof esc === 'function' ? esc : (s) => String(s)}; }

async function mdirLoad() {
  const br = mdirBridge();
  if (!br) return;
  const res = await br.modelsFolderInfo().catch(() => null);
  MDIR.info = res && res.ok ? {dir: res.dir, defaultDir: res.defaultDir, custom: res.custom === true} : null;
  mdirRepaint();
}

/** renderer.js llmLocalHTML: the card, '' until the agent has said where the folder is. Asks once per app run. */
function modelsFolderHTML() {
  if (!MDIR.asked) { MDIR.asked = true; void mdirLoad(); }
  return mdirCardHTML(MDIR, mdirHelpers());
}

async function mdirMove(opts) {
  const br = mdirBridge();
  if (!br || MDIR.phase === 'moving') return;
  MDIR.phase = 'moving'; MDIR.progress = null; MDIR.error = null; MDIR.note = null;
  if (!MDIR.unsub && br.onModelsFolderProgress) MDIR.unsub = br.onModelsFolderProgress((p) => { MDIR.progress = p; mdirRepaint(); });
  mdirRepaint();
  const res = await br.modelsFolderMove(opts).catch((e) => ({ok: false, error: e && e.message ? e.message : String(e)}));
  MDIR.phase = 'idle'; MDIR.progress = null;
  if (res && res.ok) {
    MDIR.note = mdirDoneNote(res);
    if (typeof toast === 'function') toast('Models moved', res.dir || '');
  } else {
    MDIR.error = (res && res.error) || 'The models were not moved.';
  }
  await mdirLoad();
  // Each row's "Downloaded" is read again from the new folder.
  if (typeof llmRefresh === 'function') void llmRefresh();
}

async function mdirChange() {
  const br = mdirBridge();
  if (!br || MDIR.phase !== 'idle') return;
  MDIR.phase = 'choosing'; MDIR.error = null; MDIR.note = null; mdirRepaint();
  const picked = await br.modelsFolderChoose().catch(() => null);
  MDIR.phase = 'idle';
  if (!picked || !picked.ok || !picked.path) { mdirRepaint(); return; }
  await mdirMove({path: picked.path});
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const el = t.closest('[data-mdir]');
    if (!el) return;
    e.preventDefault();
    const act = el.getAttribute('data-mdir');
    if (act === 'change') void mdirChange();
    else if (act === 'reset') void mdirMove({reset: true});
  });
}

if (typeof module !== 'undefined') {
  module.exports = {MDIR, mdirProgressLine, mdirDoneNote, mdirCardHTML, mdirMove, mdirChange, modelsFolderHTML};
}
