// ATO-2445: `src/api.py:42` in a reply is a chip that opens the preview on that line.
// renderer/reply-line-links.js is pure; main/line-path.ts is tested against
// the built output (npm run build) in throwaway folders.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { lineLinkMatch, lineLinksInHtml } = require("../renderer/reply-line-links.js");
const { resolveLinePath, pickByTail } = require("../out/main/line-path.js");

const links = (html, win) => {
  const got = [];
  const out = lineLinksInHtml(html, win, (m) => { got.push(m); return "\u0001" + (got.length - 1) + "\u0001"; });
  return { out, got };
};

test("a code span that is one path and a line is a link; anything else is not", () => {
  assert.deepEqual(lineLinkMatch("src/api.py:42", false), { path: "src/api.py", line: 42, col: 0 });
  assert.deepEqual(lineLinkMatch("src/api.py:42:7", false), { path: "src/api.py", line: 42, col: 7 });
  assert.deepEqual(lineLinkMatch("api.py#L9", false), { path: "api.py", line: 9, col: 0 });
  assert.deepEqual(lineLinkMatch("~/w/a.ts:3", false), { path: "~/w/a.ts", line: 3, col: 0 });
  assert.deepEqual(lineLinkMatch("/abs/x.rs:10", false), { path: "/abs/x.rs", line: 10, col: 0 });
  assert.equal(lineLinkMatch("src/api.py", false), null, "no line: not this link (the path chip handles it)");
  assert.equal(lineLinkMatch("src/api.py:0", false), null);
  assert.equal(lineLinkMatch("example.com:8080", false), null, "a host and port");
  assert.equal(lineLinkMatch("https://x.io/a.py:3", false), null);
  assert.equal(lineLinkMatch("12:30", false), null);
  assert.equal(lineLinkMatch("call f(src/api.py:42)", false), null);
});

test("Windows paths: a drive letter and backslashes, only when the window runs on Windows", () => {
  assert.deepEqual(lineLinkMatch("C:\\x\\y.ts:10", true), { path: "C:\\x\\y.ts", line: 10, col: 0 });
  assert.deepEqual(lineLinkMatch("src\\y.ts:10", true), { path: "src\\y.ts", line: 10, col: 0 });
  assert.equal(lineLinkMatch("C:\\x\\y.ts:10", false), null);
});

test("in a reply's text: chips for path:line, never inside a link, a button or a tag", () => {
  const { out, got } = links("<p>See src/api.py:42 and <a class=\"msglink\" data-url=\"https://h/a.py:3\">h/a.py:3</a>.</p>", false);
  assert.equal(got.length, 1);
  assert.match(got[0], /data-lnpath="src\/api\.py" data-ln="42"/);
  assert.match(out, /See \u00010\u0001 and <a /);
  assert.match(out, />h\/a\.py:3<\/a>/, "the link's own text stays");
  const two = links("<li>lib/a.ts:1:2, then b.go:30.</li>", false);
  assert.equal(two.got.length, 2, "a trailing comma or full stop is not part of it");
  assert.match(two.got[0], /data-lncol="2"/);
  assert.equal(links("version 1.2:3 at 10:30, see example.com:443", false).got.length, 0);
  assert.equal(links("<button class=\"filechip\">x/a.py:3</button>", false).got.length, 0);
  const evil = links("<p>a\"onmouseover=x.py:3</p>", false);
  for (const m of evil.got) assert.doesNotMatch(m, /"onmouseover/, "a quote never reaches an attribute");
});

/* ---- main ---- */

const root = mkdtempSync(join(tmpdir(), "lnp-"));
after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, "src", "deep"), { recursive: true });
writeFileSync(join(root, "src", "api.py"), "x\n");
writeFileSync(join(root, "src", "deep", "api.py"), "y\n");
writeFileSync(join(root, "README.md"), "r\n");
const P = process.platform;
const list = async () => ["README.md", "src/api.py", "src/deep/api.py"];

test("a relative path is found in the chat's folder; a bare name by the end of its path, the shallowest first", async () => {
  assert.deepEqual(await resolveLinePath("src/api.py", root, root, P, list), { ok: true, path: join(root, "src", "api.py") });
  assert.deepEqual(await resolveLinePath("./README.md", root, root, P, list), { ok: true, path: join(root, "README.md") });
  assert.deepEqual(await resolveLinePath("api.py", root, root, P, list), { ok: true, path: join(root, "src", "api.py") });
  assert.deepEqual(await resolveLinePath("deep/api.py", root, root, P, list), { ok: true, path: join(root, "src", "deep", "api.py") });
  assert.deepEqual(await resolveLinePath(join(root, "README.md"), null, root, P), { ok: true, path: join(root, "README.md") });
  assert.equal(pickByTail(["a/b/x.ts", "x.ts", "c/x.ts"], "x.ts"), "x.ts");
});

test("nothing climbs out of the folder, and a missing file or a bad path says so", async () => {
  const sibling = mkdtempSync(join(tmpdir(), "lnp-out-"));
  writeFileSync(join(sibling, "s.py"), "z\n");
  try {
    const rel = join("..", sibling.split(/[\\/]/).pop(), "s.py");
    assert.equal((await resolveLinePath(rel, root, root, P, list)).ok, false, "`..` out of the chat's folder");
    assert.deepEqual(await resolveLinePath("nope.py", root, root, P, list), { ok: false, reason: "missing" });
    assert.deepEqual(await resolveLinePath("src/api.py", null, root, P, list), { ok: false, reason: "missing" });
    assert.deepEqual(await resolveLinePath("https://x/a.py", root, root, P), { ok: false, reason: "bad-path" });
    assert.deepEqual(await resolveLinePath(42, root, root, P), { ok: false, reason: "bad-path" });
    assert.deepEqual(await resolveLinePath(join(root, "src"), null, root, P), { ok: false, reason: "missing" }, "a folder is not a file");
  } finally {
    rmSync(sibling, { recursive: true, force: true });
  }
});
