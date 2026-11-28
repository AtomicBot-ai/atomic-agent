/* ATO-2441: your own slash commands (`commit.md` gives /commit) and plugin
   commands in the / menu. The agent lists and renders them (GET /api/commands,
   POST /api/commands/render, src/http/route-commands.ts), the same code the
   terminal uses: shell lines run there, each one asking through the normal
   approval card, and nothing is sent when one is not allowed. Built-in
   commands and skills keep their names; a plugin command's short name
   (/review for /tools:review) is offered only when nothing else has it.
   Shared by the renderer and Node checks; no filesystem or permission policy. */
const OWN_COMMAND_SOURCE = {project: 'project', profile: 'profile', claude: '~/.claude', plugin: 'plugin'};
const OWN_COMMAND_NAME_RE = /^[a-z0-9._-]+(?::[a-z0-9._-]+)*$/;

/* Rows in the shape of the menu's SLASH table: [name, description, hint, aliases]. */
function ownCommandSlashRows(rows, builtins, skillNames) {
  const reserved = new Set((builtins || []).flatMap(row => [row[0], ...(row[3] || [])]).concat(skillNames || []));
  const seen = new Set();
  const valid = (rows || []).filter(r => r && typeof r.name === 'string' && r.name.length <= 128 && OWN_COMMAND_NAME_RE.test(r.name)
    && !reserved.has(r.name) && !seen.has(r.name) && seen.add(r.name));
  const taken = new Set([...reserved, ...valid.map(r => r.name)]);
  const shorts = new Map();
  valid.forEach(r => {
    if (r.source === 'plugin' && typeof r.command === 'string' && r.command !== r.name) shorts.set(r.command, (shorts.get(r.command) || 0) + 1);
  });
  return valid.map(r => {
    const alias = r.source === 'plugin' && shorts.get(r.command) === 1 && !taken.has(r.command) ? [r.command] : [];
    const hint = typeof r.argumentHint === 'string' && r.argumentHint ? r.argumentHint : (OWN_COMMAND_SOURCE[r.source] || '');
    return [r.name, typeof r.description === 'string' ? r.description : '', hint, alias];
  });
}

/* The command a typed `/word …` runs, by name or short name; null when it is not one of these. */
function ownCommandResolve(slashRows, word) {
  const key = String(word || '').toLowerCase();
  if (!key) return null;
  const row = (slashRows || []).find(r => r[0] === key || (r[3] || []).includes(key));
  return row ? row[0] : null;
}

/* The line under the menu when the folder has command files that wait for trust. */
function ownCommandsHiddenHint(count) {
  if (!(count > 0)) return '';
  return (count === 1 ? '1 command file in this folder waits' : count + ' command files in this folder wait')
    + ' until you trust the folder.';
}

/* `api.read(sessionId)` is BR.commandList, `api.render(body)` is BR.commandRender. */
function createOwnCommands(api) {
  const st = {rows: [], hidden: 0, key: null, supported: true, running: null};
  let serial = 0;
  async function refresh(key, sessionId) {
    const mine = ++serial;
    let res = null;
    try { res = await api.read(sessionId || null); } catch (e) { res = {ok: false, error: String(e)}; }
    if (mine !== serial) return;
    if (st.key !== key) { st.rows = []; st.hidden = 0; st.key = key; }
    if (res && res.supported === false) { st.supported = false; st.rows = []; st.hidden = 0; return; }
    if (res && res.ok && res.data) {
      st.supported = true;
      st.rows = Array.isArray(res.data.commands) ? res.data.commands : [];
      st.hidden = Number(res.data.hiddenProjectCommands) || 0;
    }
    // A failed read keeps what this folder listed before; another folder's rows were cleared above.
  }
  /* Only rows read for this chat and folder: never another chat's commands. */
  function slashRows(key, builtins, skillNames) {
    return st.key === key ? ownCommandSlashRows(st.rows, builtins, skillNames) : [];
  }
  function hint(key) { return st.key === key ? ownCommandsHiddenHint(st.hidden) : ''; }
  function row(name) { return st.rows.find(r => r && r.name === name) || null; }
  async function run(name, args, sessionId) {
    if (st.running) return {ok: false, why: '/' + st.running + ' is still running'};
    st.running = name;
    try {
      const body = {name};
      if (args) body.args = args;
      if (sessionId) body.sessionId = sessionId;
      let res = null;
      try { res = await api.render(body); } catch (e) { res = {ok: false, error: String((e && e.message) || e)}; }
      if (res && res.ok && res.data && typeof res.data.text === 'string' && res.data.text.trim()) return {ok: true, text: res.data.text};
      if (res && res.ok) return {ok: false, why: 'The command has no text to send'};
      return {ok: false, refused: !!(res && res.code === 'command_refused'), why: (res && res.error) || 'No answer from the agent'};
    } finally { st.running = null; }
  }
  return {state: st, refresh, slashRows, hint, row, run};
}

if (typeof module !== 'undefined') module.exports = {ownCommandSlashRows, ownCommandResolve, ownCommandsHiddenHint, createOwnCommands};
