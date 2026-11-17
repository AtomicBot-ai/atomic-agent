/* ---------------- ATO-576: a chat in its own git worktree ----------------
   Loaded before renderer.js; declares only, and reads renderer.js and
   chat-projects.js globals at call time.

   - A project with a folder has a branch button on its sidebar header:
     "New chat in its own branch". Main (main/chat-worktree-ipc.ts) makes a
     git worktree and branch from the project's folder (a folder outside git
     is refused there, in plain words), and the new chat opened here starts
     in it from its first turn.
   - Edit project lists the agent's worktrees of that project (the
     terminal's `/new worktree` ones too), each with Remove, which main does
     only when nothing would be lost. */

const WT = {rows: {}, for: null, busy: false};

function wtApi() {
  return typeof BR !== 'undefined' && BR && typeof BR.worktreeNewChat === 'function' ? BR : null;
}

/* The header button, for a project with a folder; '' without the bridge. */
function worktreeHeadButton(pid) {
  if (!wtApi()) return '';
  return '<span class="sesmore iconbtn" data-act="pwtnew:' + esc(pid) + '" title="New chat in its own branch (git worktree)"'
    + ' aria-label="New chat in its own branch" role="button">' + ic('branch') + '</span>';
}

/* One row of the list, as plain data: what it says and whether Remove is on. */
function worktreeRowView(row) {
  const r = row || {};
  const name = r.branch || String(r.path || '').split(/[\\/]/).pop() || 'worktree';
  return {name, path: String(r.path || ''), canRemove: r.removable === true, why: r.removable === true ? '' : String(r.reason || '')};
}

/* The Edit project sheet's "Branches of their own" block. */
function worktreeListHTML(pid) {
  if (!wtApi()) return '';
  const rows = WT.rows[pid];
  const head = '<label class="sd-cap">Chats in their own branch (git worktrees)</label>';
  if (rows === undefined) return head + '<p class="sd-cap">Looking…</p>';
  if (!rows.length) return head + '<p class="sd-cap">None. The branch button on the project starts one.</p>';
  return head + rows.map((row, i) => {
    const v = worktreeRowView(row);
    return '<div class="row" style="display:flex;gap:8px;align-items:center">'
      + '<span class="grow mono" title="' + esc(v.path) + '">' + esc(v.name) + '</span>'
      + (v.why ? '<span class="sd-cap" title="' + esc(v.why) + '">Has work</span>' : '')
      + '<button class="btn btn-s sm" data-act="pwtrm:' + i + '"' + (v.canRemove && !WT.busy ? '' : ' disabled')
        + ' title="' + esc(v.canRemove ? 'Remove the worktree and its branch (a branch with unmerged commits is kept)' : v.why) + '">Remove</button>'
      + '</div>';
  }).join('');
}

/* Read the list for the open Edit project sheet, then redraw it. */
function worktreeLoad(pid) {
  const api = wtApi();
  if (!api || !pid) return;
  WT.for = pid;
  api.worktreeList(pid).then((res) => {
    WT.rows[pid] = res && res.ok && Array.isArray(res.rows) ? res.rows : [];
    if (WT.for === pid && typeof S !== 'undefined' && S.overlay === 'pedit') projectEditRedraw({});
  }, () => { WT.rows[pid] = []; });
}

/* The verbs this file owns: pwtnew:<project id>, pwtrm:<row index of the open sheet>. */
function worktreeAct(k, v) {
  const api = wtApi();
  if (k !== 'pwtnew' && k !== 'pwtrm') return false;
  if (!api) { toast('Not available', 'Update Atomic Agent for chats in their own branch', 'bad'); return true; }
  if (k === 'pwtnew') {
    api.worktreeNewChat(v).then((res) => {
      if (!res || !res.ok) { toast('Could not start a chat in its own branch', (res && res.error) || '', 'bad'); return; }
      act('session:new');
      PROJECTS.newFor = {id: v, log: S.log};
      render();
      toast('New chat in its own branch', res.branch + ' · ' + res.path);
    }, (e) => toast('Could not start a chat in its own branch', String(e), 'bad'));
    return true;
  }
  const pid = WT.for, row = pid ? (WT.rows[pid] || [])[Number(v)] : null;
  if (!row || WT.busy) return true;
  WT.busy = true;
  api.worktreeRemove(pid, row.path).then((res) => {
    WT.busy = false;
    if (!res || !res.ok) toast('Worktree kept', (res && res.error) || '', 'bad');
    else toast('Worktree removed', res.branchKept ? 'Its branch has commits nobody merged, so the branch is kept' : (row.branch || ''));
    worktreeLoad(pid);
  }, (e) => { WT.busy = false; toast('Worktree kept', String(e), 'bad'); worktreeLoad(pid); });
  return true;
}

if (typeof module !== 'undefined') module.exports = {worktreeRowView};
