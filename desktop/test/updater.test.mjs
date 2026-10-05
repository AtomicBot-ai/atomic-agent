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
