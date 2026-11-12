// Settings › Plugins (ATO-954): renderer helpers, the main-side argument
// checks and output parsing (against the built output), and the wiring pins.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { plgCountsText, plgTrustText, plgBadges, plgPartNotes, plgParseAct } = require("../renderer/plugins-pane.js");
const {
  parsePluginSetRequest, pluginCliArgs, parsePluginListOutput, isUnsupportedPluginCli,
} = require("../out/main/plugins-cli.js");

const plugin = (over = {}) => ({
  name: "demo", version: "1.2.0", description: "Demo", enabled: true, filesOk: true, error: null,
  counts: { skills: 2, mcpServers: 1, hooks: 0, commands: 1, agents: 0 },
  runsCode: true, trust: "code-off", codeParts: ["local MCP servers: gh"], needsKey: true, missingKeys: ["GITHUB_TOKEN"],
  parts: [], notes: [], sourceLabel: "folder /x", ...over,
});

test("counts read as one line, or Empty", () => {
  assert.equal(plgCountsText({ skills: 2, mcpServers: 1, hooks: 0, commands: 1, agents: 0 }), "2 skills · 1 MCP server · 1 command");
  assert.equal(plgCountsText({ skills: 0, mcpServers: 0, hooks: 0, commands: 0, agents: 0 }), "Empty");
});

test("trust and badges follow the agent's overview", () => {
  assert.equal(plgTrustText(plugin({ trust: "no-code" })), "No code");
  assert.equal(plgTrustText(plugin({ trust: "code-allowed" })), "Code allowed");
  assert.equal(plgTrustText(plugin()), "Code off");
  assert.deepEqual(plgBadges(plugin()).map((b) => [b.text, b.tone]), [["Runs code", "line"], ["Code off", "amber"], ["Needs a key", "amber"]]);
  assert.deepEqual(plgBadges(plugin({ runsCode: false, trust: "no-code", needsKey: false })).map((b) => b.text), ["No code"]);
  assert.deepEqual(plgBadges(plugin({ filesOk: false, error: "gone" })).map((b) => b.text), ["Files missing"]);
});

test("a part says why it is not in use", () => {
  const part = { id: "mcp:gh", kind: "mcp", name: "gh", enabled: true, active: false, runsCode: true, missingKeys: ["T"] };
  assert.deepEqual(plgPartNotes(plugin(), part).map((n) => n.text), ["Runs code", "Off until code is allowed", "Needs T"]);
  assert.deepEqual(plgPartNotes(plugin({ enabled: false }), part).map((n) => n.text), ["Runs code", "Needs T"]);
});

test("Stop its code asks for no restart and shows no caveat: the agent stops the servers itself (ATO-1407)", () => {
  const pane = readFileSync(new URL("../renderer/plugins-pane.js", import.meta.url), "utf8");
  assert.match(pane, /plgWrite\(p\.name, \(\) => BR\.pluginSet\(p\.name, 'deny-code'\), false\)/);
  assert.doesNotMatch(pane, /until you restart the agent/);
  assert.doesNotMatch(pane, /next agent start/);
  assert.doesNotMatch(pane, /plgStopCodeNotice|plgStopCodeNeedsRestart/);
});

test("turning a plugin or an MCP server off asks for no restart, turning it on still does", () => {
  const pane = readFileSync(new URL("../renderer/plugins-pane.js", import.meta.url), "utf8");
  assert.match(pane, /p\.enabled \? 'disable' : 'enable'\), !p\.enabled && p\.counts && p\.counts\.mcpServers > 0\)/);
  assert.match(pane, /pt\.enabled \? 'disable' : 'enable', pt\.id\), !pt\.enabled && pt\.kind === 'mcp'\)/);
});

test("act strings carry the plugin and the whole part id", () => {
  assert.deepEqual(plgParseAct("toggle:demo"), { verb: "toggle", name: "demo", part: null });
  assert.deepEqual(plgParseAct("part:demo:mcp:gh"), { verb: "part", name: "demo", part: "mcp:gh" });
  assert.deepEqual(plgParseAct("part:demo:command:git:push"), { verb: "part", name: "demo", part: "command:git:push" });
  assert.deepEqual(plgParseAct("refresh"), { verb: "refresh", name: null, part: null });
});

test("main accepts only the requests the screen makes", () => {
  assert.deepEqual(parsePluginSetRequest({ name: "demo", op: "disable", part: "mcp:gh" }), { name: "demo", op: "disable", part: "mcp:gh" });
  assert.deepEqual(parsePluginSetRequest({ name: "demo", op: "allow-code" }), { name: "demo", op: "allow-code" });
  assert.equal(parsePluginSetRequest({ name: "../x", op: "enable" }), null);
  assert.equal(parsePluginSetRequest({ name: "demo", op: "install" }), null);
  assert.equal(parsePluginSetRequest({ name: "demo", op: "allow-code", part: "mcp:gh" }), null);
  assert.equal(parsePluginSetRequest({ name: "demo", op: "enable", part: "--force" }), null);
  assert.deepEqual(pluginCliArgs({ name: "demo", op: "disable", part: "hook:Stop" }), ["plugin", "disable", "demo", "--part", "hook:Stop"]);
  assert.deepEqual(pluginCliArgs({ name: "demo", op: "remove" }), ["plugin", "remove", "demo"]);
});

test("list output: JSON, an older text table, garbage", () => {
  assert.deepEqual(parsePluginListOutput('notice\n{"plugins":[{"name":"demo"},null]}\n'), { ok: true, plugins: [{ name: "demo" }] });
  assert.equal(parsePluginListOutput("on   demo@1.0.0  2 skills\n").unsupported, true);
  assert.equal(parsePluginListOutput("{nope").ok, false);
  assert.equal(isUnsupportedPluginCli("unknown command: plugin\n"), true);
  assert.equal(isUnsupportedPluginCli("plugin not installed: demo"), false);
});

test("the screen is wired: section, pane, acts, keys, bridge, main", () => {
  const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  assert.match(renderer, /\['plugins','Plugins','puzzle',\['plugins'\]\]/);
  assert.match(renderer, /\['skills','Skills'\],\['plugins','Plugins'\]/);
  assert.match(renderer, /if \(p === 'plugins'\) return pluginsTab\(\);/);
  assert.match(renderer, /if \(k === 'plugins'\) \{ close\(\); pluginsAct\(a\.slice\(8\)\); return; \}/);
  assert.match(renderer, /if \(pane === 'plugins' && pluginsKey\(e, k, inText\)\) return true;/);
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('src="plugins-pane.js"') !== -1 && html.indexOf('src="plugins-pane.js"') < html.indexOf('src="renderer.js"'));
  const acts = readFileSync(new URL("../renderer/analytics-acts.js", import.meta.url), "utf8");
  assert.match(acts, /plugins:\{refresh:L,[^}]*removeConfirm:L/);
  const preload = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  assert.match(preload, /pluginList: \(\) => ipcRenderer\.invoke\("cli:pluginList"\)/);
  assert.match(preload, /ipcRenderer\.invoke\("cli:pluginSet", \{ name, op, part \}\)/);
  assert.match(preload, /pluginRemove: \(name: string\) => ipcRenderer\.invoke\("cli:pluginRemove", name\)/);
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.match(main, /wirePluginsIpc\(\);/);
});
