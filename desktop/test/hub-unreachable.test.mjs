// Unit tests for main/hub-unreachable.ts (ATO-915), against the built output.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isHubUnreachable } = require("../out/main/hub-unreachable.js");

test("the no-VPN timeout seen on the second Mac counts as ClawHub unreachable", () => {
  assert.equal(isHubUnreachable("clawhub: The operation was aborted due to timeout"), true);
  assert.equal(isHubUnreachable("clawhub: network error fetching https://clawhub.ai/api/v1/search?q=pdf: TimeoutError"), true);
});

test("the outages the smoke already skipped on still count", () => {
  for (const e of [
    "clawhub: ClawHub request failed (503): https://clawhub.ai/api/v1/search",
    "clawhub: ClawHub request failed (429): https://clawhub.ai/api/v1/search",
    "clawhub: getaddrinfo ENOTFOUND clawhub.ai",
    "clawhub: connect ETIMEDOUT 1.2.3.4:443",
    "clawhub: fetch failed",
    "clawhub: connect ECONNREFUSED 1.2.3.4:443",
  ]) assert.equal(isHubUnreachable(e), true, e);
});

test("ClawHub answering with a real error is not an outage", () => {
  for (const e of [
    null,
    undefined,
    "",
    "clawhub: not found: https://clawhub.ai/api/v1/skills/x",
    "clawhub: ambiguous skill slug — install via @owner/slug (use search to resolve the owner)",
    "clawhub: ClawHub request failed (400): https://clawhub.ai/api/v1/search",
    "clawhub: unexpected response shape",
  ]) assert.equal(isHubUnreachable(e), false, String(e));
});
