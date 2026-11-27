// ATO-2457: Save as PNG on an artifact or ui.render card. Main grabs the
// card's box from the app window (main/artifact-png.ts: the rect clipped to
// the window and scaled by zoom, a safe file name); the renderer finds the
// box and says what happened (renderer/artifact-png.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../out/main/artifact-png.js");
const R = require("../renderer/artifact-png.js");

test("the capture rect is clipped to the window and scaled by its zoom", () => {
  const view = { width: 1200, height: 800 };
  assert.deepEqual(P.pngCaptureRect({ x: 10.4, y: 20.6, width: 300, height: 200 }, 1, view), { x: 10, y: 20, width: 301, height: 201 });
  assert.deepEqual(P.pngCaptureRect({ x: 100, y: 100, width: 100, height: 100 }, 1.5, view), { x: 150, y: 150, width: 150, height: 150 });
  // Taller than the window: cut at its edge.
  assert.deepEqual(P.pngCaptureRect({ x: 0, y: 600, width: 500, height: 900 }, 1, view), { x: 0, y: 600, width: 500, height: 200 });
  assert.equal(P.pngCaptureRect({ x: 0, y: 900, width: 100, height: 100 }, 1, view), null);
  assert.equal(P.pngCaptureRect({ x: 0, y: 0, width: 0, height: 10 }, 1, view), null);
  assert.equal(P.pngCaptureRect({ x: "0", y: 0, width: 10, height: 10 }, 1, view), null);
  assert.equal(P.pngCaptureRect(null, 1, view), null);
});

test("the file is named after the card, safely, and always ends in .png", () => {
  assert.equal(P.pngFileName("Quarterly revenue (2026)"), "quarterly-revenue-2026.png");
  assert.equal(P.pngFileName("../../etc/passwd"), "etc-passwd.png");
  assert.equal(P.pngFileName(""), "widget.png");
  assert.equal(P.pngTarget("/Users/me/Downloads/chart"), "/Users/me/Downloads/chart.png");
  assert.equal(P.pngTarget("C:\\Users\\me\\chart.PNG"), "C:\\Users\\me\\chart.PNG");
});

test("the renderer's toast: saved names the file, a cancel says nothing, a failure says what to do", () => {
  assert.deepEqual(R.apngToastOf({ ok: true, path: "C:\\Users\\me\\Downloads\\chart.png" }), { t: "Saved as PNG", s: "chart.png", kind: "" });
  assert.equal(R.apngToastOf({ ok: false, reason: "canceled" }), null);
  assert.equal(R.apngToastOf({ ok: false, reason: "bad-rect" }).kind, "bad");
  assert.match(R.apngToastOf(null).s, /Try again/);
  assert.deepEqual(R.apngRect({ left: 1.4, top: 2.6, width: 10, height: 20 }), { x: 1, y: 3, width: 10, height: 20 });
  assert.match(R.artifactPngButtonHTML('k"1'), /data-artpng="k&quot;1"/);
});

test("main answers app:artifactPng, preload exposes it, and the artifact bar draws the button", () => {
  const ipc = readFileSync(new URL("../main/artifact-frame-ipc.ts", import.meta.url), "utf8");
  assert.match(ipc, /ipcMain\.handle\("app:artifactPng"/);
  assert.match(ipc, /capturePage\(r\)/);
  assert.match(ipc, /app\.getPath\("downloads"\)/);
  const pre = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  assert.match(pre, /artifactPng: \(rect: [^)]*, title: string\) =>\s*ipcRenderer\.invoke\("app:artifactPng", rect, title\)/);
  const art = readFileSync(new URL("../renderer/chat-artifact.js", import.meta.url), "utf8");
  assert.match(art, /typeof artifactPngButtonHTML === 'function' \? artifactPngButtonHTML\(key, e\)/);
});
