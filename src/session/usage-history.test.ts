import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readUsageHistory,
  USAGE_HISTORY_MAX_DAYS,
  UsageHistoryStore,
  type UsageHistoryInput,
} from "./usage-history.js";

/**
 * ATO-2352: tokens and spend per day and model, kept on disk across
 * sessions and processes, for `atomic-agent usage`.
 */
function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "usage-history-")), "usage-history.json");
}

const NOON = Date.UTC(2026, 10, 12, 12, 0);

function cloudCall(over: Partial<UsageHistoryInput> = {}): UsageHistoryInput {
  return {
    providerId: "openrouter",
    modelId: "gpt-x",
    usage: { promptTokens: 1000, completionTokens: 200, totalTokens: 1200, cachedTokens: 600 },
    local: false,
    plan: false,
    price: { kind: "priced", usd: 0.25, source: "catalog" },
    ...over,
  };
}

describe("UsageHistoryStore", () => {
  it("adds input, output and cached tokens and cost per day and model", () => {
    const path = tempPath();
    const store = new UsageHistoryStore({ path, now: () => NOON });
    store.record(cloudCall());
    store.record(cloudCall());
    const rows = store.read().days["2026-11-12"];
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({
      billing: "cloud",
      providerId: "openrouter",
      model: "gpt-x",
      calls: 2,
      inputTokens: 2000,
      outputTokens: 400,
      cachedTokens: 1200,
      pricedCalls: 2,
      unpricedCalls: 0,
    });
    expect(rows?.[0]?.usd).toBeCloseTo(0.5);
  });

  it("keeps local and plan tokens apart from cloud spend, and never prices them", () => {
    const store = new UsageHistoryStore({ path: tempPath(), now: () => NOON });
    store.record(cloudCall({ providerId: "local", modelId: "qwen3-8b", local: true, price: { kind: "local" } }));
    store.record(cloudCall({ providerId: "claude-cli", modelId: "sonnet", plan: true, price: { kind: "plan" } }));
    const rows = store.read().days["2026-11-12"] ?? [];
    expect(rows.map((r) => [r.billing, r.model, r.usd, r.unpricedCalls, r.inputTokens])).toEqual([
      ["local", "qwen3-8b", 0, 0, 1000],
      ["plan", "sonnet", 0, 0, 1000],
    ]);
  });

  it("counts a cloud call with no known price as unpriced, never as $0", () => {
    const store = new UsageHistoryStore({ path: tempPath(), now: () => NOON });
    store.record(cloudCall({ price: { kind: "unpriced" } }));
    const row = store.read().days["2026-11-12"]?.[0];
    expect(row).toMatchObject({ usd: 0, pricedCalls: 0, unpricedCalls: 1, inputTokens: 1000 });
  });

  it("names the provider when the service reported no model id", () => {
    const store = new UsageHistoryStore({ path: tempPath(), now: () => NOON });
    store.record(cloudCall({ modelId: null }));
    expect(store.read().days["2026-11-12"]?.[0]?.model).toBe("openrouter");
  });

  it("ignores a completion with no tokens", () => {
    const path = tempPath();
    const store = new UsageHistoryStore({ path, now: () => NOON });
    store.record(cloudCall({ usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }));
    expect(store.read().days).toEqual({});
  });

  it("survives a restart and adds to what another process wrote", () => {
    const path = tempPath();
    new UsageHistoryStore({ path, now: () => NOON }).record(cloudCall());
    new UsageHistoryStore({ path, now: () => NOON }).record(cloudCall({ modelId: "other" }));
    const days = readUsageHistory(path).days;
    expect(days["2026-11-12"]?.map((r) => r.model)).toEqual(["gpt-x", "other"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1 });
  });

  it("files each call under its spend day, with the configured reset hour", () => {
    const path = tempPath();
    let now = NOON;
    const store = new UsageHistoryStore({ path, now: () => now, resetHourUtc: () => 6 });
    store.record(cloudCall());
    now = Date.UTC(2026, 10, 13, 5, 0); // still the 12th with a 06:00 reset
    store.record(cloudCall());
    now = Date.UTC(2026, 10, 13, 7, 0);
    store.record(cloudCall());
    const days = store.read().days;
    expect(days["2026-11-12"]?.[0]?.calls).toBe(2);
    expect(days["2026-11-13"]?.[0]?.calls).toBe(1);
  });

  it("drops the oldest days past the cap", () => {
    const path = tempPath();
    const days: Record<string, unknown[]> = {};
    for (let i = 0; i < USAGE_HISTORY_MAX_DAYS; i++) {
      const d = new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      days[d] = [{ billing: "cloud", providerId: "p", model: "m", calls: 1, inputTokens: 1, outputTokens: 1 }];
    }
    writeFileSync(path, JSON.stringify({ version: 1, days }));
    new UsageHistoryStore({ path, now: () => NOON }).record(cloudCall());
    const kept = Object.keys(readUsageHistory(path).days).sort();
    expect(kept).toHaveLength(USAGE_HISTORY_MAX_DAYS);
    expect(kept[0]).toBe("2025-01-02");
    expect(kept.at(-1)).toBe("2026-11-12");
  });

  it("reads a missing or damaged file as empty and starts over", () => {
    const path = tempPath();
    expect(readUsageHistory(path).days).toEqual({});
    writeFileSync(path, "{not json");
    expect(readUsageHistory(path).days).toEqual({});
    writeFileSync(path, JSON.stringify({ days: { "2026-11-12": [{ billing: "nope" }], bad: [] } }));
    expect(readUsageHistory(path).days).toEqual({});
    new UsageHistoryStore({ path, now: () => NOON }).record(cloudCall());
    expect(readUsageHistory(path).days["2026-11-12"]?.[0]?.calls).toBe(1);
  });
});
