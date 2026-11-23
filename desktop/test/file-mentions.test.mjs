// Unit tests for main/file-mentions.ts (ATO-1593 / ATO-1595), against the built output.
// Run: npm run build && npm run test:unit
// The @ palette's file list (bounded, cached, dependency folders skipped) and
// the block a sent message carries for the files it names. Nothing outside the
// chat folder is ever read: `../`, absolute paths and symlinks that lead out stay text.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const F = require("../out/main/file-mentions.js");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const fresh = () => { const d = mkdtempSync(join(tmpdir(), "ato1593-")); dirs.push(d); return d; };
const put = (root, rel, body = "x\n") => {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
  return p;
};
const limits = (over = {}) => ({ ...F.DEFAULT_FILE_INDEX_LIMITS, ...over });
const fileCount = (text) => (text.match(/<file path=/g) ?? []).length;

// ---------------------------------------------------------------- listing

test("the walk stops at the path limit", async () => {
  const root = fresh();
  for (let i = 0; i < 30; i++) put(root, `f${i}.txt`);
  const files = await F.walkFiles(root, limits({ maxFiles: 10 }));
  assert.equal(files.length, 10);
});

test("the walk stops at the time budget", async () => {
  const root = fresh();
  put(root, "top.txt");
  put(root, "deep/below.txt");
  // Each look at the clock moves it 150 ms: the deadline (200 ms) passes after the first folder.
  let t = 0;
  const now = () => { const v = t; t += 150; return v; };
  const files = await F.walkFiles(root, limits({ budgetMs: 200 }), now);
  assert.deepEqual(files, ["top.txt"]);
});

test("the walk skips node_modules, .git and build folders", async () => {
  const root = fresh();
  put(root, "src/a.ts");
  put(root, "node_modules/pkg/index.js");
  put(root, ".git/HEAD");
  put(root, "dist/app.js");
  put(root, "build/out.js");
  const files = await F.walkFiles(root, limits());
  assert.deepEqual(files, ["src/a.ts"]);
});

test("the index reuses a fresh list and refreshes a stale one behind it", async () => {
  let calls = 0;
  let t = 0;
  const index = F.createMentionFileIndex({
    limits: limits({ freshMs: 15_000 }),
    now: () => t,
    listFiles: async () => { calls += 1; return [`v${calls}.ts`, "has space.ts"]; },
  });
  assert.deepEqual(await index.list("/r"), ["v1.ts"]);   // a path with a space can never be sent
  t = 10_000;
  assert.deepEqual(await index.list("/r"), ["v1.ts"]);
  assert.equal(calls, 1);
  t = 16_000;
  assert.deepEqual(await index.list("/r"), ["v1.ts"]);   // stale: the old list now, a new one behind it
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2);
  assert.deepEqual(await index.list("/r"), ["v2.ts"]);
});

test("a remote agent, or no folder, gets no paths", async () => {
  assert.equal(F.mentionFolder(true, "/Users/me/project"), null);
  assert.equal(F.mentionFolder(false, ""), null);
  assert.equal(F.mentionFolder(false, undefined), null);
  assert.equal(F.mentionFolder(false, "/Users/me/project"), "/Users/me/project");
  let listed = false;
  const index = { list: async () => { listed = true; return ["a.ts"]; } };
  assert.deepEqual(await F.searchMentions(index, F.mentionFolder(true, "/x"), "a"), { ok: true, paths: [] });
  assert.equal(listed, false);
});

test("search ranks fuzzily, caps at 50, and an empty query puts shallow paths first", async () => {
  const files = ["src/deep/app.ts", "README.md", "src/app.ts", "package.json"];
  const index = { list: async () => files };
  const empty = await F.searchMentions(index, "/r", "");
  assert.deepEqual(empty.paths.slice(0, 2).sort(), ["README.md", "package.json"]);
  const hit = await F.searchMentions(index, "/r", "app");
  assert.ok(hit.paths.includes("src/app.ts"));
  assert.ok(!hit.paths.includes("package.json"));
  const many = Array.from({ length: 80 }, (_, i) => `f${i}.ts`);
  const capped = await F.searchMentions({ list: async () => many }, "/r", "f");
  assert.equal(capped.paths.length, 50);
});

// ---------------------------------------------------------------- expanding

test("@src/a.ts appends a block with the file's content", () => {
  const root = fresh();
  put(root, "src/a.ts", "export const a = 1;\n");
  const text = "look at @src/a.ts please";
  const out = F.expandFileMentions(text, root);
  assert.ok(out.startsWith(`${text}\n\n<mentioned-files>\n`));
  assert.ok(out.endsWith("</mentioned-files>"));
  assert.ok(out.includes('- src/a.ts (20 B)'));
  assert.ok(out.includes('<file path="src/a.ts">\nexport const a = 1;\n</file>'));
});

test("trailing punctuation does not stop a mention", () => {
  const root = fresh();
  put(root, "src/a.ts", "a\n");
  assert.equal(fileCount(F.expandFileMentions("see @src/a.ts.", root)), 1);
});

test("../, absolute paths and a symlink to a file outside stay plain text", () => {
  const outside = fresh();
  const secret = put(outside, "secret.txt", "TOP SECRET\n");
  const parent = fresh();
  const root = join(parent, "chat");
  mkdirSync(root);
  put(parent, "secret.txt", "TOP SECRET\n");
  symlinkSync(secret, join(root, "link.txt"));
  for (const text of ["read @../secret.txt", "read @/etc/hosts", `read @${secret}`, "read @link.txt"]) {
    assert.equal(F.expandFileMentions(text, root), text, text);
  }
});

test("folders, missing files and binary files are not inlined", () => {
  const root = fresh();
  put(root, "src/a.ts");
  writeFileSync(join(root, "blob.bin"), Buffer.from([1, 2, 0, 3]));
  assert.equal(F.expandFileMentions("@src", root), "@src");
  assert.equal(F.expandFileMentions("@nope.ts", root), "@nope.ts");
  const out = F.expandFileMentions("@blob.bin", root);
  assert.equal(fileCount(out), 0);
  assert.ok(out.includes("blob.bin (4 B, not inlined: binary file)"));
});

test("nine mentioned files: eight are inlined", () => {
  const root = fresh();
  const words = [];
  for (let i = 1; i <= 9; i++) { put(root, `f${i}.txt`, `file ${i}\n`); words.push(`@f${i}.txt`); }
  const out = F.expandFileMentions(words.join(" "), root);
  assert.equal(fileCount(out), 8);
  assert.ok(!out.includes('path="f9.txt"'));
});

test("a 100 KB file is cut to 32 KB and the block says so", () => {
  const root = fresh();
  put(root, "big.txt", "a".repeat(100 * 1024));
  const out = F.expandFileMentions("@big.txt", root);
  assert.ok(out.includes("- big.txt (100 KB, truncated to the first 32 KB)"));
  assert.ok(out.includes("[truncated: showing the first 32 KB of 100 KB; read the file itself for the rest]"));
  const body = out.slice(out.indexOf('<file path="big.txt">\n') + '<file path="big.txt">\n'.length, out.indexOf("</file>"));
  assert.equal(body.replace(/\n$/, "").length, 32 * 1024);
});

test("the message budget (96 KB) ends inlining, said in the block", () => {
  const root = fresh();
  const words = [];
  for (let i = 1; i <= 4; i++) { put(root, `b${i}.txt`, "b".repeat(40 * 1024)); words.push(`@b${i}.txt`); }
  const out = F.expandFileMentions(words.join(" "), root);
  assert.equal(fileCount(out), 3);
  assert.ok(out.includes("b4.txt (40 KB, not inlined: the message's file budget is used up)"));
});

test("an email address is not a mention", () => {
  const root = fresh();
  put(root, "site.com", "nope\n");
  const text = "write to me@site.com";
  assert.equal(F.expandFileMentions(text, root), text);
  assert.deepEqual(F.mentionTokens(text), []);
});

test("only the last message is expanded, only when it is the user's, never without a folder", () => {
  const root = fresh();
  put(root, "a.ts", "A\n");
  const history = [
    { role: "user", content: "earlier @a.ts" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "now @a.ts" },
  ];
  const out = F.expandLastUserMessage(history, root);
  assert.equal(out[0].content, "earlier @a.ts");
  assert.equal(fileCount(out[2].content), 1);
  assert.equal(history[2].content, "now @a.ts");   // the caller's array is not changed
  assert.deepEqual(F.expandLastUserMessage(history, null), history);
  const endsWithReply = history.slice(0, 2);
  assert.deepEqual(F.expandLastUserMessage(endsWithReply, root), endsWithReply);
});
