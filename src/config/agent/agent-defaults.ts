import { createCompactionDefaults } from "./compaction-config.js";
import type { UserAgentConfig } from "./agent-types.js";
import { createProviderWaitDefaults, createAgentTaskDefaults } from "../agent-execution-config.js";

export function createAgentDefaults(): UserAgentConfig {
  return {
    tokenBudget: 3000,
    maxSteps: 25,
    providerWait: createProviderWaitDefaults(),
    task: createAgentTaskDefaults(),
    toolTimeoutMs: 60_000,
    readScope: "working-dir",
    approvalLevel: 1,
    // `0` = let the model's context window decide (CONVERSATION_CAP_AUTO);
    // the fixed 32K fallback applies only when no window is known.
    compaction: createCompactionDefaults(),
    conversationMaxTokens: 0,
    conversationMaxPairs: 200,
    nameSessions: true,
    conversationLowWater: 0.65,
    // `0` = keep the `tokenBudget * 0.15` share (SESSION_SECTIONS_CAP_AUTO).
    sessionSectionsMaxTokens: 0,
    worldSnapshotMaxTokens: 8_000,
  };
}
