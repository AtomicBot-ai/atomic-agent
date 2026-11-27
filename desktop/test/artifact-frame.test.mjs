// ATO-1136: HTML artifacts in the chat are served by main from their own
// scheme under a strict CSP (main/artifact-frame.ts), and the window keeps
// every frame inside it off the web and away from any permission (main.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const F = require("../out/main/artifact-frame.js");

test("the page's CSP lets inline script run and nothing leave the page", () => {
  const csp = F.ARTIFACT_CSP;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'unsafe-inline'(;|$)/);
  assert.match(csp, /style-src 'unsafe-inline'(;|$)/);
  assert.match(csp, /img-src data: blob:(;|$)/);
  for (const d of ["connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'"]) {
    assert.ok(csp.includes(d), d);
  }
  // Loaded on its own the page is still sandboxed: scripts only, no same-origin, popups, top navigation or forms.
  assert.match(csp, /sandbox allow-scripts$/);
  assert.doesNotMatch(csp, /https?:|'self'|\*|allow-same-origin|allow-popups|allow-top-navigation/);
});

test("a page kept in the store is served with its headers, the size reporter and nothing else", () => {
  const s = new F.ArtifactStore();
  const put = s.put("<h1>Hi</h1><script>document.title='x'</script>");
  assert.equal(put.ok, true);
  assert.match(put.url, /^atomic-art:\/\/[0-9a-f]{32}\/$/);
  const r = s.response(put.url);
  assert.equal(r.status, 200);
  assert.equal(r.headers["Content-Type"], "text/html; charset=utf-8");
  // ATO-2536: the artifact CSP plus Trusted Types (artifact-rtc-block.ts).
  assert.equal(r.headers["Content-Security-Policy"], F.ARTIFACT_PAGE_CSP);
  assert.ok(F.ARTIFACT_PAGE_CSP.startsWith(F.ARTIFACT_CSP + "; "));
  assert.equal(r.headers["X-Content-Type-Options"], "nosniff");
  assert.match(r.headers["Permissions-Policy"], /camera=\(\)/);
  assert.match(r.headers["Permissions-Policy"], /microphone=\(\)/);
  assert.ok(r.body.startsWith("<!doctype html>"));
  assert.ok(r.body.includes("<h1>Hi</h1>"));
  assert.ok(r.body.endsWith(F.ARTIFACT_SIZE_SCRIPT));
  // The reporter only posts a height to the parent.
  assert.match(F.ARTIFACT_SIZE_SCRIPT, /parent\.postMessage\(\{atomicArtifact:'size',h:h\},'\*'\)/);
  assert.doesNotMatch(F.ARTIFACT_SIZE_SCRIPT, /fetch|XMLHttpRequest|location|cookie|localStorage/);
});

test("each put is a new URL; unknown and dropped URLs are 404", () => {
  const s = new F.ArtifactStore();
  const a = s.put("<p>a</p>"), b = s.put("<p>a</p>");
  assert.notEqual(a.url, b.url);
  assert.equal(s.response("atomic-art://" + "0".repeat(32) + "/").status, 404);
  assert.equal(s.response("atomic-art://nope/").status, 404);
  assert.equal(s.response("https://example.com/").status, 404);
  s.drop(a.url);
  assert.equal(s.response(a.url).status, 404);
  assert.equal(s.response(b.url).status, 200);
  // A query or hash on the URL still finds the page.
  assert.equal(s.response(b.url + "?x=1").status, 200);
});

test("empty, non-string and oversized pages are refused; the oldest page goes first", () => {
  const s = new F.ArtifactStore(3, 100);
  assert.deepEqual(s.put(""), { ok: false, reason: "empty" });
  assert.deepEqual(s.put("   "), { ok: false, reason: "empty" });
  assert.deepEqual(s.put(42), { ok: false, reason: "empty" });
  assert.deepEqual(s.put("x".repeat(101)), { ok: false, reason: "too-large" });
  // Bytes, not characters: 51 two-byte letters are 102 bytes.
  assert.deepEqual(s.put("ж".repeat(51)), { ok: false, reason: "too-large" });
  const urls = [1, 2, 3, 4].map((i) => s.put("<p>" + i + "</p>").url);
  assert.equal(s.size, 3);
  assert.equal(s.response(urls[0]).status, 404);
  assert.equal(s.response(urls[3]).status, 200);
});

test("a frame in the window may only go to artifact pages and the preview's own frames", () => {
  for (const u of ["atomic-art://" + "a".repeat(32) + "/", "about:srcdoc", "about:blank", "blob:file:///1234", "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html"]) {
    assert.equal(F.subframeNavAllowed(u), true, u);
  }
  for (const u of ["https://evil.example/", "http://localhost:3000/", "file:///etc/passwd", "data:text/html,hi", "javascript:alert(1)", "atomic-art-x://", ""]) {
    assert.equal(F.subframeNavAllowed(u), false, u);
  }
});

test("a permission asked from a frame inside the window is refused before the voice rule is asked", () => {
  assert.equal(F.permissionFromSubframe({ isMainFrame: false, requestingUrl: "atomic-art://abc/" }), true);
  assert.equal(F.permissionFromSubframe({ isMainFrame: false }), true);
  assert.equal(F.permissionFromSubframe({ requestingUrl: "ATOMIC-ART://abc/" }), true);
  assert.equal(F.permissionFromSubframe({ isMainFrame: true, requestingUrl: "file:///app/index.html" }), false);
  assert.equal(F.permissionFromSubframe(undefined), false);

  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  const req = main.slice(main.indexOf("setPermissionRequestHandler("), main.indexOf("setPermissionCheckHandler("));
  assert.ok(req.indexOf("permissionFromSubframe(") > 0 && req.indexOf("permissionFromSubframe(") < req.indexOf("voicePermissionVerdict("));
  const chk = main.slice(main.indexOf("setPermissionCheckHandler("), main.indexOf("void window.loadFile("));
  assert.match(chk, /!permissionFromSubframe\([\s\S]*&& voicePermissionVerdict\(/);
  assert.match(main, /on\("will-frame-navigate", \(event\) => \{\s*if \(!event\.isMainFrame && !subframeNavAllowed\(event\.url\)\) event\.preventDefault\(\);/);
  // The scheme is registered before the app is ready (module scope) and served once IPC is wired.
  assert.match(main, /\nregisterArtifactScheme\(\);\n/);
  assert.match(main, /\n {2}wireArtifactIpc\(\);\n/);
});

test("the window may frame the scheme, and the bridge exposes only put and drop", () => {
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.match(html, /frame-src blob: atomic-art:;/);
  assert.match(html, /script-src 'self';/, "the window's own script policy is unchanged");
  const pre = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  assert.match(pre, /artifactPut: \(html: string\) => ipcRenderer\.invoke\("app:artifactPut", html\)/);
  assert.match(pre, /artifactDrop: \(url: string\) => ipcRenderer\.invoke\("app:artifactDrop", url\)/);
  const ipc = readFileSync(new URL("../main/artifact-frame-ipc.ts", import.meta.url), "utf8");
  assert.match(ipc, /standard: true, secure: true/);
  assert.doesNotMatch(ipc, /bypassCSP|allowServiceWorkers|corsEnabled: true|supportFetchAPI: true/);
});

// ATO-2375: the widget bridge every page gets before its own markup.

/** Objects made in the vm context, as plain objects of this one (deepEqual checks prototypes). */
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Run the bridge script in a bare context with a fake parent: what it posted, its window, a way to fire events. */
function runBridge() {
  const posted = [], listeners = {}, events = [];
  const parent = { postMessage: (m, o) => posted.push({ m: plain(m), o }) };
  const ctx = {
    parent, JSON, String, Number, Promise, setTimeout,
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
    dispatchEvent: (e) => { events.push(e); return true; },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const src = F.ARTIFACT_BRIDGE_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "");
  vm.runInContext(src, ctx);
  const fire = (t, e) => (listeners[t] || []).forEach((f) => f(e));
  return { ctx, posted, events, fire, parent };
}

test("the widget bridge runs before the page's markup and reaches nothing but its parent", () => {
  const s = new F.ArtifactStore();
  const page = "<script>sendPrompt('hi')</script>";
  const r = s.response(s.put(page).url);
  const at = r.body.indexOf(F.ARTIFACT_BRIDGE_SCRIPT);
  assert.ok(at > 0 && at < r.body.indexOf(page), "the bridge comes before the page");
  assert.ok(r.body.endsWith(F.ARTIFACT_SIZE_SCRIPT));
  assert.doesNotMatch(F.ARTIFACT_BRIDGE_SCRIPT, /fetch|XMLHttpRequest|WebSocket|location|cookie|localStorage|window\.atomic=/);
  assert.match(F.ARTIFACT_BRIDGE_SCRIPT, /window\.atomicWidget=/);
  assert.match(F.ARTIFACT_BRIDGE_SCRIPT, /window\.sendPrompt=/);
  // The page is as sandboxed as before.
  assert.match(F.ARTIFACT_CSP, /connect-src 'none'/);
  assert.match(F.ARTIFACT_CSP, /sandbox allow-scripts$/);
});

test("the bridge says ready on start; sendPrompt posts the text, capped", () => {
  const { ctx, posted } = runBridge();
  assert.deepEqual(posted[0], { m: { atomicArtifact: "ready" }, o: "*" });
  assert.equal(ctx.sendPrompt("Pick laptop B"), true);
  assert.deepEqual(posted[1].m, { atomicArtifact: "prompt", text: "Pick laptop B" });
  assert.equal(ctx.atomicWidget.sendPrompt, ctx.sendPrompt);
  assert.equal(ctx.sendPrompt("   "), false);
  assert.equal(ctx.sendPrompt(42), false);
  assert.equal(posted.length, 2);
  ctx.sendPrompt("x".repeat(F.ARTIFACT_PROMPT_MAX + 50));
  assert.equal(posted.at(-1).m.text.length, F.ARTIFACT_PROMPT_MAX);
});

test("state: get answers what the parent sent back, set posts JSON of at most 64 KB", async () => {
  const { ctx, posted, events, fire, parent } = runBridge();
  // A message from anyone but the parent is ignored.
  fire("message", { source: {}, data: { atomicWidget: "state", state: { evil: 1 } } });
  fire("message", { source: parent, data: { atomicWidget: "state", state: { n: 3 } } });
  assert.deepEqual(plain(await ctx.atomicWidget.state.get()), { n: 3 });
  assert.equal(events.at(-1).type, "atomicwidgetstate");
  assert.equal(ctx.atomicWidget.state.set({ n: 4 }), true);
  assert.deepEqual(posted.at(-1).m, { atomicArtifact: "state", json: "{\"n\":4}" });
  assert.deepEqual(plain(await ctx.atomicWidget.state.get()), { n: 4 });
  const before = posted.length;
  assert.equal(ctx.atomicWidget.state.set("x".repeat(F.ARTIFACT_STATE_MAX)), false, "over 64 KB once quoted");
  const loop = {}; loop.self = loop;
  assert.equal(ctx.atomicWidget.state.set(loop), false);
  assert.equal(posted.length, before);
});

test("script errors and rejections are reported, three per load at most", () => {
  const { posted, fire } = runBridge();
  fire("error", { message: "Uncaught TypeError: x is not a function", lineno: 12 });
  fire("unhandledrejection", { reason: { message: "boom" } });
  fire("error", { message: "y".repeat(1000), lineno: 3 });
  fire("error", { message: "fourth", lineno: 4 });
  const errs = posted.filter((p) => p.m.atomicArtifact === "error").map((p) => p.m);
  assert.equal(errs.length, F.ARTIFACT_ERRORS_PER_LOAD);
  assert.deepEqual(errs[0], { atomicArtifact: "error", message: "Uncaught TypeError: x is not a function", line: 12 });
  assert.match(errs[1].message, /^Unhandled promise rejection: boom$/);
  assert.equal(errs[2].message.length, F.ARTIFACT_ERROR_MAX);
});
