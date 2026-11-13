import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "./slugify.mjs";

test("lower-cases and joins words with dashes", () => {
  assert.equal(slugify("Hello World Again"), "hello-world-again");
});

test("drops punctuation and squeezes spaces", () => {
  assert.equal(slugify("  Hello,   World!  "), "hello-world");
});
