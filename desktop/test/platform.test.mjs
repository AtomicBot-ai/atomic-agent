// Unit tests for main/platform.ts, against the built output. Every function
// takes the platform as an argument, so the Windows and Linux arms run here
// on any host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../out/main/platform.js");

test("macOS agent candidates are exactly the list the app always used", () => {
  const got = P.agentBinaryCandidates({
    platform: "darwin",
    home: "/Users/me",
    env: {},
    resourcesPath: "/Applications/Atomic Agent.app/Contents/Resources",
  });
  assert.deepEqual(got, [
    "/Applications/Atomic Agent.app/Contents/Resources/agent/atomic-agent",
    "/Users/me/atag-agent/bin/atag",
    "/Users/me/.local/bin/atag",
    "/Users/me/.local/bin/atomic-agent",
    "/usr/local/bin/atag",
    "/opt/homebrew/bin/atag",
  ]);
});

test("the ATOMIC_AGENT_BIN override leads on every platform", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const got = P.agentBinaryCandidates({ platform, home: "/h", env: { ATOMIC_AGENT_BIN: "/x/agent" } });
    assert.equal(got[0], "/x/agent", platform);
  }
});

test("Windows candidates are .exe files only, bundled first, then install.ps1's folder", () => {
  const got = P.agentBinaryCandidates({
    platform: "win32",
    home: "C:\\Users\\me",
    env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
    resourcesPath: "C:\\Program Files\\Atomic Agent\\resources",
  });
  assert.deepEqual(got, [
    "C:\\Program Files\\Atomic Agent\\resources\\agent\\atomic-agent.exe",
    "C:\\Users\\me\\AppData\\Local\\atomic-agent\\atomic-agent.exe",
    "C:\\Users\\me\\.local\\bin\\atomic-agent.exe",
    "C:\\Users\\me\\atag-agent\\bin\\atomic-agent.exe",
  ]);
  for (const c of got) assert.ok(!/\.cmd$/i.test(c), `${c} is a batch shim`);
});

test("Windows honours ATOMIC_AGENT_INSTALL_DIR and falls back without LOCALAPPDATA", () => {
  const got = P.agentBinaryCandidates({
    platform: "win32",
    home: "C:\\Users\\me",
    env: { ATOMIC_AGENT_INSTALL_DIR: "D:\\tools\\aa" },
  });
  assert.equal(got[0], "D:\\tools\\aa\\atomic-agent.exe");
  assert.equal(got[1], "C:\\Users\\me\\AppData\\Local\\atomic-agent\\atomic-agent.exe");
});

test("Linux candidates: bundled, ~/.local/bin, system prefixes, no Homebrew", () => {
  const got = P.agentBinaryCandidates({ platform: "linux", home: "/home/me", env: {}, resourcesPath: "/opt/Atomic Agent/resources" });
  assert.deepEqual(got, [
    "/opt/Atomic Agent/resources/agent/atomic-agent",
    "/home/me/atag-agent/bin/atag",
    "/home/me/.local/bin/atag",
    "/home/me/.local/bin/atomic-agent",
    "/usr/local/bin/atag",
    "/home/linuxbrew/.linuxbrew/bin/atag",
  ]);
});

test("the install hint names the platform's installer", () => {
  assert.match(P.installHint("darwin"), /curl -fsSL https:\/\/atomicagent\.io\/install \| sh/);
  assert.match(P.installHint("linux"), /curl -fsSL/);
  assert.match(P.installHint("win32"), /irm https:\/\/atomicagent\.io\/install\.ps1 \| iex/);
});

test("stop strategy: signals on POSIX, a taskkill tree kill on Windows", () => {
  assert.deepEqual(P.stopPlan("darwin", 42), { kind: "signals", first: "SIGTERM", then: "SIGKILL" });
  assert.deepEqual(P.stopPlan("linux", 42), { kind: "signals", first: "SIGTERM", then: "SIGKILL" });
  assert.deepEqual(P.stopPlan("win32", 42, "C:\\WINDOWS"), {
    kind: "taskkill",
    command: "C:\\WINDOWS\\System32\\taskkill.exe",
    args: ["/PID", "42", "/T", "/F"],
  });
  assert.equal(P.stopPlan("win32", 7).command, "C:\\Windows\\System32\\taskkill.exe");
});

test("command-line probe: ps on macOS, /proc on Linux, CIM on Windows", () => {
  assert.deepEqual(P.commandLineProbe("darwin", 9), { kind: "exec", command: "/bin/ps", args: ["-o", "command=", "-p", "9"] });
  assert.deepEqual(P.commandLineProbe("linux", 9), { kind: "procfs", file: "/proc/9/cmdline" });
  const w = P.commandLineProbe("win32", 9);
  assert.equal(w.kind, "exec");
  assert.match(w.command, /powershell\.exe$/);
  assert.ok(w.args.at(-1).includes("ProcessId=9"));
  assert.equal(P.procCmdline(["/usr/bin/atag", "serve", "--port", "123", ""].join("\u0000")), "/usr/bin/atag serve --port 123");
});

test("serve recognition matches POSIX and Windows command lines, and nothing else", () => {
  assert.ok(P.looksLikeServeCommand("/Users/me/.local/bin/atag serve --host 127.0.0.1 --port 5000 --api-key x", 5000));
  assert.ok(P.looksLikeServeCommand("atomic-agent serve --port 5000", 5000));
  assert.ok(P.looksLikeServeCommand("\"C:\\Program Files\\Atomic Agent\\resources\\agent\\atomic-agent.exe\" serve --host 127.0.0.1 --port 5000", 5000));
  assert.ok(P.looksLikeServeCommand("C:\\x\\atomic-agent.exe serve --port 5000", 5000));
  assert.ok(!P.looksLikeServeCommand("/usr/bin/atag serve --port 5001", 5000));
  assert.ok(!P.looksLikeServeCommand("/usr/bin/python serve --port 5000", 5000));
  assert.ok(!P.looksLikeServeCommand("/usr/bin/atag models --port 5000", 5000));
});

test("path containment follows each platform's rules", () => {
  assert.ok(P.isUnder("darwin", "/Users/me/.aad", "/Users/me/.aad"));
  assert.ok(P.isUnder("darwin", "/Users/me/.aad", "/Users/me/.aad/x/y"));
  assert.ok(!P.isUnder("darwin", "/Users/me/.aad", "/Users/me/.aad-other"));
  assert.ok(!P.isUnder("darwin", "/Users/me/.aad", "rel/.aad"));
  assert.ok(P.isUnder("win32", "C:\\Users\\me\\.aad", "C:\\Users\\me\\.aad\\x"));
  assert.ok(P.isUnder("win32", "C:\\Users\\me\\.aad", "c:/users/ME/.aad/x"));
  assert.ok(!P.isUnder("win32", "C:\\Users\\me\\.aad", "C:\\Users\\me\\.aad-other"));
  assert.ok(!P.isUnder("win32", "C:\\Users\\me\\.aad", "Users\\me\\.aad\\x"));
  assert.ok(P.isAbsoluteOn("win32", "C:\\x"));
  assert.ok(P.isAbsoluteOn("win32", "\\\\server\\share\\x"));
  assert.ok(!P.isAbsoluteOn("win32", "x\\y"));
  assert.ok(P.isAbsoluteOn("darwin", "/x"));
  assert.ok(!P.isAbsoluteOn("darwin", "C:\\x"));
});

test("trailing separators, last segments and ~ expansion per platform", () => {
  assert.equal(P.trimTrailingSep("darwin", "/a/b///"), "/a/b");
  assert.equal(P.trimTrailingSep("darwin", "/a\\"), "/a\\");
  assert.equal(P.trimTrailingSep("win32", "C:\\a\\b\\"), "C:\\a\\b");
  assert.equal(P.trimTrailingSep("win32", "C:\\"), "C:\\");
  assert.equal(P.lastSegment("darwin", "/Users/me/proj"), "proj");
  assert.equal(P.lastSegment("darwin", "/"), undefined);
  assert.equal(P.lastSegment("win32", "C:\\Users\\me\\proj\\"), "proj");
  assert.equal(P.expandHome("darwin", "~/x", "/Users/me"), "/Users/me/x");
  assert.equal(P.expandHome("darwin", "~\\x", "/Users/me"), "~\\x");
  assert.equal(P.expandHome("win32", "~\\x", "C:\\Users\\me"), "C:\\Users\\me\\x");
});

test("window chrome: inset lights on macOS, overlay controls on Windows, a frame on Linux", () => {
  assert.deepEqual(P.windowChrome("darwin"), {
    titleBarStyle: "hiddenInset", trafficLightPosition: { x: 20, y: 20 }, vibrancy: "sidebar",
  });
  const w = P.windowChrome("win32");
  assert.equal(w.titleBarStyle, "hidden");
  assert.equal(w.titleBarOverlay.height, P.TOOLBAR_HEIGHT);
  assert.equal(w.trafficLightPosition, undefined);
  assert.equal(w.vibrancy, undefined);
  const l = P.windowChrome("linux");
  assert.equal(l.titleBarStyle, undefined);
  assert.equal(l.titleBarOverlay, undefined);
  assert.notDeepEqual(P.titleBarOverlayColors(true), P.titleBarOverlayColors(false));
});

test("voice input and the file-manager label are platform facts", () => {
  assert.equal(P.voiceSupported("darwin"), true);
  assert.equal(P.voiceSupported("win32"), false);
  assert.equal(P.voiceSupported("linux"), false);
  assert.equal(P.fileManagerLabel("darwin"), "Show in Finder");
  assert.equal(P.fileManagerLabel("win32"), "Show in Explorer");
  assert.equal(P.bundledAgentFileName("win32"), "atomic-agent.exe");
  assert.equal(P.bundledAgentFileName("darwin"), "atomic-agent");
});
