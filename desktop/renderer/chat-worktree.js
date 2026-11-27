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
     only when nothing would be lost.
   - ATO-2754: Remove asks first in the row (Cancel / Remove, as GitHub
     Desktop and VS Code ask before deleting a worktree), then says
     "Removing…" until main answers. A list that could not be read says so,
     with Try again, instead of "None". */

const WT = {rows: {}, failed: {}, for: null, busy: false, asking: -1};

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

/* One row: the name, then Remove, or the question Remove asked, or "Removing…". */
function worktreeRowHTML(row, i) {
  const v = worktreeRowView(row);
  const line = '<div class="row" style="display:flex;gap:8px;align-items:center">'
    + '<span class="grow mono" title="' + esc(v.path) + '">' + esc(v.name) + '</span>';
  if (WT.busy === i) {
    return line + '<button class="btn btn-s sm" disabled aria-busy="true"><span class="tk-spin"></span>Removing\u2026</button></div>';
  }
  if (WT.asking === i && v.canRemove && WT.busy === false) {
    return line + '</div><div class="tk-notice tk-notice--red" role="alertdialog" aria-label="' + esc('Remove ' + v.name + '?') + '" data-wt-confirm>'
      + '<span class="grow"><b>' + esc('Remove ' + v.name + '?') + '</b> Its folder is deleted. Its branch is kept if it has commits nobody merged.</span>'
      + '<button class="btn btn-g sm" data-act="pwtrm:no">Cancel</button>'
      + '<button class="btn btn-danger sm" data-act="pwtrm:go:' + i + '">Remove</button></div>';
  }
  return line + (v.why ? '<span class="sd-cap" title="' + esc(v.why) + '">Has work</span>' : '')
    + '<button class="btn btn-s sm" data-act="pwtrm:' + i + '"' + (v.canRemove && WT.busy === false ? '' : ' disabled')
      + ' title="' + esc(v.canRemove ? 'Remove the worktree and its branch (a branch with unmerged commits is kept)' : v.why) + '">Remove</button>'
    + '</div>';
}

/* The Edit project sheet's "Branches of their own" block. */
function worktreeListHTML(pid) {
  if (!wtApi()) return '';
  const rows = WT.rows[pid];
  const head = '<label class="sd-cap">Chats in their own branch (git worktrees)</label>';
  if (WT.failed[pid]) {
    return head + '<p class="sd-cap" data-wt-failed>Could not load this project\u2019s worktrees. '
      + '<button class="btn btn-g sm" data-act="pwtrm:retry">Try again</button></p>';
  }
  if (rows === undefined) return head + '<p class="sd-cap">Looking\u2026</p>';
  if (!rows.length) return head + '<p class="sd-cap">None. The branch button on the project starts one.</p>';
  return head + rows.map((row, i) => worktreeRowHTML(row, i)).join('');
}

/* Draw the open Edit project sheet again, when it is still this project's. */
function worktreeRedraw(pid) {
  if (WT.for === pid && typeof S !== 'undefined' && S.overlay === 'pedit' && typeof projectEditRedraw === 'function') projectEditRedraw({});
}

/* Read the list for the open Edit project sheet, then redraw it. */
function worktreeLoad(pid) {
  const api = wtApi();
  if (!api || !pid) return Promise.resolve();
  WT.for = pid;
  WT.asking = -1;
  return api.worktreeList(pid).then((res) => {
    const ok = !!(res && res.ok && Array.isArray(res.rows));
    WT.failed[pid] = !ok;
    WT.rows[pid] = ok ? res.rows : undefined;
    worktreeRedraw(pid);
  }, () => { WT.failed[pid] = true; WT.rows[pid] = undefined; worktreeRedraw(pid); });
}

/* Remove, once asked: main removes it only when nothing would be lost. */
function worktreeRemove(api, pid, i) {
  const row = (WT.rows[pid] || [])[i];
  if (!row || WT.busy !== false) return;
  WT.busy = i; WT.asking = -1;
  worktreeRedraw(pid);
  const done = () => { WT.busy = false; return worktreeLoad(pid); };
  return api.worktreeRemove(pid, row.path).then((res) => {
    if (!res || !res.ok) toast('Worktree kept', (res && res.error) || '', 'bad');
    else toast('Worktree removed', res.branchKept ? 'Its branch has commits nobody merged, so the branch is kept' : (row.branch || ''));
    return done();
  }, () => { toast('Worktree kept', 'It could not be removed. Try again in a moment.', 'bad'); return done(); });
}

/* The verbs this file owns: pwtnew:<project id>; for the open sheet's list,
   pwtrm:<row> asks, pwtrm:go:<row> removes, pwtrm:no cancels, pwtrm:retry reads it again. */
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
      toast('New chat in its own branch', res.branch + ' \u00b7 ' + res.path);
    }, (e) => toast('Could not start a chat in its own branch', String(e), 'bad'));
    return true;
  }
  const pid = WT.for;
  const what = String(v == null ? '' : v);
  if (!pid) return true;
  if (what === 'retry') { WT.failed[pid] = false; WT.rows[pid] = undefined; worktreeRedraw(pid); worktreeLoad(pid); return true; }
  if (what === 'no') { WT.asking = -1; worktreeRedraw(pid); return true; }
  if (what.startsWith('go:')) { worktreeRemove(api, pid, Number(what.slice(3))); return true; }
  if (!/^\d+$/.test(what)) return true;
  const i = Number(what);
  const row = (WT.rows[pid] || [])[i];
  if (!row || WT.busy !== false || !worktreeRowView(row).canRemove) return true;
  WT.asking = i;
  worktreeRedraw(pid);
  return true;
}

if (typeof module !== 'undefined') module.exports = {WT, worktreeRowView, worktreeListHTML, worktreeAct, worktreeLoad};
