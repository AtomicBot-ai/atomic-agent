// ATO-2459: Install for a My apps app (main/my-apps-install.ts): a launcher in
// the OS app menu that opens atomicagent://app/open?id=<id>
// (main/my-apps-deeplink.ts), recorded in <app>/install.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const A = require("../out/main/my-apps-store.js");
const I = require("../out/main/my-apps-install.js");
const L = require("../out/main/my-apps-deeplink.js");
const D = require("../out/main/deeplink.js");

const fixed = (hex) => () => Buffer.from(hex, "hex");
function setup(platform, extra = {}) {
  const base = mkdtempSync(join(tmpdir(), "my-apps-inst-"));
  const home = join(base, "home");
  const res = join(base, "Resources");
  mkdirSync(home, { recursive: true });
  mkdirSync(res, { recursive: true });
  writeFileSync(join(res, "app-icon.icns"), "icns");
  writeFileSync(join(res, "app-icon.png"), "png");
  const root = join(base, "state", "apps");
  const host = { platform, home, env: {}, execPath: "/opt/Atomic Agent/atomic-agent", resourcesPath: res, ...extra };
  const { app } = A.saveApp(root, { name: "Currency converter", html: "<p>fx</p>" }, Date.now(), fixed("a1b2c3"));
  return { home, root, host, app };
}

test("the launcher opens the app's link, which routes to app-open without a card", () => {
  assert.equal(I.appLaunchLink("fx-a1b2c3"), "atomicagent://app/open?id=fx-a1b2c3");
  const r = D.routeDeeplink("atomicagent://app/open?id=fx-a1b2c3");
  assert.equal(r.ok, true);
  assert.equal(r.request.route, "app-open");
  assert.equal(L.appOpenRequestId(r.request), "fx-a1b2c3");
  for (const bad of ["atomicagent://app/open", "atomicagent://app/open?id=..%2Fx", "atomicagent://app/delete?id=fx-a1b2c3", "atomicagent://app/open?id=a&id=b", "atomicagent://app/open?id=fx-a1b2c3&x=1"]) {
    assert.equal(D.routeDeeplink(bad).ok, false, bad);
  }
  assert.equal(L.appOpenRequestId({ route: "skill-install", id: "fx-a1b2c3" }), null);
});

test("main opens an app link itself, even with no main window, and queues it before Electron is ready", () => {
  let shown = 0, notified = 0;
  const opened = [];
  let electronReady = false;
  // As main.ts: direct answers false until app.isReady().
  const direct = (req) => electronReady && req.route === "app-open" && (opened.push(req.id), true);
  const q = D.createDeeplinkQueue({ showWindow: () => shown++, notify: () => notified++, ready: () => false, log: () => {}, now: () => 0, direct });
  q.handle("atomicagent://app/open?id=fx-a1b2c3");
  assert.deepEqual(opened, [], "before ready: the window takes it when it loads");
  assert.equal(q.take().length, 1);
  electronReady = true;
  // ready() false: the main window is closed (macOS keeps the app running); the app still opens.
  const q2 = D.createDeeplinkQueue({ showWindow: () => shown++, notify: () => notified++, ready: () => false, log: () => {}, now: () => 0, direct });
  q2.handle("atomicagent://app/open?id=fx-a1b2c3");
  assert.deepEqual(opened, ["fx-a1b2c3"]);
  assert.equal(shown, 0, "the main window stays where it was");
  assert.deepEqual(q2.take(), []);
  q2.handle("atomicagent://skill/install?slug=pdf");
  assert.equal(q2.take().length, 1, "other links still go to the card");
});

test("launcher folders and names, per platform", () => {
  assert.equal(I.appShortcutFolder({ platform: "darwin", home: "/Users/n", env: {} }), "/Users/n/Applications/Atomic Apps");
  assert.equal(I.appShortcutFolder({ platform: "linux", home: "/home/n", env: {} }), "/home/n/.local/share/applications");
  assert.equal(I.appShortcutFolder({ platform: "win32", home: "C:\\Users\\n", env: { APPDATA: "C:\\Users\\n\\AppData\\Roaming" } }),
    "C:\\Users\\n\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Atomic Apps");
  assert.equal(I.shortcutBaseName('Tip: "calc" / v2?'), "Tip calc v2");
  assert.equal(I.shortcutBaseName("..."), "App");
  assert.equal(I.shortcutBaseName("CON"), "CON app");
  assert.equal(I.shortcutBaseName("x".repeat(100)).length, 60);
});

test("a Mac launcher is a small .app bundle with the app icon that opens the link", () => {
  const { home, root, host, app } = setup("darwin");
  assert.equal(I.installSupported(host), true);
  const r = I.installApp(host, root, app.id);
  assert.equal(r.ok, true);
  assert.equal(r.path, join(home, "Applications", "Atomic Apps", "Currency converter.app"));
  const plist = readFileSync(join(r.path, "Contents", "Info.plist"), "utf8");
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>launch<\/string>/);
  assert.match(plist, /<key>CFBundleIconFile<\/key><string>icon\.icns<\/string>/);
  assert.match(plist, /io\.atomicagent\.desktop\.app\.currency-converter-a1b2c3/);
  const script = join(r.path, "Contents", "MacOS", "launch");
  assert.equal(readFileSync(script, "utf8"), '#!/bin/sh\nexec /usr/bin/open "atomicagent://app/open?id=currency-converter-a1b2c3"\n');
  assert.equal(statSync(script).mode & 0o111, 0o111, "the launcher is executable");
  assert.equal(readFileSync(join(r.path, "Contents", "Resources", "icon.icns"), "utf8"), "icns");
  assert.equal(I.installedShortcut(host, root, app.id), r.path);
  assert.equal(JSON.parse(readFileSync(join(root, app.id, "install.json"), "utf8")).path, r.path);

  // A rename rewrites it under the new name, and the old bundle goes.
  A.renameApp(root, app.id, "FX <rates>");
  const again = I.installApp(host, root, app.id);
  assert.equal(again.path, join(home, "Applications", "Atomic Apps", "FX rates.app"));
  assert.equal(existsSync(r.path), false);
  assert.match(readFileSync(join(again.path, "Contents", "Info.plist"), "utf8"), /<string>FX &lt;rates&gt;<\/string>/);

  assert.deepEqual(I.uninstallApp(host, root, app.id), { ok: true, removed: true });
  assert.equal(existsSync(again.path), false);
  assert.equal(I.installedShortcut(host, root, app.id), null);
  assert.deepEqual(I.uninstallApp(host, root, app.id), { ok: true, removed: false });
});

test("a Linux launcher is a .desktop entry named after the id, AppImage-aware", () => {
  const { home, root, host, app } = setup("linux", { env: { APPIMAGE: "/home/n/Apps/Atomic Agent.AppImage" } });
  const r = I.installApp(host, root, app.id);
  assert.equal(r.path, join(home, ".local", "share", "applications", `atomic-app-${app.id}.desktop`));
  const entry = readFileSync(r.path, "utf8");
  assert.match(entry, /^\[Desktop Entry\]\nType=Application\nName=Currency converter\n/);
  assert.match(entry, /\nExec="\/home\/n\/Apps\/Atomic Agent\.AppImage" "atomicagent:\/\/app\/open\?id=currency-converter-a1b2c3"\n/);
  assert.match(entry, /\nIcon=.*app-icon\.png\n/);
  assert.match(I.linuxDesktopEntry("x", "a-000000", '/o/a"b$c', null), /Exec="\/o\/a\\\\"b\\\\\$c"/);
});

test("Windows writes a Start menu .lnk through the link writer; unpackaged runs cannot install", () => {
  const links = [];
  const { root, host, app } = setup("win32", {
    home: "C:\\Users\\n", env: { APPDATA: "C:\\Users\\n\\AppData\\Roaming" }, execPath: "C:\\Program Files\\Atomic Agent\\Atomic Agent.exe",
    writeShortcutLink: (path, op, link) => { links.push({ path, op, link }); return true; },
    ensureFolder: (dir) => { links.push({ folder: dir }); },
  });
  const r = I.installApp(host, root, app.id);
  assert.equal(r.ok, true);
  assert.equal(links[0].folder, "C:\\Users\\n\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Atomic Apps");
  links.shift();
  assert.equal(links[0].path, "C:\\Users\\n\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Atomic Apps\\Currency converter.lnk");
  assert.deepEqual(links[0].link, { target: host.execPath, args: "atomicagent://app/open?id=currency-converter-a1b2c3",
    description: "Currency converter, an app from Atomic Agent's My apps", icon: host.execPath, iconIndex: 0 });
  const failing = { ...host, writeShortcutLink: () => false };
  const { app: other } = A.saveApp(root, { name: "Other", html: "<p>o</p>" }, Date.now(), fixed("0f0f0f"));
  assert.deepEqual(I.installApp(failing, root, other.id), { ok: false, reason: "install-failed" });
  assert.equal(I.installSupported({ ...host, writeShortcutLink: undefined }), false);
  assert.equal(I.installSupported({ ...host, resourcesPath: null }), false);
  assert.deepEqual(I.installApp({ ...host, resourcesPath: null }, root, app.id), { ok: false, reason: "install-unsupported" });
  assert.deepEqual(I.installApp(host, root, "../x"), { ok: false, reason: "bad-id" });
  assert.deepEqual(I.installApp(host, root, "gone-000000"), { ok: false, reason: "not-found" });
});

test("a forged install record never removes anything outside the launcher folder", () => {
  const { home, root, host, app } = setup("darwin");
  const precious = join(home, "Documents.app");
  mkdirSync(precious);
  writeFileSync(join(root, app.id, "install.json"), JSON.stringify({ path: precious }));
  assert.deepEqual(I.uninstallApp(host, root, app.id), { ok: true, removed: false });
  assert.equal(existsSync(precious), true);
});

test("the IPC, preload, main hook and packaged icons are wired", () => {
  const ipc = readFileSync(new URL("../main/my-apps-ipc.ts", import.meta.url), "utf8");
  for (const s of ['"apps:versions"', '"apps:restore"', '"apps:install"', '"apps:uninstall"', "uninstallApp(installHost(), root, id)",
    "resourcesPath: app.isPackaged ? process.resourcesPath : null", "shell.writeShortcutLink(path, operation, link)", "win.webContents.reload()"]) {
    assert.ok(ipc.includes(s), s);
  }
  const preload = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  for (const m of ["apps:versions", "apps:restore", "apps:install", "apps:uninstall"]) assert.ok(preload.includes('"' + m + '"'), m);
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.match(main, /direct: \(request\) => app\.isReady\(\) && openAppFromDeeplink\(request\),/);
  const builder = readFileSync(new URL("../electron-builder.cjs", import.meta.url), "utf8");
  assert.match(builder, /"from": "build\/icons\/256x256\.png",\s*"to": "app-icon\.png"/);
  assert.match(builder, /"from": "build\/icon\.icns",\s*"to": "app-icon\.icns"/);
});
