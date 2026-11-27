// ATO-2536 review round 2 (main/artifact-nav-guard.ts): an artifact frame
// cannot swap its document for a `blob:`, `data:`, `javascript:` or
// `about:` one of its own, a `blob:` target must be the window's own, a
// document that commits in an artifact frame anyway gets the guard and is
// sent to "Not found", and no window is created. Electron's WebContents and
// WebFrameMain are stand-ins here; the real navigation (and Chromium's
// Trusted Types) waits for the app run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const N = require("../out/main/artifact-nav-guard.js");
const B = require("../out/main/artifact-rtc-block.js");

const ART = "atomic-art://0123456789abcdef0123456789abcdef/";
const ART2 = "atomic-art://fedcba9876543210fedcba9876543210/";
const win = { url: "file:///app/renderer/index.html", parent: null, frameTreeNodeId: 1 };
const artFrame = (id = 2, url = ART) => ({ url, parent: win, frameTreeNodeId: id });
const pdfFrame = { url: "about:blank", parent: win, frameTreeNodeId: 9 };
const nav = (url, frame, initiator) => ({ url, isMainFrame: false, frame, initiator });

test("an artifact page cannot navigate its own frame to a blob, data, javascript or about document", () => {
  const f = artFrame();
  for (const url of [
    "blob:null/1b2c3d4e-0000-4000-8000-000000000000",
    "blob:file:///1b2c3d4e-0000-4000-8000-000000000000",
    "BLOB:null/x",
    "data:text/html,<script>new RTCPeerConnection()</script>",
    "javascript:'<script>new RTCPeerConnection()</script>'",
    "about:blank",
    "about:srcdoc",
    "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html",
    "https://evil.example/",
  ]) {
    assert.equal(N.frameNavAllowed(nav(url, f, f)), false, `self: ${url}`);
    // The same when the initiator is not reported.
    assert.equal(N.frameNavAllowed(nav(url, f, null)), false, `no initiator: ${url}`);
  }
  // Another artifact page (the window replacing it, or the page's own reload) still loads.
  assert.equal(N.frameNavAllowed(nav(ART2, f, win)), true);
  assert.equal(N.frameNavAllowed(nav(ART, f, f)), true);
});

test("an artifact page cannot steer another frame of the window to a document of its own", () => {
  const f = artFrame();
  assert.equal(N.frameNavAllowed(nav("blob:file:///x", pdfFrame, f)), false, "initiated by the artifact");
  assert.equal(N.frameNavAllowed(nav("about:blank", pdfFrame, f)), false);
  // A frame under an artifact page (backstop: there should be none) is in scope too.
  const child = { url: "about:blank", parent: f, frameTreeNodeId: 3 };
  assert.equal(N.frameNavAllowed(nav("blob:null/x", child, child)), false);
});

test("a frame that has shown an artifact page stays in scope after its URL changed", () => {
  const seen = new Set([7]);
  const escaped = { url: "blob:null/x", parent: win, frameTreeNodeId: 7 };
  assert.equal(N.frameNavAllowed(nav("data:text/html,x", escaped, escaped), seen), false);
  assert.equal(N.frameNavAllowed(nav(N.ARTIFACT_GONE_URL, escaped, escaped), seen), true, "the Not found page");
  // Unknown frame: only an artifact page.
  assert.equal(N.frameNavAllowed(nav("blob:file:///x", null, win)), false);
  assert.equal(N.frameNavAllowed(nav(ART, null, win)), true);
});

test("the window may still clear an artifact frame, and the PDF preview keeps its own blob", () => {
  assert.equal(N.frameNavAllowed(nav("about:blank", artFrame(), win)), true, "the window clears its frame");
  assert.equal(N.frameNavAllowed(nav("blob:file:///1b2c3d4e", pdfFrame, win)), true, "the window's own PDF blob");
  assert.equal(N.frameNavAllowed(nav("blob:file:///1b2c3d4e#page=3", pdfFrame, win)), true);
  assert.equal(N.frameNavAllowed(nav("blob:null/1b2c3d4e", pdfFrame, win)), false, "an opaque origin's blob");
  assert.equal(N.frameNavAllowed(nav("blob:https://evil.example/1", pdfFrame, win)), false);
  // The rest of the old rule still holds for frames that are not artifacts.
  const viewer = { url: "blob:file:///1b2c3d4e", parent: pdfFrame, frameTreeNodeId: 10 };
  assert.equal(N.frameNavAllowed(nav("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html", viewer, viewer)), true);
  assert.equal(N.frameNavAllowed(nav("about:srcdoc", pdfFrame, win)), true);
  for (const url of ["https://evil.example/", "file:///etc/passwd", "data:text/html,hi", "javascript:alert(1)"]) {
    assert.equal(N.frameNavAllowed(nav(url, pdfFrame, win)), false, url);
  }
  assert.equal(N.frameNavAllowed({ url: "https://anything.example/", isMainFrame: true }), true, "the main frame has its own rule");
});

/** A WebContents stand-in plus frames whose executeJavaScript calls are recorded. */
function wire() {
  const contents = new EventEmitter();
  const frames = new Map();
  const ran = [];
  const frame = (pid, rid, f) => {
    const node = { ...f, executeJavaScript: (code) => { ran.push([f.frameTreeNodeId, code]); return Promise.resolve(); } };
    frames.set(`${pid}:${rid}`, node);
    return node;
  };
  const seen = N.watchArtifactNavigation(contents, { frameFromId: (p, r) => frames.get(`${p}:${r}`) ?? null });
  const willNav = (n) => {
    let prevented = false;
    contents.emit("will-frame-navigate", { ...n, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  const committed = (url, pid, rid) => contents.emit("did-frame-navigate", {}, url, 200, "OK", false, pid, rid);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { contents, frame, ran, seen, willNav, committed, settle };
}

test("the window's will-frame-navigate refuses the self-navigation and remembers artifact frames", () => {
  const w = wire();
  const f = artFrame(4, "about:blank");
  assert.equal(w.willNav(nav(ART, f, win)), false, "the window loads the artifact");
  assert.ok(w.seen.has(4));
  const shown = { ...f, url: ART };
  assert.equal(w.willNav(nav("blob:null/x", shown, shown)), true, "prevented");
  assert.equal(w.willNav(nav("javascript:'x'", shown, shown)), true, "prevented");
  assert.equal(w.willNav(nav("blob:file:///x", pdfFrame, win)), false, "the PDF preview");
  // The window clearing the frame takes it out of scope.
  assert.equal(w.willNav(nav("about:blank", shown, win)), false);
  assert.equal(w.seen.has(4), false);
});

test("a document that commits in an artifact frame anyway gets the guard and goes to Not found", async () => {
  const w = wire();
  w.frame(5, 50, artFrame(6));
  w.committed(ART, 5, 50);
  await w.settle();
  assert.deepEqual(w.ran, [[6, B.ARTIFACT_RTC_BLOCK_JS]], "a served page is guarded again (covers a document that kept its URL)");
  assert.ok(w.seen.has(6));

  w.ran.length = 0;
  w.frame(5, 50, { url: "blob:null/x", parent: win, frameTreeNodeId: 6 });
  w.committed("blob:null/x", 5, 50);
  await w.settle();
  assert.equal(w.ran.length, 2);
  assert.deepEqual(w.ran[0], [6, B.ARTIFACT_RTC_BLOCK_JS], "the guard runs first");
  assert.equal(w.ran[1][1], `location.replace(${JSON.stringify(N.ARTIFACT_GONE_URL)})`);

  // A frame that never showed an artifact page is left alone.
  w.ran.length = 0;
  w.frame(5, 51, { url: "blob:file:///pdf", parent: win, frameTreeNodeId: 11 });
  w.committed("blob:file:///pdf", 5, 51);
  w.committed("https://x.example/", 5, 99); // unknown frame
  // The main frame's own commits are not this guard's.
  w.contents.emit("did-frame-navigate", {}, "file:///app/renderer/index.html", 200, "OK", true, 1, 1);
  await w.settle();
  assert.deepEqual(w.ran, []);
});

test("no window is created from the window's contents", () => {
  const w = wire();
  let closed = 0;
  w.contents.emit("did-create-window", { close: () => { closed++; } });
  assert.equal(closed, 1);
});

test("the guard runs as plain script and the served tag wraps the same text", () => {
  assert.equal(B.ARTIFACT_RTC_BLOCK_SCRIPT, `<script>${B.ARTIFACT_RTC_BLOCK_JS}</script>`);
  assert.equal(N.ARTIFACT_GONE_URL, "atomic-art://" + "0".repeat(32) + "/");
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  const create = main.slice(main.indexOf("function createWindow("), main.indexOf("setPermissionRequestHandler("));
  assert.match(create, /watchArtifactNavigation\(window\.webContents as unknown as NavContents, \{\s*frameFromId: \(processId, routingId\) => \(webFrameMain\.fromId\(processId, routingId\)/);
  // The old subframe-only rule is not wired on its own any more (it let an artifact go to blob:).
  assert.doesNotMatch(create, /on\("will-frame-navigate"/);
});
