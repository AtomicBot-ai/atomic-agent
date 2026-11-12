import { describe, expect, it } from "vitest";
import { GEMMA4_THINK_PROFILE, PLAIN_INSTRUCT_PROFILE, QWEN_THINK_PROFILE } from "../../llm/model-profile.js";
import { DEFAULT_REASONING_BUDGET_TOKENS } from "../../llm/reasoning-budget.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { ToolDescriptor } from "../../prompt/stable-prefix.js";
import { REPAIR_MAX_TOKENS, repairReplyCap, tryParseToolCalls } from "./step-parsing.js";

describe("repair completion cap", () => {
  it("keeps the 1024 anti-loop guard for a model without thinking", () => {
    expect(repairReplyCap("grammar", 8192)).toBe(REPAIR_MAX_TOKENS);
    expect(repairReplyCap("grammar", 8192, { profile: PLAIN_INSTRUCT_PROFILE, budgetTokens: 1500 })).toBe(REPAIR_MAX_TOKENS);
  });

  it("adds the enforced reasoning budget for a thinking profile on a grammar link", () => {
    for (const profile of [QWEN_THINK_PROFILE, GEMMA4_THINK_PROFILE]) {
      expect(repairReplyCap("grammar", 8192, { profile, budgetTokens: 1500 })).toBe(REPAIR_MAX_TOKENS + 1500);
      expect(repairReplyCap("grammar", 8192, { profile, budgetTokens: 64 })).toBe(REPAIR_MAX_TOKENS + 64);
      // Never above the step's cap, even at the config ceiling (ATO-607).
      expect(repairReplyCap("grammar", 8192, { profile, budgetTokens: 32768 })).toBe(8192);
      expect(repairReplyCap("grammar", 512, { profile, budgetTokens: 1500 })).toBe(REPAIR_MAX_TOKENS);
      // Absent budget: whatever the default is, the same cap as passing it, as the grammar falls back to it too.
      expect(repairReplyCap("grammar", 8192, { profile })).toBe(
        repairReplyCap("grammar", 8192, { profile, budgetTokens: DEFAULT_REASONING_BUDGET_TOKENS }),
      );
    }
  });

  it("uses the step's cap for an unbounded budget, and the guard when thinking is off", () => {
    expect(repairReplyCap("grammar", 8192, { profile: QWEN_THINK_PROFILE, budgetTokens: 0 })).toBe(8192);
    expect(repairReplyCap("grammar", 512, { profile: QWEN_THINK_PROFILE, budgetTokens: 0 })).toBe(REPAIR_MAX_TOKENS);
    expect(repairReplyCap("grammar", 8192, { profile: QWEN_THINK_PROFILE, budgetTokens: 1500, thinkingOff: true })).toBe(REPAIR_MAX_TOKENS);
  });

  it("leaves native_tools on the step's cap", () => {
    expect(repairReplyCap("native_tools", 20_000)).toBe(20_000);
    expect(repairReplyCap("native_tools", 20_000, { profile: QWEN_THINK_PROFILE, budgetTokens: 1500 })).toBe(20_000);
  });
});

// ATO-1365: a native call is decoded against the tools the request
// offered, not by textual unescape, so `mcp.srv.foo__bar` never runs as
// its dotted sibling `mcp.srv.foo.bar`.
describe("native tool-call names", () => {
  const tool = (name: string): ToolDescriptor => ({ name, tier: "frequent", summary: name, argsSchema: "" });
  const descriptors = [tool("mcp.srv.foo__bar"), tool("mcp.srv.foo.bar")];
  const native = (name: string): CompletionResult =>
    ({ content: "", reasoningContent: "", toolCalls: [{ id: "c1", type: "function", function: { name, arguments: "{}" } }] }) as unknown as CompletionResult;
  const deps = { toolTransport: "native_tools" as const, toolCallAdapter: null };

  it("resolves each wire name to the tool it was offered for", () => {
    const first = tryParseToolCalls(native("mcp__srv__foo__bar_2"), PLAIN_INSTRUCT_PROFILE, deps, descriptors, false);
    expect(first.ok && first.batch.calls[0]?.tool).toBe("mcp.srv.foo__bar");
    const second = tryParseToolCalls(native("mcp__srv__foo__bar"), PLAIN_INSTRUCT_PROFILE, deps, descriptors, false);
    expect(second.ok && second.batch.calls[0]?.tool).toBe("mcp.srv.foo.bar");
  });

  it("resolves an escaped name copied into content the same way", () => {
    const content = ({ content: '[{"tool":"mcp__srv__foo__bar_2","args":{}}]', reasoningContent: "" }) as unknown as CompletionResult;
    const parsed = tryParseToolCalls(content, PLAIN_INSTRUCT_PROFILE, deps, descriptors, false);
    expect(parsed.ok && parsed.batch.calls[0]?.tool).toBe("mcp.srv.foo__bar");
  });
});
