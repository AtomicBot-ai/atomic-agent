// ATO-229: the pure parts of main/updater.ts (versions, release notes, error
// words, updates.json, the test flag) and the update_* analytics events,
// against the built output (npm run build first). The toast, Settings and
// the download are driven by the smoke (--smoke --smoke-task=65).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const U = require("../out/main/updater.js");
const V = require("../out/main/analytics/validate.js");

test("versions compare numerically, a prerelease before its release", () => {
  assert.equal(U.compareVersions("0.0.10", "0.0.9"), 1);
  assert.equal(U.compareVersions("0.7.0", "0.6.12"), 1);
  assert.equal(U.compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(U.compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(U.compareVersions("1.0.0", "1.0.0-beta.1"), 1);
  assert.equal(U.compareVersions("0.0.1", "0.0.2"), -1);
  // semver prerelease order: numbers as numbers, before words; fewer fields first.
  assert.equal(U.compareVersions("1.0.0-beta.10", "1.0.0-beta.9"), 1);
  assert.equal(U.compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(U.compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(U.compareVersions("1.0.0-rc-2", "1.0.0-rc-1"), 1);
});

test("the install waits unless it is known that nothing runs (fails closed)", async () => {
  const idleHealth = async () => ({ busyTurns: 0 });
  const base = { liveTurns: 0, download: false, agentState: "connected", health: idleHealth };
  assert.equal(await U.agentBusy(base), false);
  assert.equal(await U.agentBusy({ ...base, liveTurns: 1 }), true);
  assert.equal(await U.agentBusy({ ...base, download: true }), true);
  assert.equal(await U.agentBusy({ ...base, health: async () => ({ busyTurns: 2 }) }), true);
  // No answer in time, an error, or an answer without busyTurns: busy.
  assert.equal(await U.agentBusy({ ...base, health: () => new Promise(() => {}), timeoutMs: 50 }), true);
  assert.equal(await U.agentBusy({ ...base, health: async () => { throw new Error("down"); } }), true);
  assert.equal(await U.agentBusy({ ...base, health: async () => ({ status: "ok" }) }), true);
  // An agent on its way up may resume turns; one that is not running has none.
  assert.equal(await U.agentBusy({ ...base, agentState: "starting" }), true);
  for (const state of [null, "stopped", "missing-binary"]) {
    assert.equal(await U.agentBusy({ ...base, agentState: state, health: () => new Promise(() => {}) }), false, String(state));
  }
  // ATO-231: `error` after a health_timeout keeps its process, which may run a Telegram turn:
  // only /health saying busyTurns 0 makes it idle. An agent whose process is gone has none.
  const hung = () => new Promise(() => {});
  assert.equal(await U.agentBusy({ ...base, agentState: "error", health: hung, timeoutMs: 50 }), true);
  assert.equal(await U.agentBusy({ ...base, agentState: "error", agentAlive: true, health: hung, timeoutMs: 50 }), true);
  assert.equal(await U.agentBusy({ ...base, agentState: "error", agentAlive: true, health: async () => ({ busyTurns: 1 }) }), true);
  assert.equal(await U.agentBusy({ ...base, agentState: "error", agentAlive: true }), false);
  assert.equal(await U.agentBusy({ ...base, agentState: "error", agentAlive: false, health: hung }), false);
});

test("macOS: no update outside /Applications, for an ad-hoc signed app, or where the user cannot write", () => {
  assert.equal(U.macUpdateBlocker({ inApplications: true, teamId: "MU9G7XKJUL" }), null);
  assert.equal(U.macUpdateBlocker({ inApplications: true, teamId: "MU9G7XKJUL", writable: true }), null);
  assert.match(U.macUpdateBlocker({ inApplications: false, teamId: "MU9G7XKJUL" }), /Applications folder/);
  assert.match(U.macUpdateBlocker({ inApplications: true, teamId: null }), /isn’t signed/);
  // ATO-231: an admin-owned copy run by a standard user says so, not "close and reopen".
  assert.match(U.macUpdateBlocker({ inApplications: true, teamId: "MU9G7XKJUL", writable: false }), /can’t write to.*admin.*~\/Applications/);
});

test("macOS: a codesign that timed out or did not run is no answer, not \"unsigned\"", () => {
  assert.equal(U.codesignTeam(null, "Identifier=io.atomicagent.desktop\nTeamIdentifier=MU9G7XKJUL\n"), "MU9G7XKJUL");
  assert.equal(U.codesignTeam(null, "Signature=adhoc\nTeamIdentifier=not set\n"), null);
  assert.equal(U.codesignTeam({ code: 1 }, "/Applications/Atomic Agent.app: code object is not signed at all\n"), null);
  assert.equal(U.codesignTeam({ killed: true, code: null }, ""), undefined);
  assert.equal(U.codesignTeam({ code: "ENOENT" }, ""), undefined);
  // A killed run that had already printed the answer still has it.
  assert.equal(U.codesignTeam({ killed: true, code: null }, "TeamIdentifier=MU9G7XKJUL\n"), "MU9G7XKJUL");
});

test("Windows: the installer's process is found in tasklist's CSV", () => {
  const out = '"Atomic-Agent-Setup-0.7.0.exe","4312","Console","1","52,108 K"\r\n';
  assert.equal(U.tasklistHasImage(out, "Atomic-Agent-Setup-0.7.0.exe"), true);
  assert.equal(U.tasklistHasImage(out, "atomic-agent-setup-0.7.0.EXE"), true);
  assert.equal(U.tasklistHasImage(out, "Atomic-Agent-Setup-0.6.9.exe"), false);
  assert.equal(U.tasklistHasImage("INFO: No tasks are running which match the specified criteria.\r\n", "Atomic-Agent-Setup-0.7.0.exe"), false);
  assert.equal(U.tasklistHasImage("", "x.exe"), false);
});

test("release notes: one plain line, from markdown, HTML or the per-version list", () => {
  assert.equal(U.firstNotesLine("## What's new\n- Faster downloads"), "What's new");
  assert.equal(U.firstNotesLine("\n\n* **Faster** model downloads\n* fixes"), "Faster model downloads");
  assert.equal(U.firstNotesLine("<h2>Fixes</h2><ul><li>One</li></ul>"), "Fixes");
  assert.equal(U.firstNotesLine([{ version: "1.0.0", note: null }, { version: "0.9.0", note: "Old &amp; good" }]), "Old & good");
  assert.equal(U.firstNotesLine(null), null);
  assert.equal(U.firstNotesLine("   \n  "), null);
  assert.ok(U.firstNotesLine("x".repeat(400)).length <= 160);
});

test("a failed check is put in plain words", () => {
  assert.equal(U.plainUpdateError(new Error("net::ERR_INTERNET_DISCONNECTED")).reason, "offline");
  assert.equal(U.plainUpdateError(new Error("getaddrinfo ENOTFOUND updates.example")).reason, "offline");
  assert.equal(U.plainUpdateError(new Error("HttpError: 404 Not Found\n\"method: GET url: .../stable-mac.yml\"")).reason, "no-feed");
  assert.equal(U.plainUpdateError(new Error("Cannot find channel \"stable-mac.yml\" update info")).reason, "no-feed");
  assert.equal(U.plainUpdateError(new Error("something else")).reason, "other");
  // No raw error text reaches the window.
  assert.doesNotMatch(U.plainUpdateError(new Error("secret /Users/me/path")).message, /secret|Users/);
});

test("updates.json: automatic checks default on; junk is dropped", () => {
  assert.deepEqual(U.coerceUpdatePrefs(null), { autoCheck: true, skippedVersion: null, lastDismissed: null, pendingInstall: null });
  assert.deepEqual(
    U.coerceUpdatePrefs({ autoCheck: false, skippedVersion: "0.7.0", lastDismissed: { version: "0.7.1", at: 5 }, pendingInstall: { from: "0.6.0", to: "0.7.1", at: 6 } }),
    { autoCheck: false, skippedVersion: "0.7.0", lastDismissed: { version: "0.7.1", at: 5 }, pendingInstall: { from: "0.6.0", to: "0.7.1", at: 6 } },
  );
  const junk = U.coerceUpdatePrefs({ autoCheck: "no", skippedVersion: "../../etc", lastDismissed: { version: "x" }, pendingInstall: { to: "1.0.0" } });
  assert.deepEqual(junk, { autoCheck: true, skippedVersion: null, lastDismissed: null, pendingInstall: null });
});

test("--fake-update takes a version and nothing else", () => {
  assert.equal(U.fakeUpdateArg(["electron", ".", "--fake-update=0.0.9"]), "0.0.9");
  assert.equal(U.fakeUpdateArg(["electron", ".", "--fake-update=latest"]), null);
  assert.equal(U.fakeUpdateArg(["electron", "."]), null);
});

test("update_* events carry a version and fixed words only", () => {
  const ok = V.validateEvent("update_available", { version: "0.7.0", trigger: "auto" }, "main");
  assert.deepEqual(ok.props, { version: "0.7.0", trigger: "auto" });
  assert.equal("version" in V.validateEvent("update_accepted", { version: "/Users/me" }, "main").props, false);
  assert.equal("via" in V.validateEvent("update_dismissed", { version: "0.7.0", via: "nope" }, "main").props, false);
  assert.deepEqual(V.validateEvent("update_installed", { version: "0.7.0", from_version: "0.6.9" }, "main").props,
    { version: "0.7.0", from_version: "0.6.9" });
  // Main's events only: the window cannot send them.
  assert.equal(V.validateEvent("update_skipped", { version: "0.7.0" }, "ui"), null);
});
