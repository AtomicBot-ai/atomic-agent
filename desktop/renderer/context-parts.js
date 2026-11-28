/* ATO-2453: what each row of the context popover is made of, and the one tip.
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/context-parts.test.mjs).

   The agent already measures it: the session row's contextUsage and the
   /api/context-preview reply both carry `parts` (prompt scaffold sections,
   built-in tools, one row per MCP server, the native tool schemas by server)
   and, on an MCP server's part, `tools` (one row per tool, biggest first).
   This file only lays those rows out. Ports of the terminal panel:
   src/tui/context/context-panel-body.ts (rows, the fold of a long tool list)
   and src/tui/context/context-hint.ts (the tip, same thresholds). */

/* Same thresholds as the terminal (context-hint.ts HINT_WINDOW_MAX, HINT_SHARE):
   only a window of 64k or less gets a tip, and only for a part over 10% of it. */
const CTX_HINT_WINDOW_MAX = 65536;
const CTX_HINT_SHARE = 0.1;
/* prompt-part-shares.ts BUILTIN_TOOLS_PART. */
const CTX_BUILTIN_PART = 'built-in tools';
/* Tools listed under an open server before the rest fold into "+N more". */
const CTX_TOOLS_SHOWN = 8;

/* The MCP servers whose tools are listed. Kept for the app run, like the
   terminal's open panel; a click on the server's row flips it. */
const CTX_OPEN_SERVERS = new Set();

function ctxToggleServer(server) {
  const key = String(server || '');
  if (!key) return false;
  if (CTX_OPEN_SERVERS.has(key)) CTX_OPEN_SERVERS.delete(key);
  else CTX_OPEN_SERVERS.add(key);
  return CTX_OPEN_SERVERS.has(key);
}

/* The parts of one section row, in the order the agent measured them. */
function ctxPartsOf(parts, parent) {
  return (Array.isArray(parts) ? parts : []).filter((p) => p && p.parent === parent && p.tokens > 0);
}

/* What the row says: "MCP github" for a server, the agent's own label otherwise. */
function ctxPartLabel(part) {
  return part.mcpServer ? 'MCP ' + part.mcpServer : String(part.label || '');
}

/* A server's tool rows: the biggest CTX_TOOLS_SHOWN, then one row for the
   rest so the rows still add up to the server's figure. Folding one tool
   into "+1 more" saves no line, so it is listed instead. */
function ctxToolRows(part, limit = CTX_TOOLS_SHOWN) {
  const tools = Array.isArray(part && part.tools) ? part.tools.filter((t) => t && t.tokens > 0) : [];
  const shown = tools.length <= limit + 1 ? tools : tools.slice(0, limit);
  const rows = shown.map((t) => ({label: String(t.label || ''), tokens: t.tokens}));
  const rest = tools.slice(shown.length);
  if (rest.length) rows.push({label: '+' + rest.length + ' more', tokens: rest.reduce((a, t) => a + t.tokens, 0), more: true});
  return rows;
}

/* The <dt>/<dd> pairs under one section row of the popover's kvgrid.
   `h` = {esc, fmt}: the renderer's escaper and token formatter, so every
   label (an MCP server's name, a tool's name) is escaped before it is HTML. */
function ctxPartRowsHTML(parts, parent, h) {
  let out = '';
  for (const part of ctxPartsOf(parts, parent)) {
    const value = '<dd class="mono tnum ter">' + h.esc(h.fmt(part.tokens)) + '</dd>';
    const tools = ctxToolRows(part);
    if (!part.mcpServer || !tools.length) {
      out += '<dt class="ter ctxpart">' + h.esc(ctxPartLabel(part)) + '</dt>' + value;
      continue;
    }
    const open = CTX_OPEN_SERVERS.has(part.mcpServer);
    const tip = (open ? 'Hide' : 'Show') + ' the tools of ' + part.mcpServer;
    out += '<dt class="ter ctxpart"><button type="button" class="ctxexp" data-ctx-expand="' + h.esc(part.mcpServer)
      + '" aria-expanded="' + open + '" title="' + h.esc(tip) + '">'
      + '<span class="ctxcaret" aria-hidden="true">' + (open ? '▾' : '▸') + '</span>'
      + h.esc(ctxPartLabel(part)) + '<span class="ctxcount">' + h.esc(String(part.tools.length)) + ' tools</span></button></dt>' + value;
    if (!open) continue;
    for (const tool of tools) {
      out += '<dt class="ter ctxtool' + (tool.more ? ' ctxmore' : '') + '">' + h.esc(tool.label) + '</dt>'
        + '<dd class="mono tnum ter">' + h.esc(h.fmt(tool.tokens)) + '</dd>';
    }
  }
  return out;
}

/* The tip, as two short sentences, or null when nothing is big enough to
   mention. Same choice as the terminal: the biggest MCP server first (the one
   cost the user added and can take away in one step), then the built-in
   tools while tool search is off. The words name the app's own places, not
   config keys. */
function ctxHint(parts, win, toolSearchActive) {
  if (!(win > 0) || win > CTX_HINT_WINDOW_MAX) return null;
  const threshold = win * CTX_HINT_SHARE;
  const byServer = new Map();
  let builtin = 0;
  for (const p of Array.isArray(parts) ? parts : []) {
    if (!p || !(p.tokens > 0)) continue;
    if (p.mcpServer) byServer.set(p.mcpServer, (byServer.get(p.mcpServer) || 0) + p.tokens);
    else if (p.label === CTX_BUILTIN_PART) builtin += p.tokens;
  }
  let server = null, serverTokens = 0;
  for (const [name, tokens] of byServer) if (tokens > serverTokens) { server = name; serverTokens = tokens; }
  const share = (n) => Math.round(n / win * 100);
  const where = 'Settings › Connections › MCP servers';
  const search = 'Settings › Diagnostics › All settings';
  if (server !== null && serverTokens > threshold) {
    return ['Tip: the MCP server ' + server + ' takes ' + share(serverTokens) + '% of the window.',
      toolSearchActive
        ? 'Turn it off in ' + where + ' to free it.'
        : 'Turn it off in ' + where + ', or turn on tool search in ' + search + '.'];
  }
  if (!toolSearchActive && builtin > threshold) {
    return ['Tip: built-in tools take ' + share(builtin) + '% of the window.',
      'Turn on tool search in ' + search + ' to load them only when needed.'];
  }
  return null;
}

function ctxHintHTML(parts, win, toolSearchActive, esc) {
  const lines = ctxHint(parts, win, toolSearchActive);
  return lines ? '<p class="cap ctxtip">' + esc(lines.join(' ')) + '</p>' : '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {CTX_OPEN_SERVERS, CTX_TOOLS_SHOWN, ctxToggleServer, ctxPartsOf, ctxPartLabel, ctxToolRows, ctxPartRowsHTML, ctxHint, ctxHintHTML};
}
