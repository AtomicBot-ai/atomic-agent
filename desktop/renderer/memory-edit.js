/* ---------------- ATO-582: edit and delete memory from the Memory tab ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/memory-edit.test.mjs).

   The tab read memory.sqlite and could only show it: to forget a note or a
   fact the operator had to ask the agent (memory.notes.forget,
   memory.profile.remove). A note's page and a fact's page now have Edit
   and Delete. The write goes to the running agent (app:memoryWrite →
   main/memory-write.ts → the agent's /api/memory routes), never as SQL of
   the desktop's: the agent keeps the FTS index and the vectors in step, and
   the terminal reads the same ~/.atomic-agent.

   Delete asks first, in the page (Delete again, or Cancel). Edit turns the
   note's text (or the fact's value: the agent keeps the old one in the
   fact's history) into a box; Save sends it, Cancel or Esc leaves it. The box's
   text is kept here on every keystroke, so a repaint of the pane while the
   operator types does not lose it. After a write the list or the note is
   read again. An agent without the routes answers "Update the agent to
   edit memory here". */

const MEMEDIT = {key: null, mode: null, text: '', original: null, busy: false, error: null};

/* The page's identity for an edit: 'note:<id>' or 'profile:<key>', null for the others. */
function memEditKey(d) {
  if (!d) return null;
  if (d.channel === 'notes' && typeof d.id === 'number') return 'note:' + d.id;
  if (d.channel === 'profile' && typeof d.key === 'string') return 'profile:' + d.key;
  return null;
}

/* The edit box's text, checked before it is sent: {ok:true, text}, {ok:true, same:true}, or {ok:false, error}. */
function memEditCheckText(raw, current, what) {
  const text = String(raw == null ? '' : raw);
  if (!text.trim()) return {ok: false, error: 'A ' + (what || 'note') + ' cannot be empty. Delete it instead.'};
  if (current != null && text.trim() === String(current).trim()) return {ok: true, same: true, text};
  return {ok: true, text};
}

/* A fact's value now: the row of profile.history nothing superseded, or null. */
function memEditActiveValue(rows) {
  const active = (rows || []).filter((r) => r && (r.superseded_by === null || r.superseded_by === undefined));
  return active.length ? String(active[active.length - 1].value) : null;
}

/* The op main sends to the agent for this page. */
function memEditOp(d, action, text) {
  if (!d) return null;
  if (d.channel === 'notes' && typeof d.id === 'number') {
    if (action === 'delete') return {op: 'note.delete', id: d.id};
    if (action === 'edit') return {op: 'note.edit', id: d.id, text: String(text)};
  }
  if (d.channel === 'profile' && typeof d.key === 'string') {
    if (action === 'delete') return {op: 'profile.delete', key: d.key};
    if (action === 'edit') return {op: 'profile.edit', key: d.key, value: String(text)};
  }
  return null;
}

/* What the tab does with main's answer: {next:'list'|'reopen'|'stay', toast?, error?}. */
function memEditOutcome(op, res) {
  const what = op && (op.op === 'profile.delete' || op.op === 'profile.edit') ? 'fact' : 'note';
  const edit = op && (op.op === 'note.edit' || op.op === 'profile.edit');
  if (res && res.ok) {
    if (edit) return {next: 'reopen', toast: what === 'fact' ? 'Fact saved' : 'Note saved'};
    return {next: 'list', toast: what === 'fact' ? 'Fact deleted' : 'Note deleted'};
  }
  const reason = res && res.reason;
  if (reason === 'unsupported') return {next: 'stay', error: 'Update the agent to edit memory here'};
  // Gone before we got there (the agent or the terminal removed it): show the list as it is now.
  if (reason === 'gone') return {next: 'list', toast: 'This ' + what + ' was already removed'};
  const msg = res && res.error ? String(res.error) : 'the agent did not answer';
  return {next: 'stay', error: (edit ? 'Could not save the ' + what + ': ' : 'Could not delete the ' + what + ': ') + msg};
}

function memEditReset() { MEMEDIT.key = null; MEMEDIT.mode = null; MEMEDIT.text = ''; MEMEDIT.original = null; MEMEDIT.busy = false; MEMEDIT.error = null; }

/* The detail bar's buttons for this page. */
function memEditButtonsHTML(d) {
  const key = memEditKey(d);
  if (!key) return '';
  const busy = MEMEDIT.key === key && MEMEDIT.busy;
  const dis = busy ? ' disabled' : '';
  const editing = MEMEDIT.key === key && MEMEDIT.mode === 'edit';
  return (!editing ? '<button class="btn btn-s sm" data-act="memory:edit"' + dis + ' title="' + (d.channel === 'profile' ? 'Change this fact’s value' : 'Change this note’s text') + '">' + ic('edit') + 'Edit</button>' : '')
    + '<button class="btn btn-s sm" data-act="memory:delete"' + dis + ' title="Delete from memory">' + ic('trash') + 'Delete</button>';
}

/* The confirm line, the edit box and the last error, under the bar. */
function memEditPanelHTML(d) {
  const key = memEditKey(d);
  if (!key || MEMEDIT.key !== key) return '';
  const what = d.channel === 'profile' ? 'fact “' + d.key + '”' : 'note #' + d.id;
  let html = '';
  if (MEMEDIT.error) html += '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(MEMEDIT.error) + '</span></div>';
  if (MEMEDIT.mode === 'confirm') {
    html += '<div class="tk-notice tk-notice--red">' + ic('trash') + '<span class="grow">Delete ' + esc(what) + ' from memory? The agent will forget it, here and in the terminal.</span>'
      + '<button class="btn btn-d sm" data-act="memory:delete-yes"' + (MEMEDIT.busy ? ' disabled' : '') + '>' + (MEMEDIT.busy ? 'Deleting…' : 'Delete') + '</button>'
      + '<button class="btn btn-g sm" data-act="memory:delete-no"' + (MEMEDIT.busy ? ' disabled' : '') + '>Cancel</button></div>';
  }
  if (MEMEDIT.mode === 'edit') {
    html += '<div class="sd-memedit"><textarea id="mem-edit-text" class="tk-inp sd-memedit-box" rows="' + (d.channel === 'profile' ? 3 : 10) + '" spellcheck="true" aria-label="' + (d.channel === 'profile' ? 'Fact value' : 'Note text') + '"'
      + (MEMEDIT.busy ? ' disabled' : '') + '>' + esc(MEMEDIT.text) + '</textarea>'
      + '<div class="tk-bar"><span class="grow"></span>'
      + '<button class="btn btn-g sm" data-act="memory:edit-cancel"' + (MEMEDIT.busy ? ' disabled' : '') + '>Cancel</button>'
      + '<button class="btn btn-p sm" data-act="memory:edit-save"' + (MEMEDIT.busy ? ' disabled' : '') + '>' + (MEMEDIT.busy ? 'Saving…' : 'Save') + '</button></div></div>';
  }
  return html;
}

async function memEditSend(d, op) {
  const key = memEditKey(d);
  MEMEDIT.busy = true; MEMEDIT.error = null; render();
  let res;
  try { res = await BR.memoryWrite(op); } catch (e) { res = {ok: false, reason: 'error', error: e && e.message ? e.message : String(e)}; }
  if (MEMEDIT.key !== key) return; // left the page meanwhile
  const out = memEditOutcome(op, res);
  MEMEDIT.busy = false;
  if (out.next === 'stay') { MEMEDIT.error = out.error; render(); return; }
  memEditReset();
  if (out.toast) toast(out.toast, '', 'info');
  if (out.next === 'reopen') {
    if (op.op === 'note.edit') memOpenNoteById(op.id);
    else memOpenDetail({rowKey: 'profile:' + op.key, channel: 'profile', primary: op.key, secondary: '', meta: '', profileKey: op.key});
    return;
  }
  MEM.mode = 'list'; MEM.detailRowKey = null; MEM.detail = null;
  memRefresh();
}

/* memoryAct's hook: true when the verb was an edit verb. */
function memEditAct(verb, arg) {
  if (!['edit', 'edit-save', 'edit-cancel', 'delete', 'delete-yes', 'delete-no'].includes(verb)) {
    // Any other move in the tab (back, another note, a channel) drops a half-made edit.
    if (MEMEDIT.key && !(MEM.detail && memEditKey(MEM.detail) === MEMEDIT.key && verb === 'refresh')) memEditReset();
    return false;
  }
  const d = MEM.detail;
  const key = memEditKey(d);
  if (!BR || !key || !BR.memoryWrite) return true;
  if (MEMEDIT.key !== key) memEditReset();
  if (MEMEDIT.busy) return true;
  if (verb === 'delete') { MEMEDIT.key = key; MEMEDIT.mode = 'confirm'; MEMEDIT.error = null; render(); return true; }
  if (verb === 'delete-no' || verb === 'edit-cancel') { memEditReset(); render(); return true; }
  if (verb === 'delete-yes') { const op = memEditOp(d, 'delete'); if (op) memEditSend(d, op); return true; }
  if (verb === 'edit') {
    MEMEDIT.key = key; MEMEDIT.mode = 'edit'; MEMEDIT.error = null; MEMEDIT.busy = true; render();
    // The full text, read again (the page shows a clipped body); a fact's active value is the row nothing superseded.
    const read = d.channel === 'notes'
      ? memQ('notes.get', [d.id]).then((rows) => (rows.length ? rows[0].content : null))
      : memQ('profile.history', [d.key]).then((rows) => memEditActiveValue(rows));
    read.then((value) => {
      if (MEMEDIT.key !== key) return;
      MEMEDIT.busy = false;
      if (value === null || value === undefined) { memEditReset(); MEM.mode = 'list'; MEM.detail = null; MEM.detailRowKey = null; memRefresh(); return; }
      MEMEDIT.text = String(value); MEMEDIT.original = MEMEDIT.text;
      render();
      const box = typeof document !== 'undefined' && document.getElementById('mem-edit-text');
      if (box) box.focus();
    }, (e) => { if (MEMEDIT.key === key) { MEMEDIT.busy = false; MEMEDIT.mode = null; MEMEDIT.error = e && e.message ? e.message : String(e); render(); } });
    return true;
  }
  if (verb === 'edit-save') {
    const box = typeof document !== 'undefined' && document.getElementById('mem-edit-text');
    if (box) MEMEDIT.text = box.value;
    const checked = memEditCheckText(MEMEDIT.text, MEMEDIT.original, d.channel === 'profile' ? 'fact' : 'note');
    if (!checked.ok) { MEMEDIT.error = checked.error; render(); return true; }
    if (checked.same) { memEditReset(); render(); return true; }
    memEditSend(d, memEditOp(d, 'edit', checked.text));
    return true;
  }
  return true;
}

if (typeof document !== 'undefined') {
  // Keep what is typed, so a repaint of the pane rebuilds the box with it.
  document.addEventListener('input', (e) => { if (e.target && e.target.id === 'mem-edit-text') MEMEDIT.text = e.target.value; });
  document.addEventListener('keydown', (e) => {
    if (!e.target || e.target.id !== 'mem-edit-text') return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); memEditAct('edit-cancel'); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); memEditAct('edit-save'); }
  }, true);
}

if (typeof module !== 'undefined') module.exports = {memEditKey, memEditCheckText, memEditActiveValue, memEditOp, memEditOutcome};
