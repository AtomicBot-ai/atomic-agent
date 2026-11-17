/* ---------------- ATO-1157: Agents, who is waiting for you ----------------
   Loaded before renderer.js; declares only. The pure half is shared with the
   Node checks (test/agent-hub.test.mjs); the renderer half reads renderer.js
   and handoff.js globals at call time, as handoff.js does.

   The sheet lists the person's Claude Code and Codex sessions of the last
   day (`hub:scan`, main/agent-hub-scan.ts), in three groups: the ones
   waiting for them (a tool call to approve, a reply to answer, a limit hit),
   the ones running, and the rest. Each row can be continued here (the
   existing "Continue from Claude Code / Codex" path, handoff.js) or opened
   in Terminal with the agent's own resume command typed, not run
   (terminal-open, macOS only).

   Opened from the palette ("Agents: who is waiting for you") and from the
   handoff sheet's footer. */

const HUB_AGENT_LABELS = {'claude-code': 'Claude Code', codex: 'Codex'};
const HUB_GROUPS = [['waiting', 'Waiting for you'], ['running', 'Running'], ['idle', 'Recent']];
/** Ids main hands out; anything else never reaches a command line. */
const HUB_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const HUB_TERMINAL_PLATFORMS = ['darwin'];

function hubEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

/** Last folder name of a path. */
function hubFolder(cwd) {
  if (!cwd) return '';
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(cwd);
}

/** A row's group; an unknown state reads as idle. */
function hubStateOf(row) {
  return HUB_GROUPS.some(([s]) => s === row.state) ? row.state : 'idle';
}

/** Rows split by state, in the sheet's order; each group keeps newest first. */
function hubGroupRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return HUB_GROUPS.map(([state, label]) => ({
    state, label,
    rows: list.filter((r) => r && hubStateOf(r) === state)
      .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0)),
  })).filter((g) => g.rows.length);
}

/** The same dot grammar as the task rows: amber waits on you, brand pulses while it runs. */
function hubDotClass(row) {
  if (row && row.state === 'waiting') return /error|limit/.test(row.reason || '') ? 'tk-dot tk-dot--red' : 'tk-dot tk-dot--amber';
  if (row && row.state === 'running') return 'tk-dot tk-dot--brand tk-dot--pulse';
  return 'tk-dot tk-dot--hollow';
}

/** The agent's own resume command for a row, or '' when its id is not one we trust on a command line. */
function hubResumeCommand(row) {
  const id = row && row.resumeId;
  if (!id || !HUB_SAFE_ID.test(id)) return '';
  if (row.agent === 'claude-code') return 'claude --resume ' + id;
  if (row.agent === 'codex') return 'codex resume ' + id;
  return '';
}

function hubRowMeta(row, rel) {
  const bits = [HUB_AGENT_LABELS[row.agent] || 'Agent'];
  if (row.reason) bits.push(row.reason);
  const folder = hubFolder(row.cwd);
  if (folder) bits.push(folder);
  if (row.mtimeMs && typeof rel === 'function') bits.push(rel(row.mtimeMs));
  return bits.join(' · ');
}

/** One row. `o`: {rel, terminalOk, starting} — starting is the "<agent>:<id>" being continued. */
function hubRowHTML(row, o) {
  const opts = o || {};
  const key = row.agent + ':' + row.id;
  const busy = opts.starting === key;
  const term = opts.terminalOk && hubResumeCommand(row)
    ? '<button class="btn btn-g sm" data-act="hub:term:' + hubEsc(key) + '" title="' + hubEsc(hubResumeCommand(row)) + '">Open in Terminal</button>'
    : '';
  return '<div class="row hubrow"><i class="' + hubDotClass(row) + '"></i>'
    + '<span class="main"><span class="t">' + hubEsc(row.title || '(untitled)') + '</span>'
    + '<span class="s">' + hubEsc(hubRowMeta(row, opts.rel)) + '</span></span>'
    + term
    + '<button class="btn btn-p sm" data-act="hub:go:' + hubEsc(key) + '"' + (opts.starting ? ' disabled' : '') + '>'
    + (busy ? '<span class="tk-spin"></span>' : '') + 'Continue here</button></div>';
}

/** The sheet's body below any notice: the groups, or the empty line. */
function hubListHTML(rows, o) {
  const groups = hubGroupRows(rows);
  if (!groups.length) return '<div class="sesempty">No Claude Code or Codex sessions in the last 24 hours.</div>';
  return groups.map((g) => '<div class="hubgroup"><div class="hubgroup-h">' + hubEsc(g.label)
    + ' <span class="hubgroup-n">' + g.rows.length + '</span></div>'
    + '<div class="rows handoffrows">' + g.rows.map((r) => hubRowHTML(r, o)).join('') + '</div></div>').join('');
}

/* ---- renderer side (globals from renderer.js and handoff.js, read at call time) ---- */

const AG_HUB = {rows: null, loading: false, error: null, starting: null, seq: 0};

async function hubLoad() {
  if (!BR || typeof BR.hubScan !== 'function') { AG_HUB.error = 'This build cannot list Claude Code or Codex sessions.'; render(); return; }
  const seq = ++AG_HUB.seq;
  AG_HUB.loading = true; AG_HUB.error = null;
  render();
  let res = null;
  try { res = await BR.hubScan(); } catch { res = null; }
  if (seq !== AG_HUB.seq) return;
  AG_HUB.loading = false;
  if (!res || !res.ok) { AG_HUB.error = (res && res.message) || 'Could not read the sessions.'; AG_HUB.rows = res && res.reason === 'remote' ? [] : AG_HUB.rows; render(); return; }
  AG_HUB.rows = Array.isArray(res.sessions) ? res.sessions : [];
  render();
}

function hubTerminalOk() {
  return HUB_TERMINAL_PLATFORMS.includes(PLATFORM) && !!(BR && typeof BR.terminalOpenWithCommand === 'function');
}

function hubSheetHTML() {
  let body = '<p class="sd-cap">Your Claude Code and Codex sessions from the last day. Continue one here, or open it in Terminal.</p>';
  if (AG_HUB.error) body += '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(AG_HUB.error) + '</span></div>';
  if (AG_HUB.loading && !AG_HUB.rows) body += '<div class="tk-empty"><span class="tk-spin"></span><p>Reading sessions…</p></div>';
  else if (AG_HUB.rows) body += hubListHTML(AG_HUB.rows, {rel: relTime, terminalOk: hubTerminalOk(), starting: AG_HUB.starting});
  return sheet('Agents', body,
    '<button class="btn btn-g sm" data-act="hub:refresh"' + (AG_HUB.loading ? ' disabled' : '') + '>' + ic('refresh') + 'Refresh</button>'
    + '<span class="grow"></span><button class="btn btn-s sm" data-act="close">Close</button>',
    'sheet-handoff sheet-hub');
}

function hubFind(key) {
  const i = key.indexOf(':');
  if (i < 0) return null;
  const agent = key.slice(0, i), id = key.slice(i + 1);
  return (AG_HUB.rows || []).find((r) => r.agent === agent && r.id === id) || null;
}

/** Continue here: the handoff sheet's own start, for this row's agent. */
async function hubContinue(row) {
  if (typeof handoffStartRow !== 'function' || typeof HANDOFF === 'undefined' || AG_HUB.starting) return;
  HANDOFF.agent = row.agent;
  HANDOFF.error = null;
  AG_HUB.starting = row.agent + ':' + row.id; AG_HUB.error = null;
  render();
  try { await handoffStartRow(row.id); } finally { AG_HUB.starting = null; }
  if (HANDOFF.error) AG_HUB.error = HANDOFF.error;
  render();
}

function hubOpenTerminal(row) {
  const command = hubResumeCommand(row);
  const fail = (why) => toast("Couldn't open Terminal", typeof why === 'string' ? why : '', 'bad');
  if (!command || !hubTerminalOk()) { fail(); return; }
  Promise.resolve().then(() => BR.terminalOpenWithCommand({command, cwd: row.cwd || null}))
    .then((r) => { if (!r || r.ok !== true) fail(r && r.message); }, () => fail());
}

/** `hub:<verb>` from act(): open · refresh · go:<agent>:<id> · term:<agent>:<id>. */
function hubAct(v) {
  if (v === 'open') { S.overlay = 'hub'; AG_HUB.error = null; hubLoad(); return; }
  if (v === 'refresh') { hubLoad(); return; }
  if (v.indexOf('go:') === 0) { const row = hubFind(v.slice(3)); if (row) hubContinue(row); return; }
  if (v.indexOf('term:') === 0) { const row = hubFind(v.slice(5)); if (row) hubOpenTerminal(row); return; }
}

if (typeof module !== 'undefined') module.exports = {hubEsc, hubFolder, hubGroupRows, hubDotClass, hubResumeCommand, hubRowMeta, hubRowHTML, hubListHTML, HUB_GROUPS};
