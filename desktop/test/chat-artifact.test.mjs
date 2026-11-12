// ATO-1136: HTML artifacts in the chat (renderer/chat-artifact.js): where
// they come from (`event: canvas`, a reply's .html file, a ```html block's
// Preview), the box a reply draws, the frame's sandbox, and the hooks in
// renderer.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// A bridge that keeps what it was given, like main's store.
const puts = [], drops = [], previews = {};
globalThis.window = {
  atomic: {
    artifactPut: async (html) => { puts.push(html); return { ok: true, url: "atomic-art://" + String(puts.length).padStart(32, "0") + "/" }; },
    artifactDrop: async (url) => { drops.push(url); return { ok: true }; },
    filePreview: async (p) => previews[p] || { ok: false, reason: "missing" },
  },
};
const A = require("../renderer/chat-artifact.js");
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await tick(); }
}

test("the frame is sandboxed to scripts alone and allowed no device or clipboard", () => {
  assert.equal(A.ART_SANDBOX, "allow-scripts");
  assert.doesNotMatch(A.ART_SANDBOX, /same-origin|popups|top-navigation|forms|modals|downloads/);
  for (const f of ["camera", "microphone", "geolocation", "clipboard-read", "clipboard-write", "display-capture"]) {
    assert.match(A.ART_ALLOW, new RegExp(f + " 'none'"));
  }
});

test("an event's payload is checked: an id and a page, or nothing", () => {
  assert.deepEqual(A.artifactFromEvent({ id: " sales ", title: " Sales ", html: "<b>1</b>", path: "/w/sales.html" }),
    { id: "sales", title: "Sales", html: "<b>1</b>", path: "/w/sales.html" });
  assert.equal(A.artifactFromEvent({ id: "x", html: "   " }), null);
  assert.equal(A.artifactFromEvent({ html: "<b>1</b>" }), null);
  assert.equal(A.artifactFromEvent({ id: 3, html: "<b>1</b>" }), null);
  assert.equal(A.artifactFromEvent(null), null);
  assert.equal(A.artifactFromEvent("x"), null);
  assert.equal(A.artifactFromEvent({ id: "big", html: "x".repeat(2 * 1024 * 1024 + 1) }), null);
});

test("a page's height is clamped; nonsense is the default", () => {
  assert.equal(A.artClampHeight(10), A.ART_MIN_H);
  assert.equal(A.artClampHeight(99999), A.ART_MAX_H);
  assert.equal(A.artClampHeight(420.2), 421);
  assert.equal(A.artClampHeight("x"), A.ART_DEFAULT_H);
  assert.equal(A.artClampHeight(-5), A.ART_DEFAULT_H);
});

test("an event puts the page in main and the reply draws one box for it, kept by the morph", async () => {
  const item = {};
  assert.equal(A.chatArtifactEvent(item, { id: "d1", title: "Revenue", html: "<p>v1</p>" }), true);
  assert.deepEqual(item.artifacts, [{ key: "id:d1", title: "Revenue", path: "" }]);
  assert.equal(A.chatArtifactEvent(item, { id: "d1", html: "" }), false, "nothing to draw");
  await until(() => A.CHAT_ART.get("id:d1").state === "ok");
  const [box] = A.chatArtifactEventSlots(item);
  assert.match(box, /class="chat-art"/);
  assert.match(box, /data-chat-art="id:d1"/);
  assert.match(box, /data-morph-keep="art:id:d1"/);
  assert.match(box, /Revenue/);
  // The page's text never goes into the window's markup: only main has it.
  assert.doesNotMatch(box, /v1/);
  assert.equal(puts.at(-1), "<p>v1</p>");
});

test("the same id again loads the new page in the same artifact and drops the old one", async () => {
  const item = {};
  A.chatArtifactEvent(item, { id: "d2", html: "<p>a</p>" });
  await until(() => A.CHAT_ART.get("id:d2").state === "ok");
  const first = A.CHAT_ART.get("id:d2").url;
  A.chatArtifactEvent(item, { id: "d2", title: "Now", html: "<p>b</p>" });
  await until(() => A.CHAT_ART.get("id:d2").url !== first);
  assert.equal(item.artifacts.length, 1);
  assert.equal(item.artifacts[0].title, "Now");
  assert.ok(drops.includes(first));
  // The same page again is not sent again.
  const n = puts.length;
  A.chatArtifactSet("id:d2", "<p>b</p>");
  assert.equal(puts.length, n);
});

test("a page main refuses is not drawn", async () => {
  const keep = window.atomic.artifactPut;
  window.atomic.artifactPut = async () => ({ ok: false, reason: "too-large" });
  try {
    A.chatArtifactSet("id:big", "<p>x</p>");
    await until(() => A.CHAT_ART.get("id:big").state === "fail");
    assert.equal(A.chatArtifactSlotHTML("id:big"), null);
  } finally { window.atomic.artifactPut = keep; }
});

test("a reply's .html file is read through main's preview and drawn; anything else is left to the chip", async () => {
  previews["/w/chart.html"] = { ok: true, kind: "html", text: "<svg></svg>", truncated: false };
  previews["/w/huge.html"] = { ok: true, kind: "html", text: "<p>", truncated: true };
  assert.equal(A.chatArtifactFileSlotHTML("/w/notes.md"), null);
  assert.equal(A.isHtmlArtifactPath("/w/A.HTM"), true);
  const first = A.chatArtifactFileSlotHTML("/w/chart.html");
  assert.match(first, /chat-art loading/);
  assert.match(first, /data-file="\/w\/chart.html"/, "the file's chip opens the preview, Cmd-click the browser");
  await until(() => A.CHAT_ART.get("file:/w/chart.html").state === "ok");
  assert.match(A.chatArtifactFileSlotHTML("/w/chart.html"), /class="chat-art"/);
  // Too large to read whole, or out of the roots: a chip, as before.
  A.chatArtifactFileSlotHTML("/w/huge.html");
  await until(() => A.CHAT_ART.get("file:/w/huge.html").state === "fail");
  assert.equal(A.chatArtifactFileSlotHTML("/w/huge.html"), null);
  A.chatArtifactFileSlotHTML("/etc/x.html");
  await until(() => A.CHAT_ART.get("file:/etc/x.html").state === "fail");
  assert.equal(A.chatArtifactFileSlotHTML("/etc/x.html"), null);
  // The file an event already drew is not drawn twice.
  const m = {};
  A.chatArtifactEvent(m, { id: "d3", html: "<p>c</p>", path: "/w/d3.html" });
  assert.equal(A.chatArtifactFileSlotHTML("/w/d3.html", undefined, m), "");
});

test("a closed ```html block has Preview; it opens a box under the block and closes again", async () => {
  const pre = '<pre class="mdpre" data-lang="html"><code>&lt;b&gt;hi&lt;/b&gt;\n</code></pre>';
  assert.equal(A.chatArtifactCodeButton(pre, "js"), "");
  assert.equal(A.chatArtifactCodeButton('<pre class="mdpre" data-open="1" data-lang="html"><code>x</code></pre>', "html"), "", "not while the fence is open");
  const btn = A.chatArtifactCodeButton(pre, "html");
  const key = A.chatArtifactCodeKey(pre);
  assert.equal(key, A.chatArtifactCodeKey(pre), "the same text gives the same key");
  assert.notEqual(key, A.chatArtifactCodeKey(pre.replace("hi", "ho")));
  assert.match(btn, new RegExp('data-artprev="' + key + '"'));
  assert.match(btn, />Preview</);
  assert.equal(A.chatArtifactCodeSlot(pre), "");
  assert.equal(A.chatArtifactToggleCode(key, "<b>hi</b>\n"), true);
  assert.match(A.chatArtifactCodeButton(pre, "HTML"), />Hide</);
  await until(() => A.CHAT_ART.get(key).state === "ok");
  assert.match(A.chatArtifactCodeSlot(pre), new RegExp('data-chat-art="' + key + '"'));
  assert.equal(puts.at(-1), "<b>hi</b>\n");
  A.chatArtifactToggleCode(key, "");
  assert.equal(A.chatArtifactCodeSlot(pre), "");
});

test("only a frame of ours can set its height, and only with a size message", () => {
  const win = {};
  const node = { contentWindow: win, style: {} };
  A.CHAT_ART.set("id:h", { key: "id:h", node, state: "ok", h: A.ART_DEFAULT_H });
  assert.equal(A.chatArtifactMessage({ data: { atomicArtifact: "size", h: 500 }, source: {} }), false);
  assert.equal(A.chatArtifactMessage({ data: { atomicArtifact: "other", h: 500 }, source: win }), false);
  assert.equal(A.chatArtifactMessage({ data: "size", source: win }), false);
  assert.equal(A.chatArtifactMessage({ data: { atomicArtifact: "size", h: 500 }, source: win }), true);
  assert.equal(node.style.height, "500px");
  A.CHAT_ART.delete("id:h");
});

test("renderer.js hooks: the canvas event, the reply's boxes, Preview on a code block", () => {
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  assert.match(src, /const LIVE_DRAWS = new Set\(\[[^\]]*'canvas'/);
  assert.match(src, /if \(ev\.kind === 'canvas'\) \{\s*if \(item && typeof chatArtifactEvent === 'function' && chatArtifactEvent\(item, ev\.payload\)\) render\(\);\s*return;/);
  const strip = src.slice(src.indexOf("\nfunction replyFilesStrip("), src.indexOf("\nfunction chatPicHTML("));
  assert.match(strip, /chatArtifactEventSlots\(m, esc\)/);
  assert.match(strip, /chatArtifactFileSlotHTML\(p, esc, m\)/);
  assert.match(strip, /replyfiles-arts/);
  const frame = src.slice(src.indexOf("\nfunction codeBlockFrame("), src.indexOf("\nfunction codeSpanIsPath("));
  assert.match(frame, /chatArtifactCodeButton\(pre, lang\)/);
  assert.match(frame, /chatArtifactCodeSlot\(pre\)/);
  assert.match(src, /t\.closest\('\[data-artprev\]'\)/);
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('src="chat-artifact.js"') > 0 && html.indexOf('src="chat-artifact.js"') < html.indexOf('src="renderer.js"'));
  assert.ok(html.indexOf('src="dom-morph.js"') < html.indexOf('src="renderer.js"'));
});
