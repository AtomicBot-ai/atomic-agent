/* ---------------- ATO-2457: the MCP Apps bridge (SEP-1865) ----------------
   An MCP App's page (mcp-app.js puts it in the sandboxed artifact frame)
   talks to its host in JSON-RPC 2.0 over postMessage, as the MCP Apps
   spec (io.modelcontextprotocol/ui, stable 2026-01-26) defines. This file
   is the host side, on the same frame and the same checks as the agent's
   own widgets (artifact-bridge.js): a message counts only from one of our
   frames whose key is an MCP App's.

   View → host:
     ui/initialize               → {protocolVersion, hostInfo, hostCapabilities, hostContext}
     ui/notifications/initialized  the host then sends tool-input and tool-result
     ui/message {role, content}  its text goes where a widget's does (widgetDeliver,
                                 widget-send.js), only right after a click or key in
                                 this frame, one per AB_PROMPT_GAP_MS
     ui/open-link {url}          http(s) only, same click rule, opened in the browser
     ui/notifications/size-changed {height}  the frame takes it (clamped)
     ui/request-display-mode     → {mode: 'inline'} (the one mode here)
     ping                        → {}
     notifications/message       a log line; ignored
     anything else (tools/call, resources/read, ui/update-model-context…)
                                 → error -32601: not offered in hostCapabilities
   Host → view (only after `initialized`, as the spec requires):
     ui/notifications/tool-input {arguments}, ui/notifications/tool-result (CallToolResult),
     ui/notifications/host-context-changed {theme} when the window's theme changes,
     ui/resource-teardown before a new page replaces this one in the frame.

   The frame stays as chat-artifact.js makes it (sandbox="allow-scripts", no
   network): the server's csp/permissions/domain requests are not granted.

   Loaded after artifact-bridge.js and mcp-app.js. Pure part exported for
   test/mcp-app-bridge.test.mjs. */

const MCPB_PROTOCOL = '2026-01-26';
const MCPB_HOST = {name: 'Atomic Agent', version: '1'};
/* key → {toolInput, toolResult, tool, ready, nextId}. */
const MCPB = {apps: new Map(), arts: null};

function mcpbArts() { return MCPB.arts || (typeof CHAT_ART !== 'undefined' ? CHAT_ART : new Map()); }

/** The CHAT_ART entry of an MCP App whose frame sent `source`, or null. */
function mcpbEntryOf(source) {
  if (!source) return null;
  for (const st of mcpbArts().values()) {
    if (st && String(st.key || '').startsWith('mcpapp:') && st.node && st.node.contentWindow === source) return st;
  }
  return null;
}

/** The call data for app `key` (mcp-app.js, on each ok call). A page already up gets it at once. */
function mcpAppBridgeSet(key, data) {
  let a = MCPB.apps.get(key);
  if (!a) { a = {ready: false, nextId: 1}; MCPB.apps.set(key, a); }
  a.tool = data.tool || '';
  a.toolInput = data.toolInput && typeof data.toolInput === 'object' ? data.toolInput : {};
  a.toolResult = data.toolResult && typeof data.toolResult === 'object' ? data.toolResult : null;
  if (a.ready) mcpbSendCall(key);
  return a;
}

function mcpbTheme() { return typeof artTheme === 'function' ? artTheme() : 'light'; }

function mcpbHostContext(a) {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* no Intl: left out */ }
  return {
    theme: mcpbTheme(), displayMode: 'inline', availableDisplayModes: ['inline'], platform: 'desktop',
    ...(nav.language ? {locale: nav.language} : {}), ...(tz ? {timeZone: tz} : {}),
    ...(a && a.tool ? {toolInfo: {tool: {name: a.tool}}} : {}),
  };
}

function mcpbPost(st, msg) {
  try { st.node.contentWindow.postMessage(msg, '*'); return true; } catch (e) { return false; }
}

/** Tool input, then the result, into app `key`'s frame (once it said `initialized`). */
function mcpbSendCall(key) {
  const a = MCPB.apps.get(key);
  const st = mcpbArts().get(key);
  if (!a || !a.ready || !st || !st.node) return false;
  mcpbPost(st, {jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: {arguments: a.toolInput || {}}});
  if (a.toolResult) mcpbPost(st, {jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: a.toolResult});
  return true;
}

/** Before a new page loads in app `key`'s frame (chatMcpApp): tell the old one, and wait for the new one's handshake. */
function mcpAppBridgeTeardown(key) {
  const a = MCPB.apps.get(key);
  const st = mcpbArts().get(key);
  if (!a || !a.ready) return false;
  if (st && st.node) mcpbPost(st, {jsonrpc: '2.0', id: 'teardown-' + (a.nextId++), method: 'ui/resource-teardown', params: {reason: 'replaced'}});
  a.ready = false;
  return true;
}

/** The text of a ui/message's content (one block or a list; text blocks only), capped. */
function mcpbMessageText(params) {
  const c = params && params.content;
  const blocks = Array.isArray(c) ? c : c ? [c] : [];
  const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return typeof abPromptText === 'function' ? abPromptText(text) : (text.trim().slice(0, 4000) || null);
}

/** Did the person just click or type in this app's frame, and may it speak now? (artifact-bridge.js rules.) */
function mcpbMayAct(st, now) {
  if (typeof abUserActive === 'function' && !abUserActive()) return false;
  if (typeof abFocusIn === 'function' && !abFocusIn(st)) return false;
  if (typeof abWidget === 'function' && typeof abPromptAllowed === 'function') return abPromptAllowed(abWidget(st.key), now);
  return true;
}

/** One request or notification's answer: {result} | {error} | null (a notification, nothing to answer). */
function mcpbHandle(st, d, now) {
  const a = MCPB.apps.get(st.key) || mcpAppBridgeSet(st.key, {});
  const m = d.method;
  const p = d.params && typeof d.params === 'object' ? d.params : {};
  const err = (code, message) => ({error: {code, message}});
  if (m === 'ui/initialize') {
    a.ready = false;   // a page (re)loaded in this frame: it gets the call again once it says `initialized`
    return {result: {protocolVersion: MCPB_PROTOCOL, hostInfo: MCPB_HOST, hostCapabilities: {openLinks: {}, logging: {}}, hostContext: mcpbHostContext(a)}};
  }
  if (m === 'ui/notifications/initialized') { a.ready = true; mcpbSendCall(st.key); return null; }
  if (m === 'ui/notifications/size-changed') {
    if (typeof artClampHeight === 'function' && st.node && st.node.style && Number(p.height) > 0) { st.h = artClampHeight(p.height); st.node.style.height = st.h + 'px'; }
    return null;
  }
  if (m === 'notifications/message' || (typeof m === 'string' && m.startsWith('notifications/'))) return null;
  if (m === 'ping') return {result: {}};
  if (m === 'ui/request-display-mode') return {result: {mode: 'inline'}};
  if (m === 'ui/message') {
    const text = mcpbMessageText(p);
    if (!text) return err(-32602, 'ui/message needs text content');
    if (!mcpbMayAct(st, now)) return err(-32000, 'The person has to click in the app first');
    const r = typeof widgetDeliver === 'function' ? widgetDeliver(text, st.title) : (typeof abFillComposer === 'function' ? abFillComposer(text, st.title) : 'none');
    return r === 'filled' || r === 'sent' ? {result: {}} : err(-32000, 'The message box holds the person\'s own draft');
  }
  if (m === 'ui/open-link') {
    // The same rule as main's open-external (main.ts): lower-case scheme only, so a link answered as opened is opened.
    const url = typeof p.url === 'string' && p.url.length <= 2048 && /^https?:\/\//.test(p.url) ? p.url : '';
    if (!url) return err(-32602, 'Only http and https links open');
    if (!mcpbMayAct(st, now)) return err(-32000, 'The person has to click in the app first');
    const br = typeof window !== 'undefined' && window.atomic ? window.atomic : null;
    if (!br || typeof br.openExternal !== 'function') return err(-32000, 'Links cannot be opened here');
    br.openExternal(url);
    return {result: {}};
  }
  return d.id === undefined ? null : err(-32601, 'Not supported by this host: ' + String(m).slice(0, 80));
}

/** A JSON-RPC message from one of our MCP App frames. True when it was one. `now` is a test seam. */
function mcpAppBridgeMessage(e, now) {
  const d = e && e.data;
  if (!d || typeof d !== 'object' || d.jsonrpc !== '2.0' || typeof d.method !== 'string') return false;
  const st = mcpbEntryOf(e.source);
  if (!st) return false;
  const out = mcpbHandle(st, d, typeof now === 'number' ? now : Date.now());
  if (out && d.id !== undefined && d.id !== null) {
    try { e.source.postMessage({jsonrpc: '2.0', id: d.id, ...out}, '*'); } catch (x) { /* the frame went */ }
  }
  return true;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('message', mcpAppBridgeMessage);
}
if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
  let lastTheme = mcpbTheme();
  new MutationObserver(() => {
    const t = mcpbTheme();
    if (t === lastTheme) return;
    lastTheme = t;
    for (const [key, a] of MCPB.apps) {
      const st = mcpbArts().get(key);
      if (a.ready && st && st.node) mcpbPost(st, {jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: {theme: t}});
    }
  }).observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {MCPB, MCPB_PROTOCOL, mcpAppBridgeSet, mcpAppBridgeTeardown, mcpAppBridgeMessage, mcpbHandle, mcpbMessageText, mcpbEntryOf, mcpbSendCall};
}
