// ATO-2459: Settings › My apps, versions with Restore and Install / Uninstall
// (renderer/my-apps-more.js), and a launcher's link taken by the renderer
// (renderer/deeplink.js) opening the app with no card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const calls = [];
const VERSIONS = [{ version: 2, savedAt: "2026-11-27T14:05:00Z", bytes: 2048 }, { version: 1, savedAt: "2026-11-26T09:00:00Z", bytes: 100 }];
globalThis.window = {};
globalThis.BR = {
  appsList: async () => ({ ok: true, apps: [], install: { supported: true } }),
  appsOpen: async (id) => { calls.push(["open", id]); return id === "gone-000000" ? { ok: false, reason: "not-found" } : { ok: true }; },
  appsVersions: async (id) => { calls.push(["versions", id]); return { ok: true, versions: VERSIONS }; },
  appsRestore: async (id, n) => { calls.push(["restore", id, n]); return { ok: true, app: { id, name: "Fx", updatedAt: "2026-11-28T00:00:00Z" }, kept: { version: 3 } }; },
  appsInstall: async (id) => { calls.push(["install", id]); return { ok: true, path: "/x" }; },
  appsUninstall: async (id) => { calls.push(["uninstall", id]); return { ok: true, removed: true }; },
  deeplinkTake: async () => [],
};
globalThis.S = { settings: 1, settingsPane: "myapps", sessionId: "chat-7" };
globalThis.settingsPaneId = (p) => p;
globalThis.paneRepaintKeepFocus = () => {};
globalThis.render = () => {};
globalThis.PLATFORM = "darwin";
const toasts = [];
globalThis.toast = (t, s, kind) => toasts.push({ t, s, kind });
globalThis.esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
globalThis.ic = (n) => "<i:" + n + ">";

const X = require("../renderer/my-apps-more.js");
Object.assign(globalThis, X);
const M = require("../renderer/my-apps.js");
Object.assign(globalThis, { MA: M.MA, maReasonText: M.maReasonText });
// my-apps.js reads these at call time; in the page they are globals of the same script scope.
for (const k of ["maCall", "maRepaint", "maRefresh"]) if (M[k]) globalThis[k] = M[k];
const DL = require("../renderer/deeplink.js");

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await tick(); }
}

const APP = { id: "fx-a1b2c3", name: "Fx", createdAt: "2026-11-27T10:00:00Z", installed: false, versions: 2 };

test("a row offers Install when this build can, Uninstall once installed, and Versions when there are some", () => {
  M.MA.apps = [APP];
  M.MA.installSupported = true;
  let html = M.myAppsTab();
  assert.match(html, /data-act="myapps:install:fx-a1b2c3"/);
  assert.match(html, /data-act="myapps:versions:fx-a1b2c3"/);
  M.MA.apps = [{ ...APP, installed: true, versions: 0 }];
  html = M.myAppsTab();
  assert.match(html, /data-act="myapps:uninstall:fx-a1b2c3"/);
  assert.doesNotMatch(html, /myapps:versions:/);
  M.MA.installSupported = false;
  assert.doesNotMatch(M.myAppsTab(), /myapps:(un)?install:/, "an unpackaged run shows no Install");
});

test("Versions opens a list with Restore, which asks once, then restores and keeps the replaced page", async () => {
  M.MA.apps = [APP];
  M.myAppsAct("versions:fx-a1b2c3");
  await until(() => X.MAV.list !== null);
  let html = M.myAppsTab();
  assert.match(html, /Version 2 · .*2026.* · 2 KB/);
  assert.match(html, /data-act="myapps:restore:fx-a1b2c3:1"/);
  M.myAppsAct("restore:fx-a1b2c3:1");
  html = M.myAppsTab();
  assert.match(html, /Put this version back\? The current page is kept as a version\./);
  assert.match(html, /data-act="myapps:restoreConfirm:fx-a1b2c3:1"/);
  assert.equal(calls.some((c) => c[0] === "restore"), false, "the first click only asks");
  M.myAppsAct("restoreConfirm:fx-a1b2c3:1");
  await until(() => calls.some((c) => c[0] === "restore"));
  assert.deepEqual(calls.find((c) => c[0] === "restore"), ["restore", "fx-a1b2c3", 1]);
  await until(() => !M.MA.busy);
  assert.match(M.MA.msg, /^Version 1 of Fx is back\./);
  assert.equal(M.MA.apps[0].versions, 3);
  M.myAppsAct("versions:fx-a1b2c3");
  assert.equal(X.MAV.open, null, "a second click closes the list");
  X.MAV.list = [];
  X.MAV.open = "fx-a1b2c3";
  assert.match(X.maxVersionsHTML(APP), /No earlier versions/);
  X.myAppsMoreReset();
});

test("bad arguments do nothing", () => {
  const before = calls.length;
  M.myAppsAct('restoreConfirm:x"];:1');
  M.myAppsAct("restoreConfirm:fx-a1b2c3:0");
  M.myAppsAct("install:../x");
  assert.equal(calls.length, before);
});

test("Install says where the app is now, in this OS's words", async () => {
  M.MA.apps = [APP];
  M.MA.installSupported = true;
  M.myAppsAct("install:fx-a1b2c3");
  await until(() => M.MA.apps[0].installed === true);
  assert.equal(M.MA.msg, "Fx is installed. Find it in Launchpad or Spotlight.");
  assert.equal(X.maxInstalledWhere("win32"), "Find it in the Start menu.");
  assert.equal(X.maxInstalledWhere("linux"), "Find it in your app menu.");
  await until(() => !M.MA.busy);
  M.myAppsAct("uninstall:fx-a1b2c3");
  await until(() => M.MA.apps[0].installed === false);
  assert.match(M.MA.msg, /removed from your apps\. It is still in My apps\./);
});

test("a launcher's link opens its app without a card; a gone app says so", async () => {
  await DL.deeplinkOpenApp({ route: "app-open", id: "fx-a1b2c3" });
  assert.deepEqual(calls.at(-1), ["open", "fx-a1b2c3"]);
  await DL.deeplinkOpenApp({ route: "app-open", id: "gone-000000" });
  assert.equal(toasts.at(-1).t, "Could not open the app");
  const before = calls.length;
  await DL.deeplinkOpenApp({ route: "app-open", id: "../x" });
  assert.equal(calls.length, before);
  const src = readFileSync(new URL("../renderer/deeplink.js", import.meta.url), "utf8");
  assert.match(src, /for \(const q of list\) if \(q && q\.route === 'app-open'\) deeplinkOpenApp\(q\);/);
});

test("index.html loads my-apps-more.js before my-apps.js, and its stylesheet", () => {
  const idx = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.ok(idx.indexOf('<script src="my-apps-more.js"></script>') > 0);
  assert.ok(idx.indexOf('<script src="my-apps-more.js"></script>') < idx.indexOf('<script src="my-apps.js"></script>'));
  assert.ok(idx.includes('<link rel="stylesheet" href="css/my-apps.css">'));
});
