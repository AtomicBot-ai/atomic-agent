// Unit tests for main/mention-kinds.ts (ATO-2241, ATO-2472), against the built output.
// Run: npm run build && npm run test:unit
// Which `@` words are diff / git / problems / ranges / links and what the palette offers for them.
// Reading them is the agent's (src/mentions/ in core, tested there); main/mention-core.ts is
// tested in mention-core.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const K = require("../out/main/mention-kinds.js");

// ---------------------------------------------------------------- kinds

test("diff, git:N, ranges and links are told apart; everything else is not a kind", () => {
  assert.deepEqual(K.parseMentionKind("diff"), { kind: "diff" });
  assert.deepEqual(K.parseMentionKind("git:4"), { kind: "git", count: 4 });
  assert.deepEqual(K.parseMentionKind("git:99"), { kind: "git", count: 20 });
  assert.equal(K.parseMentionKind("git:0"), null);
  assert.deepEqual(K.parseMentionKind("src/a.ts:10-40"), { kind: "range", path: "src/a.ts", start: 10, end: 40 });
  assert.deepEqual(K.parseMentionKind("src/a.ts:7"), { kind: "range", path: "src/a.ts", start: 7, end: 7 });
  assert.deepEqual(K.parseMentionKind("a.ts#L10-L40"), { kind: "range", path: "a.ts", start: 10, end: 40 });
  assert.deepEqual(K.parseMentionKind("a.ts#L10-40"), { kind: "range", path: "a.ts", start: 10, end: 40 });
  assert.equal(K.parseMentionKind("a.ts:40-10"), null);
  assert.equal(K.parseMentionKind("a.ts:0"), null);
  assert.deepEqual(K.parseMentionKind("https://example.com/a?b=1"), { kind: "url", url: "https://example.com/a?b=1" });
  assert.deepEqual(K.parseMentionKind("http://localhost:3000"), { kind: "url", url: "http://localhost:3000/" });
  assert.equal(K.parseMentionKind("https://user:pw@host/"), null);
  for (const word of ["ftp://host/x", "file:///etc/hosts", "javascript:alert(1)", "src/a.ts", "Diff", "git", "git:x"]) {
    assert.equal(K.parseMentionKind(word), null, word);
  }
});

test("the palette offers diff and git:5 for a prefix, and keeps a typed range, link or folder as typed", () => {
  assert.deepEqual(K.contextSuggestions(""), []);
  assert.deepEqual(K.contextSuggestions("d"), ["diff"]);
  assert.deepEqual(K.contextSuggestions("gi"), ["git:5"]);
  assert.deepEqual(K.contextSuggestions("git:3"), ["git:3"]);
  assert.deepEqual(K.contextSuggestions("git:77"), ["git:20"]);
  assert.deepEqual(K.contextSuggestions("src/a.ts:10-40"), ["src/a.ts:10-40"]);
  assert.deepEqual(K.contextSuggestions("https://example.com/x"), ["https://example.com/x"]);
  assert.deepEqual(K.contextSuggestions("src/"), ["src/"]);
  assert.deepEqual(K.contextSuggestions("readme"), []);
});

test("ATO-2472: problems is a keyword the palette offers, and folders come from the file list", () => {
  assert.deepEqual(K.parseMentionKind("problems"), { kind: "problems" });
  assert.deepEqual(K.contextSuggestions("pro"), ["problems"]);
  assert.deepEqual(K.contextSuggestions("problems"), ["problems"]);
  assert.deepEqual(K.foldersOf(["README.md", "src/a.ts", "src/tui/b.ts", "docs/x.md"]), ["docs/", "src/", "src/tui/"]);
});
