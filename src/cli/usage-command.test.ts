import { describe, expect, it } from "vitest";

import type { UsageHistoryFile } from "../session/usage-history.js";
import { usageCommand } from "./usage-command.js";

/** ATO-2352: `atag usage` prints tokens and cost per day, or the same as JSON. */
const HISTORY: UsageHistoryFile = {
  version: 1,
  days: {
    "2026-11-12": [
      {
        billing: "local", providerId: "local", model: "qwen3-8b", calls: 2,
        inputTokens: 3000, outputTokens: 400, cachedTokens: 1000, usd: 0, pricedCalls: 0, unpricedCalls: 0,
      },
      {
        billing: "cloud", providerId: "openrouter", model: "gpt-x", calls: 1,
        inputTokens: 1000, outputTokens: 100, cachedTokens: 0, usd: 0.2, pricedCalls: 1, unpricedCalls: 0,
      },
    ],
  },
};

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await usageCommand(args, {
    write: (t) => { out += t; },
    writeErr: (t) => { err += t; },
    readHistory: () => HISTORY,
    today: () => "2026-11-12",
    providers: () => ({ providers: [] }),
  });
  return { code, out, err };
}

describe("usageCommand", () => {
  it("prints the per-day table by default, --daily included", async () => {
    for (const args of [[], ["--daily"]]) {
      const { code, out } = await run(args);
      expect(code).toBe(0);
      expect(out).toContain("Token usage, 2026-11-06 to 2026-11-12");
      expect(out).toMatch(/2026-11-12\s+3\s+4\.0k\s+500\s+1\.0k\s+76%\s+\$0\.20/);
    }
  });

  it("--json is valid JSON with the day totals, models only with --models", async () => {
    const plain = JSON.parse((await run(["--json", "--days", "3"])).out) as {
      from: string;
      days: Array<Record<string, unknown>>;
      total: Record<string, number>;
    };
    expect(plain.from).toBe("2026-11-10");
    expect(plain.days[0]).toMatchObject({ day: "2026-11-12", inputTokens: 4000, localTokens: 3400, cloudTokens: 1100 });
    expect(plain.days[0]).not.toHaveProperty("models");
    expect(plain.total.usd).toBeCloseTo(0.2);
    const withModels = JSON.parse((await run(["--json", "--models"])).out) as { days: Array<{ models: unknown[] }> };
    expect(withModels.days[0]?.models).toHaveLength(2);
  });

  it("accepts --days=N and --all", async () => {
    expect((await run(["--days=1"])).out).toContain("2026-11-12 to 2026-11-12");
    expect((await run(["--all"])).out).toContain("all days to 2026-11-12");
  });

  it("refuses a bad --days or an unknown option with a usage error", async () => {
    for (const args of [["--days", "0"], ["--days"], ["--days", "x"], ["--year"]]) {
      const { code, err } = await run(args);
      expect(code).toBe(2);
      expect(err).toContain("Usage: atomic-agent usage");
    }
  });

  // ATO-2442.
  it("prints the saved-by-local estimate under the table, at the reference asked for", async () => {
    const plain = (await run([])).out;
    expect(plain).toMatch(/Saved by local \(estimate\): about \$0\.\d+, the 3\.4k local tokens at deepseek\/deepseek-v4-flash/);
    const other = (await run(["--compare", "google/gemini-flash-lite-latest"])).out;
    expect(other).toContain("google/gemini-flash-lite-latest list prices");
    expect(other).toContain("the model you chose");
    expect((await run(["--compare", "no-such-model"])).out).toContain("Saved by local: unknown.");
  });

  it("--tools, --projects and --sessions add their tables and column", async () => {
    const withSplit: UsageHistoryFile = {
      ...HISTORY,
      tools: { "2026-11-12": { "fs.read": { calls: 2, errors: 0 } } },
      projects: {
        "2026-11-12": [{
          billing: "cloud", project: "abcdef123456", label: "site", calls: 1,
          inputTokens: 1000, outputTokens: 100, cachedTokens: 0, usd: 0.2, pricedCalls: 1, unpricedCalls: 0,
        }],
      },
      sessions: { "2026-11-12": ["a1", "b2"] },
    };
    let out = "";
    const code = await usageCommand(["--tools", "--projects", "--sessions"], {
      write: (t) => { out += t; },
      readHistory: () => withSplit,
      today: () => "2026-11-12",
      providers: () => ({ providers: [] }),
    });
    expect(code).toBe(0);
    expect(out).toMatch(/Cloud cost\s+Sessions\n2026-11-12.*\s2\n/);
    expect(out).toMatch(/\nTools\nTool\s+Calls\s+Errors\s+Share\nfs\.read\s+2\s+-\s+100%/);
    expect(out).toMatch(/\nProjects\n.*\nsite\s+1\s+1\.0k\s+100\s+0%\s+\$0\.20/);
  });

  it("--json carries savedByLocal, and tools and projects when asked", async () => {
    const out = JSON.parse((await run(["--json", "--tools", "--projects"])).out) as Record<string, unknown>;
    expect(out.savedByLocal).toMatchObject({ status: "estimate", estimate: true, localInputTokens: 3000 });
    expect(out.tools).toEqual([]);
    expect(out.projects).toEqual([]);
  });

  it("refuses --compare with no model", async () => {
    const { code, err } = await run(["--compare"]);
    expect(code).toBe(2);
    expect(err).toContain("--compare needs a model");
  });
});
