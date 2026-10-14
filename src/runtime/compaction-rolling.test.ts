import { describe, expect, it } from "vitest";
import { estimateTokens } from "../prompt/token-budget.js";
import { assistantToolCallTurn, toolResultTurn, userTurn, type ConversationTurn } from "../session/conversation-turn.js";
import { safeCompactionCuts } from "../session/session-compaction.js";
import { renderRollingSource } from "./compaction-rolling.js";

function turns(steps: number, body = "x"): ConversationTurn[] {
  const out: ConversationTurn[] = [userTurn("REQUEST: keep the public API")];
  for (let i = 0; i < steps; i++) {
    out.push(assistantToolCallTurn({ tool: "os.fs.read", args: { path: `/src/file-${i}.ts` } }));
    out.push(toolResultTurn({ tool: "os.fs.read", status: "ok", summary: `BODY_${i} ${body}` }));
  }
  return out;
}
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
