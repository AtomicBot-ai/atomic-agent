// Unit tests for main/context-mentions.ts (ATO-2241), against the built output.
// Run: npm run build && npm run test:unit
// `@diff`, `@git:N`, `@path:10-40`, `@folder/` and `@https://...` land in the same
// `<mentioned-files>` block as `@file`, under the same caps and the same folder guard.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../out/main/context-mentions.js");
const R = require("../renderer/file-mentions.js");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const fresh = () => { const d = mkdtempSync(join(tmpdir(), "ato2241-")); dirs.push(d); return d; };
const put = (root, rel, body = "x\n") => {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
  return p;
};
const section = (out, path) => {
  const open = `<file path=${JSON.stringify(path)}>\n`;
  const at = out.indexOf(open);
  return at < 0 ? null : out.slice(at + open.length, out.indexOf("</file>", at));
};

/** Fakes that record what was asked and never touch git or the network. */
function fakes(over = {}) {
  const calls = { git: [], urls: [], folders: [] };
  const deps = {
    runGit: async (cwd, args) => { calls.git.push({ cwd, args }); return { text: "diff --git a/x b/x\n+new\n", cut: false }; },
    fetchUrl: async (url) => { calls.urls.push(url); return { text: "page words\n", cut: false }; },
    listFolder: async (dir) => { calls.folders.push(dir); return ["b.ts", "a.ts"]; },
    ...over,
  };
  return { deps, calls };
}

// ---------------------------------------------------------------- line ranges

test("@src/a.ts:2-3 inlines those lines, numbered", async () => {
  const root = fresh();
  put(root, "src/a.ts", "one\ntwo\nthree\nfour\n");
  const { deps } = fakes();
  const out = await C.expandMentions("look at @src/a.ts:2-3", root, undefined, deps);
  assert.equal(section(out, "src/a.ts:2-3"), "2\ttwo\n3\tthree\n");
  assert.ok(out.includes("- src/a.ts:2-3 ("));
});

test("#L2-L3, #L2-3, #L2 and :2 all read a range; the end is clamped to the file", async () => {
  const root = fresh();
  put(root, "a.ts", "one\ntwo\nthree\n");
  const { deps } = fakes();
  for (const [word, body] of [["a.ts#L2-L3", "2\ttwo\n3\tthree\n"], ["a.ts#L2-3", "2\ttwo\n3\tthree\n"],
    ["a.ts#L2", "2\ttwo\n"], ["a.ts:2", "2\ttwo\n"], ["a.ts:3-99", "3\tthree\n"]]) {
    const out = await C.expandMentions(`@${word}`, root, undefined, deps);
    assert.equal(section(out, word), body, word);
  }
});

test("a range past the end is named, not inlined; trailing punctuation is cut", async () => {
  const root = fresh();
  put(root, "a.ts", "one\ntwo\n");
  const { deps } = fakes();
  const out = await C.expandMentions("see @a.ts:9-12.", root, undefined, deps);
  assert.ok(out.includes("a.ts:9-12 (0 B, not inlined: the file has 2 lines)"));
});

test("a range never reads outside the folder: ../, absolute and a symlink out stay text", async () => {
  const outside = fresh();
  const secret = put(outside, "secret.txt", "TOP SECRET\n");
  const parent = fresh();
  const root = join(parent, "chat");
  mkdirSync(root);
  put(parent, "secret.txt", "TOP SECRET\n");
  symlinkSync(secret, join(root, "link.txt"));
  const { deps } = fakes();
  for (const text of ["read @../secret.txt:1", `read @${secret}:1-2`, "read @link.txt#L1"]) {
    assert.equal(await C.expandMentions(text, root, undefined, deps), text, text);
  }
});

// ---------------------------------------------------------------- folders

test("@src/ lists the folder's files, sorted, under the folder's name", async () => {
  const root = fresh();
  put(root, "src/a.ts");
  const { deps, calls } = fakes();
  const out = await C.expandMentions("what is in @src/", root, undefined, deps);
  assert.equal(section(out, "src/"), "src/a.ts\nsrc/b.ts\n");
  assert.deepEqual(calls.folders, [join(realpathSync(root), "src")]);
});

test("the real folder listing walks without git and skips dependency folders", async () => {
  const root = fresh();
  put(root, "src/a.ts");
  put(root, "src/deep/b.ts");
  put(root, "src/node_modules/pkg/index.js");
  const out = await C.expandMentions("@src", root);
  assert.equal(section(out, "src"), "src/a.ts\nsrc/deep/b.ts\n");
});

test("a folder outside, or a symlink to one, is never listed", async () => {
  const outside = fresh();
  put(outside, "secret.txt");
  const parent = fresh();
  const root = join(parent, "chat");
  mkdirSync(root);
  symlinkSync(outside, join(root, "out"));
  const { deps, calls } = fakes();
  for (const text of ["@../", "@out/", `@${outside}/`]) {
    assert.equal(await C.expandMentions(text, root, undefined, deps), text, text);
  }
  assert.deepEqual(calls.folders, []);
});

// ---------------------------------------------------------------- git

test("@diff runs git diff HEAD with fixed arguments kept to the folder", async () => {
  const root = fresh();
  const { deps, calls } = fakes();
  const out = await C.expandMentions("review @diff", root, undefined, deps);
  assert.equal(calls.git.length, 1);
  assert.equal(calls.git[0].cwd, realpathSync(root));
  assert.deepEqual(calls.git[0].args, ["diff", "HEAD", "--no-color", "--no-ext-diff", "--no-textconv", "--relative", "--", "."]);
  assert.equal(section(out, "diff"), "diff --git a/x b/x\n+new\n");
});

test("@git:3 asks for three commits; @git:500 is held to 20; an empty answer says so", async () => {
  const root = fresh();
  const { deps, calls } = fakes({ runGit: async (cwd, args) => { calls.git.push({ cwd, args }); return { text: "", cut: false }; } });
  const out = await C.expandMentions("@git:3 and @git:500", root, undefined, deps);
  assert.equal(calls.git[0].args[1], "-n3");
  assert.equal(calls.git[1].args[1], "-n20");
  assert.deepEqual(calls.git[0].args.slice(-2), ["--", "."]);
  assert.equal(section(out, "git:3"), "No commits touch this folder.\n");
});

test("git failing (not a checkout) is named in the block, the message still goes", async () => {
  const root = fresh();
  const { deps } = fakes({ runGit: async () => { throw new Error("fatal: not a git repository"); } });
  const out = await C.expandMentions("@diff", root, undefined, deps);
  assert.ok(out.includes("- diff (0 B, not inlined: not a git checkout, or git failed)"));
});

test("a real file named diff stays a file mention", async () => {
  const root = fresh();
  put(root, "diff", "my notes\n");
  const { deps, calls } = fakes();
  const out = await C.expandMentions("@diff", root, undefined, deps);
  assert.equal(section(out, "diff"), "my notes\n");
  assert.equal(calls.git.length, 0);
});

// ---------------------------------------------------------------- urls

test("@https://... inlines the page; ftp and plain words are not fetched", async () => {
  const root = fresh();
  const { deps, calls } = fakes();
  const out = await C.expandMentions("read @https://example.com/doc and @ftp://x/y and @hello", root, undefined, deps);
  assert.deepEqual(calls.urls, ["https://example.com/doc"]);
  assert.equal(section(out, "https://example.com/doc"), "page words\n");
});

// ---------------------------------------------------------------- caps

test("files and other mentions share the per-message caps", async () => {
  const root = fresh();
  for (let i = 1; i <= 3; i++) put(root, `b${i}.txt`, "b".repeat(32 * 1024));
  const { deps, calls } = fakes();
  // Three 32 KB files use the 96 KB budget: the diff is named, git is not run.
  const out = await C.expandMentions("@b1.txt @b2.txt @b3.txt @diff", root, undefined, deps);
  assert.ok(out.includes("- diff (0 B, not inlined: the message's file budget is used up)"));
  assert.equal(calls.git.length, 0);
  // Eight entries at most, whatever their kind.
  const words = [];
  for (let i = 1; i <= 8; i++) { put(root, `f${i}.txt`, "f\n"); words.push(`@f${i}.txt`); }
  const full = await C.expandMentions(`${words.join(" ")} @diff`, root, undefined, deps);
  assert.equal(section(full, "diff"), null);
});

test("a long answer is cut to 32 KB and the block says so", async () => {
  const root = fresh();
  const { deps } = fakes({ runGit: async () => ({ text: "d".repeat(100 * 1024), cut: false }) });
  const out = await C.expandMentions("@diff", root, undefined, deps);
  assert.ok(out.includes("- diff (100 KB, truncated to the first 32 KB)"));
  assert.equal(section(out, "diff").replace(/\n$/, "").length, 32 * 1024);
});

// ---------------------------------------------------------------- the message

test("only the last user message is expanded, never without a folder", async () => {
  const root = fresh();
  const { deps } = fakes();
  const history = [{ role: "user", content: "earlier @diff" }, { role: "assistant", content: "ok" }, { role: "user", content: "now @diff" }];
  const out = await C.expandLastUserMessageWithContext(history, root, undefined, deps);
  assert.equal(out[0].content, "earlier @diff");
  assert.notEqual(section(out[2].content, "diff"), null);
  assert.equal(history[2].content, "now @diff");
  assert.deepEqual(await C.expandLastUserMessageWithContext(history, null, undefined, deps), history);
});

test("the chat shows one line per mention and send again gets the typed text back", async () => {
  const root = fresh();
  put(root, "a.ts", "one\ntwo\n");
  const { deps } = fakes();
  const typed = "check @diff and @a.ts:1-2";
  const out = await C.expandMentions(typed, root, undefined, deps);
  assert.equal(R.fmTypedText(out), typed);
  const lines = R.fmCollapse(out).split("\n");
  assert.equal(lines[0], typed);
  assert.ok(lines.some((l) => l.startsWith("@diff · ")));
  assert.ok(lines.some((l) => l.startsWith("@a.ts:1-2 · ")));
});
