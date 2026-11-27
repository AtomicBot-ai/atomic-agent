// ATO-1731: main/sentry/scrub.ts sends a TypeError's text only as one of V8's
// fixed templates, with the name replaced by `<name>`, against the built
// output (npm run build first). Every text here is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../out/main/sentry/scrub.js");

test("the four TypeError templates are sent with the name replaced by <name>", () => {
  const passing = [
    ["Cannot read properties of undefined (reading 'length')", "Cannot read properties of undefined (reading '<name>')"],
    ["Cannot read properties of null (reading 'webContents')", "Cannot read properties of null (reading '<name>')"],
    ["Cannot set properties of undefined (setting 'innerHTML')", "Cannot set properties of undefined (setting '<name>')"],
    ["Cannot set properties of null (setting '$state')", "Cannot set properties of null (setting '<name>')"],
    ["paint is not a function", "<name> is not a function"],
    ["window.api.chat.send is not a function", "<name> is not a function"],
    ["_handlers is not iterable", "<name> is not iterable"],
    [`${"a".repeat(64)} is not a function`, "<name> is not a function"],
  ];
  for (const [m, want] of passing) assert.equal(S.safeMessage("TypeError", m), want, m);
});

test("a token-shaped or personal name never leaves: only the placeholder does", () => {
  const secrets = ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "sk_abc123def456ghi789jkl", "alice"];
  for (const secret of secrets) {
    const texts = [
      `Cannot read properties of undefined (reading '${secret}')`,
      `Cannot set properties of null (setting '${secret}')`,
      `${secret} is not a function`,
      `config.${secret} is not iterable`,
    ];
    for (const m of texts) {
      const out = S.safeMessage("TypeError", m);
      assert.ok(out?.includes("<name>"), m);
      assert.ok(!out.includes(secret), `${m} leaked ${secret}`);
    }
  }
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
