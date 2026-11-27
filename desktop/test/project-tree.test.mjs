// ATO-2445: the Files panel's project tree of the chat's folder, with git marks.
// main/project-tree.ts and project-tree-git.ts are tested against the built
// output (npm run build) in throwaway folders, one of them a real git
// checkout; the renderer's project-tree.js runs in a vm after file-preview.js.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const { listTreeDir, cleanRel, sortEntries } = require("../out/main/project-tree.js");
const { markFor, parseStatus, gitIgnored, runGitCode } = require("../out/main/project-tree-git.js");

const home = mkdtempSync(join(tmpdir(), "pt-home-"));
const away = mkdtempSync(join(tmpdir(), "pt-away-"));
after(() => { for (const d of [home, away]) rmSync(d, { recursive: true, force: true }); });
const P = process.platform;
const names = (r) => r.entries.map((e) => (e.dir ? e.name + "/" : e.name) + (e.mark ? ":" + e.mark : "") + (e.changed ? "*" : ""));

const repo = join(home, "proj");
mkdirSync(join(repo, "src", "deep"), { recursive: true });
mkdirSync(join(repo, "node_modules", "x"), { recursive: true });
mkdirSync(join(repo, "build"), { recursive: true });
writeFileSync(join(repo, ".gitignore"), "node_modules/\n*.log\nbuild/\n");
writeFileSync(join(repo, "README.md"), "r\n");
writeFileSync(join(repo, "src", "a.ts"), "a\n");
writeFileSync(join(repo, "src", "file 10.ts"), "b\n");
writeFileSync(join(repo, "src", "file 2.ts"), "c\n");
writeFileSync(join(repo, "src", "deep", "d.ts"), "d\n");
const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
git("init", "-q");
git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
writeFileSync(join(repo, "src", "a.ts"), "changed\n");
writeFileSync(join(repo, "src", "deep", "new.ts"), "n\n");
writeFileSync(join(repo, "debug.log"), "l\n");

test("a git checkout: .gitignore'd entries left out, folders first, git marks, a dot on changed folders", async () => {
  const top = await listTreeDir(repo, "", [home], P);
  assert.equal(top.ok, true);
  assert.equal(top.git, true);
  assert.deepEqual(names(top), ["src/*", ".gitignore", "README.md"], "node_modules/, build/ and *.log are ignored; .git never shows");
  const src = await listTreeDir(repo, "src", [home], P);
  assert.deepEqual(names(src), ["deep/*", "a.ts:M", "file 2.ts", "file 10.ts"], "digits as numbers");
  const deep = await listTreeDir(repo, "src/deep", [home], P);
  assert.deepEqual(names(deep), ["d.ts", "new.ts:U"]);
});

test("check-ignore gets its paths on stdin, NUL-separated (git refuses -z without --stdin)", async () => {
  const calls = [];
  const stub = async (cwd, args, input) => { calls.push({ args, input }); return { code: 0, out: "build/\0" }; };
  const got = await gitIgnored(stub, repo, ["build/", "README.md"]);
  assert.deepEqual([...got], ["build"]);
  assert.deepEqual(calls, [{ args: ["check-ignore", "--stdin", "-z"], input: "build/\0README.md\0" }], "no paths on the command line");
  const real = await gitIgnored(runGitCode, repo, ["node_modules/", "build/", "debug.log", "src/", "README.md"]);
  assert.deepEqual([...real].sort(), ["build", "debug.log", "node_modules"], "the real git answers through stdin");
});

test("a name that starts with ':' is sent as ./name, so check-ignore does not read it as pathspec magic", async () => {
  const calls = [];
  const stub = async (cwd, args, input) => { calls.push(input); return { code: 0, out: "./:!x\0build/\0" }; };
  assert.deepEqual([...(await gitIgnored(stub, repo, [":!x", "build/", "README.md"]))].sort(), [":!x", "build"]);
  assert.deepEqual(calls, ["./:!x\0build/\0README.md\0"]);
});

test("a folder holding ':!x', ':^y' and ':(x)' still has its .gitignore'd entries left out", { skip: P === "win32" }, async () => {
  const colon = join(home, "colon");
  mkdirSync(join(colon, "build"), { recursive: true });
  writeFileSync(join(colon, ".gitignore"), "build/\n*.log\n");
  for (const n of [":!x", ":^y", ":(x)", "debug.log"]) writeFileSync(join(colon, n), "n\n");
  execFileSync("git", ["init", "-q"], { cwd: colon, stdio: "pipe" });
  const r = await listTreeDir(colon, "", [home], P);
  assert.equal(r.git, true);
  assert.deepEqual(r.entries.map((e) => e.name).sort(), [".gitignore", ":!x", ":(x)", ":^y"], "build/ and debug.log stay hidden");
});

test("a submodule's folder: its own .gitignore applies (check-ignore from the top dies 'is in submodule')", async () => {
  const sub = join(home, "sub-src");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, ".gitignore"), "node_modules/\n");
  writeFileSync(join(sub, "keep.txt"), "k\n");
  const id = ["-c", "user.email=t@t", "-c", "user.name=t"];
  const g = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe" });
  g(sub, "init", "-q"); g(sub, "add", "."); g(sub, ...id, "commit", "-q", "-m", "s");
  const sup = join(home, "super");
  mkdirSync(sup, { recursive: true });
  writeFileSync(join(sup, "top.txt"), "t\n");
  g(sup, "init", "-q"); g(sup, "add", "."); g(sup, ...id, "commit", "-q", "-m", "t");
  g(sup, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "lib");
  g(sup, ...id, "commit", "-q", "-m", "lib");
  mkdirSync(join(sup, "lib", "node_modules", "x"), { recursive: true });
  const lib = await listTreeDir(sup, "lib", [home], P);
  assert.equal(lib.ok, true);
  assert.equal(lib.git, true);
  assert.deepEqual(lib.entries.map((e) => e.name).sort(), [".gitignore", "keep.txt"], "node_modules/ is left out; the .git file never shows");
});

test("a link to a folder in the checkout does not stop .gitignore from applying", { skip: P === "win32" }, async () => {
  symlinkSync(join(repo, "src"), join(repo, "srclink"));
  const top = await listTreeDir(repo, "", [home], P);
  assert.deepEqual(names(top), ["src/*", "srclink/", ".gitignore", "README.md"], "node_modules/, build/ and *.log still left out");
  const inLink = await listTreeDir(repo, "srclink", [home], P);
  assert.equal(inLink.ok, true);
  assert.equal(inLink.git, false, "git does not follow the link, so its folder is a plain one");
  assert.deepEqual(names(inLink), ["deep/", "a.ts", "file 2.ts", "file 10.ts"]);
});

test("outside a checkout: the mention walk's skipped folders are left out, no marks", async () => {
  const plain = join(home, "plain");
  mkdirSync(join(plain, "node_modules"), { recursive: true });
  mkdirSync(join(plain, "docs"), { recursive: true });
  writeFileSync(join(plain, "notes.txt"), "n\n");
  const r = await listTreeDir(plain, "", [home], P, { git: null });
  assert.deepEqual(names(r), ["docs/", "notes.txt"]);
  assert.equal(r.git, false);
  const empty = await listTreeDir(plain, "docs", [home], P, { git: null });
  assert.deepEqual(empty.entries, []);
  const capped = await listTreeDir(plain, "", [home], P, { git: null, max: 1 });
  assert.equal(capped.entries.length, 1);
  assert.equal(capped.cut, true);
});

test("read scope: only inside the preview's roots, never out of the tree's root, by `..` or a link", async () => {
  assert.deepEqual(await listTreeDir(away, "", [home], P, { git: null }), { ok: false, reason: "outside" }, "a folder the preview cannot read");
  assert.deepEqual(await listTreeDir(repo, "../plain", [home], P, { git: null }), { ok: false, reason: "outside" });
  assert.deepEqual(await listTreeDir(repo, "nope", [home], P, { git: null }), { ok: false, reason: "missing" });
  assert.deepEqual(await listTreeDir(repo, "README.md", [home], P, { git: null }), { ok: false, reason: "not-dir" });
  if (P !== "win32") {
    writeFileSync(join(away, "secret.txt"), "s\n");
    symlinkSync(away, join(repo, "out-link"));
    const top = await listTreeDir(repo, "", [home], P, { git: null });
    assert.ok(top.entries.some((e) => e.name === "out-link" && e.dir), "the link is shown");
    assert.deepEqual(await listTreeDir(repo, "out-link", [home], P, { git: null }), { ok: false, reason: "outside" }, "and not opened");
  }
  assert.equal(cleanRel("a\\b/./c"), "a/b/c");
  assert.equal(cleanRel("a/../b"), null);
  assert.equal(cleanRel(undefined), "");
});

test("git status letters and porcelain parsing (renames carry their old path)", () => {
  assert.equal(markFor("??"), "U");
  assert.equal(markFor(" M"), "M");
  assert.equal(markFor("A "), "A");
  assert.equal(markFor("R "), "R");
  assert.equal(markFor("UU"), "C");
  assert.equal(markFor(" D"), "D");
  const m = parseStatus(" M sub/a.ts\0R  sub/new.ts\0sub/old.ts\0?? sub/x/\0 M other/b.ts\0", "sub/");
  assert.deepEqual([...m.entries()], [["a.ts", "M"], ["new.ts", "R"], ["x", "U"]]);
  const sorted = sortEntries([{ name: "b", dir: false }, { name: "Z", dir: true }, { name: "a", dir: false }]);
  assert.deepEqual(sorted.map((e) => e.name), ["Z", "a", "b"]);
});

/* ---- renderer ---- */

function loadPanel(tree) {
  const ctx = vm.createContext({ window: { atomic: { filesTree: tree } }, setTimeout, clearTimeout, Intl, console });
  for (const f of ["table-sort.js", "file-preview.js", "project-tree.js"]) {
    vm.runInContext(readFileSync(join(HERE, "..", "renderer", f), "utf8"), ctx, { filename: f });
  }
  return (code) => vm.runInContext(code, ctx);
}

test("the list view has This chat / Project; Project loads the root, then each folder opened", async () => {
  const asked = [];
  const run = loadPanel(async (sid, rel) => {
    asked.push(rel);
    if (rel === "") return { ok: true, root: "/w/proj", name: "proj", rel: "", git: true, cut: false,
      entries: [{ name: "src", rel: "src", dir: true, changed: true }, { name: "a.md", rel: "a.md", dir: false, mark: "M" }] };
    return { ok: true, root: "/w/proj", rel, git: true, cut: false, entries: [] };
  });
  const chat = run("ptListHtml('<ul>chat</ul>')");
  assert.match(chat, /aria-selected="true" data-ptx="mode" data-pt-mode="chat"/);
  assert.match(chat, /<ul>chat<\/ul>/);
  run("PT.mode = 'tree';");
  assert.match(run("ptListHtml('')"), /Loading…/);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const tree = run("ptListHtml('')");
  assert.match(tree, /data-ptx="toggle" data-pt-rel="src" aria-expanded="false"/);
  assert.match(tree, /class="pt-dot"/);
  assert.match(tree, /pt-mark pt-m-M" title="Modified">M</);
  assert.equal(run("JSON.stringify(ptHead())"), JSON.stringify({ name: "proj", meta: "Git checkout" }));
  run("PT.open.add('src'); ptListHtml('');");
  assert.deepEqual(asked, [""], "a folder is read when it is opened, not before");
  assert.equal(run("ptJoin('/w/proj', 'src/a.ts')"), "/w/proj/src/a.ts");
  assert.equal(run("ptJoin('C:\\\\w\\\\proj', 'src/a.ts')"), "C:\\w\\proj\\src\\a.ts");
});

test("the tree's error and empty states read plainly", () => {
  const run = loadPanel(async () => ({ ok: false, reason: "remote" }));
  run("PT.mode = 'tree'; PT.sid = null; PT.nodes.set('', {state: 'error', reason: 'remote'});");
  assert.match(run("ptRowsHtml('', 0)"), /on another computer/);
  run("PT.nodes.set('', {state: 'ok', entries: [], cut: false});");
  assert.match(run("ptRowsHtml('', 0)"), /This folder is empty\./);
  run("PT.nodes.set('', {state: 'ok', entries: [{name: 'x', rel: 'x', dir: true}], cut: true}); PT.open.add('x'); PT.nodes.set('x', {state: 'ok', entries: [], cut: false});");
  const html = run("ptRowsHtml('', 0)");
  assert.match(html, /Empty folder/);
  assert.match(html, /Showing the first 1 item of this folder\./);
});
