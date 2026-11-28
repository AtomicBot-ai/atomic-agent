// ATO-2536: an artifact page gets no WebRTC (main/artifact-rtc-block.ts,
// main/artifact-page-guard.ts): the RTC constructors are removed before the
// page runs, no child frame can bring them back even when the page changes
// built-ins first, main drops a page that makes one anyway, and the window
// turns off WebRTC's UDP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const F = require("../out/main/artifact-frame.js");
const B = require("../out/main/artifact-rtc-block.js");

const XHTML = "http://www.w3.org/1999/xhtml";

/**
 * Run the block script in a bare context with stand-ins for the browser
 * objects it touches. The stand-ins live in this realm, like the browser's
 * own natives, so a page that changes the context's built-ins does not
 * change them; `seen` records what each one was handed.
 */
function runBlock() {
  const seen = [];
  class DOMException extends Error { constructor(m, n) { super(m); this.name = n; } }
  class Document {
    createElement(n) { seen.push(["createElement", n]); return { tag: String(n).toLowerCase() }; }
    createElementNS(_s, q) { seen.push(["createElementNS", q]); return { tag: String(q) }; }
    write(...a) { seen.push(["write", ...a]); }
    writeln(...a) { seen.push(["writeln", ...a]); }
    execCommand(c, _u, v) { seen.push(["execCommand", c, v]); return true; }
  }
  class DOMImplementation { createDocument(_n, q) { seen.push(["createDocument", q]); return { root: String(q) }; } }
  class DOMParser { parseFromString(s, t) { seen.push(["parseFromString", s, t]); return { text: String(s) }; } }
  class CustomElementRegistry { define(_n, _c, o) { seen.push(["define", o]); return "defined"; } }
  const policies = [];
  class TrustedTypePolicyFactory {
    createPolicy(name, rules) {
      // Like the browser: a second "default" policy is refused.
      if (name === "default" && policies.some((p) => p.name === "default")) throw new TypeError("default policy exists");
      policies.push({ name, rules });
      return { name, createHTML: (s) => { const h = rules.createHTML; if (typeof h !== "function") throw new TypeError("no createHTML"); return h(s); } };
    }
  }
  const ctx = {
    DOMException, Document, DOMImplementation, DOMParser, CustomElementRegistry,
    RTCPeerConnection: function RTCPeerConnection() {}, webkitRTCPeerConnection: function () {},
    RTCDataChannel: function () {}, RTCIceTransport: function () {}, XSLTProcessor: function () {},
    TrustedHTML: { fromLiteral: () => "raw" }, trustedTypes: new TrustedTypePolicyFactory(),
  };
  vm.createContext(ctx);
  vm.runInContext("var window = this;", ctx);
  vm.runInContext(B.ARTIFACT_RTC_BLOCK_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, ""), ctx);
  ctx.document = new Document();
  ctx.impl = new DOMImplementation();
  const page = (code) => vm.runInContext(code, ctx);
  return { ctx, policies, seen, page };
}

test("review round 2: the default policy refuses a javascript: navigation and passes same-realm script sinks", () => {
  const { policies } = runBlock();
  const script = policies[0].rules.createScript;
  // A javascript: URL the page navigates its own frame to: a new document the guard never ran in.
  assert.throws(() => script("'<script>new RTCPeerConnection()</script>'", "TrustedScript", "Location href"), { name: "NotSupportedError" });
  // No sink, or one not on the list: refused (fail closed).
  assert.throws(() => script("1"), { name: "NotSupportedError" });
  assert.throws(() => script("1", "TrustedScript", "Something new"), { name: "NotSupportedError" });
  for (const sink of ["eval", "Function", "Window setTimeout", "Window setInterval", "HTMLScriptElement text", "HTMLScriptElement textContent", "HTMLScriptElement innerText"]) {
    assert.equal(script("x + 1", "TrustedScript", sink), "x + 1", sink);
  }
});

test("review round 2: the guard can run twice in one document (main runs it again)", () => {
  const { ctx, policies, page } = runBlock();
  assert.doesNotThrow(() => vm.runInContext(B.ARTIFACT_RTC_BLOCK_JS, ctx));
  assert.equal(policies.filter((p) => p.name === "default").length, 1);
  assert.equal(ctx.RTCPeerConnection, undefined);
  assert.throws(() => page("document.createElement('iframe')"), { name: "NotSupportedError" });
});

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
  assert.throws(() => doc.createElementNS(XHTML, "html:iframe"), { name: "NotSupportedError" });
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

test("F2079.1: a page that changes built-ins first still cannot make a frame", () => {
  const { page, policies } = runBlock();
  page(`
    RegExp.prototype.test = function () { return false; };
    RegExp.prototype.exec = function () { return null; };
    RegExp.prototype[Symbol.replace] = function (s) { return "" + s; };
    String.prototype.replace = function () { return "" + this; };
    String.prototype.slice = function () { return ""; };
    String.prototype.split = function () { return ["div"]; };
    String.prototype.toLowerCase = function () { return "div"; };
    String = function () { return "div"; };
    Object.defineProperty(Object.prototype, "createHTML", { get() { return (s) => s; }, set() {}, configurable: true });
  `);
  assert.throws(() => page("document.createElement('iframe')"), { name: "NotSupportedError" });
  assert.throws(() => page("document.createElement('IFRAME')"), { name: "NotSupportedError" });
  assert.throws(() => page(`document.createElementNS('${XHTML}', 'h:iframe')`), { name: "NotSupportedError" });
  assert.equal(policies[0].rules.createHTML("<iframe></iframe>"), "<x-blocked-iframe></x-blocked-iframe>");
  assert.equal(page("trustedTypes.createPolicy('p', { createHTML: (s) => s }).createHTML('<iframe>')"), "<x-blocked-iframe>");
});

test("F2079.1: a page that changes apply or call does not get the real createElement", () => {
  const { page } = runBlock();
  page(`
    var leaked = [];
    Function.prototype.apply = function () { leaked.push(this); };
    Function.prototype.call = function () { leaked.push(this); };
    Reflect.apply = function (f) { leaked.push(f); };
    document.createElement('div');
    document.createElementNS('${XHTML}', 'div');
    trustedTypes.createPolicy('p', { createHTML: (s) => s }).createHTML('<p>');
  `);
  assert.equal(page("leaked.length"), 0);
  assert.throws(() => page("document.createElement('iframe')"), { name: "NotSupportedError" });
});

test("a name is read once, so a toString that changes its answer does not help", () => {
  const { page, seen } = runBlock();
  const el = page("var n = 0; document.createElement({ toString() { return ++n === 1 ? 'div' : 'iframe'; } })");
  assert.equal(el.tag, "div");
  assert.deepEqual(seen.at(-1), ["createElement", "div"]);
  page("var m = 0; customElements = new CustomElementRegistry(); customElements.define('x-y', class {}, { get extends() { return ++m === 1 ? 'div' : 'iframe'; } })");
  const [kind, options] = seen.at(-1);
  assert.equal(kind, "define");
  assert.equal(options.extends, "div");
  assert.equal(page("m"), 1);
});

test("F2079.2: createDocument and prefixed XHTML markup cannot make a frame", () => {
  const { page, seen, policies } = runBlock();
  for (const q of ["iframe", "h:iframe", "H:IFRAME", "a:b:object"]) {
    assert.throws(() => page(`impl.createDocument('${XHTML}', '${q}', null)`), { name: "NotSupportedError" }, q);
  }
  assert.deepEqual({ ...page(`impl.createDocument('${XHTML}', 'html', null)`) }, { root: "html" });
  const xml = `<h:iframe xmlns:h="${XHTML}"/>`;
  assert.doesNotMatch(B.stripChildFrames(xml), /:iframe/);
  assert.equal(B.stripChildFrames(xml), `<h:x-blocked-iframe xmlns:h="${XHTML}"/>`);
  assert.equal(policies[0].rules.createHTML(xml), `<h:x-blocked-iframe xmlns:h="${XHTML}"/>`);
  page(`new DOMParser().parseFromString(${JSON.stringify(xml)}, 'application/xml')`);
  assert.deepEqual(seen.at(-1), ["parseFromString", `<h:x-blocked-iframe xmlns:h="${XHTML}"/>`, "application/xml"]);
  // An XML entity can spell markup the string check never sees: no DOCTYPE in XML.
  const entity = `<!DOCTYPE x [<!ENTITY e "&#60;h:iframe xmlns:h='${XHTML}'/>">]><x>&e;</x>`;
  assert.throws(() => page(`new DOMParser().parseFromString(${JSON.stringify(entity)}, 'application/xml')`), { name: "NotSupportedError" });
  page("new DOMParser().parseFromString('<!doctype html><p>a</p>', 'text/html')");
  assert.deepEqual(seen.at(-1), ["parseFromString", "<!doctype html><p>a</p>", "text/html"]);
});

test("F2079.3: a document.write that stops inside a tag name is refused", () => {
  const { page, seen } = runBlock();
  for (const s of ["<ifr", "<", "</", "<h:", "<p>a</p><IFRA"]) {
    assert.throws(() => page(`document.write(${JSON.stringify(s)})`), { name: "NotSupportedError" }, s);
    assert.throws(() => page(`document.writeln(${JSON.stringify(s)})`), { name: "NotSupportedError" }, s);
  }
  page("document.write('<ifr', 'ame></iframe>')");
  assert.deepEqual(seen.at(-1), ["write", "<x-blocked-iframe></x-blocked-iframe>"]);
  page("document.write('<p>a < b</p>')");
  assert.deepEqual(seen.at(-1), ["write", "<p>a < b</p>"]);
  page("document.execCommand('insertHTML', false, '<iframe>')");
  assert.deepEqual(seen.at(-1), ["execCommand", "insertHTML", "<x-blocked-iframe>"]);
});

test("F2079.4: a policy whose createHTML getter answers twice is still stripped", () => {
  const { ctx } = runBlock();
  let n = 0;
  const own = ctx.trustedTypes.createPolicy("p", { get createHTML() { return ++n === 1 ? (s) => s : undefined; } });
  assert.equal(own.createHTML("<iframe>"), "<x-blocked-iframe>");
  assert.equal(n, 1);
});

test("stripChildFrames rewrites frame tags as the tokenizer reads them and leaves the rest", () => {
  assert.equal(B.stripChildFrames("<p>a</p><IFRAME src=x></iframe><iframe/>"), "<p>a</p><x-blocked-IFRAME src=x></x-blocked-iframe><x-blocked-iframe/>");
  assert.equal(B.stripChildFrames("<object\tdata=1><embed>\n<frameset><frame>"), "<x-blocked-object\tdata=1><x-blocked-embed>\n<x-blocked-frameset><x-blocked-frame>");
  for (const keep of ["<iframes>", "<x-iframe>", "< iframe>", "<div>iframe</div>", "<objective>", "<h:iframes>"]) assert.equal(B.stripChildFrames(keep), keep);
});

test("the page's strip (no RegExp) and stripChildFrames agree", () => {
  const { policies } = runBlock();
  const corpus = [
    "<p>a</p><IFRAME src=x></iframe><iframe/>", "<object\tdata=1><embed>\n<frameset><frame>", "<iframe", "</iframe",
    "<h:iframe/>", "<a:b:EMBED x>", "<x-iframe>", "<iframes>", "< iframe>", "<<iframe>", "<a<iframe>", "<:iframe>",
    "<fencedframe></fencedframe><portal>", "a < b <c>", "", "<", "</", "<iframe\fx>", "<iframe\rx>",
  ];
  for (const s of corpus) assert.equal(policies[0].rules.createHTML(s), B.stripChildFrames(s), JSON.stringify(s));
});

test("a served page has the block first, no child frame in its markup and Trusted Types on", () => {
  const s = new F.ArtifactStore();
  const r = s.response(s.put("<iframe></iframe><h:iframe/><script>new RTCPeerConnection({iceServers:[{urls:'stun:x.example'}]})</script>").url);
  const block = r.body.indexOf(B.ARTIFACT_RTC_BLOCK_SCRIPT);
  assert.ok(block > 0 && block < r.body.indexOf(F.ARTIFACT_BRIDGE_SCRIPT), "the block comes before the bridge and the page");
  assert.doesNotMatch(r.body.slice(block + B.ARTIFACT_RTC_BLOCK_SCRIPT.length), /<(?:[\w-]*:)?iframe/i);
  assert.doesNotMatch(B.ARTIFACT_RTC_BLOCK_SCRIPT.slice("<script>".length, -"</script>".length), /<\/script|<!--/i);
  assert.match(r.headers["Content-Security-Policy"], /; require-trusted-types-for 'script'; webrtc 'block'$/);
  // My Apps keep the plain artifact CSP: they do not get the block script.
  assert.doesNotMatch(F.ARTIFACT_CSP, /trusted-types|webrtc/);
});

test("main drops an artifact page that has a child frame", () => {
  const win = { url: "app://index.html", parent: null };
  const art = { url: "atomic-art://0123456789abcdef0123456789abcdef/", parent: win };
  const child = { url: "about:blank", parent: art };
  assert.equal(F.artifactFrameAbove(child), art);
  assert.equal(F.artifactFrameAbove({ url: "about:blank", parent: child }), art);
  assert.equal(F.artifactFrameAbove(art), null);
  assert.equal(F.artifactFrameAbove({ url: "about:srcdoc", parent: win }), null);
  assert.equal(F.artifactFrameAbove(null), null);
  const ipc = readFileSync(new URL("../main/artifact-frame-ipc.ts", import.meta.url), "utf8");
  const watch = ipc.slice(ipc.indexOf("export function watchArtifactChildFrames("));
  assert.match(watch, /contents\.on\("frame-created"/);
  assert.match(watch, /artifactFrameAbove\(/);
  assert.match(watch, /store\.drop\(page\.url\);/);
  assert.match(watch, /page\.reload\(\);/);
});

test("the main window turns off WebRTC's UDP and watches artifact frames", () => {
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  const create = main.slice(main.indexOf("function createWindow("), main.indexOf("setPermissionRequestHandler("));
  assert.match(create, /window\.webContents\.setWebRTCIPHandlingPolicy\("disable_non_proxied_udp"\);/);
  assert.match(create, /watchArtifactChildFrames\(window\.webContents\);/);
});
