/* ---------------- ATO-1010: MCP Apps in the chat, sandboxed ----------------
   An MCP server can ship a small UI for one of its tools (the MCP Apps
   extension, SEP-1865: the tool names a `ui://` page, the host shows it next
   to the result). The agent core (ATO-1135, src/mcp/mcp-apps.ts) reads that
   page from the server after an ok call and the call's `tool_result` frame
   carries it as `mcp_app: {resourceUri, mimeType, html, csp?, permissions?,
   domain?, prefersBorder?, toolInput?, toolResult?}`. The frame's `tool`
   (`mcp.<server>.<tool>`) names the server. The core sends it only when the
   host turned MCP Apps on (`McpClientDeps.appsUi`).

   The page is someone else's code, so it goes through the SAME frame as the
   agent's own canvases (chat-artifact.js): main keeps the text and serves it
   from `atomic-art://<token>/` under the strict CSP (inline script and style,
   `connect-src 'none'`, no frames, no forms), in an <iframe sandbox=
   "allow-scripts"> with an opaque origin. Nothing here makes a frame, sets
   `srcdoc` or opens a URL of the server's. The server's `csp`, `permissions`
   and `domain` are requests; this frame grants none of them. `toolInput` and
   `toolResult` go to the page through the spec's postMessage bridge
   (ATO-2457, mcp-app-bridge.js), which also takes its ui/message and
   ui/open-link; calls back to the server are not offered.

   One frame per app page per chat: a second call of the same tool loads the
   page in the frame already on screen, where it is, as a canvas of the same
   title does (ATO-1138).

   Loaded after chat-artifact.js and before renderer.js; only declares. The
   pure part is exported for test/mcp-app.test.mjs. */

/** Largest page drawn (UTF-8 bytes); the core and the artifact frame cap it the same (4 MB). */
const MCP_APP_MAX_BYTES = 4 * 1024 * 1024;

function mcpAppBytes(s) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(s).length;
  return s.length * 3;   // worst case, without an encoder
}

/** The server of an MCP tool name `mcp.<server>.<tool>`, or ''. */
function mcpAppServer(tool) {
  const m = typeof tool === 'string' ? /^mcp\.([a-z0-9][a-z0-9-]{0,62})\.\S+$/.exec(tool) : null;
  return m ? m[1] : '';
}

/** The `mcp_app` an ok tool_result frame carries, checked: {server, uri, title, html} or null. */
function mcpAppFromToolResult(p) {
  if (!p || typeof p !== 'object' || (p.status != null && p.status !== 'ok')) return null;
  const a = p.mcp_app;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const server = mcpAppServer(p.tool);
  const ru = a.resourceUri;
  const uri = typeof ru === 'string' && ru.length <= 2048 && /^ui:\/\/\S+$/i.test(ru) ? ru : '';
  if (!server || !uri) return null;
  if (typeof a.html !== 'string' || !a.html.trim()) return null;
  if (a.html.length > MCP_APP_MAX_BYTES || mcpAppBytes(a.html) > MCP_APP_MAX_BYTES) return null;
  // ATO-2457: the call's data for the bridge (mcp-app-bridge.js); plain objects only.
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  return {server, uri, title: server + ' app', html: a.html, tool: p.tool, toolInput: obj(a.toolInput), toolResult: obj(a.toolResult)};
}

/** One frame per app page in a chat. */
function mcpAppKey(scope, app) {
  return 'mcpapp:' + String(scope || '') + ':' + app.server + ':' + app.uri;
}

/**
 * An ok MCP tool call whose frame carries `mcp_app`, into the reply `item`:
 * the page shown in the sandboxed artifact frame. False when the frame
 * carries no usable app. `scope` is the chat; `log` its rows.
 */
function chatMcpApp(item, payload, scope, log) {
  const app = mcpAppFromToolResult(payload);
  if (!item || !app || typeof chatArtifactSet !== 'function') return false;
  const key = mcpAppKey(scope, app);
  const owner = (Array.isArray(log) ? log : []).find((m) => m && m !== item && Array.isArray(m.artifacts) && m.artifacts.some((x) => x.key === key));
  const rows = owner ? owner.artifacts : (Array.isArray(item.artifacts) ? item.artifacts : (item.artifacts = []));
  let row = rows.find((x) => x.key === key);
  if (!row) { row = {key, title: app.title}; rows.push(row); }
  row.title = app.title;
  // A page that failed before gets a fresh try.
  if (typeof CHAT_ART !== 'undefined' && CHAT_ART.has(key) && CHAT_ART.get(key).state === 'fail') CHAT_ART.delete(key);
  // ATO-2457: a new page in the frame first tears the old one down; the same page gets the new call's data.
  const prev = typeof CHAT_ART !== 'undefined' ? CHAT_ART.get(key) : null;
  if (prev && prev.html && prev.html !== app.html && typeof mcpAppBridgeTeardown === 'function') mcpAppBridgeTeardown(key);
  if (typeof mcpAppBridgeSet === 'function') mcpAppBridgeSet(key, {tool: app.tool, toolInput: app.toolInput, toolResult: app.toolResult});
  chatArtifactSet(key, app.html, {title: app.title});
  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {MCP_APP_MAX_BYTES, mcpAppServer, mcpAppFromToolResult, mcpAppKey, chatMcpApp};
}
