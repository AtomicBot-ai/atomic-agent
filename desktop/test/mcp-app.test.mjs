// ATO-1010: MCP Apps in the chat (renderer/mcp-app.js): an ok MCP tool
// call's `tool_result.mcp_app` page (the core's shape, ATO-1135
// src/mcp/mcp-apps.ts: {resourceUri, mimeType, html, csp?, ..., toolInput?,
// toolResult?}, the server named by the frame's `tool`) is checked and shown
// through the same sandboxed artifact frame as a canvas (chat-artifact.js),
// and the hook in renderer.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// A bridge that keeps what it was given, like main's store.
const puts = [];
globalThis.window = {
  atomic: {
    artifactPut: async (html) => { puts.push(html); return { ok: true, url: "atomic-art://" + String(puts.length).padStart(32, "0") + "/" }; },
    artifactDrop: async () => ({ ok: true }),
  },
};
const A = require("../renderer/chat-artifact.js");
// In the window these are shared globals of the classic scripts.
globalThis.chatArtifactSet = A.chatArtifactSet;
globalThis.CHAT_ART = A.CHAT_ART;
const M = require("../renderer/mcp-app.js");
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await tick(); }
}

const PAGE = "<!doctype html><h1>Forecast</h1><script>document.body.dataset.ok='1'</script>";
const frame = (app, tool = "mcp.weather.forecast") => ({ tool, status: "ok", mcp_app: app });
// As the core's mcpAppFrame forwards `details.mcpApp` (McpAppUi + withToolCall).
const APP = {
  resourceUri: "ui://weather/card",
  mimeType: "text/html;profile=mcp-app",
  html: PAGE,
  csp: { connectDomains: ["https://api.weather.example"] },
  permissions: { geolocation: true },
  prefersBorder: true,
  toolInput: { city: "Tallinn" },
  toolResult: { content: [{ type: "text", text: "5C" }] },
};

test("the frame's mcp_app is checked: a ui:// page of an MCP tool's server, or nothing", () => {
  // ATO-2457: the call's input and result ride along for the bridge (mcp-app-bridge.js).
  assert.deepEqual(M.mcpAppFromToolResult(frame(APP)), {
    server: "weather", uri: "ui://weather/card", title: "weather app", html: PAGE,
    tool: "mcp.weather.forecast", toolInput: { city: "Tallinn" }, toolResult: { content: [{ type: "text", text: "5C" }] },
  });
  // A tool name with dots in its raw part still names the server by its second segment.
  assert.equal(M.mcpAppFromToolResult(frame(APP, "mcp.my-plugin-weather.os.read")).server, "my-plugin-weather");
  // Only the core's field names: the old {server, uri} shape draws nothing.
  assert.equal(M.mcpAppFromToolResult(frame({ server: "weather", uri: "ui://weather/card", html: PAGE })), null);
  assert.equal(M.mcpAppFromToolResult({ tool: "mcp.weather.forecast", status: "ok", mcpApp: APP }), null);
  // Not an MCP tool, or not ok: nothing.
  assert.equal(M.mcpAppFromToolResult(frame(APP, "canvas.render")), null);
  // No tool name at all (frame(APP, undefined) would take the default name).
  assert.equal(M.mcpAppFromToolResult({ status: "ok", mcp_app: APP }), null);
  assert.equal(M.mcpAppFromToolResult({ ...frame(APP), status: "error" }), null);
  assert.equal(M.mcpAppFromToolResult(frame([APP])), null);
  assert.equal(M.mcpAppFromToolResult({}), null);
  assert.equal(M.mcpAppFromToolResult(null), null);
  assert.equal(M.mcpAppFromToolResult(frame({ ...APP, html: undefined })), null);
  assert.equal(M.mcpAppFromToolResult(frame({ ...APP, html: 42 })), null);
  assert.equal(M.mcpAppFromToolResult(frame({ ...APP, html: { toString: () => PAGE } })), null);
  assert.equal(M.mcpAppFromToolResult(frame({ ...APP, html: "   " })), null);
  assert.equal(M.mcpAppFromToolResult(frame({ ...APP, html: "x".repeat(M.MCP_APP_MAX_BYTES + 1) })), null);
  // Multi-byte text counts in bytes, not characters.
  assert.equal(M.mcpAppFromToolResult(frame({ ...APP, html: "я".repeat(M.MCP_APP_MAX_BYTES / 2 + 1) })), null);
  // The same 4 MB the core and the artifact frame allow is drawn.
  assert.equal(M.MCP_APP_MAX_BYTES, 4 * 1024 * 1024);
  assert.ok(M.mcpAppFromToolResult(frame({ ...APP, html: "x".repeat(M.MCP_APP_MAX_BYTES) })));
  assert.equal(M.mcpAppFromToolResult(frame({ ...APP, resourceUri: "https://evil.example/app.html" })), null);
  assert.equal(M.mcpAppFromToolResult(frame({ ...APP, resourceUri: "file:///etc/passwd" })), null);
  assert.equal(M.mcpAppFromToolResult(frame({ ...APP, resourceUri: undefined })), null);
  assert.equal(M.mcpAppFromToolResult(frame(APP, "mcp..forecast")), null);
});

test("an app page goes to the sandboxed atomic-art frame and onto the reply", async () => {
  const item = {};
  assert.equal(M.chatMcpApp(item, frame(APP), "s-1", [item]), true);
  const key = M.mcpAppKey("s-1", { server: "weather", uri: "ui://weather/card" });
  assert.equal(key, "mcpapp:s-1:weather:ui://weather/card");
  assert.deepEqual(item.artifacts, [{ key, title: "weather app" }]);
  await until(() => A.CHAT_ART.get(key).state === "ok");
  const st = A.CHAT_ART.get(key);
  assert.equal(puts.at(-1), PAGE);
  assert.match(st.url, /^atomic-art:\/\/[0-9]+\/$/);
  // The frame is the artifact frame: scripts only, no srcdoc, its src our scheme.
  const attrs = {};
  globalThis.document = {
    documentElement: { getAttribute: () => "light" },
    createElement: () => ({ style: {}, setAttribute: (k, v) => { attrs[k] = v; }, set src(v) { attrs.src = v; }, get src() { return attrs.src; } }),
  };
  try {
    A.artNode(st);
    assert.equal(attrs.sandbox, "allow-scripts");
    assert.equal(attrs.srcdoc, undefined);
    assert.match(attrs.src, /^atomic-art:\/\//);
  } finally { delete globalThis.document; st.node = null; }
});

test("the reply's box shows only the checked server name", async () => {
  const item = {};
  // A server name the core would refuse cannot reach the box at all ...
  assert.equal(M.chatMcpApp(item, frame(APP, 'mcp.x"><img src=x onerror=alert(1)>.y'), "s-2", [item]), false);
  assert.equal(item.artifacts, undefined);
  // ... and a page's own markup only ever goes into the sandboxed frame, not the box.
  const app = { ...APP, resourceUri: "ui://x/y", html: '<img src=x onerror=alert(1)>' };
  assert.equal(M.chatMcpApp(item, frame(app, "mcp.x.y"), "s-2", [item]), true);
  const key = item.artifacts[0].key;
  await until(() => A.CHAT_ART.get(key).state === "ok");
  const html = A.chatArtifactEventSlots(item).join("");
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /x app/);
});

test("a second call of the same app loads in the earlier frame, the new reply adds none", async () => {
  const first = {}, second = {};
  M.chatMcpApp(first, frame(APP), "s-3", [first]);
  const key = first.artifacts[0].key;
  await until(() => A.CHAT_ART.get(key).state === "ok");
  const page2 = PAGE.replace("Forecast", "Forecast 2");
  M.chatMcpApp(second, frame({ ...APP, html: page2 }), "s-3", [first, second]);
  assert.equal(second.artifacts, undefined);
  assert.equal(first.artifacts.length, 1);
  await until(() => puts.at(-1) === page2);
});

test("nothing is drawn for a frame without an app or without a reply", () => {
  const item = {};
  assert.equal(M.chatMcpApp(item, { tool: "mcp.weather.forecast", status: "ok" }, "s-4", [item]), false);
  assert.equal(M.chatMcpApp(null, frame(APP), "s-4", []), false);
  assert.equal(item.artifacts, undefined);
});

test("renderer.js hooks the tool_result frame; index.html loads mcp-app.js after chat-artifact.js", () => {
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  const tr = src.slice(src.indexOf("if (ev.kind === 'tool_result') {"), src.indexOf("if (ev.kind === 'tool_update') {"));
  assert.match(tr, /chatArtifactCanvas\(item, p, S\.sessionId, S\.log\);\s*\/\/[^\n]*\n\s*if \(p\.mcp_app && item && typeof chatMcpApp === 'function'\) chatMcpApp\(item, p, S\.sessionId, S\.log\);/);
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const at = (s) => html.indexOf(s);
  assert.ok(at('src="mcp-app.js"') > at('src="chat-artifact.js"') && at('src="chat-artifact.js"') > 0);
  assert.ok(at('src="mcp-app.js"') < at('src="renderer.js"'));
  // No path of its own to the network or to a frame: it only hands the page to chatArtifactSet.
  const mod = readFileSync(new URL("../renderer/mcp-app.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(mod, /srcdoc|createElement|fetch\(|XMLHttpRequest|\.src\s*=|window\.open/);
});

test("the agent the desktop starts is told it may send MCP Apps pages (ATOMIC_AGENT_MCP_APPS_UI)", () => {
  // Core #1623 reads this switch (src/mcp/mcp-apps.ts mcpAppsUiFromEnv); without it no page ever arrives.
  const src = readFileSync(new URL("../main/state-dir.ts", import.meta.url), "utf8");
  const env = src.slice(src.indexOf("export function agentEnv"), src.indexOf("export function underDesktopState"));
  assert.match(env, /ATOMIC_AGENT_MCP_APPS_UI: "1"/);
});
