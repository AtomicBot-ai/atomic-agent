// Unit tests for ATO-532 (a snapshot of an app window attached to the chat):
// main/window-snapshot.ts (against the built output), the pure half of
// renderer/window-snapshot.js, and the wiring read from the sources.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/window-snapshot.js");
const R = require("../renderer/window-snapshot.js");
const { menuTemplate } = require("../out/main/menu.js");

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ---------- which windows are offered ---------- */

test("nativeWindowId reads the native id of a window source, and nothing else", () => {
  assert.equal(M.nativeWindowId("window:1234:0"), "1234");
  assert.equal(M.nativeWindowId("window:1234:1"), "1234");
  assert.equal(M.nativeWindowId("window:1234"), "1234");
  assert.equal(M.nativeWindowId("screen:0:0"), null);
  assert.equal(M.nativeWindowId("window:abc:0"), null);
  assert.equal(M.nativeWindowId(""), null);
  assert.equal(M.nativeWindowId(undefined), null);
});

test("the picker never offers this app's own windows, even when the trailing part differs", () => {
  const sources = [
    { id: "window:10:0", name: "Atomic Agent" },
    { id: "window:11:0", name: "Terminal — zsh" },
    { id: "window:12:0", name: "Connect to Another Computer" },
    { id: "window:13:0", name: "Safari" },
  ];
  const out = M.pickerSources(sources, ["window:10:1", "window:12:0"]);
  assert.deepEqual(out.map((s) => s.id), ["window:11:0", "window:13:0"]);
});

test("the picker keeps the system's order and drops untitled, pictureless, repeated and non-window sources", () => {
  const sources = [
    { id: "window:3:0", name: "Front" },
    { id: "screen:1:0", name: "Entire screen" },
    { id: "window:4:0", name: "   " },
    { id: "window:5:0", name: "Minimized", thumbEmpty: true },
    { id: "window:3:0", name: "Front again" },
    { id: "window:6:0", name: "Back" },
    null,
    { id: 7, name: "bad id" },
  ];
  const out = M.pickerSources(sources, []);
  assert.deepEqual(out.map((s) => s.name), ["Front", "Back"]);
});

test("the picker keeps whatever else a source carries (the capturer's own object rides along)", () => {
  const thing = {};
  const out = M.pickerSources([{ id: "window:1:0", name: "A", src: thing }], []);
  assert.equal(out[0].src, thing);
});

test("the picker offers at most PICKER_MAX windows", () => {
  const many = Array.from({ length: M.PICKER_MAX + 15 }, (_, i) => ({ id: `window:${i + 1}:0`, name: `W${i}` }));
  assert.equal(M.pickerSources(many, []).length, M.PICKER_MAX);
});

/* ---------- the snapshot's size and name ---------- */

test("fitLongSide scales the long side down to the limit and keeps the aspect ratio", () => {
  assert.deepEqual(M.fitLongSide(3840, 2160, 1920), { width: 1920, height: 1080 });
  assert.deepEqual(M.fitLongSide(1200, 2400, 1920), { width: 960, height: 1920 });
  assert.deepEqual(M.fitLongSide(2000, 2000, 1920), { width: 1920, height: 1920 });
});

test("fitLongSide never scales up, and a size with no area is 0x0", () => {
  assert.deepEqual(M.fitLongSide(800, 600, 1920), { width: 800, height: 600 });
  assert.deepEqual(M.fitLongSide(1920, 10, 1920), { width: 1920, height: 10 });
  assert.deepEqual(M.fitLongSide(0, 600, 1920), { width: 0, height: 0 });
  assert.deepEqual(M.fitLongSide(NaN, 600, 1920), { width: 0, height: 0 });
  assert.deepEqual(M.fitLongSide(-5, 600, 1920), { width: 0, height: 0 });
});

test("fitLongSide keeps at least one pixel on a very thin window", () => {
  assert.deepEqual(M.fitLongSide(10000, 2, 1920), { width: 1920, height: 1 });
});

test("the attached picture is at most 1920 px on its long side", () => {
  assert.equal(M.SNAPSHOT_MAX_PX, 1920);
  assert.ok(M.PICKER_THUMB_PX < M.SNAPSHOT_MAX_PX, "the picker's pictures are small");
});

test("snapshotFileName is a plain, short name the composer reads as an image", () => {
  assert.equal(M.snapshotFileName("Terminal — zsh — 80×24"), "window-terminal-zsh-80-24.png");
  assert.equal(M.snapshotFileName("Café: menu", "jpg"), "window-cafe-menu.jpg");
  assert.equal(M.snapshotFileName("../../etc/passwd"), "window-etc-passwd.png");
  assert.equal(M.snapshotFileName("Документ"), "window.png");
  assert.equal(M.snapshotFileName(""), "window.png");
  const long = M.snapshotFileName("a".repeat(30) + " " + "b".repeat(30));
  assert.ok(long.length <= "window-".length + 48 + ".png".length);
  assert.doesNotMatch(long, /-\.png$/);
});

/* ---------- the macOS permission ---------- */

test("only macOS without Screen Recording permission is refused", () => {
  assert.equal(M.screenAccessVerdict("darwin", "granted"), "ok");
  for (const s of ["denied", "not-determined", "restricted", "unknown", null]) {
    assert.equal(M.screenAccessVerdict("darwin", s), "permission", String(s));
  }
  assert.equal(M.screenAccessVerdict("win32", null), "ok");
  assert.equal(M.screenAccessVerdict("linux", null), "ok");
});

test("the permission message names the exact System Settings place", () => {
  assert.match(M.SCREEN_PERMISSION_MESSAGE, /System Settings → Privacy & Security → Screen & System Audio Recording/);
});

/* ---------- the renderer's pure half ---------- */

const PIC = "data:image/png;base64,iVBORw0KGgo=";

test("only an image data: URL from main goes into an <img>", () => {
  assert.equal(R.wsnapSafeImage(PIC), PIC);
  assert.equal(R.wsnapSafeImage("data:image/jpeg;base64,/9j/4A=="), "data:image/jpeg;base64,/9j/4A==");
  assert.equal(R.wsnapSafeImage("file:///etc/passwd"), null);
  assert.equal(R.wsnapSafeImage("data:image/svg+xml;base64,PHN2Zz4="), null);
  assert.equal(R.wsnapSafeImage('data:image/png;base64,AA" onerror="x'), null);
  assert.equal(R.wsnapSafeImage(null), null);
});

test("a listing becomes the list; a window without a safe picture is left out; a bad icon is dropped", () => {
  const v = R.wsnapListView({ ok: true, windows: [
    { id: "window:1:0", name: "Safari", thumb: PIC, icon: PIC },
    { id: "window:2:0", name: "Bad", thumb: "https://x/y.png", icon: null },
    { id: "window:3:0", name: "Notes", thumb: PIC, icon: "javascript:1" },
  ] });
  assert.equal(v.state, "list");
  assert.deepEqual(v.windows.map((w) => [w.id, w.icon]), [["window:1:0", PIC], ["window:3:0", null]]);
});

test("an empty listing is still a list (the picker says nothing is open)", () => {
  assert.deepEqual(R.wsnapListView({ ok: true, windows: [] }), { state: "list", windows: [] });
});

test("a refused listing shows the permission message, anything else an error line", () => {
  assert.deepEqual(R.wsnapListView({ ok: false, reason: "permission", error: "Turn it on" }), { state: "permission", message: "Turn it on" });
  assert.equal(R.wsnapListView({ ok: false, reason: "failed", error: "Nope" }).state, "error");
  assert.equal(R.wsnapListView(null).state, "error");
  assert.ok(R.wsnapListView(undefined).message.length > 0);
});

test("a capture becomes a File's parts; a gone window re-lists; permission and failures say so", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  assert.deepEqual(R.wsnapCaptureView({ ok: true, bytes, name: "window-a.png", mimeType: "image/png" }),
    { ok: true, bytes, name: "window-a.png", type: "image/png" });
  assert.equal(R.wsnapCaptureView({ ok: true, bytes, name: "window-a.gif", mimeType: "image/gif" }).ok, false);
  assert.equal(R.wsnapCaptureView({ ok: false, reason: "gone", error: "closed" }).state, "relist");
  assert.equal(R.wsnapCaptureView({ ok: false, reason: "permission", error: "x" }).state, "permission");
  assert.equal(R.wsnapCaptureView({ ok: false, reason: "failed" }).state, "error");
  assert.equal(R.wsnapCaptureView(null).state, "error");
});

/* ---------- wiring, read from the sources ---------- */

test("a snapshot goes through the composer's one attachment path (attAdd with a File), not a second one", () => {
  const js = src("../renderer/window-snapshot.js");
  assert.match(js, /new File\(\[bytes\], view\.name, \{type: view\.type/);
  assert.match(js, /attAdd\(\[\{file\}\], 'window'\)/);
  assert.doesNotMatch(js, /attachSave|snapshot:save/, "it never saves on its own");
});

test("the window button sits beside \"+\" in the composer, and the act opens the picker", () => {
  const r = src("../renderer/renderer.js");
  assert.match(r, /attButtonHTML\(\) \+ \(typeof wsnapButtonHTML === 'function' \? wsnapButtonHTML\(\) : ''\) \+ micButton\(\)/);
  assert.match(r, /if \(a === 'attach:window'\) \{ close\(\); render\(\); wsnapOpen\(\); return; \}/);
  assert.match(r, /appwin:'/);
  const html = src("../renderer/index.html");
  assert.ok(html.indexOf('src="attachments.js"') < html.indexOf('src="window-snapshot.js"'), "loaded after attachments.js");
  assert.ok(html.indexOf('src="window-snapshot.js"') < html.indexOf('src="renderer.js"'), "loaded before renderer.js");
  assert.match(html, /href="css\/window-snapshot\.css"/);
  assert.match(src("../renderer/analytics-acts.js"), /attach:\{window:L\}/);
});

test("main lists windows only (no screens), and nothing in the feature injects input", () => {
  const ipc = src("../main/window-snapshot-ipc.ts");
  const pure = src("../main/window-snapshot.ts");
  const js = src("../renderer/window-snapshot.js");
  assert.match(ipc, /types: \["window"\]/);
  assert.doesNotMatch(ipc, /types: \[[^\]]*"screen"/);
  for (const text of [ipc, pure, js]) {
    assert.doesNotMatch(text, /sendInputEvent|robotjs|nut-js|CGEvent|keybd_event|SendInput|xdotool|osascript/);
  }
  assert.match(ipc, /getMediaAccessStatus\("screen"\)/);
  assert.match(ipc, /listed\.has\(id\)/, "only an id the last listing returned can be captured");
  const pre = src("../preload/preload.ts");
  assert.match(pre, /snapshotWindows: \(\) => ipcRenderer\.invoke\("snapshot:windows"\)/);
  assert.match(pre, /snapshotCapture: \(id: string\) => ipcRenderer\.invoke\("snapshot:capture", id\)/);
  assert.match(src("../main/main.ts"), /wireWindowSnapshotIpc\(\);/);
});

for (const platform of ["darwin", "win32", "linux"]) {
  test(`File › Attach App Window… sends attach:window (${platform})`, () => {
    const sent = [];
    const file = menuTemplate((c) => sent.push(c), platform).find((m) => m.label === "File");
    const it = file.submenu.find((i) => i.label === "Attach App Window…");
    assert.ok(it, "the File menu has Attach App Window…");
    assert.equal(it.accelerator, undefined, "no chord of its own");
    it.click();
    assert.deepEqual(sent, ["attach:window"]);
  });
}
