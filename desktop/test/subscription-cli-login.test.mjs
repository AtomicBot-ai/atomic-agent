// ATO-845: "Sign in with Claude / ChatGPT" opens the system terminal with the
// sign-in running. Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const L = require("../out/main/subscription-cli-login.js");

test("the command is `claude` or `codex login`, with a plain off-PATH path quoted", () => {
  assert.equal(L.loginCommandLine("codex", null, "darwin"), "codex login");
  assert.equal(L.loginCommandLine("claude", null, "linux"), "claude");
  assert.equal(L.loginCommandLine("claude", "/Users/nadia/.local/bin/claude", "darwin"), "'/Users/nadia/.local/bin/claude'");
  assert.equal(L.loginCommandLine("codex", "C:\\Users\\nadia\\AppData\\Roaming\\npm\\codex.cmd", "win32"),
    '"C:\\Users\\nadia\\AppData\\Roaming\\npm\\codex.cmd" login');
});

test("a path with shell characters never reaches the command: the bare name is used", () => {
  for (const bad of ["/tmp/x';rm -rf ~;'", "/tmp/$(id)/claude", "/tmp/a`b`", "/tmp/a\"b", "../../claude", "/tmp/a&b"]) {
    assert.equal(L.loginBinary("claude", bad), "claude", bad);
  }
});

test("macOS opens a .command file in Terminal, no AppleScript", async () => {
  const launched = [];
  const written = [];
  const r = await L.openLoginTerminal("codex", null, {
    platform: "darwin",
    writeScript: (name, text) => { written.push({ name, text }); return `/var/folders/x/T/${name}`; },
    launch: (l) => { launched.push(l); return Promise.resolve(true); },
  });
  assert.deepEqual(r, { ok: true, terminal: "terminal_app" });
  assert.equal(written[0].name, "atomic-agent-sign-in-codex.command");
  assert.match(written[0].text, /^#!\/bin\/sh\n/);
  assert.match(written[0].text, /\ncodex login\n$/);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].command, "/usr/bin/open");
  assert.deepEqual(launched[0].args, ["-a", "Terminal", "/var/folders/x/T/atomic-agent-sign-in-codex.command"]);
  assert.equal(launched[0].waitForExit, true);
});

test("the Claude script says to type /login if it does not ask", () => {
  assert.match(L.macLoginScript("claude", null), /type \/login/);
  assert.doesNotMatch(L.macLoginScript("codex", null), /\/login/);
});

test("Windows opens a new cmd window that stays open", async () => {
  const launched = [];
  const r = await L.openLoginTerminal("claude", null, { platform: "win32", launch: (l) => { launched.push(l); return Promise.resolve(true); } });
  assert.deepEqual(r, { ok: true, terminal: "cmd" });
  assert.equal(launched[0].command, "cmd.exe");
  assert.deepEqual(launched[0].args, ["/d", "/c", 'start "Sign in" cmd.exe /k claude']);
  assert.equal(launched[0].windowsVerbatimArguments, true);
});

test("Linux tries the terminals in order and reports the first that starts", async () => {
  const tried = [];
  const r = await L.openLoginTerminal("codex", null, {
    platform: "linux",
    launch: (l) => { tried.push(l.terminal); return Promise.resolve(l.terminal === "konsole"); },
  });
  assert.deepEqual(tried, ["x-terminal-emulator", "gnome-terminal", "konsole"]);
  assert.deepEqual(r, { ok: true, terminal: "konsole" });
});

test("no terminal at all is a plain failure the window can explain", async () => {
  assert.deepEqual(await L.openLoginTerminal("codex", null, { platform: "linux", launch: () => Promise.resolve(false) }),
    { ok: false, reason: "no_terminal" });
  assert.deepEqual(await L.openLoginTerminal("codex", null, { platform: "darwin", writeScript: () => "/x.command", launch: () => Promise.resolve(false) }),
    { ok: false, reason: "launch_failed" });
  assert.deepEqual(await L.openLoginTerminal("codex", null, { platform: "darwin", writeScript: () => { throw new Error("EACCES"); } }),
    { ok: false, reason: "launch_failed" });
  assert.deepEqual(await L.openLoginTerminal("codex", null, { platform: "aix" }), { ok: false, reason: "unsupported_platform" });
});

test("the catalogue accepts the three sign-in events", () => {
  const V = require("../out/main/analytics/validate.js");
  assert.deepEqual(V.validateEvent("subscription_login_clicked", { cli: "claude", step: "onboarding" }, "ui").props,
    { cli: "claude", step: "onboarding" });
  const opened = V.validateEvent("subscription_terminal_opened", { cli: "codex", step: "settings", opened: true, terminal: "terminal_app" }, "ui");
  assert.equal(opened.props.terminal, "terminal_app");
  const failed = V.validateEvent("subscription_terminal_opened", { cli: "codex", step: "settings", opened: false, reason: "no_terminal" }, "ui");
  assert.equal(failed.props.reason, "no_terminal");
  const ok = V.validateEvent("subscription_login_succeeded", { cli: "codex", step: "settings", seconds_to_sign_in: 42 }, "ui");
  assert.equal(ok.props.seconds_to_sign_in, 42);
});
