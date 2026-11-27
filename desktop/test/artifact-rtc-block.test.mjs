// ATO-2536: an artifact page gets no WebRTC (main/artifact-rtc-block.ts):
// the RTC constructors are removed before the page runs, no child frame can
// bring them back, and the window turns off WebRTC's UDP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const F = require("../out/main/artifact-frame.js");
const B = require("../out/main/artifact-rtc-block.js");

/** Run the block script in a bare context that has the browser globals it touches. */
function runBlock() {
  class DOMException extends Error { constructor(m, n) { super(m); this.name = n; } }
  class Document { createElement(n) { return { tag: String(n).toLowerCase() }; } createElementNS(_s, q) { return { tag: q }; } }
  class CustomElementRegistry { define() { return "defined"; } }
  const policies = [];
  class TrustedTypePolicyFactory {
    createPolicy(name, rules) { policies.push({ name, rules }); return { name, createHTML: (s) => rules.createHTML(s) }; }
  }
  const ctx = {
    DOMException, Document, CustomElementRegistry,
    RTCPeerConnection: function RTCPeerConnection() {}, webkitRTCPeerConnection: function () {},
    RTCDataChannel: function () {}, RTCIceTransport: function () {}, XSLTProcessor: function () {},
    TrustedHTML: { fromLiteral: () => "raw" }, trustedTypes: new TrustedTypePolicyFactory(),
  };
  vm.createContext(ctx);
  vm.runInContext("var window = this;", ctx);
  vm.runInContext(B.ARTIFACT_RTC_BLOCK_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, ""), ctx);
  return { ctx, policies };
}

test("the page runs with no RTC constructor, and cannot put one back", () => {
  const { ctx } = runBlock();
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceTransport"]) {
    assert.equal(ctx[name], undefined, name);
  }
  vm.runInContext("RTCPeerConnection = function () {}; try { delete window.RTCPeerConnection; } catch (e) {}", ctx);
  assert.equal(ctx.RTCPeerConnection, undefined);
  assert.throws(() => vm.runInContext("Object.defineProperty(window, 'RTCPeerConnection', { value: 1 })", ctx));
});

test("no child frame can be made, so no fresh realm brings WebRTC back", () => {
  const { ctx, policies } = runBlock();
  const doc = new ctx.Document();
  for (const tag of ["iframe", "IFRAME", "frame", "object", "embed", "fencedframe", "portal"]) {
    assert.throws(() => doc.createElement(tag), { name: "NotSupportedError" }, tag);
  }
  assert.throws(() => doc.createElementNS("http://www.w3.org/1999/xhtml", "html:iframe"), { name: "NotSupportedError" });
  assert.deepEqual({ ...doc.createElement("div") }, { tag: "div" });
  assert.throws(() => new ctx.CustomElementRegistry().define("x-frame", class {}, { extends: "iframe" }), { name: "NotSupportedError" });
  assert.equal(new ctx.CustomElementRegistry().define("x-ok", class {}, { extends: "div" }), "defined");
  assert.equal(ctx.XSLTProcessor, undefined);
  // HTML strings: the default policy strips frames; a page's own policy is stripped too.
  assert.equal(policies[0].name, "default");
  assert.equal(policies[0].rules.createHTML("<iframe></iframe>"), "<x-blocked-iframe></x-blocked-iframe>");
  const own = ctx.trustedTypes.createPolicy("lit-html", { createHTML: (s) => s });
  assert.equal(own.createHTML("<IFRAME src=x>"), "<x-blocked-IFRAME src=x>");
  assert.equal(ctx.TrustedHTML.fromLiteral, undefined);
});

test("stripChildFrames rewrites frame tags as the tokenizer reads them and leaves the rest", () => {
  assert.equal(B.stripChildFrames("<p>a</p><IFRAME src=x></iframe><iframe/>"), "<p>a</p><x-blocked-IFRAME src=x></x-blocked-iframe><x-blocked-iframe/>");
  assert.equal(B.stripChildFrames("<object\tdata=1><embed>\n<frameset><frame>"), "<x-blocked-object\tdata=1><x-blocked-embed>\n<x-blocked-frameset><x-blocked-frame>");
  for (const keep of ["<iframes>", "<x-iframe>", "< iframe>", "<div>iframe</div>", "<objective>"]) assert.equal(B.stripChildFrames(keep), keep);
});

test("a served page has the block first, no child frame in its markup and Trusted Types on", () => {
  const s = new F.ArtifactStore();
  const r = s.response(s.put("<iframe></iframe><script>new RTCPeerConnection({iceServers:[{urls:'stun:x.example'}]})</script>").url);
  const block = r.body.indexOf(B.ARTIFACT_RTC_BLOCK_SCRIPT);
  assert.ok(block > 0 && block < r.body.indexOf(F.ARTIFACT_BRIDGE_SCRIPT), "the block comes before the bridge and the page");
  assert.doesNotMatch(r.body.slice(block + B.ARTIFACT_RTC_BLOCK_SCRIPT.length), /<iframe/i);
  assert.match(r.headers["Content-Security-Policy"], /require-trusted-types-for 'script'$/);
  // My Apps keep the plain artifact CSP: they do not get the block script.
  assert.doesNotMatch(F.ARTIFACT_CSP, /trusted-types/);
});

test("the main window turns off WebRTC's UDP", () => {
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  const create = main.slice(main.indexOf("function createWindow("), main.indexOf("setPermissionRequestHandler("));
  assert.match(create, /window\.webContents\.setWebRTCIPHandlingPolicy\("disable_non_proxied_udp"\);/);
});
