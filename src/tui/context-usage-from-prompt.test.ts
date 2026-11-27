import { describe, expect, it } from "vitest";
import type { BuiltPrompt } from "../prompt/build-prompt-types.js";
import { contextUsageFromPrompt } from "./context-usage-from-prompt.js";

function builtPrompt(overrides: Partial<BuiltPrompt> = {}): BuiltPrompt {
  return {
    messages: { system: "", droppedSummary: null, turns: [], tail: "" },
    conversationPackStart: null,
    text: "",
    stablePrefix: "",
    tail: "",
    tokens: {
      stablePrefix: 5240,
      loadedSkills: 0,
      sessionFacts: 610,
      loadedTools: 0,
      profile: 0,
      worldSnapshot: 1020,
      conversation: 31_880,
      recalled: 2150,
      memoryIndex: 0,
      taskPolicy: 0,
      total: 40_900,
    },
    limits: {
      total: 40_000,
      stablePrefix: 14_000,
      session: 6000,
      worldSnapshot: 6000,
      conversation: 14_000,
    },
    truncated: false,
    truncation: {
      loadedSkills: false,
      sessionFacts: false,
      loadedTools: false,
      profile: false,
      worldSnapshot: false,
      conversation: false,
      recalled: false,
      memoryIndex: false,
    },
    contextWindow: 131_072,
    conversationCapEffective: 14_000,
    conversationCapAuto: false,
    droppedTurns: 0,
    conversationPairs: 3,
    droppedPairs: 0,
    conversationPairsCap: 20,
    conversationBoundBy: null,
    pairCosts: [10_000, 11_000, 10_880],
    ...overrides,
  };
}

describe("contextUsageFromPrompt", () => {
  it("carries the total, the window and the dropped-turn count", () => {
    const usage = contextUsageFromPrompt(builtPrompt({ droppedTurns: 12 }));
    expect(usage.tokens).toBe(40_900);
    expect(usage.contextWindow).toBe(131_072);
    expect(usage.droppedTurns).toBe(12);
  });

  /**
   * The three figures behind the chip's gauge. `conversationCapEffective`
   * is what the packer trims to; `limits.conversation` is what the
   * operator configured, and the gap between them is the only way to say
   * whether config or the window is holding the transcript down.
   */
  it("carries the transcript and both forms of its cap", () => {
    const usage = contextUsageFromPrompt(builtPrompt());
    expect(usage.conversationTokens).toBe(31_880);
    expect(usage.conversationCap).toBe(14_000);
    expect(usage.conversationCapConfigured).toBe(14_000);
  });

  /**
   * A session with no skills loaded should not have to read the word
   * "skills" to find that out.
   */
  it("lists only the sections that cost something", () => {
    const usage = contextUsageFromPrompt(builtPrompt());
    expect(usage.sections.map((s) => s.label)).toEqual([
      "prompt scaffold",
      "conversation",
      "recalled memory",
      "world snapshot",
      "session facts",
    ]);
    expect(usage.sections[1]).toEqual({
      label: "conversation",
      tokens: 31_880,
    });
  });

  it("reports a cloud prompt's unknown window as unknown", () => {
    expect(
      contextUsageFromPrompt(builtPrompt({ contextWindow: null }))
        .contextWindow,
    ).toBeNull();
  });

  /**
   * ATO-2355: the native `tools` payload is in `total`, so without its
   * own row the panel's rows did not add up to its title.
   */
  it("lists the native tool schemas as their own section", () => {
    const base = builtPrompt();
    const usage = contextUsageFromPrompt(
      builtPrompt({ tokens: { ...base.tokens, toolSchema: 3100 } }),
    );
    expect(usage.sections).toContainEqual({ label: "tool schemas", tokens: 3100 });
  });

  /**
   * ATO-2355: the scaffold row is broken down from the prefix text the
   * prompt actually carries, and the parts add up to the row.
   */
  it("breaks the prompt scaffold into parts that sum to it", () => {
    const stablePrefix = [
      "### system",
      "You are the agent.",
      "",
      "### tools",
      "# common (full)",
      "- os.fs.read — Read a file.",
      "  args: { path: string }",
      "- mcp.github.create_issue — [mcp:github] Open an issue.",
      "  args: { repo: string, title: string, body: string }",
      "",
      "### instructions",
      "Emit a JSON ARRAY.",
    ].join("\n");
    const base = builtPrompt();
    const usage = contextUsageFromPrompt(
      builtPrompt({ stablePrefix, tokens: { ...base.tokens, stablePrefix: 5240 } }),
    );
    const parts = usage.parts ?? [];
    expect(parts.map((p) => p.label)).toEqual([
      "persona",
      "built-in tools",
      "mcp github",
      "instructions",
    ]);
    expect(parts.every((p) => p.parent === "prompt scaffold")).toBe(true);
    expect(parts.reduce((a, p) => a + p.tokens, 0)).toBe(5240);
    expect(parts.find((p) => p.label === "mcp github")?.mcpServer).toBe("github");
    expect(usage.toolSearchActive).toBe(false);
  });

  /**
   * ATO-2495: the desktop popover drew its own reply reserve from the raw
   * cap and missed the small-window rule; the readout now carries the
   * figure the budget held back, local or cloud.
   */
  it("carries the reply reserve the budget held back", () => {
    expect(contextUsageFromPrompt(builtPrompt({ replyReserve: 6_144 })).replyReserve).toBe(6_144);
    expect(
      contextUsageFromPrompt(builtPrompt({ contextBudget: { window: 200_000, replyReserve: 16_384 } })).replyReserve,
    ).toBe(16_384);
    expect("replyReserve" in contextUsageFromPrompt(builtPrompt())).toBe(false);
  });
});
