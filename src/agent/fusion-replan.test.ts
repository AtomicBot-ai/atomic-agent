import { describe, expect, it } from "vitest";
import type { CompressedToolResult } from "../compressor/result-compressor.js";
import {
  createReplanState,
  observeReplanStep,
  REPLAN_MAX_HELD_STEPS,
  replanToolSet,
  takeReplanNotice,
} from "./fusion-replan.js";

function delegate(details: Record<string, unknown>, status: "ok" | "error" = "ok"): CompressedToolResult {
  return { tool: "fusion.delegate", status, summary: "", details, truncated: false };
}
const read: CompressedToolResult = { tool: "os.fs.read", status: "ok", summary: "", details: {}, truncated: false };

describe("automatic replan hold (ATO-941)", () => {
  it("holds the next step to fusion.delegate while tasks are pending", () => {
    let s = observeReplanStep(createReplanState(), [
      delegate({ replan: { pending: [{ id: "ui" }], exhausted: [] } }),
    ]);
    expect(replanToolSet(s)?.names).toEqual(["fusion.delegate"]);
    expect(takeReplanNotice(s).notice).toMatch(/Replan required: ui did not close/);
    // The replan ran and closed everything: the hold is lifted.
    s = observeReplanStep(s, [delegate({})]);
    expect(replanToolSet(s)).toBeNull();
    expect(takeReplanNotice(s).notice).toBeNull();
  });

  it("does not count an unparsed or refused delegate as the replan", () => {
    let s = observeReplanStep(createReplanState(), [
      delegate({ replan: { pending: [{ id: "a" }] } }),
    ]);
    s = observeReplanStep(s, [delegate({ field: "tasks" }, "error")]);
    expect(replanToolSet(s)).not.toBeNull();
  });

  it("lets a planner that will not delegate go after a bounded number of held steps, and says so once", () => {
    let s = observeReplanStep(createReplanState(), [
      delegate({ replan: { pending: [{ id: "a" }] } }),
    ]);
    for (let i = 0; i < REPLAN_MAX_HELD_STEPS; i += 1) {
      s = observeReplanStep(s, [read]);
    }
    expect(replanToolSet(s)).toBeNull();
    const first = takeReplanNotice(s);
    expect(first.notice).toMatch(/Reply to the person now/);
    expect(takeReplanNotice(first.state).notice).toBeNull();
  });
});
