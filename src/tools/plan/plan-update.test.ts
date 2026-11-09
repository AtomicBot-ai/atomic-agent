import { describe, expect, it } from "vitest";

import { planUpdateTool, PLAN_SNAPSHOT_DETAIL } from "./plan-update.js";
import type { ToolContext } from "../tool-registry.js";

const ctx = { workingDir: "/tmp", sessionId: "s" } as unknown as ToolContext;

describe("plan.update", () => {
  it("is read-only so it runs in plan mode and never asks", () => {
    expect(planUpdateTool.name).toBe("plan.update");
    expect(planUpdateTool.readonly).toBe(true);
  });

  it("returns the whole snapshot in details and the list in the summary", async () => {
    const result = await planUpdateTool.run(
      {
        items: [
          { step: "Read the test", status: "done" },
          { step: "Fix the parser", status: "in_progress" },
          { step: "Run the suite", status: "pending" },
        ],
      },
      ctx,
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("Plan 1/3 done.");
    expect(result.summary).toContain("[>] Fix the parser");
    const snapshot = result.details[PLAN_SNAPSHOT_DETAIL] as { items: unknown[]; updatedAt: number };
    expect(snapshot.items).toEqual([
      { step: "Read the test", status: "done" },
      { step: "Fix the parser", status: "in_progress" },
      { step: "Run the suite", status: "pending" },
    ]);
    expect(typeof snapshot.updatedAt).toBe("number");
  });

  it("keeps every step of a long plan in the summary", async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ step: `step ${i + 1}`, status: "pending" }));
    const result = await planUpdateTool.run({ items }, ctx);
    expect(result.summary).toContain("step 1");
    expect(result.summary).toContain("step 20");
  });

  it("clears the plan with an empty list", async () => {
    const result = await planUpdateTool.run({ items: [] }, ctx);
    expect(result.summary).toBe("Plan cleared.");
    expect((result.details[PLAN_SNAPSHOT_DETAIL] as { items: unknown[] }).items).toEqual([]);
  });

  it("refuses a malformed list", async () => {
    await expect(planUpdateTool.run({ items: "do stuff" }, ctx)).rejects.toThrow(/must be an array/);
  });
});
