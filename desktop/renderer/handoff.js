/* ---------------- ATO-1156: Continue from Claude Code / Codex ----------------
   Loaded before renderer.js; declares only. The pure half is shared with the
   Node checks (test/handoff.test.mjs); the renderer half reads renderer.js
   globals at call time, as chat-rename.js does.

   The hook (epic ATO-1014): "Claude Code hit its limit. My local agent
   picked up exactly where it stopped." The sheet lists the fresh sessions of
   Claude Code or Codex (`atag handoff --list`, main/handoff.ts); Continue
   saves the picked one as a NEW chat (`atag handoff --session <id> --json`),
   opens it, and puts the continuation message in the composer. Nothing is
   sent by itself: the person sees the carried history, picks the model and
   presses Enter.

   Opened from the palette ("Continue from Claude Code / Codex…") and from
   Settings › Import's header. */

const HANDOFF_AGENT_ROWS = [['claude-code', 'Claude Code'], ['codex', 'Codex']];

/** Last folder name of a path, for a row's subtitle. */
function handoffFolder(cwd) {
  if (!cwd) return '';
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(cwd);
}

/** One row's subtitle: folder · when · how long. */
function handoffRowMeta(row, rel) {
  const bits = [];
  const folder = handoffFolder(row.cwd);
  if (folder) bits.push(folder);
  if (row.mtimeMs) bits.push(rel(row.mtimeMs));
  if (row.messageCount) bits.push(row.messageCount + (row.messageCount === 1 ? ' message' : ' messages'));
  return bits.join(' · ');
}

/** What the toast says once the chat is open. */
function handoffDoneText(res, label) {
  const ctx = res && res.context;
  const fitted = ctx && ctx.compacted
    ? ' The older part of the history was summarised to fit the local model.'
    : '';
  return 'The message in the box asks the agent to pick the task up from ' + label + '. Choose the model and press Enter.' + fitted;
}

/* ---- renderer side (globals from renderer.js, read at call time) ---- */

const HANDOFF = {agent: 'claude-code', rows: null, sourceDir: '', loading: false, error: null, starting: null, seq: 0};

function handoffLabel(agent) {
  const row = HANDOFF_AGENT_ROWS.find(([id]) => id === agent);
  return row ? row[1] : 'Claude Code';
}

async function handoffLoad() {
  if (!BR || !BR.handoffList) { HANDOFF.error = 'This build cannot read Claude Code or Codex sessions.'; render(); return; }
  const seq = ++HANDOFF.seq;
  HANDOFF.loading = true; HANDOFF.error = null; HANDOFF.rows = null;
  render();
  const res = await BR.handoffList(HANDOFF.agent);
  if (seq !== HANDOFF.seq) return;   // the person switched the agent meanwhile
  HANDOFF.loading = false;
  if (!res || !res.ok) { HANDOFF.error = (res && res.error) || 'Could not read the sessions.'; render(); return; }
  HANDOFF.rows = res.sessions || [];
  HANDOFF.sourceDir = res.sourceDir || '';
  render();
}

function handoffSheetHTML() {
  const label = handoffLabel(HANDOFF.agent);
  let body = segControl(HANDOFF_AGENT_ROWS, HANDOFF.agent, 'handoff:agent:')
    + '<p class="sd-cap">Pick the session that stopped. It opens as a new chat with its history, ready to continue here.</p>';
  if (HANDOFF.error) body += '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(HANDOFF.error) + '</span></div>';
  if (HANDOFF.loading) {
    body += '<div class="tk-empty"><span class="tk-spin"></span><p>Reading ' + esc(label) + ' sessions…</p></div>';
  } else if (HANDOFF.rows) {
    const rows = HANDOFF.rows.map((row) => {
      const busy = HANDOFF.starting === row.id;
      return '<div class="row handoffrow">'
        + '<span class="main"><span class="t">' + esc(row.title || '(untitled)') + '</span>'
        + '<span class="s">' + esc(handoffRowMeta(row, relTime)) + '</span></span>'
        + '<button class="btn btn-p sm" data-act="handoff:go:' + esc(row.id) + '"' + (HANDOFF.starting ? ' disabled' : '') + '>'
        + (busy ? '<span class="tk-spin"></span>' : '') + 'Continue</button></div>';
    }).join('');
    body += '<div class="rows handoffrows">' + (rows || '<div class="sesempty">No ' + esc(label) + ' sessions'
      + (HANDOFF.sourceDir ? ' in ' + esc(HANDOFF.sourceDir) : '') + '.</div>') + '</div>';
  }
  return sheet('Continue from ' + label,
    body,
    '<button class="btn btn-g sm" data-act="handoff:refresh"' + (HANDOFF.loading ? ' disabled' : '') + '>' + ic('refresh') + 'Refresh</button>'
    + '<span class="grow"></span><button class="btn btn-s sm" data-act="close">Close</button>',
    'sheet-handoff');
}

async function handoffStartRow(id) {
  if (!BR || !BR.handoffStart || HANDOFF.starting) return;
  if (S.busy) { toast('A turn is running', 'Continue the task once it has finished.', 'bad'); return; }
  const agent = HANDOFF.agent;
  HANDOFF.starting = id; HANDOFF.error = null;
  render();
  const res = await BR.handoffStart(agent, id);
  HANDOFF.starting = null;
  if (!res || !res.ok) { HANDOFF.error = (res && res.error) || 'Could not continue this session.'; render(); return; }
  S.overlay = null;
  S.settings = null;   // opened from Settings › Import: the chat is where this lands
  await refreshSessions();
  await openSession(res.sessionId);
  // The draft is set once the chat is on screen, so the switch does not stash it with the chat left behind.
  S.draft = res.prompt;
  render();
  const entry = $('#entry');
  if (entry) { entry.value = res.prompt; autosize(entry); entry.focus(); }
  toast('Continued from ' + handoffLabel(agent), handoffDoneText(res, handoffLabel(agent)));
}

/** `handoff:<verb>` from act(): open · agent:<id> · go:<session id> · refresh. */
function handoffAct(v) {
  if (v === 'open') {
    S.overlay = 'handoff';
    HANDOFF.error = null;
    handoffLoad();
    return;
  }
  if (v === 'refresh') { handoffLoad(); return; }
  if (v.indexOf('agent:') === 0) {
    const agent = v.slice('agent:'.length);
    if (!HANDOFF_AGENT_ROWS.some(([id]) => id === agent) || agent === HANDOFF.agent) return;
    HANDOFF.agent = agent;
    handoffLoad();
    return;
  }
  if (v.indexOf('go:') === 0) { handoffStartRow(v.slice('go:'.length)); return; }
}

if (typeof module !== 'undefined') module.exports = {handoffFolder, handoffRowMeta, handoffDoneText, HANDOFF_AGENT_ROWS};
