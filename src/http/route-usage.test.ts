import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { USAGE_HISTORY_FILE_NAME } from "../session/usage-history.js";
import { usageToday } from "../session/usage-report-defaults.js";
import { startTestHarness, type Harness } from "./test-harness.js";

/** ATO-2442: the usage report over HTTP, for the desktop's Usage tab. */
describe("GET /api/usage", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
  });

  it("serves the per-day report with models, tools, projects and saved by local", async () => {
    harness = await startTestHarness();
    const today = usageToday();
    writeFileSync(
      join(harness.stateDir, USAGE_HISTORY_FILE_NAME),
      JSON.stringify({
        version: 1,
        days: {
          [today]: [
            { billing: "local", providerId: "local", model: "qwen3-8b", calls: 2, inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, usd: 0, pricedCalls: 0, unpricedCalls: 0 },
          ],
        },
        tools: { [today]: { "fs.read": { calls: 2, errors: 0 } } },
        sessions: { [today]: ["abc"] },
      }),
    );
    const res = await fetch(`${harness.baseUrl}/api/usage?days=all&compare=deepseek/deepseek-v4-flash`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      from: string | null;
      days: Array<{ day: string; models: unknown[]; sessions: number | null }>;
      tools: Array<{ tool: string }>;
      projects: unknown[];
      savedByLocal: { status: string; estimate?: boolean; usd?: number; reference?: { source: string } };
    };
    expect(body.from).toBeNull();
    expect(body.days[0]).toMatchObject({ day: today, sessions: 1 });
    expect(body.days[0]?.models).toHaveLength(1);
    expect(body.tools.map((t) => t.tool)).toEqual(["fs.read"]);
    expect(body.projects).toEqual([]);
    expect(body.savedByLocal).toMatchObject({ status: "estimate", estimate: true, reference: { source: "compare" } });
    expect(body.savedByLocal.usd).toBeCloseTo(0.15, 6);
  });

  it("answers an empty report with no history, and 400 for a bad days value", async () => {
    harness = await startTestHarness();
    const empty = (await (await fetch(`${harness.baseUrl}/api/usage`)).json()) as { days: unknown[]; savedByLocal: unknown };
    expect(empty.days).toEqual([]);
    expect(empty.savedByLocal).toEqual({ status: "none" });
    for (const days of ["0", "x", "401", "2.5"]) {
      const res = await fetch(`${harness.baseUrl}/api/usage?days=${days}`);
      expect(res.status).toBe(400);
    }
  });
});
