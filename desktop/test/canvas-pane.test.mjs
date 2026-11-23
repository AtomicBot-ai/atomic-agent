// ATO-1055: an artifact opened in a canvas beside the chat (renderer/canvas-pane.js):
// the pane's chrome escapes the title, it holds only the artifact's own sandboxed
// frame on an atomic-art: page, it closes when the artifact is gone, the reply's
// card draws Expand, and index.html loads the module in the right place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
globalThis.window = { atomic: { artifactPut: async () => ({ ok: true, url: "atomic-art://" + "a".repeat(32) + "/" }) } };
const A = require("../renderer/chat-artifact.js");
const P = require("../renderer/canvas-pane.js");

const TOKEN = "atomic-art://" + "0123456789abcdef".repeat(2) + "/";
function fakeFrame(attrs) {
  return {
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    hasAttribute: (n) => n in attrs,
  };
}

test("the pane's chrome escapes the title and has Back to chat and Close", () => {
  const h = P.canvasPaneHTML('<img src=x onerror="alert(1)">');
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(h, /data-cp="back"/);
  assert.match(h, /data-cp="close"/);
  assert.match(h, /class="cp-body"/);
  assert.doesNotMatch(h, /<iframe/);   // the frame is the artifact's own, moved in after
  assert.match(P.canvasPaneHTML(""), />Artifact</);
});

test("only atomic-art: pages", () => {
  assert.ok(P.canvasPaneUrlOk(TOKEN));
  assert.ok(P.canvasPaneUrlOk(""));   // still loading
  for (const bad of ["https://example.com/", "file:///etc/passwd", "blob:atomic-art://x", "javascript:alert(1)",
    "data:text/html,hi", "atomic-art://short/", "atomic-art://" + "0".repeat(32) + "/../x", "ATOMIC-ART://" + "0".repeat(32) + "/"]) {
    assert.equal(P.canvasPaneUrlOk(bad), false, bad);
  }
});

test("only a frame sandboxed to scripts alone, never with allow-same-origin or srcdoc", () => {
  assert.ok(P.canvasPaneFrameOk(fakeFrame({ sandbox: "allow-scripts", src: TOKEN })));
  assert.ok(P.canvasPaneFrameOk(fakeFrame({ sandbox: A.ART_SANDBOX })));
  assert.equal(P.canvasPaneFrameOk(fakeFrame({ sandbox: "allow-scripts allow-same-origin", src: TOKEN })), false);
  assert.equal(P.canvasPaneFrameOk(fakeFrame({ sandbox: "allow-same-origin", src: TOKEN })), false);
  assert.equal(P.canvasPaneFrameOk(fakeFrame({ src: TOKEN })), false);   // no sandbox at all
  assert.equal(P.canvasPaneFrameOk(fakeFrame({ sandbox: "allow-scripts", src: "https://example.com/" })), false);
  assert.equal(P.canvasPaneFrameOk(fakeFrame({ sandbox: "allow-scripts", srcdoc: "<b>x</b>" })), false);
  assert.equal(P.canvasPaneFrameOk(null), false);
});

test("the pane follows its artifact: gone, failed, or a hidden code preview closes it", () => {
  const arts = new Map([["canvas:s:sales", { state: "ok" }], ["code:h1", { state: "ok" }], ["file:/w/x.html", { state: "fail" }]]);
  assert.ok(P.canvasPaneLive("canvas:s:sales", arts, new Set()));
  assert.equal(P.canvasPaneLive("canvas:s:other", arts, new Set()), false);
  assert.equal(P.canvasPaneLive("file:/w/x.html", arts, new Set()), false);
  assert.ok(P.canvasPaneLive("code:h1", arts, new Set(["code:h1"])));
  assert.equal(P.canvasPaneLive("code:h1", arts, new Set()), false);
  assert.equal(P.canvasPaneKey(), "");   // closed at start
});

test("the reply's card draws Expand once the page is there, and Close canvas while it is beside the chat", () => {
  A.CHAT_ART.set("canvas:s:kpi", { key: "canvas:s:kpi", title: "KPI", state: "ok", url: TOKEN, node: null, h: A.ART_DEFAULT_H });
  A.CHAT_ART.set("canvas:s:wait", { key: "canvas:s:wait", title: "Wait", state: "loading", url: "", node: null, h: A.ART_DEFAULT_H });
  try {
    globalThis.canvasPaneKey = () => "";
    const shut = A.chatArtifactSlotHTML("canvas:s:kpi");
    assert.match(shut, /data-artexpand="canvas:s:kpi"/);
    assert.match(shut, /aria-pressed="false"/);
    assert.match(shut, />Expand</);
    assert.doesNotMatch(shut, /on-canvas/);
    assert.doesNotMatch(A.chatArtifactSlotHTML("canvas:s:wait"), /data-artexpand/);   // nothing to open yet
    globalThis.canvasPaneKey = () => "canvas:s:kpi";
    const open = A.chatArtifactSlotHTML("canvas:s:kpi");
    assert.match(open, /class="chat-art on-canvas"/);
    assert.match(open, /aria-pressed="true"/);
    assert.match(open, />Close canvas</);
    assert.match(open, /data-morph-keep="art:canvas:s:kpi"/);   // the box is still kept across repaints
  } finally {
    delete globalThis.canvasPaneKey;
    A.CHAT_ART.delete("canvas:s:kpi");
    A.CHAT_ART.delete("canvas:s:wait");
  }
});

test("Esc is taken in the capture phase, and the click on Expand is handled before renderer.js's", () => {
  const src = readFileSync(new URL("../renderer/canvas-pane.js", import.meta.url), "utf8");
  assert.match(src, /addEventListener\('keydown', \(e\) => \{[\s\S]*?stopImmediatePropagation\(\); canvasPaneClose\(false\);[\s\S]*?\}, true\);/);
  assert.match(src, /closest\('\[data-artexpand\]'\)[\s\S]*?canvasPaneToggle\(ex\.dataset\.artexpand\)[\s\S]*?\}, true\);/);
  // The frame is the artifact's own (artNode), never one the pane makes.
  assert.doesNotMatch(src, /createElement\('iframe'\)/);
  assert.match(src, /artNode\(st\)/);
});

test("index.html: the pane's aside beside the file preview, the script after chat-artifact.js and before renderer.js", () => {
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.match(html, /<aside id="fpreview" hidden><\/aside>[\s\S]*?<aside id="canvaspane" hidden><\/aside>[\s\S]*?<aside id="inspector">/);
  const at = (s) => html.indexOf(s);
  assert.ok(at('src="chat-artifact.js"') > 0);
  assert.ok(at('src="file-preview.js"') < at('src="canvas-pane.js"'));
  assert.ok(at('src="chat-artifact.js"') < at('src="canvas-pane.js"'));
  assert.ok(at('src="canvas-pane.js"') < at('src="renderer.js"'));
  assert.ok(at('href="css/canvas-pane.css"') > at('href="css/file-preview.css"'));   // it reuses the .fp-* head
});
