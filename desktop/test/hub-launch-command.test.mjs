// ATO-2737: "Open on local model" in the Agents sheet types the app's own
// agent by full path, not a bare `atag`. main/hub-launch-command.ts is checked
// against the built output (npm run build first); the renderer half of
// renderer/agent-hub.js is loaded as a CommonJS module, as in agent-hub.test.mjs.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const L = require("../out/main/hub-launch-command.js");
const R = require("../renderer/agent-hub.js");

const MAC_BIN = "/Applications/Atomic Agent.app/Contents/Resources/agent/atomic-agent";
const WIN_BIN = "C:\\Program Files\\Atomic Agent\\resources\\agent\\atomic-agent.exe";
const LINUX_BIN = "/opt/Atomic Agent/resources/agent/atomic-agent";

test("macOS: the bundled agent by full path, single-quoted so the space in the .app name stays one word", () => {
  assert.equal(L.bundledLaunchCommand("claude", "darwin", MAC_BIN),
    "'/Applications/Atomic Agent.app/Contents/Resources/agent/atomic-agent' launch claude");
  assert.equal(L.bundledLaunchCommand("codex", "darwin", MAC_BIN),
    "'/Applications/Atomic Agent.app/Contents/Resources/agent/atomic-agent' launch codex");
  assert.ok(!L.bundledLaunchCommand("claude", "darwin", MAC_BIN).startsWith("atag "), "not the bare atag");
});

test("POSIX quoting: a quote, $ and a backtick in the path stay literal", () => {
  assert.equal(L.posixQuote("/Users/o'neil/$HOME/`x`/atag"), "'/Users/o'\\''neil/$HOME/`x`/atag'");
  assert.equal(L.bundledLaunchCommand("claude", "darwin", "/Users/o'neil/Atomic Agent.app/agent/atomic-agent"),
    "'/Users/o'\\''neil/Atomic Agent.app/agent/atomic-agent' launch claude");
});

test("Windows: PowerShell's call operator with a single-quoted path (Program Files has a space)", () => {
  assert.equal(L.bundledLaunchCommand("claude", "win32", WIN_BIN),
    "& 'C:\\Program Files\\Atomic Agent\\resources\\agent\\atomic-agent.exe' launch claude");
  assert.equal(L.bundledLaunchCommand("codex", "win32", WIN_BIN),
    "& 'C:\\Program Files\\Atomic Agent\\resources\\agent\\atomic-agent.exe' launch codex");
  // A quote is doubled; $ stays literal inside single quotes.
  assert.equal(L.powershellQuote("C:\\Users\\O'Neil\\$x\\a.exe"), "'C:\\Users\\O''Neil\\$x\\a.exe'");
});

test("Linux: POSIX single quotes too", () => {
  assert.equal(L.bundledLaunchCommand("claude", "linux", LINUX_BIN),
    "'/opt/Atomic Agent/resources/agent/atomic-agent' launch claude");
});

test("no agent binary (a dev run with nothing built): the bare atag line, as before", () => {
  assert.equal(L.bundledLaunchCommand("claude", "darwin", null), "atag launch claude");
  assert.equal(L.bundledLaunchCommand("codex", "win32", null), "atag launch codex");
  assert.equal(L.bundledLaunchCommand("claude", "linux", "  "), "atag launch claude");
  // A path with a line break would run as two commands: refused, bare atag instead.
  assert.equal(L.bundledLaunchCommand("claude", "darwin", "/a\nrm -rf ~"), "atag launch claude");
});

test("hub:launchCommand answer: refused when connected to a remote agent, only claude and codex", () => {
  assert.deepEqual(L.hubLaunchAnswer("claude", { isRemote: false, platform: "darwin", binPath: MAC_BIN }),
    { ok: true, command: "'/Applications/Atomic Agent.app/Contents/Resources/agent/atomic-agent' launch claude" });
  const remote = L.hubLaunchAnswer("claude", { isRemote: true, platform: "darwin", binPath: MAC_BIN });
  assert.equal(remote.ok, false);
  assert.equal(remote.reason, "remote");
  assert.ok(remote.message.length > 0 && !remote.message.includes("/"), "words, no path");
  assert.equal(L.hubLaunchAnswer("opencode; rm -rf ~", { isRemote: false, platform: "darwin", binPath: MAC_BIN }).reason, "invalid-agent");
  assert.equal(L.hubLaunchAnswer(undefined, { isRemote: false, platform: "darwin", binPath: MAC_BIN }).ok, false);
});

test("renderer: the button's tooltip says what it does, not the long path; the agent name maps", () => {
  const row = { agent: "claude-code", id: "c1", state: "idle", resumeId: "c1" };
  assert.equal(R.hubLaunchAgent(row), "claude");
  assert.equal(R.hubLaunchAgent({ agent: "codex" }), "codex");
  assert.equal(R.hubLaunchAgent({ agent: "other" }), "");
  const html = R.hubRowHTML(row, { terminalOk: true });
  assert.ok(html.includes('title="Runs Claude Code on your local model, in Terminal"'));
  assert.ok(!/title="atag launch/.test(html), "the tooltip is no longer the typed command");
});

test("renderer: Open on local model types the command main built, falls back to bare atag, stops when remote", async () => {
  const typed = [];
  const toasts = [];
  globalThis.PLATFORM = "darwin";
  globalThis.toast = (...a) => toasts.push(a);
  const row = { agent: "claude-code", id: "c1", cwd: "/w/app" };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  globalThis.BR = {
    hubLaunchCommand: async (agent) => L.hubLaunchAnswer(agent, { isRemote: false, platform: "darwin", binPath: MAC_BIN }),
    terminalOpenWithCommand: (req) => { typed.push(req); return { ok: true }; },
  };
  await R.hubOpenLocal(row);
  await tick();
  assert.deepEqual(typed.pop(), { command: "'" + MAC_BIN + "' launch claude", cwd: "/w/app" });

  // An older preload with no hub:launchCommand: the bare line, as before.
  globalThis.BR = { terminalOpenWithCommand: (req) => { typed.push(req); return { ok: true }; } };
  await R.hubOpenLocal({ agent: "codex", id: "x1", cwd: null });
  await tick();
  assert.deepEqual(typed.pop(), { command: "atag launch codex", cwd: null });

  // Remote: nothing typed, the reason in a toast.
  globalThis.BR = {
    hubLaunchCommand: async (agent) => L.hubLaunchAnswer(agent, { isRemote: true, platform: "darwin", binPath: MAC_BIN }),
    terminalOpenWithCommand: (req) => { typed.push(req); return { ok: true }; },
  };
  await R.hubOpenLocal(row);
  await tick();
  assert.equal(typed.length, 0);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0][2], "bad");
});

test("wiring: preload, the hub IPC route, and act() goes through hubOpenLocal", () => {
  const pre = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  assert.match(pre, /hubLaunchCommand: \(agent: string\) => ipcRenderer\.invoke\("hub:launchCommand", agent\)/);
  const ipc = readFileSync(new URL("../main/agent-hub-ipc.ts", import.meta.url), "utf8");
  assert.match(ipc, /import \{ resolveBinary \} from "\.\/agent-client\.js";/);
  assert.match(ipc, /ipcMain\.handle\("hub:launchCommand"/);
  assert.match(ipc, /hubLaunchAnswer\(agent, \{ isRemote: opts\.isRemote\(\), platform: process\.platform, binPath:/);
  const hub = readFileSync(new URL("../renderer/agent-hub.js", import.meta.url), "utf8");
  assert.match(hub, /if \(v\.indexOf\('local:'\) === 0\) \{ const row = hubFind\(v\.slice\(6\)\); if \(row\) hubOpenLocal\(row\); return; \}/);
});
