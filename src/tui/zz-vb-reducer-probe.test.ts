import { describe, it } from "vitest";
import { reduceTuiState } from "./agent-event-reducer.js";
import { contextUsageFromPrompt } from "./context-usage-from-prompt.js";
import { createInitialTuiState } from "./tui-state.js";
import { fakeSession } from "./test-fixtures.js";

const p: any = {
  text: "", stablePrefix: "", tail: "",
  tokens: { stablePrefix: 100, loadedSkills: 0, sessionFacts: 0, loadedTools: 0, profile: 0, worldSnapshot: 0, conversation: 50, recalled: 0, memoryIndex: 0, taskPolicy: 0, total: 150 },
  limits: { total: 3000, stablePrefix: 1050, session: 450, worldSnapshot: 450, conversation: 1050 },
  truncated: false,
  truncation: { loadedSkills: false, sessionFacts: false, loadedTools: false, profile: false, worldSnapshot: false, conversation: false, recalled: false, memoryIndex: false },
  contextWindow: 128000, conversationCapEffective: 32000, conversationCapAuto: false,
  droppedTurns: 0, conversationPairs: 1, droppedPairs: 0, conversationPairsCap: 20,
  conversationBoundBy: null, pairCosts: [50],
};

describe("probe", () => {
  it("logs", () => {
    console.log("DIRECT:", JSON.stringify(contextUsageFromPrompt(p)));
    const base: any = { ...createInitialTuiState(fakeSession()), onboarding: null };
    const next: any = reduceTuiState(base, { type: "agent_event", event: { type: "prompt_built", prompt: p, slotId: 0 } } as any);
    console.log("VIA REDUCER:", JSON.stringify(next.contextUsage));
    console.log("SAME OBJ:", next === base);
  });
});
