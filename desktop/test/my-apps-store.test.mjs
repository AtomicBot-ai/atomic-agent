// ATO-2383: My apps. An artifact page saved as an app lives in
// <stateDir>/apps/<id>/ (main/my-apps-store.ts) and runs in a window of its
// own, locked down (main/my-apps-ipc.ts), under the artifact CSP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const A = require("../out/main/my-apps-store.js");
const F = require("../out/main/artifact-frame.js");

const fixed = (hex) => () => Buffer.from(hex, "hex");
function tmpRoot() { return join(mkdtempSync(join(tmpdir(), "my-apps-")), "apps"); }

test("an app id is a lowercase slug and nothing that could leave the apps folder", () => {
  for (const ok of ["todo-a1b2c3", "app-000000", "x", "a1-b2-c3"]) assert.equal(A.isAppId(ok), true, ok);
  for (const bad of ["", "..", "../x", "a/b", "a\\b", "A-1", "-a", "a-", "a--b", "a b", "a.b", "x".repeat(65), 42, null]) {
    assert.equal(A.isAppId(bad), false, String(bad));
  }
  const root = "/s/apps";
  assert.equal(A.appDir(root, "../etc"), null);
  assert.equal(A.appDir(root, ""), null);
  assert.equal(A.appDir(root, "todo-a1b2c3"), join("/s/apps", "todo-a1b2c3"));
});

test("names are cleaned, ids are slug plus six hex digits", () => {
  assert.equal(A.cleanAppName("  Tip\n calc\t"), "Tip calc");
  assert.equal(A.cleanAppName(""), "Untitled app");
  assert.equal(A.cleanAppName(7), "Untitled app");
  assert.equal(A.cleanAppName("x".repeat(200)).length, A.MY_APP_NAME_MAX);
  assert.equal(A.newAppId("Tip Calculator!", fixed("abcdef")), "tip-calculator-abcdef");
  assert.equal(A.newAppId("Привет", fixed("010203")), "app-010203");
  assert.equal(A.isAppId(A.newAppId("Café ☕ timer")), true);
});

test("the app CSP is the artifact CSP with an origin of its own, and still no network", () => {
  const csp = A.MY_APP_CSP;
  for (const d of F.ARTIFACT_CSP.split(/;\s*/).filter((x) => !x.startsWith("sandbox"))) assert.ok(csp.includes(d), d);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /sandbox allow-scripts allow-same-origin$/);
  assert.equal(csp.match(/sandbox/g).length, 1);
  assert.doesNotMatch(csp, /allow-popups|allow-top-navigation|allow-forms/);
  const h = A.appHeaders();
  assert.equal(h["Content-Security-Policy"], csp);
  assert.equal(h["Permissions-Policy"], F.ARTIFACT_PERMISSIONS_POLICY);
});

test("URLs and partitions name one app; requests off its own page are refused", () => {
  assert.equal(A.appUrl("todo-a1b2c3"), "atomic-app://todo-a1b2c3/");
  assert.equal(A.appPartition("todo-a1b2c3"), "persist:atomic-app-todo-a1b2c3");
  assert.equal(A.appIdFromUrl("atomic-app://todo-a1b2c3/"), "todo-a1b2c3");
  assert.equal(A.appIdFromUrl("atomic-app://todo-a1b2c3/index.html?x=1"), "todo-a1b2c3");
  assert.equal(A.appIdFromUrl("atomic-app://todo-a1b2c3/../../etc/passwd"), null);
  assert.equal(A.appIdFromUrl("atomic-app://todo-a1b2c3/app.json"), null);
  assert.equal(A.appIdFromUrl("https://todo-a1b2c3/"), null);
  assert.equal(A.appRequestAllowed("atomic-app://todo-a1b2c3/", "todo-a1b2c3"), true);
  assert.equal(A.appRequestAllowed("data:image/png;base64,AA", "todo-a1b2c3"), true);
  assert.equal(A.appRequestAllowed("atomic-app://other-000000/", "todo-a1b2c3"), false);
  assert.equal(A.appRequestAllowed("https://example.com/x.js", "todo-a1b2c3"), false);
  assert.equal(A.appRequestAllowed("file:///etc/passwd", "todo-a1b2c3"), false);
});

test("save writes index.html and app.json, list reads them back newest first", () => {
  const root = tmpRoot();
  assert.deepEqual(A.listApps(root), []);
  const a = A.saveApp(root, { name: "Tip calc", html: "<h1>tip</h1>", chatId: "s-42" }, Date.UTC(2026, 10, 1), fixed("aaaaaa"));
  assert.equal(a.ok, true);
  assert.equal(a.app.id, "tip-calc-aaaaaa");
  assert.equal(a.app.sourceChatId, "s-42");
  assert.equal(a.app.createdAt, "2026-11-01T00:00:00.000Z");
  assert.equal(readFileSync(join(root, "tip-calc-aaaaaa", "index.html"), "utf8"), "<h1>tip</h1>");
  const manifest = JSON.parse(readFileSync(join(root, "tip-calc-aaaaaa", "app.json"), "utf8"));
  assert.equal(manifest.name, "Tip calc");
  assert.equal(manifest.bytes, 12);
  const b = A.saveApp(root, { name: "Timer", html: "<p>t</p>", chatId: "bad id with spaces" }, Date.UTC(2026, 10, 5), fixed("bbbbbb"));
  assert.equal(b.app.sourceChatId, undefined);
  assert.deepEqual(A.listApps(root).map((x) => x.id), ["timer-bbbbbb", "tip-calc-aaaaaa"]);
});

test("a folder without a valid manifest, or with a mismatched id, is not listed", () => {
  const root = tmpRoot();
  mkdirSync(join(root, "half-000000"), { recursive: true });
  writeFileSync(join(root, "half-000000", "index.html"), "<p>x</p>");
  mkdirSync(join(root, "liar-000000"), { recursive: true });
  writeFileSync(join(root, "liar-000000", "app.json"), JSON.stringify({ id: "other-000000", name: "x", createdAt: "2026-11-01T00:00:00Z" }));
  mkdirSync(join(root, "Bad Name"), { recursive: true });
  assert.deepEqual(A.listApps(root), []);
  assert.equal(A.parseManifest("{not json", "x"), null);
  assert.equal(A.parseManifest({ id: "x", createdAt: "nope" }, "x"), null);
});

test("empty and oversized pages are refused, as an artifact is", () => {
  const root = tmpRoot();
  assert.deepEqual(A.saveApp(root, { name: "x", html: "   " }), { ok: false, reason: "empty" });
  assert.deepEqual(A.saveApp(root, { name: "x", html: 5 }), { ok: false, reason: "empty" });
  assert.deepEqual(A.saveApp(root, { name: "x", html: "a".repeat(F.ARTIFACT_MAX_BYTES + 1) }), { ok: false, reason: "too-large" });
  assert.equal(existsSync(root), false);
});

test("rename keeps the page and the created date; delete removes the folder; bad ids are refused", () => {
  const root = tmpRoot();
  const { app } = A.saveApp(root, { name: "Old", html: "<p>keep</p>" }, Date.UTC(2026, 10, 1), fixed("cccccc"));
  const r = A.renameApp(root, app.id, "  New name ", Date.UTC(2026, 10, 2));
  assert.equal(r.ok, true);
  assert.equal(r.app.name, "New name");
  assert.equal(r.app.createdAt, app.createdAt);
  assert.equal(r.app.updatedAt, "2026-11-02T00:00:00.000Z");
  assert.equal(A.readApp(root, app.id).html, "<p>keep</p>");
  assert.equal(A.listApps(root)[0].name, "New name");
  assert.deepEqual(A.renameApp(root, "../x", "y"), { ok: false, reason: "bad-id" });
  assert.deepEqual(A.renameApp(root, "gone-000000", "y"), { ok: false, reason: "not-found" });
  assert.deepEqual(A.deleteAppFiles(root, "../.."), { ok: false, reason: "bad-id" });
  assert.deepEqual(A.deleteAppFiles(root, app.id), { ok: true });
  assert.equal(existsSync(join(root, app.id)), false);
  assert.deepEqual(A.deleteAppFiles(root, app.id), { ok: false, reason: "not-found" });
});

test("the scheme serves an app's own page under the app CSP, and nothing else", () => {
  const root = tmpRoot();
  const { app } = A.saveApp(root, { name: "Clock", html: "<script>1</script>" }, Date.now(), fixed("dddddd"));
  const ok = A.appResponse(root, A.appUrl(app.id), app.id);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["Content-Security-Policy"], A.MY_APP_CSP);
  assert.match(ok.body, /^<!doctype html>/);
  assert.match(ok.body, /<script>1<\/script>$/);
  assert.equal(A.appResponse(root, A.appUrl(app.id), "other-000000").status, 404);
  assert.equal(A.appResponse(root, "atomic-app://" + app.id + "/app.json", app.id).status, 404);
  rmSync(join(root, app.id, "index.html"));
  assert.equal(A.appResponse(root, A.appUrl(app.id), app.id).status, 404);
});

test("the app window is locked down and wired once from main", () => {
  const ipc = readFileSync(new URL("../main/my-apps-ipc.ts", import.meta.url), "utf8");
  for (const s of ["sandbox: true", "contextIsolation: true", "nodeIntegration: false", "webviewTag: false",
    "partition: appPartition(id)", 'setWindowOpenHandler(() => ({ action: "deny" }))', 'on("will-navigate", (event) => event.preventDefault())',
    "setPermissionRequestHandler((_wc, _perm, cb) => cb(false))", "setPermissionCheckHandler(() => false)",
    'on("will-download", (event) => event.preventDefault())', "appRequestAllowed(details.url, id)", "shell.trashItem(dir)"]) {
    assert.ok(ipc.includes(s), s);
  }
  assert.doesNotMatch(ipc, /preload:/);
  // The helpers above must actually run for every app window, not just exist.
  const open = ipc.slice(ipc.indexOf("function openApp("), ipc.indexOf("let wired"));
  assert.match(open, /\n  appSession\(root, id\);/, "openApp wires the app's session");
  assert.match(open, /\n  lockDown\(win\.webContents\);/, "openApp locks the window down");
  const lock = ipc.slice(ipc.indexOf("function lockDown("), ipc.indexOf("function openApp("));
  assert.match(lock, /on\("will-prevent-unload", \(event\) => event\.preventDefault\(\)\)/, "a page's beforeunload cannot hold the window");
  assert.match(lock, /setWebRTCIPHandlingPolicy\("disable_non_proxied_udp"\)/);
  const scheme = readFileSync(new URL("../main/artifact-frame-ipc.ts", import.meta.url), "utf8");
  assert.match(scheme, /\{ scheme: MY_APP_SCHEME, privileges: \{ standard: true, secure: true/);
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.match(main, /wireMyAppsIpc\(\{ mainWindow: \(\) => win \}\)/);
  const preload = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  for (const m of ["apps:save", "apps:list", "apps:rename", "apps:delete", "apps:open"]) assert.ok(preload.includes('"' + m + '"'), m);
});

test("a saved widget keeps the bridge names: sendPrompt does nothing, state lives in localStorage", async () => {
  const doc = A.appDocument("<p>hi</p>");
  assert.ok(doc.indexOf(A.MY_APP_BRIDGE_SHIM) > 0 && doc.indexOf(A.MY_APP_BRIDGE_SHIM) < doc.indexOf("<p>hi</p>"), "the shim runs before the page");
  const script = A.MY_APP_BRIDGE_SHIM.replace(/^<script>/, "").replace(/<\/script>$/, "");
  const store = new Map();
  const win = { localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) } };
  win.window = win;
  vm.runInNewContext(script, vm.createContext(win));
  assert.equal(win.sendPrompt("I pick B"), false);
  assert.equal(win.atomicWidget.sendPrompt, win.sendPrompt);
  assert.equal(await win.atomicWidget.state.get(), null);
  assert.equal(win.atomicWidget.state.set({ clicks: 3 }), true);
  assert.equal(JSON.stringify(await win.atomicWidget.state.get()), "{\"clicks\":3}");
  assert.equal(win.atomicWidget.state.set("x".repeat(A.MY_APP_STATE_MAX)), false, "over 64 KB");
  const cyc = {}; cyc.me = cyc;
  assert.equal(win.atomicWidget.state.set(cyc), false);
  assert.equal(JSON.stringify(await win.atomicWidget.state.get()), "{\"clicks\":3}");
});
