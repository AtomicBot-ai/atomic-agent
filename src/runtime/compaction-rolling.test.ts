import { describe, expect, it } from "vitest";
import { estimateTokens } from "../prompt/token-budget.js";
import type { CompactionPlan } from "../prompt/plan-compaction.js";
import { assistantToolCallTurn, toolResultTurn, userTurn, type ConversationTurn } from "../session/conversation-turn.js";
import { compactionBoundaryHash, safeCompactionCuts, summaryTextHash } from "../session/session-compaction.js";
import { createEmptySessionState, type SessionState } from "../session/session-state.js";
import { compactFromRolling, renderRollingSource } from "./compaction-rolling.js";

function turns(steps: number, body = "x"): ConversationTurn[] {
  const out: ConversationTurn[] = [userTurn("REQUEST: keep the public API")];
  for (let i = 0; i < steps; i++) {
    out.push(assistantToolCallTurn({ tool: "os.fs.read", args: { path: `/src/file-${i}.ts` } }));
    out.push(toolResultTurn({ tool: "os.fs.read", status: "ok", summary: `BODY_${i} ${body}` }));
  }
  return out;
}
function session(list: ConversationTurn[], rollingThrough?: number, summary = "Goal: keep the public API. Done: read the early files."): SessionState {
  const state = { ...createEmptySessionState({ id: "chat", workingDir: "/tmp" }), turns: list };
  if (rollingThrough !== undefined) state.rollingSummary = { version: 1, summary, from: 0, baseHash: summaryTextHash(""),
    coveredThrough: rollingThrough, boundaryHash: compactionBoundaryHash(list[rollingThrough - 1]!), createdAt: 1, model: "bg-model" };
  return state;
}
const plan = (through: number, summaryMaxTokens = 600): CompactionPlan => ({ reason: "threshold", from: 0, through, summaryMaxTokens, targetTokens: 5000, tokensBefore: 9000 });

describe("rolling summary job input", () => {
  it("is capped, ends on a safe cut within the limit and uses the historical renderer", () => {
    const list = turns(400, "long output ".repeat(100));
    const source = renderRollingSource(list, 0, list.length, 2_000)!;
    expect(estimateTokens(source.text)).toBeLessThanOrEqual(2_000);
    expect(source.through).toBeGreaterThan(1);
    expect(source.through).toBeLessThan(list.length);
    expect(safeCompactionCuts(list)).toContain(source.through);
    expect(source.text).toContain("Record 0: user: REQUEST: keep the public API");
    expect(source.text).toContain("tool_result[os.fs.read ok]: BODY_0");
    expect(source.text).not.toContain('"kind"');
    // The next job starts where this one stopped.
    const next = renderRollingSource(list, source.through, list.length, 2_000)!;
    expect(next.text.startsWith(`Record ${source.through}:`)).toBe(true);
    expect(next.through).toBeGreaterThan(source.through);
  });

  it("never passes the limit, and clips a single oversized record to the cap", () => {
    const list = turns(10);
    expect(renderRollingSource(list, 0, 7, 10_000)!.through).toBe(7);
    expect(renderRollingSource(list, 7, 7, 10_000)).toBeNull();
    const huge = [userTurn(`HEAD ${"word ".repeat(20_000)} TAIL`), ...turns(2).slice(1)];
    const source = renderRollingSource(huge, 0, huge.length, 500)!;
    expect(source.through).toBe(1);
    expect(estimateTokens(source.text)).toBeLessThanOrEqual(500);
  });
});

describe("checkpoint from a rolling summary", () => {
  it("uses the ready summary and appends the freshest records extractively", () => {
    const list = turns(12);
    const result = compactFromRolling(session(list, 13), plan(21))!;
    expect(result.through).toBe(21);
    expect(result.summary.startsWith("Goal: keep the public API. Done: read the early files.")).toBe(true);
    expect(result.summary).toContain("Extractive summary of conversation records 13-20");
    expect(result.summary).toContain("/src/file-9.ts");
    expect(result.summary).not.toContain("/src/file-5.ts");
    expect(estimateTokens(result.summary)).toBeLessThanOrEqual(600);
  });

  it("uses the summary alone at its watermark, and moves an earlier cut up to it", () => {
    const list = turns(12);
    expect(compactFromRolling(session(list, 9), plan(9))).toMatchObject({ through: 9, summary: "Goal: keep the public API. Done: read the early files." });
    expect(compactFromRolling(session(list, 13), plan(9))).toMatchObject({ through: 13 });
  });

  it("is not used when it covers under half of the checkpoint's records", () => {
    const list = turns(12);
    expect(compactFromRolling(session(list, 9), plan(21))).toBeNull();
    expect(compactFromRolling(session(list, 13), plan(21))).not.toBeNull();
  });

  it("is not used when stale, too large, covering everything, or for another checkpoint", () => {
    const list = turns(12);
    const stale = session(list, 13);
    stale.turns = [...list];
    stale.turns[12] = toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "edited" });
    expect(compactFromRolling(stale, plan(21))).toBeNull();
    expect(compactFromRolling(session(list, 13, "word ".repeat(2_000)), plan(21))).toBeNull();
    expect(compactFromRolling(session(list, 25), plan(21))).toBeNull();
    expect(compactFromRolling(session(list, 13), { ...plan(21), from: 3 })).toBeNull();
    expect(compactFromRolling(session(list), plan(21))).toBeNull();
  });
});
