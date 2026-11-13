// ATO-1136: HTML artifacts in the chat (renderer/chat-artifact.js): where
// they come from (an ok canvas.render's `tool_result.canvas`, a reply's
// .html file, a ```html block's Preview), the box a reply draws, the frame's sandbox, and the hooks in
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

test("a canvas.render tool_result's canvas is checked: an .html path, or nothing", () => {
  assert.deepEqual(A.canvasFromToolResult({ tool: "canvas.render", canvas: { path: "/w/canvas-sales-20261112-142233.html", title: " Sales ", kind: "chart", chart: "bar", bytes: 2048 } }),
    { path: "/w/canvas-sales-20261112-142233.html", title: "Sales", kind: "chart", chart: "bar" });
  assert.deepEqual(A.canvasFromToolResult({ canvas: { path: "/w/p.html", kind: "html" } }), { path: "/w/p.html", title: "", kind: "html", chart: "" });
  assert.equal(A.canvasFromToolResult({ canvas: { path: 42 } }), null);
  assert.equal(A.canvasFromToolResult({ canvas: { path: "/w/notes.md" } }), null);
  assert.equal(A.canvasFromToolResult({ tool: "os.fs.write" }), null);
  assert.equal(A.canvasFromToolResult(null), null);
});

test("a page's height is clamped; nonsense is the default", () => {
  assert.equal(A.artClampHeight(10), A.ART_MIN_H);
  assert.equal(A.artClampHeight(99999), A.ART_MAX_H);
  assert.equal(A.artClampHeight(420.2), 421);
  assert.equal(A.artClampHeight("x"), A.ART_DEFAULT_H);
  assert.equal(A.artClampHeight(-5), A.ART_DEFAULT_H);
});

test("an ok canvas.render reads the page it wrote and the reply draws one box for it, kept by the morph", async () => {
  previews["/w/canvas-rev.html"] = { ok: true, kind: "html", text: "<p>v1</p>", truncated: false };
  const item = {};
  const frame = { tool: "canvas.render", canvas: { path: "/w/canvas-rev.html", title: "Revenue", kind: "chart", chart: "line", bytes: 9 } };
  assert.equal(A.chatArtifactCanvas(item, frame), true);
  assert.equal(A.chatArtifactCanvas(item, { tool: "os.fs.write" }), false, "no canvas on the frame");
  assert.deepEqual(item.artifacts, [{ key: "file:/w/canvas-rev.html", title: "Revenue", path: "/w/canvas-rev.html" }]);
  await until(() => A.CHAT_ART.get("file:/w/canvas-rev.html").state === "ok");
  const [box] = A.chatArtifactEventSlots(item);
  assert.match(box, /class="chat-art"/);
  assert.match(box, /data-chat-art="file:\/w\/canvas-rev.html"/);
  assert.match(box, /data-morph-keep="art:file:\/w\/canvas-rev.html"/);
  assert.match(box, /Revenue/);
  assert.match(box, /data-file="\/w\/canvas-rev.html"/, "the file's chip opens the preview, Cmd-click the browser");
  // The page's text never goes into the window's markup: only main has it.
  assert.doesNotMatch(box, /v1/);
  assert.equal(puts.at(-1), "<p>v1</p>");
  // The same frame again (a replayed frame) adds nothing.
  A.chatArtifactCanvas(item, frame);
  assert.equal(item.artifacts.length, 1);
  // A canvas main cannot read (out of the roots, another machine's path) is not drawn.
  A.chatArtifactCanvas(item, { canvas: { path: "/remote/canvas-x.html", title: "X" } });
  await until(() => A.CHAT_ART.get("file:/remote/canvas-x.html").state === "fail");
  assert.equal(A.chatArtifactEventSlots(item).length, 1);
});

test("a new page for the same artifact loads in place and drops the old one", async () => {
  A.chatArtifactSet("id:d2", "<p>a</p>");
  await until(() => A.CHAT_ART.get("id:d2").state === "ok");
  const first = A.CHAT_ART.get("id:d2").url;
  A.chatArtifactSet("id:d2", "<p>b</p>");
  await until(() => A.CHAT_ART.get("id:d2").url !== first);
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
  // The file a canvas.render already drew is not drawn twice when the reply attaches it too.
  previews["/w/d3.html"] = { ok: true, kind: "html", text: "<p>c</p>", truncated: false };
  const m = {};
  A.chatArtifactCanvas(m, { canvas: { path: "/w/d3.html", title: "D3" } });
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

test("renderer.js hooks: canvas.render's tool_result, the reply's boxes, Preview on a code block", () => {
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  const tr = src.slice(src.indexOf("if (ev.kind === 'tool_result') {"), src.indexOf("if (ev.kind === 'tool_update') {"));
  assert.match(tr, /toolSettle\(card, p, ev\.at \|\| Date\.now\(\)\);\s*\/\/[^\n]*\n\s*if \(p\.canvas && item && typeof chatArtifactCanvas === 'function'\) chatArtifactCanvas\(item, p, card\);\s*render\(\);/);
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
