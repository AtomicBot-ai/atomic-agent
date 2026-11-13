/* ---------------- ATO-1056 / ATO-1058: roll back, edit, fork ----------------
   Loaded before renderer.js; declares only.

   Three actions on a message, beside copy and retry:
   - "Roll back here" (a question): the chat goes back to just before it, and
     the files the agent's file tools changed since then are put back. A
     confirmation lists the files that will change and the messages that go.
     The question returns to the composer, as the terminal's /rewind does.
   - "Edit" (a question): the same confirmation with the files that will
     change, then the edited text is sent. When files change there are two
     ways: files and conversation (files: true), or the conversation only
     (files: false); with no file changes, one button and no file section.
   - "Fork from here" (a reply): a new chat with the history up to and
     including that reply; the original stays as it is.

   The agent does the work (POST /api/sessions/{id}/rewind[/preview], /fork):
   it names the question by how many questions come before it and its text,
   like "Regenerate" does (priorQuestions in renderer.js), and refuses a
   different one. Only changes made by the agent's own file tools can be put
   back: shell commands, git commands and Fusion workers are not undone, and
   the confirmation says so. */

/* ---- pure part (unit-tested in desktop/test/chat-rewind.test.mjs) ---- */

/** The question a message stands for: itself (a question), or the one its reply answers. */
function rewindQuestionFor(log, m) {
  if (!m || !Array.isArray(log)) return null;
  if (m.k === 'user') return m.steered ? null : m;
  if (m.k !== 'assistant') return null;
  for (let i = log.indexOf(m) - 1; i >= 0; i--) {
    const x = log[i];
    if (x && x.k === 'user' && !x.steered) return x;
  }
  return null;
}

const REWIND_REASON = {
  too_large: 'too large to keep a copy of',
  binary: 'not a text file',
  not_a_file: 'a folder, not a file',
  unreadable: 'could not be read',
};

const REWIND_TOOL_WORDS = [
  [(t) => t.indexOf('os.shell.') === 0, 'shell command', 'shell commands'],
  [(t) => t.indexOf('os.git.') === 0, 'git command', 'git commands'],
  [(t) => t === 'os.fs.archive.extract', 'archive extraction', 'archive extractions'],
  [(t) => t === 'fusion.delegate', 'Fusion run', 'Fusion runs'],
];

function rewindPlural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

/** A path as the confirmation shows it: relative to the chat's folder when inside it. */
function rewindPathLabel(path, workingDir) {
  const p = String(path || '');
  const wd = String(workingDir || '').replace(/[\\/]+$/, '');
  if (wd && (p.indexOf(wd + '/') === 0 || p.indexOf(wd + '\\') === 0)) return p.slice(wd.length + 1);
  return p;
}

/** What the confirmation says, from the agent's preview. */
function rewindSummary(preview, workingDir) {
  const p = preview || {};
  const removed = p.removed || {};
  const q = Number(removed.questions) || 0;
  const r = Number(removed.replies) || 0;
  const files = Array.isArray(p.files) ? p.files : [];
  const out = {
    removedText: rewindPlural(q, 'message of yours', 'messages of yours') + ' and ' + rewindPlural(r, 'reply', 'replies') + ' will be removed from this chat.',
    restore: files.filter((f) => f.action === 'restore').map((f) => rewindPathLabel(f.path, workingDir)),
    remove: files.filter((f) => f.action === 'delete').map((f) => rewindPathLabel(f.path, workingDir)),
    cannot: (Array.isArray(p.notRestorable) ? p.notRestorable : [])
      .map((f) => rewindPathLabel(f.path, workingDir) + ' (' + (REWIND_REASON[f.reason] || 'no copy was kept') + ')'),
    warnings: [],
  };
  if (p.incomplete) out.warnings.push('Some older file changes are no longer kept, so not every file can be put back.');
  const counts = new Map();
  for (const u of Array.isArray(p.uncovered) ? p.uncovered : []) {
    const words = REWIND_TOOL_WORDS.find(([match]) => match(String(u.tool || '')));
    if (!words) continue;
    counts.set(words, (counts.get(words) || 0) + (Number(u.count) || 0));
  }
  if (counts.size) {
    const list = [...counts].map(([[, one, many], n]) => rewindPlural(n, one, many));
    out.warnings.push('This part of the chat also ran ' + list.join(', ') + '. What they changed is not undone.');
  }
  out.warnings.push('Only files changed by the agent\'s own file tools are put back. Shell commands and Fusion workers are never undone, and edits you made to these files by hand since then will be lost.');
  return out;
}

/**
 * The confirm buttons of the sheet: [act, label, files flag]. Roll back sends
 * no flag (the agent's default puts files back). Edit offers both ways only
 * when files will really change; otherwise one button, conversation only.
 */
function rewindButtons(mode, summary) {
  if (mode !== 'edit') return [['rewind:go', 'Roll back', undefined]];
  const s = summary || {};
  const changes = (s.restore || []).length + (s.remove || []).length > 0;
  if (!changes) return [['rewind:go-chat', 'Send edited message', false]];
  return [['rewind:go-chat', 'Conversation only', false], ['rewind:go', 'Roll back files and conversation, then resend', true]];
}

/** Whether the sheet shows its file section (lists and file warnings). */
function rewindShowsFiles(mode, summary) {
  if (mode !== 'edit') return true;
  const s = summary || {};
  return (s.restore || []).length + (s.remove || []).length + (s.cannot || []).length > 0;
}

/** The words for the agent refusing (its 409 code). */
function rewindRefusalText(r) {
  const code = r && r.code;
  if (code === 'turn_in_progress') return 'The agent is still working in this chat. Wait for it to finish, then try again.';
  if (code === 'point_mismatch') return 'The chat changed on the agent side. Open it again, then try again.';
  if (code === 'point_compacted') return 'This part of the chat was already summarized, so it cannot be taken back.';
  if (code === 'session_not_found') return 'This chat is not saved yet.';
  return (r && r.error) || 'The agent gave no reason. Nothing was changed.';
}

/* ---- renderer side (globals from renderer.js, read at call time) ---- */

const REWIND = {supported: true, mode: null, id: null, sid: null, prior: 0, text: '', preview: null, loading: false, busy: false, error: null, draft: ''};

function rewindReady() {
  return typeof BR !== 'undefined' && BR && BR.rewindPreview && REWIND.supported && S.agentSession && !S.busy && !S.pending;
}

/** The buttons for message `m`, drawn into its row of actions (msgActs). */
function rewindActsHTML(m) {
  if (!rewindReady() || !m || m.placeholder || !String(m.text || '').trim()) return '';
  const btn = (verb, icon, label) => '<button class="msgact" data-rw="1" data-act="rewind:' + verb + ':' + esc(m.id)
    + '" title="' + label + '" aria-label="' + label + '">' + ic(icon) + '</button>';
  if (m.k === 'user') return m.steered ? '' : btn('edit', 'edit', 'Edit') + btn('back', 'undo', 'Roll back here');
  if (m.k === 'assistant' && rewindQuestionFor(S.log, m)) return btn('fork', 'branch', 'Fork from here');
  return '';
}

/** `rewind:<verb>:<message id>` from act(): back · edit · fork · go · go-chat (edit, conversation only). */
function rewindAct(v) {
  const colon = v.indexOf(':');
  const verb = colon < 0 ? v : v.slice(0, colon);
  const id = colon < 0 ? '' : v.slice(colon + 1);
  if (verb === 'go') return rewindConfirm(REWIND.mode === 'edit' ? true : undefined);
  if (verb === 'go-chat') return rewindConfirm(false);
  if (verb === 'back' || verb === 'edit' || verb === 'fork') rewindStart(verb, id);
}

function rewindStart(mode, id) {
  const m = S.log.find((x) => x.id === id);
  const q = rewindQuestionFor(S.log, m);
  if (!q || !rewindReady()) return;
  Object.assign(REWIND, {mode, id: q.id, sid: S.agentSession, prior: priorQuestions(q), text: String(q.text || ''),
    preview: null, error: null, busy: false, loading: mode !== 'fork', draft: attToEditor(String(q.text || ''))});
  if (mode === 'fork') { rewindFork(); return; }
  S.overlay = 'rewind';
  render();
  rewindLoadPreview();
}

async function rewindLoadPreview() {
  const sid = REWIND.sid;
  const r = await BR.rewindPreview(sid, REWIND.prior, REWIND.text).catch((err) => ({ok: false, supported: true, error: String(err)}));
  if (REWIND.sid !== sid || S.overlay !== 'rewind') return;
  REWIND.loading = false;
  if (r && r.supported === false) { REWIND.supported = false; S.overlay = null; render(); toast('Not available', 'This agent version cannot roll a chat back. Update Atomic Agent.', 'bad'); return; }
  if (!r || !r.ok) REWIND.error = rewindRefusalText(r);
  else REWIND.preview = r.data;
  render();
}

function rewindSheetHTML() {
  const edit = REWIND.mode === 'edit';
  let body = '';
  if (edit) {
    body += '<p class="sd-cap">Change your message. Sending it takes the chat back to just before it, then sends the new text.</p>'
      + '<textarea id="rw-edit" class="tk-inp" rows="5" spellcheck="true">' + esc(REWIND.draft) + '</textarea>';
  }
  if (REWIND.error) body += '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(REWIND.error) + '</span></div>';
  if (REWIND.loading) body += '<div class="tk-empty"><span class="tk-spin"></span><p>Checking what will change…</p></div>';
  const s = REWIND.preview ? rewindSummary(REWIND.preview, typeof WORKSPACE === 'string' ? WORKSPACE : '') : null;
  if (s && !rewindShowsFiles(REWIND.mode, s)) body += '<p class="sd-cap">' + esc(s.removedText) + '</p>';
  else if (s) {
    const list = (title, items) => items.length
      ? '<p class="sd-cap"><b>' + esc(title) + '</b></p><div class="rows">' + items.map((t) => '<div class="row"><span class="main"><span class="t">' + esc(t) + '</span></span></div>').join('') + '</div>'
      : '';
    body += '<p class="sd-cap">' + esc(s.removedText) + '</p>';
    body += (s.restore.length || s.remove.length) ? '' : '<p class="sd-cap">No files will change.</p>';
    body += list('Put back as they were', s.restore) + list('Removed (the agent created them)', s.remove) + list('Cannot be put back', s.cannot);
    body += s.warnings.map((w) => '<div class="tk-notice tk-notice--amber">' + ic('alert') + '<span class="grow">' + esc(w) + '</span></div>').join('');
  }
  const disabled = REWIND.loading || REWIND.busy || !REWIND.preview;
  const buttons = rewindButtons(REWIND.mode, s);
  // The last button is the primary one.
  const foot = buttons.map(([a, label], i) => {
    const kind = i < buttons.length - 1 ? 'btn-s' : edit ? 'btn-p' : 'btn-df';
    return '<button class="btn ' + kind + ' sm" data-act="' + a + '"' + (disabled ? ' disabled' : '') + '>'
      + (REWIND.busy && i === buttons.length - 1 ? '<span class="tk-spin"></span>' : '') + esc(label) + '</button>';
  }).join('');
  return sheet(edit ? 'Edit message' : 'Roll back to this message', body,
    '<span class="grow"></span><button class="btn btn-s sm" data-act="close">Cancel</button>' + foot, 'sheet-rewind');
}

/** `files`: undefined (roll back, the agent's default), true or false (edit). */
async function rewindConfirm(files) {
  if (REWIND.busy || !REWIND.preview) return;
  const edit = REWIND.mode === 'edit';
  const box = document.getElementById('rw-edit');
  const draft = edit ? String(box ? box.value : REWIND.draft) : '';
  if (edit && !draft.trim()) { REWIND.error = 'The message is empty.'; render(); return; }
  const entry = $('#entry');
  const typed = String((entry ? entry.value : S.draft) || '').trim();
  if (typed || (typeof ATT !== 'undefined' && ATT.items.length)) { REWIND.error = 'Your draft is in the way. Send or clear the composer first.'; render(); return; }
  const sid = REWIND.sid;
  REWIND.busy = true; REWIND.error = null; render();
  const r = await BR.rewind(sid, REWIND.prior, REWIND.text, files).catch((err) => ({ok: false, supported: true, error: String(err)}));
  REWIND.busy = false;
  if (!r || !r.ok) { REWIND.error = rewindRefusalText(r); render(); return; }
  S.overlay = null;
  await openSession(sid);
  if (S.agentSession !== sid) return;
  const d = r.data || {};
  const failed = Array.isArray(d.failed) ? d.failed : [];
  S.draft = edit ? draft : attToEditor(String(d.text || REWIND.text));
  const e = $('#entry');
  if (e) { e.value = S.draft; autosize(e); e.focus(); }
  refreshSend();
  const n = (d.restored || []).length + (d.deleted || []).length;
  toast(edit ? 'Message edited' : 'Rolled back', (n ? rewindPlural(n, 'file', 'files') + ' put back. ' : '')
    + (failed.length ? failed.length + ' could not be written: ' + failed.map((f) => f.path).join(', ') : ''), failed.length ? 'bad' : undefined);
  if (edit) submit();
}

async function rewindFork() {
  const sid = REWIND.sid;
  const r = await BR.forkSession(sid, REWIND.prior, REWIND.text).catch((err) => ({ok: false, supported: true, error: String(err)}));
  if (r && r.supported === false) { REWIND.supported = false; render(); toast('Not available', 'This agent version cannot fork a chat. Update Atomic Agent.', 'bad'); return; }
  if (!r || !r.ok || !r.data || !r.data.id) { toast("Couldn't fork", rewindRefusalText(r), 'bad'); return; }
  await refreshSessions();
  await openSession(r.data.id);
  toast('Forked', 'A new chat with the history up to here. The original is unchanged.');
}

/* The edit box keeps its text across repaints while it is not focused. */
if (typeof document !== 'undefined') {
  document.addEventListener('input', (e) => { if (e.target && e.target.id === 'rw-edit') REWIND.draft = e.target.value; });
}

if (typeof module !== 'undefined') module.exports = {rewindQuestionFor, rewindPathLabel, rewindSummary, rewindRefusalText, rewindButtons, rewindShowsFiles,
  REWIND, rewindSheetHTML, rewindAct, rewindConfirm};
