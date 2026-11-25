import { afterEach, describe, expect, it } from "vitest";
import { getConfig, resetConfigCache } from "../../config/index.js";
import { QWEN_THINK_PROFILE } from "../../llm/model-profile.js";
import { LOCAL_REASONING_BUDGET_TOKENS } from "../../llm/reasoning-levels.js";
import type { ReasoningEffort } from "../../llm/provider/completion-types.js";
import { SlotManager } from "../../llm/slot-manager.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { effectiveReplyReserve } from "../../prompt/token-budget.js";
import type { StepContext, StepDependencies } from "./step-contract.js";
import { prepareStepInference } from "./step-inference.js";

/**
 * ATO-1678: a chat's reasoning level (ATO-490) bounds a local grammar
 * model's think block with its own budget. The prompt's reply reserve
 * planned for `localModels.reasoningBudgetTokens` (default 0, none)
 * instead, so on a small window the bounded think block plus the tool
 * call did not fit the reserve and the reply ran into the window's end.
 */

afterEach(() => resetConfigCache());

const WINDOW = 16_384;

function prepare(level: ReasoningEffort | undefined, transport: "grammar" | "native_tools" = "grammar") {
  const ctx: StepContext = {
    session: {
      ...createEmptySessionState({ id: "reasoning-reserve", workingDir: "/fixture" }),
      turns: [{ kind: "user", text: "do it", at: 1 }],
    },
    toolDescriptors: [{ name: "reply", summary: "Answer.", argsSchema: "{ text: string }" }],
    skillCatalog: [],
    capabilities: {
      platform: "win32", arch: "x64", browserChannel: "chrome",
      workingDir: "/fixture", hasClipboard: false, hasWmctrl: false, hasNotifications: false,
    },
    stepIndex: 1,
    signal: new AbortController().signal,
    ...(level !== undefined ? { reasoningOverride: level } : {}),
  };
  const deps: StepDependencies = {
    registry: new ToolRegistry(),
    slotManager: new SlotManager(1),
    profile: QWEN_THINK_PROFILE,
    grammar: 'root ::= "fixture"',
    toolTransport: transport,
    toolCallAdapter: null,
    supportsSlotAffinity: false,
    contextWindow: WINDOW,
    profileWindowApplies: false,
    llmComplete: async () => { throw new Error("not called"); },
  };
  return prepareStepInference(ctx, deps).prompt;
}

describe("reply reserve under a chat's reasoning level (ATO-1678)", () => {
  const cap = () => getConfig().localModels.completionMaxTokens;

  it("reserves the level's think budget plus room for the tool call", () => {
    const expected = effectiveReplyReserve(cap(), WINDOW, LOCAL_REASONING_BUDGET_TOKENS.medium);
    // The level really moves the reserve on this window.
    expect(expected).toBeGreaterThan(effectiveReplyReserve(cap(), WINDOW, 0));
    const prompt = prepare("medium");
    expect(prompt.replyReserve).toBe(expected);
    expect(prompt.conversationCapEffective).toBeLessThan(prepare(undefined).conversationCapEffective);
  });

  it("keeps the configured budget when no level is picked", () => {
    expect(prepare(undefined).replyReserve).toBe(
      effectiveReplyReserve(cap(), WINDOW, getConfig().localModels.reasoningBudgetTokens),
    );
  });

  it("leaves a native-tools link, whose think block no grammar bounds, as before", () => {
    expect(prepare("medium", "native_tools").replyReserve).toBe(prepare(undefined, "native_tools").replyReserve);
  });
});
