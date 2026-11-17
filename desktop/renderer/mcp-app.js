/* ---------------- ATO-1010: MCP Apps in the chat, sandboxed ----------------
   An MCP server can ship a small UI for one of its tools (the MCP Apps
   extension, SEP-1865: the tool names a `ui://` page, the host shows it next
   to the result). The agent reads that page from the server after an ok call
   and the call's `tool_result` frame carries it as
   `mcp_app: {server, uri, title, html, bytes}`.

   The page is someone else's code, so it goes through the SAME frame as the
   agent's own canvases (chat-artifact.js): main keeps the text and serves it
   from `atomic-art://<token>/` under the strict CSP (inline script and style,
   `connect-src 'none'`, no frames, no forms), in an <iframe sandbox=
   "allow-scripts"> with an opaque origin. Nothing here makes a frame, sets
   `srcdoc` or opens a URL of the server's. An app that needs live calls back
   to its server (the spec's postMessage bridge) draws but cannot fetch yet.

   One frame per app page per chat: a second call of the same tool loads the
   page in the frame already on screen, where it is, as a canvas of the same
   title does (ATO-1138).

   Loaded after chat-artifact.js and before renderer.js; only declares. The
   pure part is exported for test/mcp-app.test.mjs. */

/** Largest page drawn (UTF-8 bytes); the agent caps it the same. */
const MCP_APP_MAX_BYTES = 1024 * 1024;

function mcpAppBytes(s) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(s).length;
  return s.length * 3;   // worst case, without an encoder
}

/** The `mcp_app` a tool_result frame carries, checked: {server, uri, title, html} or null. */
function mcpAppFromToolResult(p) {
  const a = p && typeof p === 'object' ? (p.mcp_app || p.mcpApp) : null;
  if (!a || typeof a !== 'object') return null;
  const server = typeof a.server === 'string' ? a.server.trim().slice(0, 64) : '';
  const uri = typeof a.uri === 'string' && a.uri.length <= 2048 && /^ui:\/\/\S+$/i.test(a.uri) ? a.uri : '';
  if (!server || !uri) return null;
  if (typeof a.html !== 'string' || !a.html.trim()) return null;
  if (a.html.length > MCP_APP_MAX_BYTES || mcpAppBytes(a.html) > MCP_APP_MAX_BYTES) return null;
  return {server, uri, title: server + ' app', html: a.html};
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
  chatArtifactSet(key, app.html, {title: app.title});
  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {MCP_APP_MAX_BYTES, mcpAppFromToolResult, mcpAppKey, chatMcpApp};
}
