// ATO-2457: the MCP Apps bridge (renderer/mcp-app-bridge.js), SEP-1865
// JSON-RPC over postMessage on the artifact frame: the handshake, the
// call's input and result after `initialized`, ui/message and ui/open-link
// only after a click in that frame, and errors for what is not offered.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const delivered = [];
const opened = [];
let active = true;
let focused = true;
globalThis.abPromptText = (t) => (typeof t === "string" && t.trim() ? t.trim().slice(0, 4000) : null);
globalThis.abUserActive = () => active;
globalThis.abFocusIn = () => focused;
globalThis.widgetDeliver = (text, title) => { delivered.push({ text, title }); return "filled"; };
globalThis.artClampHeight = (h) => Math.min(Math.max(Math.ceil(h), 80), 1400);
globalThis.window = { atomic: { openExternal: (u) => opened.push(u) } };
const M = require("../renderer/mcp-app-bridge.js");

const KEY = "mcpapp:s1:weather:ui://weather/card";
let win, st;
beforeEach(() => {
  win = { got: [], postMessage(m, o) { this.got.push({ m, o }); } };
  st = { key: KEY, title: "weather app", node: { contentWindow: win, style: {} }, h: 320 };
  M.MCPB.apps.clear();
  M.MCPB.arts = new Map([[KEY, st]]);
  delivered.length = 0; opened.length = 0; active = true; focused = true;
});
const rpc = (method, params, id) => ({ source: win, data: { jsonrpc: "2.0", method, ...(params ? { params } : {}), ...(id !== undefined ? { id } : {}) } });
let gap = 0;
const now = () => (gap += 5000);

test("ui/initialize answers the protocol, the host and its context; nothing is sent before initialized", () => {
  M.mcpAppBridgeSet(KEY, { tool: "mcp.weather.forecast", toolInput: { city: "Tallinn" }, toolResult: { content: [{ type: "text", text: "5C" }] } });
  assert.equal(win.got.length, 0);
  assert.equal(M.mcpAppBridgeMessage(rpc("ui/initialize", { protocolVersion: "2026-01-26", appCapabilities: {} }, 1), now()), true);
  const answer = win.got.shift().m;
  assert.equal(answer.id, 1);
  assert.equal(answer.result.protocolVersion, M.MCPB_PROTOCOL);
  assert.equal(answer.result.hostInfo.name, "Atomic Agent");
  assert.deepEqual(answer.result.hostCapabilities, { openLinks: {}, logging: {} });
  assert.equal(answer.result.hostContext.displayMode, "inline");
  assert.equal(answer.result.hostContext.platform, "desktop");
  assert.deepEqual(answer.result.hostContext.toolInfo, { tool: { name: "mcp.weather.forecast" } });
  assert.equal(win.got.length, 0);
  M.mcpAppBridgeMessage(rpc("ui/notifications/initialized"), now());
  assert.deepEqual(win.got.map((g) => g.m.method), ["ui/notifications/tool-input", "ui/notifications/tool-result"]);
  assert.deepEqual(win.got[0].m.params, { arguments: { city: "Tallinn" } });
  assert.deepEqual(win.got[1].m.params, { content: [{ type: "text", text: "5C" }] });
});

test("a later call of the same app reaches the page already up; a new page is torn down first", () => {
  M.mcpAppBridgeSet(KEY, { toolInput: { city: "A" } });
  M.mcpAppBridgeMessage(rpc("ui/notifications/initialized"), now());
  win.got.length = 0;
  M.mcpAppBridgeSet(KEY, { toolInput: { city: "B" }, toolResult: { content: [] } });
  assert.deepEqual(win.got.map((g) => g.m.params.arguments ?? "result"), [{ city: "B" }, "result"]);
  win.got.length = 0;
  assert.equal(M.mcpAppBridgeTeardown(KEY), true);
  assert.equal(win.got[0].m.method, "ui/resource-teardown");
  M.mcpAppBridgeSet(KEY, { toolInput: { city: "C" } });
  assert.equal(win.got.length, 1, "nothing more until the new page says initialized");
});

test("ui/message goes where a widget's text goes, only right after a click in this frame", () => {
  M.mcpAppBridgeMessage(rpc("ui/message", { role: "user", content: { type: "text", text: "Show Tallinn" } }, 7), now());
  assert.deepEqual(delivered.pop(), { text: "Show Tallinn", title: "weather app" });
  assert.deepEqual(win.got.pop().m, { jsonrpc: "2.0", id: 7, result: {} });
  // The array form of content, as the draft spec has it.
  M.mcpAppBridgeMessage(rpc("ui/message", { role: "user", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }, 8), now());
  assert.equal(delivered.pop().text, "a\nb");
  focused = false;
  M.mcpAppBridgeMessage(rpc("ui/message", { role: "user", content: { type: "text", text: "timer" } }, 9), now());
  assert.equal(delivered.length, 0);
  assert.equal(win.got.pop().m.error.code, -32000);
});

test("ui/open-link opens http(s) only, after a click", () => {
  M.mcpAppBridgeMessage(rpc("ui/open-link", { url: "https://weather.example/tallinn" }, 1), now());
  assert.deepEqual(opened, ["https://weather.example/tallinn"]);
  M.mcpAppBridgeMessage(rpc("ui/open-link", { url: "file:///etc/passwd" }, 2), now());
  assert.equal(win.got.pop().m.error.code, -32602);
  active = false;
  M.mcpAppBridgeMessage(rpc("ui/open-link", { url: "https://x.example" }, 3), now());
  assert.equal(opened.length, 1);
});

test("size, ping and display mode are answered; calls back to the server are refused; other frames are ignored", () => {
  M.mcpAppBridgeMessage(rpc("ui/notifications/size-changed", { width: 400, height: 5000 }), now());
  assert.equal(st.node.style.height, "1400px");
  M.mcpAppBridgeMessage(rpc("ping", {}, 1), now());
  assert.deepEqual(win.got.pop().m.result, {});
  M.mcpAppBridgeMessage(rpc("ui/request-display-mode", { mode: "fullscreen" }, 2), now());
  assert.deepEqual(win.got.pop().m.result, { mode: "inline" });
  M.mcpAppBridgeMessage(rpc("tools/call", { name: "refresh" }, 3), now());
  assert.equal(win.got.pop().m.error.code, -32601);
  // Not one of our app frames: a canvas, or a stranger.
  const other = { got: [], postMessage(m) { this.got.push(m); } };
  M.MCPB.arts.set("canvas:s1:x", { key: "canvas:s1:x", node: { contentWindow: other } });
  assert.equal(M.mcpAppBridgeMessage({ source: other, data: { jsonrpc: "2.0", method: "ping", id: 1 } }, now()), false);
  assert.equal(M.mcpAppBridgeMessage({ source: {}, data: { jsonrpc: "2.0", method: "ping", id: 1 } }, now()), false);
  assert.equal(other.got.length, 0);
});
