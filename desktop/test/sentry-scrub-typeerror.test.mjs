// ATO-1731: main/sentry/scrub.ts lets a TypeError's text through only on V8's
// fixed templates naming a code identifier, against the built output
// (npm run build first). Every text here is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../out/main/sentry/scrub.js");

test("the four TypeError templates pass when the name is an identifier from code", () => {
  const passing = [
    "Cannot read properties of undefined (reading 'length')",
    "Cannot read properties of null (reading 'webContents')",
    "Cannot set properties of undefined (setting 'innerHTML')",
    "Cannot set properties of null (setting '$state')",
    "paint is not a function",
    "window.api.chat.send is not a function",
    "_handlers is not iterable",
    `${"a".repeat(64)} is not a function`,
  ];
  for (const m of passing) assert.equal(S.safeMessage("TypeError", m), m, m);
});

test("anything else stays cut: paths, URLs, spaces, non-ASCII, long names, other texts", () => {
  const cut = [
    "Cannot read properties of undefined (reading '/Users/alice/notes.txt')",
    "Cannot read properties of undefined (reading 'https://example.com/x')",
    "Cannot read properties of undefined (reading 'my secret key')",
    "Cannot read properties of undefined (reading 'привет')",
    "Cannot set properties of undefined (setting 'C:\\Users\\bob')",
    "https://example.com/a is not a function",
    "/Users/alice/x.js is not a function",
    "привет is not a function",
    "café is not iterable",
    `${"a".repeat(65)} is not a function`,
    `Cannot read properties of undefined (reading '${"b".repeat(65)}')`,
    "Cannot read properties of undefined (reading '')",
    "Cannot read properties of undefined (reading '0')",
    "a..b is not a function",
    "foo is not a function or its return value is not iterable",
    "Cannot read properties of undefined (reading 'x') at /Users/alice",
    "paint is not a function\n/Users/alice/secret.txt",
    "cannot read /Users/alice",
    "Failed to fetch https://example.com/?q=alice",
  ];
  for (const m of cut) assert.equal(S.safeMessage("TypeError", m), undefined, m);
});

test("only TypeError gets the templates; other types and non-strings stay cut", () => {
  assert.equal(S.safeMessage("Error", "paint is not a function"), undefined);
  assert.equal(S.safeMessage("RangeError", "Cannot read properties of undefined (reading 'x')"), undefined);
  assert.equal(S.safeMessage("TypeError", undefined), undefined);
  assert.equal(S.safeMessage("TypeError", 42), undefined);
  assert.equal(S.STATIC_MESSAGE_ERRORS.size, 0);
});
