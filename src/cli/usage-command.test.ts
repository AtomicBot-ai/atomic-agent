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
});
