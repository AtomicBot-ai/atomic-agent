// Unit tests for main/chat-session.ts (U27), against the built output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chatSessionIdFor } = require("../out/main/chat-session.js");

test("an existing chat keeps its session id", () => {
  assert.equal(chatSessionIdFor("api-0123456789abcdef"), "api-0123456789abcdef");
});

test("a new chat gets a fresh id every time, never a derived one", () => {
  const a = chatSessionIdFor(undefined);
  const b = chatSessionIdFor(null);
  const c = chatSessionIdFor("");
  for (const id of [a, b, c]) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(new Set([a, b, c]).size, 3);
});
