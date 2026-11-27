/* ---------------- ATO-1173: worker chats ----------------
   Loaded before renderer.js; declares only, and reads renderer.js globals at
   call time, as chat-projects.js does. The pure half is shared with the Node
   checks (test/project-workers-ui.test.mjs).

   A chat in a project (the coordinator) splits a big task into up to three
   worker chats. "Split into worker chats…" on the chat's row menu opens a
   sheet with three task boxes; Start asks main (projects:startWorkers,
   main/project-workers-ipc.ts) to make a copy of the project folder per task
   (a git worktree, or a copy of a folder with no git), a new chat per copy,
   filed in the project, and to start its first turn. The window takes those
   turns over as turns of chats it is not showing (adoptLiveTurns), so they
   stream in the background while the person stays where they are.

   Each worker's row carries a badge: working, waiting (an approval is open),
   done, failed or stopped. When the last worker of a split ends, main sends
   the coordinator's report (each worker's closing summary and its folder),
   and it goes into the coordinator chat's message box: at once if that chat
   is on screen with an empty box, else when it is opened next. Nothing is
   sent by itself.

   The precedent: Cursor's background agents, Conductor and Claude Code's
   parallel sessions, each agent in its own worktree. */

const PWORKERS_MAX = 3;
const PWORKERS = {groups: [], loaded: false, sheet: null, reports: new Map(), owed: new Map()};

/** The group and worker record of chat `sid`, or null. */
function pworkersFind(groups, sid) {
  for (const g of groups || []) {
    const w = (g.workers || []).find((x) => x.sid === sid);
    if (w) return {group: g, worker: w};
  }
  return null;
}

/** The newest group a coordinator chat started, or null (groups are newest first). */
function pworkersGroupOf(groups, coordinatorSid) {
  return (groups || []).find((g) => g.coordinatorSid === coordinatorSid) || null;
}

/** A worker's badge word: live state first (the turn runs, an approval is open), then what main recorded. */
function workerBadgeState(recorded, running, waiting) {
  if (waiting) return 'waiting';
  if (running) return 'working';
  if (recorded === 'done' || recorded === 'failed' || recorded === 'stopped') return recorded;
  return recorded === 'working' ? 'working' : 'stopped';
}

/** What a turn's last frame means for its worker. */
function workerEndStatus(kind) {
  if (kind === 'done') return 'done';
  if (kind === 'aborted') return 'stopped';
  return 'failed';
}

/** "1/3 workers" on the coordinator's row: how many have ended. */
function coordinatorBadgeText(group) {
  const ws = (group && group.workers) || [];
  const ended = ws.filter((w) => w.status && w.status !== 'working').length;
  return ended + '/' + ws.length + ' workers';
}

/** The tasks the sheet sends: trimmed, the empty boxes dropped. */
function pworkersTasks(boxes) {
  return (boxes || []).map((t) => String(t || '').trim()).filter(Boolean).slice(0, PWORKERS_MAX);
}

/** ATO-2744: a failed start as {text, hint, detail}. Git's known refusals in words (human-error.js
    herrGitWorktree), main's sentence otherwise; the raw words, worker number and kept copies under Details. */
function pworkersError(res) {
  const generic = "The worker chats didn't start. Try again.";
  if (!res) return {text: generic, hint: '', detail: ''};
  const detail = String(res.detail || '');
  const known = res.reason === 'git' && typeof herrGitWorktree === 'function' ? herrGitWorktree(detail) : null;
  const kept = Number(res.kept) > 0
    ? (Number(res.kept) === 1 ? 'One worker copy was' : Number(res.kept) + ' worker copies were') + ' already made and kept.'
    : '';
  return {text: (known && known.text) || String(res.error || '') || generic, hint: kept, detail};
}

/* ---- renderer side (globals from renderer.js, read at call time) ---- */

function pworkersApi() {
  if (typeof BR === 'undefined' || !BR || typeof BR.projectsStartWorkers !== 'function') return null;
  return BR;
}

function pworkersRunning(sid) {
  if (typeof RUNNING === 'undefined') return false;
  for (const v of RUNNING.values()) if (v === sid) return true;
  return false;
}

/** The project a chat is in, when it has a folder on disk (only those can be copied), else null. */
function pworkersProjectOf(sid) {
  if (typeof PROJECTS === 'undefined' || typeof projectOf !== 'function' || typeof chatById !== 'function') return null;
  const p = projectOf(PROJECTS.state, chatById(sid), typeof homeDir === 'function' ? homeDir() : '');
  return p && p.folder && String(p.id || '')[0] === 'p' ? p : null;
}

/** Whether the row menu offers "Split into worker chats…" for chat `sid`. */
function pworkersCanSplit(sid) {
  if (!sid || !pworkersApi()) return false;
  if (typeof SESSIONS === 'undefined' || !SESSIONS.some((s) => s.id === sid)) return false;   // a stored chat only
  if (pworkersFind(PWORKERS.groups, sid)) return false;   // a worker does not split again (no nesting in this slice)
  return !!pworkersProjectOf(sid);
}

/** The badge on a chat row: a worker's state, or a coordinator's count. '' for any other chat. */
function workerBadgeHTML(sid) {
  const found = pworkersFind(PWORKERS.groups, sid);
  if (found) {
    const waiting = typeof PENDING_APPROVALS !== 'undefined' && PENDING_APPROVALS.has(sid);
    const st = workerBadgeState(found.worker.status, pworkersRunning(sid), waiting);
    return '<span class="pw-badge pw-' + st + '" title="' + esc('Worker chat · ' + st + ' · ' + found.worker.dir) + '">' + st + '</span>';
  }
  const g = pworkersGroupOf(PWORKERS.groups, sid);
  if (!g) return '';
  return '<span class="pw-badge" title="Coordinator of these worker chats">' + esc(coordinatorBadgeText(g)) + '</span>';
}

function pworkersPutGroup(group) {
  if (!group || !group.id || !Array.isArray(group.workers)) return;
  const i = PWORKERS.groups.findIndex((g) => g.id === group.id);
  if (i >= 0) PWORKERS.groups[i] = group; else PWORKERS.groups.unshift(group);
}

async function pworkersLoad() {
  const api = pworkersApi();
  if (!api || typeof api.projectsWorkers !== 'function') return;
  let res = null;
  try { res = await api.projectsWorkers(); } catch (e) { res = null; }
  if (!res || res.ok === false || !res.data || !Array.isArray(res.data.groups)) return;
  PWORKERS.groups = res.data.groups;
  for (const g of PWORKERS.groups) if (g.report) PWORKERS.reports.set(g.id, g.report);
  PWORKERS.loaded = true;
  if (typeof renderSidebar === 'function') renderSidebar();
}

/** Main started worker turns: take them over as background turns, and say what they are. */
function pworkersTakeTurns(payload) {
  if (!payload || !Array.isArray(payload.turns)) return;
  pworkersPutGroup(payload.group);
  if (typeof adoptLiveTurns === 'function') adoptLiveTurns(payload.turns);
  for (const t of payload.turns) {
    const rec = typeof LIVE_TURNS !== 'undefined' ? LIVE_TURNS.get(t.turnId) : null;
    const note = rec && rec.log ? rec.log.find((r) => r.k === 'system') : null;
    // adoptLiveTurns' line is for a window opened mid-turn; this one was started from here.
    if (note) note.text = 'Worker chat. It works in its own copy of the project: ' + t.dir;
  }
  if (typeof renderSidebar === 'function') renderSidebar();
}

/** renderer.js onChatEvent: a turn of chat `sid` ended (done / aborted / error). */
function workerTurnEnded(sid, kind) {
  const found = pworkersFind(PWORKERS.groups, sid);
  if (!found || found.worker.status !== 'working') return;
  found.worker.status = workerEndStatus(kind);   // main's own record follows (projects:workersChanged)
  if (typeof renderSidebar === 'function') renderSidebar();
}

/** Put `text` into the composer of the chat on screen, when its box is empty. */
function pworkersFill(text) {
  const e = typeof $ === 'function' ? $('#entry') : null;
  if (String((e ? e.value : S.draft) || '').trim()) return false;
  S.draft = typeof attToEditor === 'function' ? attToEditor(text) : text;
  if (e) { e.value = S.draft; if (typeof autosize === 'function') autosize(e); e.focus(); }
  if (typeof refreshSend === 'function') refreshSend();
  if (typeof ctxDraftChanged === 'function') ctxDraftChanged();
  return true;
}

function pworkersDeliver(coordinatorSid, groupId) {
  const text = PWORKERS.reports.get(groupId);
  if (!text) return;
  if (S.sessionId === coordinatorSid && S.room === 'chat' && pworkersFill(text)) {
    toast('Worker chats finished', 'Their results are in the message box. Edit them or press Enter.');
    return;
  }
  PWORKERS.owed.set(coordinatorSid, groupId);
  const c = typeof chatById === 'function' ? chatById(coordinatorSid) : null;
  toast('Worker chats finished', 'Their results wait in the message box of ' + (c && c.t ? '“' + c.t + '”' : 'the chat that started them') + '.');
}

/** renderer.js openSession: a report owed to this chat goes into its box now. */
function pworkersStashBack(sid) {
  const groupId = PWORKERS.owed.get(sid);
  if (!groupId) return;
  const text = PWORKERS.reports.get(groupId);
  if (text && pworkersFill(text)) PWORKERS.owed.delete(sid);
}

function pworkersChanged(payload) {
  if (!payload || !payload.group) return;
  pworkersPutGroup(payload.group);
  if (typeof payload.report === 'string' && payload.report) {
    PWORKERS.reports.set(payload.group.id, payload.report);
    pworkersDeliver(payload.group.coordinatorSid, payload.group.id);
  }
  if (typeof renderSidebar === 'function') renderSidebar();
}

if (typeof window !== 'undefined') {
  setTimeout(() => {
    const api = pworkersApi();
    if (!api) return;
    if (typeof api.onWorkersStarted === 'function') api.onWorkersStarted(pworkersTakeTurns);
    if (typeof api.onWorkersChanged === 'function') api.onWorkersChanged(pworkersChanged);
    pworkersLoad();
  }, 0);
}

/* ---- the sheet (S.overlay === 'pworkers') ---- */

function pworkersOpen(sid) {
  const p = pworkersProjectOf(sid);
  if (!p) { toast('Not in a project with a folder', 'Worker chats copy the project folder, so the chat has to be in one.', 'bad'); return; }
  PWORKERS.sheet = {coordinatorSid: sid, projectId: p.id, projectName: p.name, folder: p.folder, tasks: ['', '', ''], error: null, starting: false};
  S.overlay = 'pworkers';
  render();
  const f = typeof document !== 'undefined' && document.getElementById('pw-task-0');
  if (f) f.focus();
}

async function pworkersStart() {
  const sh = PWORKERS.sheet, api = pworkersApi();
  if (!sh || !api || sh.starting) return;
  const tasks = pworkersTasks(sh.tasks);
  if (!tasks.length) { sh.error = 'Write at least one task'; render(); return; }
  sh.starting = true; sh.error = null;
  render();
  let res = null;
  try { res = await api.projectsStartWorkers({coordinatorSid: sh.coordinatorSid, projectId: sh.projectId, tasks}); } catch (e) { res = {ok: false, error: '', detail: String((e && e.message) || e)}; }
  if (PWORKERS.sheet !== sh) return;   // closed meanwhile; main still started them, and its event brought them in
  sh.starting = false;
  if (!res || !res.ok) { sh.error = pworkersError(res); render(); return; }
  pworkersTakeTurns(res);
  PWORKERS.sheet = null;
  if (S.overlay === 'pworkers') S.overlay = null;
  render();
  toast(tasks.length + (tasks.length === 1 ? ' worker chat started' : ' worker chats started'), 'They run in ' + sh.projectName + ' while you stay here. Their results come back to this chat.');
}

function pworkersSheetHTML() {
  const sh = PWORKERS.sheet;
  if (!sh) return '';
  let body = '<p class="sd-cap">Each task runs in its own new chat, in its own copy of <b title="' + esc(sh.folder) + '">' + esc(herrBase(sh.folder)) + '</b>: a git worktree of the last commit'
    + ' (uncommitted changes are not in it), or a plain copy for a folder without git. Your folder is not touched.'
    + ' When all of them finish, their summaries go into this chat\'s message box.</p>';
  for (let i = 0; i < PWORKERS_MAX; i++) {
    body += '<textarea id="pw-task-' + i + '" class="pw-task" rows="3" maxlength="4000" placeholder="' + esc('Task ' + (i + 1) + (i ? ' (optional)' : '')) + '"'
      + (sh.starting ? ' disabled' : '') + '>' + esc(sh.tasks[i] || '') + '</textarea>';
  }
  const last = pworkersGroupOf(PWORKERS.groups, sh.coordinatorSid);
  if (last) {
    body += '<div class="pw-last"><span class="sd-cap">Last split: ' + esc(coordinatorBadgeText(last)) + '</span><ul>'
      + last.workers.map((w) => '<li title="' + esc(w.dir) + '">' + esc(w.status + ' · ' + String(w.task).split('\n')[0].slice(0, 80)) + '</li>').join('')
      + '</ul>' + (PWORKERS.reports.has(last.id) ? '<button class="btn btn-g sm" data-act="pwfill:' + esc(last.id) + '">Put its results in the box</button>' : '') + '</div>';
  }
  if (sh.error) body += herrNoticeHTML(sh.error, {icon: ic('alert')});
  return sheet('Split into worker chats', body,
    '<span class="grow"></span><button class="btn btn-s sm" data-act="close">Cancel</button>'
    + '<button class="btn btn-p sm" data-act="pwstart:"' + (sh.starting ? ' disabled' : '') + '>' + (sh.starting ? '<span class="tk-spin"></span>' : '') + 'Start</button>',
    'sheet-pworkers');
}

if (typeof document !== 'undefined') {
  document.addEventListener('input', (ev) => {
    const sh = PWORKERS.sheet, t = ev.target;
    if (!sh || !t || typeof t.id !== 'string') return;
    const m = /^pw-task-(\d)$/.exec(t.id);
    if (m) sh.tasks[Number(m[1])] = t.value;
  });
}

/** The act verbs this file owns: pworkers:<chat id> opens the sheet, pwstart: starts, pwfill:<group id> fills the box. */
function pworkersAct(k, v) {
  if (k === 'pworkers') { pworkersOpen(v); return true; }
  if (k === 'pwstart') { pworkersStart(); return true; }
  if (k === 'pwfill') {
    const sh = PWORKERS.sheet, text = PWORKERS.reports.get(v);
    if (!sh || !text) return true;
    PWORKERS.sheet = null;
    if (S.overlay === 'pworkers') S.overlay = null;
    render();
    if (S.sessionId !== sh.coordinatorSid) {
      // Opening the chat puts it in the box (openSession's pworkersStashBack).
      PWORKERS.owed.set(sh.coordinatorSid, v);
      if (typeof openSession === 'function') openSession(sh.coordinatorSid);
    } else if (!pworkersFill(text)) toast('The message box is not empty', 'Send or clear what is there, then try again.', 'bad');
    return true;
  }
  return false;
}

if (typeof module !== 'undefined') module.exports = {PWORKERS, PWORKERS_MAX, pworkersFind, pworkersGroupOf, workerBadgeState, workerEndStatus,
  coordinatorBadgeText, pworkersTasks, pworkersError, workerBadgeHTML, workerTurnEnded, pworkersAct, pworkersCanSplit, pworkersChanged, pworkersStashBack};
