/* ---------------- ATO-2498: the task board's card thread, picker and waits ----------------
   Loaded before workboard.js; declares only. The pure half is shared with the
   Node checks (test/workboard.test.mjs); the renderer half reads renderer.js
   and workboard.js globals (BR, WB, render, toast, wbFind, wbLoad) at call time.

   - A card's comment thread (agent, person and the agent's own notices, the
     way Linear and the Hermes kanban keep one), opened from the card. A
     notice's details (a failed run's last error) sit behind "Details".
   - The assignee is picked from the agent's profiles instead of typed; a
     card assigned to a profile runs as it (src/tasks/task-board-assignee.ts).
   - A card can wait on other cards; it shows "Waiting on N" and Run now asks
     first, since the scheduler would leave it until they are done. */

const WX_COMMENT_MAX = 2000;
const WX_DEPS_MAX = 20;
const WX_SAFE_ID = /^[\w.-]{1,64}$/;
const WX_AUTHORS = {agent: 'Agent', person: 'You', system: 'Atomic Agent'};

function wxEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}
function wxShort(text, max) {
  const line = String(text || '').trim().split(/\r?\n/)[0] || '(no message)';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/** The small line under a card's title: comments and what it waits on. */
function wxBadgesHTML(card) {
  const out = [];
  const n = Number(card && card.commentCount) || 0;
  const id = wxEsc(card && card.task && card.task.id);
  out.push('<button class="wb-chip" data-act="board:thread:' + id + '">' + (n ? n + (n === 1 ? ' comment' : ' comments') : 'Comment') + '</button>');
  const waits = Array.isArray(card && card.waitingOn) ? card.waitingOn.length : 0;
  if (waits) out.push('<span class="wb-chip wb-chip--wait" title="The scheduler leaves this card until the cards it waits on are done">Waiting on ' + waits + '</span>');
  return '<div class="wb-chips">' + out.join('') + '</div>';
}

/** Ask before Run now on a card still waiting on others; `null` when there is nothing to ask. */
function wxRunQuestion(card) {
  const waits = Array.isArray(card && card.waitingOn) ? card.waitingOn.length : 0;
  if (!waits) return null;
  return 'This card waits on ' + waits + (waits === 1 ? ' card that is' : ' cards that are') + ' not done yet. Run it anyway?';
}

function wxRunConfirmHTML(id, question) {
  return '<div class="wb-ask"><span>' + wxEsc(question) + '</span><div class="wb-row">'
    + '<button class="btn btn-p sm" data-act="board:runanyway:' + wxEsc(id) + '">Run anyway</button>'
    + '<button class="btn btn-g sm" data-act="board:runcancel">Cancel</button></div></div>';
}

/** The assignee field: the profile list, or a text box when it cannot be read. `p`: {list, loading, error}. */
function wxAssigneeHTML(p, current) {
  const value = String(current || '');
  if (p && p.loading) return '<select data-wb-draft="assignee" disabled><option>Loading profiles…</option></select>';
  if (!p || !Array.isArray(p.list)) {
    return '<input data-wb-draft="assignee" placeholder="Assignee (profile name)" value="' + wxEsc(value) + '" spellcheck="false">'
      + (p && p.error ? '<div class="wb-hint">Could not read the profiles. Type a profile name, or leave it empty.</div>' : '');
  }
  const names = p.list.map((x) => x.name);
  const opts = ['<option value=""' + (value ? '' : ' selected') + '>No one (the main agent)</option>']
    .concat(p.list.map((x) => '<option value="' + wxEsc(x.name) + '"' + (x.name === value ? ' selected' : '') + ' title="' + wxEsc(x.description || '') + '">'
      + wxEsc(x.name) + (x.description ? ' · ' + wxEsc(wxShort(x.description, 50)) : '') + '</option>'));
  if (value && !names.includes(value)) opts.push('<option value="' + wxEsc(value) + '" selected>' + wxEsc(value) + ' (not found)</option>');
  return '<label class="wb-lbl">Assignee</label><select data-wb-draft="assignee" aria-label="Assignee">' + opts.join('') + '</select>';
}

/** The "waits on" checkboxes: every other card, the picked ones ticked. */
function wxDepsHTML(cards, id, picked) {
  const chosen = new Set(Array.isArray(picked) ? picked : []);
  const others = (cards || []).filter((c) => c && c.task && c.task.id !== id && WX_SAFE_ID.test(String(c.task.id)));
  if (!others.length) return '';
  return '<label class="wb-lbl">Waits on</label><div class="wb-deps">' + others.map((c) => '<label class="wb-dep"><input type="checkbox" data-wb-dep="' + wxEsc(c.task.id) + '"'
    + (chosen.has(c.task.id) ? ' checked' : '') + '><span>' + wxEsc(wxShort(c.task.userMessage, 60)) + '</span></label>').join('') + '</div>';
}

/** Tick or untick one dependency in a draft list; capped like the agent. */
function wxToggleDep(list, depId, on) {
  const out = (Array.isArray(list) ? list : []).filter((x) => x !== depId);
  if (on && WX_SAFE_ID.test(depId) && out.length < WX_DEPS_MAX) out.push(depId);
  return out;
}

/** One comment: who, when, the first line, and the rest behind Details. */
function wxCommentHTML(c, rel) {
  const lines = String(c.text || '').split(/\r?\n/);
  const head = lines[0], rest = lines.slice(1).join('\n').trim();
  const when = typeof rel === 'function' && c.createdAt ? ' · ' + wxEsc(rel(c.createdAt)) : '';
  return '<div class="wb-c wb-c--' + wxEsc(c.author) + '"><div class="wb-c-h">' + wxEsc(WX_AUTHORS[c.author] || 'Agent') + when + '</div>'
    + '<div class="wb-c-t">' + wxEsc(head) + '</div>'
    + (rest ? '<details class="wb-c-d"><summary>Details</summary><pre>' + wxEsc(rest) + '</pre></details>' : '') + '</div>';
}

/** The open thread. `t`: {comments, loading, error, unsupported, draft, sending}. */
function wxThreadHTML(id, t, rel) {
  const th = t || {};
  let body = '';
  if (th.unsupported) body = '<div class="wb-hint">Update Atomic Agent to keep comments on cards.</div>';
  else if (th.error) body = '<div class="wb-err">Could not read the comments.</div>';
  else if (th.loading && !th.comments) body = '<div class="wb-hint"><span class="tk-spin"></span>Reading comments…</div>';
  else if (th.comments && !th.comments.length) body = '<div class="wb-hint">No comments yet.</div>';
  else if (th.comments) body = th.comments.slice().reverse().map((c) => wxCommentHTML(c, rel)).join('');
  const form = th.unsupported ? '' : '<textarea data-wb-comment rows="2" maxlength="' + WX_COMMENT_MAX + '" placeholder="Add a comment">' + wxEsc(th.draft || '') + '</textarea>'
    + '<div class="wb-row"><button class="btn btn-p sm" data-act="board:comment:' + wxEsc(id) + '"' + (th.sending ? ' disabled' : '') + '>'
    + (th.sending ? '<span class="tk-spin"></span>' : '') + 'Comment</button>'
    + '<button class="btn btn-g sm" data-act="board:threadclose">Close</button></div>';
  return '<div class="wb-thread">' + body + form + '</div>';
}

/* ---- renderer side ---- */

const WX = {profiles: null, thread: null, confirmRun: null};

async function wxLoadProfiles(taskId) {
  WX.profiles = {list: null, loading: true, error: null};
  let res = null;
  try { res = typeof BR.boardProfiles === 'function' ? await BR.boardProfiles(taskId) : null; } catch { res = null; }
  const list = res && res.ok && res.data && Array.isArray(res.data.profiles) ? res.data.profiles.filter((p) => p && typeof p.name === 'string') : null;
  WX.profiles = {list, loading: false, error: list ? null : 'unreadable'};
  render();
}

async function wxLoadThread(id) {
  if (!WX.thread || WX.thread.id !== id) return;
  WX.thread.loading = true; render();
  let res = null;
  try { res = typeof BR.boardComments === 'function' ? await BR.boardComments(id) : {ok: false, unsupported: true}; } catch { res = null; }
  if (!WX.thread || WX.thread.id !== id) return;
  const th = WX.thread;
  th.loading = false;
  th.error = null; th.unsupported = false;
  if (!res) th.error = 'unreadable';
  else if (!res.ok) { if (res.unsupported) th.unsupported = true; else th.error = res.error || 'unreadable'; }
  else if (res.data && res.data.available === false) th.unsupported = true;
  else th.comments = Array.isArray(res.data && res.data.comments) ? res.data.comments : [];
  render();
}

async function wxSendComment(id) {
  const th = WX.thread;
  if (!th || th.id !== id || th.sending) return;
  const text = String(th.draft || '').trim();
  if (!text) return;
  th.sending = true; render();
  let res = null;
  try { res = await BR.addBoardComment(id, text); } catch { res = null; }
  th.sending = false;
  if (!res || !res.ok) { toast("Couldn't add the comment", 'Try again in a moment.', 'bad'); render(); return; }
  th.draft = '';
  wxLoadThread(id);
  wbLoad();
}

/** Verbs workboard.js hands over; true when handled. */
function wxAct(verb, id) {
  if (verb === 'thread') {
    if (WX.thread && WX.thread.id === id) { WX.thread = null; render(); return true; }
    WX.thread = {id, comments: null, loading: false, error: null, unsupported: false, draft: '', sending: false};
    wxLoadThread(id); return true;
  }
  if (verb === 'threadclose') { WX.thread = null; render(); return true; }
  if (verb === 'comment') { wxSendComment(id); return true; }
  if (verb === 'runcancel') { WX.confirmRun = null; render(); return true; }
  if (verb === 'runanyway') { WX.confirmRun = null; wbRun(id); return true; }
  return false;
}

function wxInstall(doc) {
  doc.addEventListener('change', (e) => {
    const box = e.target && e.target.getAttribute && e.target.getAttribute('data-wb-dep');
    if (box && WB.draft) WB.draft.dependsOn = wxToggleDep(WB.draft.dependsOn, box, !!e.target.checked);
  });
  doc.addEventListener('input', (e) => {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-wb-comment') && WX.thread) WX.thread.draft = e.target.value;
  });
}
if (typeof document !== 'undefined' && typeof module === 'undefined') wxInstall(document);

if (typeof module !== 'undefined') module.exports = {wxEsc, wxBadgesHTML, wxRunQuestion, wxRunConfirmHTML, wxAssigneeHTML, wxDepsHTML, wxToggleDep, wxCommentHTML, wxThreadHTML};
