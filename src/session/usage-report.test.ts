import { describe, expect, it } from "vitest";

import type { LlmProviderConfigEntry } from "../llm/provider/registry/provider-types.js";
import { summarizeUsageBreakdown } from "./usage-breakdown.js";
import type { UsageHistoryFile, UsageHistoryRow, UsageProjectRow } from "./usage-history-types.js";
import { buildUsageReport, usageReportJson } from "./usage-report.js";
import { formatSavedByLocal, formatUsageReportText } from "./usage-report-format.js";
import { estimateSavedByLocal, resolveReferenceModel } from "./usage-saved-by-local.js";

/** ATO-2442: tools, projects and "saved by local" over the usage history, against hand sums. */
function row(over: Partial<UsageHistoryRow>): UsageHistoryRow {
  return {
    billing: "cloud", providerId: "openrouter", model: "gpt-x", calls: 1,
    inputTokens: 1000, outputTokens: 100, cachedTokens: 0, usd: 0.1, pricedCalls: 1, unpricedCalls: 0,
    ...over,
  };
}

function project(over: Partial<UsageProjectRow>): UsageProjectRow {
  return {
    billing: "cloud", project: "aaaa1111bbbb", label: "app", calls: 1,
    inputTokens: 1000, outputTokens: 100, cachedTokens: 0, usd: 0.1, pricedCalls: 1, unpricedCalls: 0,
    ...over,
  };
}

const LOCAL = row({
  billing: "local", providerId: "local", model: "qwen3-8b", calls: 3,
  inputTokens: 2_000_000, outputTokens: 1_000_000, cachedTokens: 1_000_000, usd: 0, pricedCalls: 0,
});

const HISTORY: UsageHistoryFile = {
  version: 1,
  days: { "2026-11-01": [row({})], "2026-11-12": [row({}), LOCAL] },
  projects: {
    "2026-11-01": [project({ label: "old-name" })],
    "2026-11-12": [
      project({ calls: 2, inputTokens: 5000 }),
      project({ project: "cccc2222dddd", label: "app", inputTokens: 9000 }),
      project({ project: "-", label: "(no project)", inputTokens: 90_000 }),
      project({ billing: "local", project: "cccc2222dddd", label: "app", usd: 0, pricedCalls: 0 }),
    ],
  },
  tools: {
    "2026-11-11": { "fs.read": { calls: 3, errors: 1 } },
    "2026-11-12": { "fs.read": { calls: 1, errors: 0 }, "shell.run": { calls: 4, errors: 0 } },
  },
};

const WEEK = { days: 7, today: "2026-11-12" } as const;

describe("summarizeUsageBreakdown", () => {
  it("sums tools over the window, most used first, with their share", () => {
    const b = summarizeUsageBreakdown(HISTORY, WEEK);
    expect(b.tools).toEqual([
      { tool: "fs.read", calls: 4, errors: 1, share: 0.5 },
      { tool: "shell.run", calls: 4, errors: 0, share: 0.5 },
    ]);
    expect(b.countedFrom).toBe("2026-11-11");
  });

  it("sums projects by folder, tells same-named folders apart, and puts calls outside a chat last", () => {
    const b = summarizeUsageBreakdown(HISTORY, WEEK);
    expect(b.projects.map((p) => [p.label, p.calls, p.inputTokens])).toEqual([
      ["app (cccc)", 2, 10_000],
      ["app (aaaa)", 2, 5000],
      ["(no project)", 1, 90_000],
    ]);
    expect(b.projects[0]).toMatchObject({ localTokens: 1100, cloudTokens: 9100 });
  });

  it("is empty for a history from before the split", () => {
    const b = summarizeUsageBreakdown({ version: 1, days: { "2026-11-12": [row({})] } }, WEEK);
    expect(b).toEqual({ projects: [], tools: [], countedFrom: null });
  });
});

describe("resolveReferenceModel", () => {
  const SNAPSHOT = {
    deepseek: { "deepseek-v4-flash": { context: 1, cost: { input: 0.15, output: 0.6, cacheRead: 0.003 } } },
    google: { "gemini-flash-lite-latest": { context: 1, cost: { input: 0.3, output: 2.5 } } },
    anthropic: { "claude-sonnet-5": { context: 1, cost: { input: 2, output: 10 } }, "no-price": { context: 1 } },
  };
  const anthropic: LlmProviderConfigEntry = {
    id: "anthropic", kind: "openai-compatible", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5",
  };

  it("uses the model asked for, as provider/model or a bare id, any case", () => {
    expect(resolveReferenceModel({ compare: "google/gemini-flash-lite-latest", snapshot: SNAPSHOT })).toMatchObject({
      provider: "google", model: "gemini-flash-lite-latest", source: "compare",
    });
    expect(resolveReferenceModel({ compare: "Claude-Sonnet-5", snapshot: SNAPSHOT })).toMatchObject({
      provider: "anthropic", model: "claude-sonnet-5", source: "compare",
    });
  });

  it("uses the operator's own priced cloud model, the active one first", () => {
    const deepseek: LlmProviderConfigEntry = {
      id: "deepseek", kind: "openai-compatible", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash",
    };
    const plan: LlmProviderConfigEntry = { id: "claude-cli", kind: "subscription-cli", model: "claude-sonnet-5" };
    expect(
      resolveReferenceModel({ providers: [plan, deepseek, anthropic], activeTextProvider: "anthropic", snapshot: SNAPSHOT }),
    ).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5", source: "configured" });
    expect(resolveReferenceModel({ providers: [plan, anthropic, deepseek], snapshot: SNAPSHOT })).toMatchObject({
      provider: "anthropic", source: "configured",
    });
  });

  it("answers null for a model with no known price, never a $0 price", () => {
    expect(resolveReferenceModel({ compare: "anthropic/no-price", snapshot: SNAPSHOT })).toBeNull();
    expect(resolveReferenceModel({ compare: "made-up-model", snapshot: SNAPSHOT })).toBeNull();
  });

  it("falls back to the cheap default when nothing configured is priced, and to null offline with no data", () => {
    const local: LlmProviderConfigEntry = { id: "lm", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", model: "claude-sonnet-5" };
    expect(resolveReferenceModel({ providers: [local], snapshot: SNAPSHOT })).toMatchObject({
      provider: "deepseek", model: "deepseek-v4-flash", source: "default",
    });
    expect(resolveReferenceModel({ snapshot: {} })).toBeNull();
  });

  it("the built-in snapshot prices the default reference", () => {
    expect(resolveReferenceModel({})).toMatchObject({ source: "default", provider: "deepseek" });
  });
});

describe("estimateSavedByLocal", () => {
  const ref = { provider: "deepseek", model: "deepseek-v4-flash", source: "default" as const, pricing: { input: 0.15, output: 0.6, cacheRead: 0.003 } };

  it("prices local tokens at the reference, cached ones at its cache rate", () => {
    const saved = estimateSavedByLocal([row({}), LOCAL], ref);
    // 1M uncached × 0.15 + 1M cached × 0.003 + 1M out × 0.6
    expect(saved.status).toBe("estimate");
    if (saved.status !== "estimate") return;
    expect(saved.usd).toBeCloseTo(0.753, 6);
    expect(saved).toMatchObject({ localInputTokens: 2_000_000, localOutputTokens: 1_000_000, localCachedTokens: 1_000_000 });
    expect(saved.reference).toMatchObject({ provider: "deepseek", inputPerMTok: 0.15, outputPerMTok: 0.6 });
  });

  it("is unknown with no price and none with no local tokens", () => {
    expect(estimateSavedByLocal([LOCAL], null, "x/y")).toMatchObject({ status: "unknown", requested: "x/y" });
    expect(estimateSavedByLocal([row({})], ref)).toEqual({ status: "none" });
  });
});

describe("the report", () => {
  const inputs = { ...WEEK, providers: [] };

  it("prints the saved-by-local line under the table, labelled an estimate", () => {
    const text = formatUsageReportText(buildUsageReport(HISTORY, inputs), { models: false, tools: false, projects: false, sessions: false });
    expect(text).toMatch(/Saved by local \(estimate\): about \$0\.75, the 3\.0M local tokens at deepseek\/deepseek-v4-flash list prices/);
    expect(text).not.toContain("Tools");
  });

  it("says unknown, not $0, when the compare model has no price", () => {
    const report = buildUsageReport(HISTORY, { ...inputs, compare: "made-up-model" });
    expect(formatSavedByLocal(report.savedByLocal)).toBe(
      "Saved by local: unknown. The built-in price list has no price for made-up-model.",
    );
  });

  it("adds the tool and project tables when asked", () => {
    const text = formatUsageReportText(buildUsageReport(HISTORY, inputs), { models: false, tools: true, projects: true, sessions: false });
    expect(text).toMatch(/\nTools\nTool\s+Calls\s+Errors\s+Share\nfs\.read\s+4\s+1\s+50%/);
    expect(text).toMatch(/\nProjects\nProject\s+Calls\s+Input\s+Output\s+Local\s+Cloud cost\napp \(cccc\)\s+2\s+10\.0k/);
  });

  it("JSON carries savedByLocal with estimate: true, tools and projects only when asked", () => {
    const report = buildUsageReport(HISTORY, inputs);
    const plain = usageReportJson(report, { models: false, tools: false, projects: false });
    expect(plain.savedByLocal).toMatchObject({ status: "estimate", estimate: true });
    expect(plain).not.toHaveProperty("tools");
    const full = usageReportJson(report, { models: true, tools: true, projects: true });
    expect(full.tools).toHaveLength(2);
    expect(full.projects).toHaveLength(3);
    expect(full.breakdownCountedFrom).toBe("2026-11-11");
  });
});
