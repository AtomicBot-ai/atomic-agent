// ATO-2751: the composer's `@` menu offers @diff / @git:N / ranges / links as
// rows (renderer/mention-rows.js), shows "Searching…" and "Couldn't search
// files" instead of vanishing, lets Enter send when there is nothing to pick,
// and says why a mention was skipped (renderer/file-mentions.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const MR = require("../renderer/mention-rows.js");
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/* ---------- the kind rows, read from the typed text ---------- */

test("@diff and @git are offered from their first letters; a typed kind stays as typed", () => {
  assert.deepEqual(MR.mrKindRows(""), []);
  assert.deepEqual(MR.mrKindRows("d"), ["diff"]);
  assert.deepEqual(MR.mrKindRows("diff"), ["diff"]);
  assert.deepEqual(MR.mrKindRows("gi"), ["git:5"]);
  assert.deepEqual(MR.mrKindRows("git:"), ["git:5"]);
  assert.deepEqual(MR.mrKindRows("git:3"), ["git:3"]);
  assert.deepEqual(MR.mrKindRows("git:77"), ["git:20"]);
  assert.deepEqual(MR.mrKindRows("git:0"), []);
  assert.deepEqual(MR.mrKindRows("https://example.com/a"), ["https://example.com/a"]);
  assert.deepEqual(MR.mrKindRows("https://"), [], "no host yet: nothing to read");
  assert.deepEqual(MR.mrKindRows("src/a.ts:10-40"), ["src/a.ts:10-40"]);
  assert.deepEqual(MR.mrKindRows("src/a.ts#L10"), ["src/a.ts#L10"]);
  assert.deepEqual(MR.mrKindRows("src/"), ["src/"]);
  assert.deepEqual(MR.mrKindRows("readme"), []);
});

test("each kind row says what it reads, in words", () => {
  assert.equal(MR.mrRowHint("diff"), "Uncommitted changes");
  assert.equal(MR.mrRowHint("git:1"), "The last commit");
  assert.equal(MR.mrRowHint("git:5"), "The last 5 commits");
  assert.equal(MR.mrRowHint("https://example.com"), "Web page");
  assert.equal(MR.mrRowHint("src/a.ts:10-40"), "Lines 10 to 40");
  assert.equal(MR.mrRowHint("src/a.ts:7"), "Line 7");
  assert.equal(MR.mrRowHint("src/"), "Folder");
  assert.equal(MR.mrRowHint("src/app.ts"), "");
});

test("kind rows go first and a path main also returned is listed once", () => {
  assert.deepEqual(MR.mrMerge(["diff"], ["diff", "a.ts", "b.ts"], 50), ["diff", "a.ts", "b.ts"]);
  assert.equal(MR.mrMerge([], Array.from({ length: 80 }, (_, i) => "f" + i), 50).length, 50);
});

test("a skip reason is said plainly; an HTTP code never reaches the chat line", () => {
  assert.equal(MR.mrSkipReason("not a git checkout, or git failed"), "not a git checkout, or git failed");
  assert.equal(MR.mrSkipReason("HTTP 404"), "page not found");
  assert.equal(MR.mrSkipReason("HTTP 403"), "the page needs a sign-in");
  assert.equal(MR.mrSkipReason("HTTP 503"), "the site had a problem");
  assert.equal(MR.mrSkipReason("not a text page (image/png)"), "not a text page");
  assert.equal(MR.mrSkipReason("no answer in 10 s"), "the site did not answer");
  assert.equal(MR.mrSkipReason(""), "skipped");
});

/* ---------- the menu, in one context with the globals it reads ---------- */

function load(search) {
  const timers = [];
  const ctx = {
    console: { warn() {} }, document: undefined, URL,
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    S: { draft: "", slash: false, overlay: null, settings: null, alert: null },
    BR: { mentionsSearch: async (_sid, q) => search(q) },
  };
  vm.createContext(ctx);
  vm.runInContext(read("../renderer/mention-rows.js"), ctx, { filename: "mention-rows.js" });
  vm.runInContext(read("../renderer/file-mentions.js"), ctx, { filename: "file-mentions.js" });
  ctx.type = (value) => { ctx.S.draft = value; vm.runInContext("fmOnInput", ctx)({ value, selectionStart: value.length }); };
  ctx.flush = async () => { const fns = timers.splice(0); for (const fn of fns) await fn(); };
  ctx.menu = () => vm.runInContext("fmMenuHTML()", ctx);
  ctx.key = (key) => {
    const ev = { key, target: { id: "entry" }, shiftKey: false, altKey: false, prevented: false, preventDefault() { ev.prevented = true; } };
    return { took: vm.runInContext("fmKeydown", ctx)(ev), prevented: ev.prevented };
  };
  return ctx;
}

test("@diff is a row with its hint, even before the file search answers", async () => {
  const c = load(() => ({ ok: true, paths: [] }));
  c.type("show @diff");
  assert.match(c.menu(), /data-fm-row="0"[^>]*>.*@.*diff.*Uncommitted changes/);
  await c.flush();
  assert.doesNotMatch(c.menu(), /No matching files/);
});

test("Enter on a fully typed @git:3 is the composer's: it sends instead of only closing the menu", async () => {
  const c = load(() => ({ ok: true, paths: ["git:3"] }));
  c.type("@git:3");
  await c.flush();
  const k = c.key("Enter");
  assert.equal(k.took, false, "renderer.js goes on to submit()");
  assert.equal(k.prevented, false);
  assert.equal(c.menu(), "");
});

test("Enter with nothing to pick sends", async () => {
  const c = load(() => ({ ok: true, paths: [] }));
  c.type("@zzz");
  await c.flush();
  assert.match(c.menu(), /No matching files/);
  const k = c.key("Enter");
  assert.equal(k.took, false);
  assert.equal(k.prevented, false);
});

test("Enter on a partly typed row still picks it", async () => {
  const c = load(() => ({ ok: true, paths: ["src/app.ts"] }));
  c.type("@ap");
  await c.flush();
  const k = c.key("Enter");
  assert.equal(k.took, true);
  assert.equal(c.S.draft, "@src/app.ts ");
});

test("a slow search shows Searching…; a quick one never draws it", async () => {
  let release;
  const c = load(() => new Promise((r) => { release = r; }));
  c.type("@rea");
  assert.equal(c.menu(), "", "nothing drawn in the first moment");
  const pending = c.flush();   // runs the debounce (search on its way) and the slow-search timer
  await new Promise((r) => setImmediate(r));
  assert.match(c.menu(), /Searching…/);
  release({ ok: true, paths: ["README.md"] });
  await pending;
  assert.doesNotMatch(c.menu(), /Searching…/);
  assert.match(c.menu(), /README\.md/);
});

test("a failed search is a visible row, not a vanished menu, and keeps the kind rows", async () => {
  const c = load(() => { throw new Error("EACCES"); });
  c.type("@di");
  await c.flush();
  const html = c.menu();
  assert.match(html, /Couldn’t search files/);
  assert.match(html, /diff/);
  assert.doesNotMatch(html, /EACCES/, "the raw error stays in the log");
  const d = load(() => ({ ok: true, paths: ["git:5"], filesError: "git ls-files timed out" }));
  d.type("@gi");
  await d.flush();
  assert.match(d.menu(), /Couldn’t search files/);
  assert.match(d.menu(), /git:5/);
});

test("a sent @diff that was skipped says why, not just \"not inlined\"", () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(read("../renderer/mention-rows.js"), ctx);
  vm.runInContext(read("../renderer/file-mentions.js"), ctx);
  const sep = vm.runInContext("FM_SEPARATOR", ctx);
  const msg = "check @diff @https://x.test/a" + sep
    + "- diff (0 B, not inlined: not a git checkout, or git failed)\n"
    + "- https://x.test/a (0 B, not inlined: HTTP 404)\n</mentioned-files>";
  assert.equal(vm.runInContext("fmCollapse", ctx)(msg), [
    "check @diff @https://x.test/a",
    "@diff · skipped: not a git checkout, or git failed",
    "@https://x.test/a · skipped: page not found",
  ].join("\n"));
});

test("main still offers the words when the file listing fails; index.html loads mention-rows.js first", () => {
  const ipc = read("../main/file-mentions-ipc.ts");
  assert.match(ipc, /words\.length \? \{ ok: true, paths: words, filesError: error \} : \{ ok: false, error \}/);
  const html = read("../renderer/index.html");
  const at = html.indexOf('src="mention-rows.js"');
  assert.ok(at > 0 && at < html.indexOf('src="file-mentions.js"'));
});
