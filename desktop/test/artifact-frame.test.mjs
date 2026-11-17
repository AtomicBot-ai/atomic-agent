// ATO-1136: HTML artifacts in the chat are served by main from their own
// scheme under a strict CSP (main/artifact-frame.ts), and the window keeps
// every frame inside it off the web and away from any permission (main.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

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
  assert.equal(r.headers["Content-Security-Policy"], F.ARTIFACT_CSP);
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
