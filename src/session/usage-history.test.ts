import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Pass-through by default; one test makes a single read fail.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

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
    writeFileSync(path, JSON.stringify({ version: 1, days: { "2026-11-12": [{ billing: "nope" }], bad: [] } }));
    expect(readUsageHistory(path).days).toEqual({});
    new UsageHistoryStore({ path, now: () => NOON }).record(cloudCall());
    expect(readUsageHistory(path).days["2026-11-12"]?.[0]?.calls).toBe(1);
  });

  it("never overwrites a history it could not read", () => {
    const path = tempPath();
    const store = new UsageHistoryStore({ path, now: () => NOON });
    store.record(cloudCall());
    store.record(cloudCall({ modelId: "other" }));
    const before = readFileSync(path, "utf8");
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    store.record(cloudCall());
    expect(readFileSync(path, "utf8")).toBe(before);
    // The next readable write adds to the full history again.
    store.record(cloudCall());
    expect(readUsageHistory(path).days["2026-11-12"]?.map((r) => [r.model, r.calls])).toEqual([
      ["gpt-x", 2],
      ["other", 1],
    ]);
  });

  it("never overwrites a file it could not parse or a newer version's file", () => {
    for (const text of ["{not json", JSON.stringify({ version: 2, days: {} })]) {
      const path = tempPath();
      writeFileSync(path, text);
      new UsageHistoryStore({ path, now: () => NOON }).record(cloudCall());
      expect(readFileSync(path, "utf8")).toBe(text);
    }
  });
});

/**
 * ATO-2442: the project, tool and session sections, added without
 * breaking a file from before them.
 */
describe("UsageHistoryStore, per project, tool and session", () => {
  it("files a session's calls under its folder's name, one row per folder and billing", () => {
    const store = new UsageHistoryStore({
      path: tempPath(),
      now: () => NOON,
      workingDirOf: (id) => (id === "s1" || id === "s2" ? "/work/app" : id === "s3" ? "/other/app" : null),
    });
    store.record(cloudCall({ sessionId: "s1" }));
    store.record(cloudCall({ sessionId: "s2" }));
    store.record(cloudCall({ sessionId: "s3" }));
    store.record(cloudCall());
    const projects = store.read().projects?.["2026-11-12"] ?? [];
    expect(projects.map((p) => [p.label, p.calls])).toEqual([
      ["app", 2],
      ["app", 1],
      ["(no project)", 1],
    ]);
    // Two folders called `app` stay apart; no path is stored.
    expect(projects[0]?.project).not.toBe(projects[1]?.project);
    expect(JSON.stringify(store.read())).not.toContain("/work");
  });

  it("counts the distinct sessions of a day as hashes, never the ids", () => {
    const store = new UsageHistoryStore({ path: tempPath(), now: () => NOON });
    store.record(cloudCall({ sessionId: "chat-a" }));
    store.record(cloudCall({ sessionId: "chat-a" }));
    store.record(cloudCall({ sessionId: "chat-b" }));
    store.record(cloudCall());
    const seen = store.read().sessions?.["2026-11-12"] ?? [];
    expect(seen).toHaveLength(2);
    expect(seen.join(",")).not.toContain("chat-");
  });

  it("asks for a session's folder again until it is known, and survives a throwing lookup", () => {
    let known = false;
    const store = new UsageHistoryStore({
      path: tempPath(),
      now: () => NOON,
      workingDirOf: (id) => {
        if (id === "boom") throw new Error("db closed");
        return known ? "/work/app" : undefined;
      },
    });
    store.record(cloudCall({ sessionId: "s1" }));
    known = true;
    store.record(cloudCall({ sessionId: "s1" }));
    store.record(cloudCall({ sessionId: "boom" }));
    const rows = store.read().projects?.["2026-11-12"] ?? [];
    expect(rows.map((p) => [p.label, p.calls])).toEqual([
      ["(no project)", 2],
      ["app", 1],
    ]);
  });

  it("counts tool calls and their errors per day, but not the turn's reply or finish", () => {
    const store = new UsageHistoryStore({ path: tempPath(), now: () => NOON });
    store.recordTool("fs.read", false);
    store.recordTool("fs.read", true);
    store.recordTool("shell.run", false);
    store.recordTool("reply", false);
    store.recordTool("finish", false);
    expect(store.read().tools?.["2026-11-12"]).toEqual({
      "fs.read": { calls: 2, errors: 1 },
      "shell.run": { calls: 1, errors: 0 },
    });
  });

  it("loads a file from before the new sections and keeps its days when adding to it", () => {
    const path = tempPath();
    const old = {
      version: 1,
      days: {
        "2026-11-11": [
          { billing: "local", providerId: "local", model: "qwen3-8b", calls: 4, inputTokens: 40, outputTokens: 4, cachedTokens: 0, usd: 0, pricedCalls: 0, unpricedCalls: 0 },
        ],
      },
    };
    writeFileSync(path, JSON.stringify(old));
    const before = readUsageHistory(path);
    expect(before.days["2026-11-11"]?.[0]?.calls).toBe(4);
    expect(before.projects).toBeUndefined();
    expect(before.tools).toBeUndefined();
    const store = new UsageHistoryStore({ path, now: () => NOON });
    store.record(cloudCall({ sessionId: "s1" }));
    store.recordTool("fs.read", false);
    const after = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(after.version).toBe(1);
    expect(readUsageHistory(path).days["2026-11-11"]?.[0]?.calls).toBe(4);
    expect(Object.keys(after).sort()).toEqual(["days", "projects", "sessions", "tools", "version"]);
  });

  it("drops a damaged project row, tool entry or session list and keeps the rest", () => {
    const path = tempPath();
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        days: {},
        projects: { "2026-11-12": [{ billing: "cloud", project: "", label: "x" }, { billing: "local", project: "abc", label: "app", calls: 1 }] },
        tools: { "2026-11-12": { "fs.read": { calls: 2, errors: 9 }, bad: "x", zero: { calls: 0 } }, nope: {} },
        sessions: { "2026-11-12": ["a", "a", 3, ""] },
      }),
    );
    const file = readUsageHistory(path);
    expect(file.projects?.["2026-11-12"]?.map((p) => p.project)).toEqual(["abc"]);
    expect(file.tools?.["2026-11-12"]).toEqual({ "fs.read": { calls: 2, errors: 2 } });
    expect(file.sessions?.["2026-11-12"]).toEqual(["a"]);
  });
});
