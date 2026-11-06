// Unit tests for renderer/usage-meter.js (ATO-569).
// Run: npm run test:unit
// The chat's cost and plan-limit chip: what it prints, when it warns, and
// that an unknown price is never shown as $0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const U = createRequire(import.meta.url)("../renderer/usage-meter.js");

const NOW = new Date(2026, 10, 6, 12, 0).getTime();
const AT15 = new Date(2026, 10, 6, 15, 0).getTime();

test("reads the session row (camelCase) and the stream frame (snake_case) alike", () => {
  const row = U.usageFromAgent({
    costUsd: 0.31, pricedCalls: 2, unpricedCalls: 0, localCalls: 0, planCalls: 0,
    limits: [{ providerId: "codex", scope: "subscription", name: "5h", usedPercent: 83, resetsAt: AT15, observedAt: NOW }],
  }, NOW);
  const frame = U.usageFromAgent({
    object: "atomic.usage_updated", session_id: "s1",
    cost_usd: 0.31, priced_calls: 2, unpriced_calls: 0, local_calls: 0, plan_calls: 0,
    limits: [{ provider_id: "codex", scope: "subscription", name: "5h", used_percent: 83, resets_at: AT15 }],
  }, NOW);
  assert.deepEqual(frame, row);
  assert.equal(U.usageChipText(row, NOW), "$0.31 · 17% left");
  assert.match(U.usageTooltip(row, NOW), /Plan 5h: 17% left, resets 15:00/);
});

test("an older agent sends nothing, and nothing is drawn", () => {
  assert.equal(U.usageFromAgent(undefined, NOW), null);
  assert.equal(U.usageChipText(null, NOW), "");
  assert.equal(U.usageChipText(U.usageFromAgent({}, NOW), NOW), "");
});

test("an unknown price is never $0", () => {
  assert.equal(U.usageCostText({ costUsd: 0, pricedCalls: 0, unpricedCalls: 3, localCalls: 0, planCalls: 0 }), "cost n/a");
  assert.equal(U.usageCostText({ costUsd: 0.5, pricedCalls: 1, unpricedCalls: 1, localCalls: 0, planCalls: 0 }), "$0.50+");
  assert.equal(U.usageCostText({ costUsd: 0, pricedCalls: 0, unpricedCalls: 0, localCalls: 4, planCalls: 0 }), "local");
  assert.equal(U.usageCostText({ costUsd: 0, pricedCalls: 0, unpricedCalls: 0, localCalls: 0, planCalls: 2 }), "plan");
});

test("a reading past its reset time is gone", () => {
  const u = U.usageFromAgent({ planCalls: 1, limits: [{ scope: "subscription", name: "5h", used_percent: 99, resets_at: NOW - 1 }] }, NOW);
  assert.equal(U.usageChipText(u, NOW), "plan");
  assert.equal(U.usageUrgent(u, NOW), false);
});

test("warns only when the plan window is nearly spent, never for spend alone", () => {
  const near = U.usageFromAgent({ limits: [{ scope: "subscription", name: "weekly", used_percent: 95, resets_at: AT15 }] }, NOW);
  assert.equal(U.usageUrgent(near, NOW), true);
  const rich = U.usageFromAgent({ cost_usd: 80, priced_calls: 9 }, NOW);
  assert.equal(U.usageUrgent(rich, NOW), false);
});

test("an API budget shows only past 80% used", () => {
  const low = U.usageFromAgent({ limits: [{ scope: "api", name: "requests", used_percent: 10, resets_at: AT15 }] }, NOW);
  assert.equal(U.usageChipText(low, NOW), "");
  const high = U.usageFromAgent({ limits: [{ scope: "api", name: "requests", used_percent: 90, resets_at: AT15 }] }, NOW);
  assert.equal(U.usageChipText(high, NOW), "10% left");
});

test("no text uses an em dash", () => {
  const u = U.usageFromAgent({ cost_usd: 1, priced_calls: 1, unpriced_calls: 1, local_calls: 1, plan_calls: 1,
    limits: [{ scope: "subscription", name: "5h", status: "rejected", resets_at: AT15 }] }, NOW);
  for (const line of [U.usageChipText(u, NOW), U.usageTooltip(u, NOW)]) assert.ok(!line.includes("—"), line);
});
