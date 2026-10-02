/* ---------------- MCP tab: live server control (agent 0.6.6) ----------------
   Loaded BEFORE renderer.js, so it only declares: everything it touches
   (BR, MCP, esc, ic, render, mcpRefresh, mcpServers) is read when a
   function runs, never at load time.

   POST /api/mcp/servers/{name}/restart|enable|disable act on the running
   agent and answer that server's McpServerStatus ({name, state, ts,
   lastError?, toolCount?}). There is still no route that lists every
   server's status, so a row shows a live state only once an action has
   reported it; until then it keeps the honest "state —" chip.
   enable / disable also persist `enabled` in config.json, which the next
   refresh reads back. */

const MCP_LIVE = {status:{}, busy:null};

const MCP_STATE_WORDS = {up:'running', starting:'starting', down:'failed', disabled:'disabled'};

/* The row's state chip: the config's `enabled:false` first, then the last
   status an action reported, else the unknown state. */
function mcpStateChipHTML(name, cfgState) {
  if (MCP_LIVE.busy === name) return '<span class="tk-chip tk-chip--sm tk-chip--line" title="Working"><span class="tk-spin"></span>working</span>';
  if (cfgState === 'disabled') return '<span class="tk-chip tk-chip--sm tk-chip--line" title="Disabled in config.json">disabled</span>';
  const st = MCP_LIVE.status[name];
  if (!st || st.state === 'disabled') return '<span class="tk-chip tk-chip--sm tk-chip--line" title="Unknown until the server is restarted here">state —</span>';
  const cls = st.state === 'up' ? 'tk-chip--green' : st.state === 'down' ? 'tk-chip--red' : 'tk-chip--blue';
  const when = st.ts ? ' · as of ' + new Date(st.ts).toLocaleTimeString() : '';
  const title = (st.state === 'down' && st.lastError ? st.lastError : MCP_STATE_WORDS[st.state] || st.state) + when;
  return '<span class="tk-chip tk-chip--sm ' + cls + '" title="' + esc(title) + '">' + esc(MCP_STATE_WORDS[st.state] || st.state) + '</span>';
}

/* The row's own controls: Restart (enabled servers only) and the enable
   switch. Spans, because the row itself is the button that opens the
   detail; the click handler resolves the innermost [data-act]. */
function mcpRowControlsHTML(name, enabled) {
  const busy = MCP_LIVE.busy !== null;
  return (enabled
      ? '<span class="iconbtn sm" role="button" data-act="mcp:restart:' + esc(name) + '" title="Restart (R)" aria-label="Restart ' + esc(name) + '"' + (busy ? ' aria-disabled="true"' : '') + '>' + ic('refresh') + '</span>'
      : '')
    + '<span class="tk-switch' + (enabled ? ' on' : '') + '" role="switch" aria-checked="' + enabled + '" aria-label="' + (enabled ? 'Disable ' : 'Enable ') + esc(name) + '" title="Turn ' + (enabled ? 'off' : 'on') + ' (e)" data-act="mcp:toggle:' + esc(name) + '"' + (busy ? ' aria-disabled="true"' : '') + '></span>';
}

/* The detail header's controls: the same two, as real buttons. */
function mcpDetailControlsHTML(name, enabled) {
  const busy = MCP_LIVE.busy !== null;
  return (enabled ? '<button class="btn btn-s sm" data-act="mcp:restart:' + esc(name) + '" title="Restart (R)"' + (busy ? ' disabled' : '') + '>' + ic('refresh') + 'Restart</button>' : '')
    + '<button class="tk-switch' + (enabled ? ' on' : '') + '" role="switch" aria-checked="' + enabled + '" aria-label="' + (enabled ? 'Disable ' : 'Enable ') + esc(name) + '" title="Turn ' + (enabled ? 'off' : 'on') + ' (e)" data-act="mcp:toggle:' + esc(name) + '"' + (busy ? ' disabled' : '') + '></button>';
}

/* One line saying what the action did, from the status the agent answered. */
function mcpLiveSummary(name, op, st) {
  if (op === 'disable') return name + ' is off. The agent no longer uses its tools.';
  if (!st) return name + ': the agent did not report a state.';
  if (st.state === 'up') {
    const n = typeof st.toolCount === 'number' ? st.toolCount : null;
    return name + ' is running' + (n === null ? '.' : ' with ' + n + (n === 1 ? ' tool.' : ' tools.'));
  }
  if (st.state === 'down') return name + ' failed to start' + (st.lastError ? ': ' + st.lastError : '.');
  if (st.state === 'starting') return name + ' is starting.';
  return name + ': ' + (MCP_STATE_WORDS[st.state] || st.state) + '.';
}

/* `op` is restart | enable | disable | toggle. The toggle reads the
   config's `enabled` for the named server. */
async function mcpLiveAct(op, name) {
  if (!BR || !name || MCP_LIVE.busy !== null) return {ok:false, error:'busy'};
  if (!BR.mcpServer) { MCP.lastError = 'This build cannot control MCP servers.'; render(); return {ok:false, error:MCP.lastError}; }
  const cfg = mcpServers().find((s) => s && s.name === name);
  if (!cfg) { MCP.lastError = 'Server ' + JSON.stringify(name) + ' is not in config.'; render(); return {ok:false, error:MCP.lastError}; }
  if (op === 'toggle') op = cfg.enabled === false ? 'enable' : 'disable';
  if (op === 'restart' && cfg.enabled === false) { MCP.msg = {text:name + ' is off. Turn it on first.'}; render(); return {ok:false, error:'disabled'}; }
  MCP_LIVE.busy = name; MCP.lastError = null; MCP.msg = null; render();
  if (typeof ANX !== 'undefined') ANX.mcpAction(op);   // analytics: the verb only, never the server name
  let res;
  try { res = await BR.mcpServer(name, op); } finally { MCP_LIVE.busy = null; }
  if (!res || !res.ok) {
    const why = (res && res.error) || 'unknown error';
    MCP.lastError = res && res.unsupported
      ? 'This agent cannot ' + op + ' MCP servers. Update Atomic Agent.'
      // route-mcp.ts reads the agent's loaded config: a server written to the
      // file behind its back (a CLI write) is unknown to it until a restart.
      : /not found in config\.mcp\.servers/.test(why)
        ? 'The agent has not loaded ' + name + ' yet. Restart Atomic Agent, then try again.'
        : 'Could not ' + op + ' ' + name + ': ' + why;
    render();
    return {ok:false, error:MCP.lastError};
  }
  const st = res.data && typeof res.data === 'object' ? res.data : null;
  if (st) MCP_LIVE.status[name] = st; else delete MCP_LIVE.status[name];
  MCP.msg = {text:mcpLiveSummary(name, op, st)};
  await mcpRefresh(); // enable/disable rewrote config.json; the tool count moved with the connection
  return {ok:true, status:st};
}

if (typeof window !== 'undefined') {
  // --smoke: the live controls and the status they cached.
  window.__mcpLive = () => ({busy:MCP_LIVE.busy, status:Object.assign({}, MCP_LIVE.status)});
  window.__mcpLiveAct = (op, name) => mcpLiveAct(op, name);
}
