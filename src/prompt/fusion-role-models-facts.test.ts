import { describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../config/config-schema.js";
import { resolveFusionMachineFacts } from "./fusion-machine-facts.js";

// Two roles on one OpenRouter entry, a model each (`roleModels`): the
// planner must see both names, or it cannot put either in a task's `model`.
function config(): AtomicAgentConfig {
  return {
    localModels: {
      mode: "managed",
      managed: { parallel: 2, contextSize: 0, modelId: "qwen-14b" },
    },
    llm: {
      activeTextProvider: "openrouter",
      providers: [
        { id: "local-llama", kind: "llama-server" },
        { id: "openrouter", kind: "openrouter", defaultChatModel: "anthropic/claude-opus-5.5" },
      ],
      runMode: {
        mode: "fusion",
        fusion: {
          roles: { plan: "openrouter", review: "openrouter", explore: "local-llama" },
          roleModels: { review: "deepseek/deepseek-v4.1", explore: "ignored-on-llama" },
        },
      },
    },
  } as unknown as AtomicAgentConfig;
}

describe("### fusion roles line: roles sharing one provider", () => {
  it("names each role's own model, and the loaded model on a llama-server entry", () => {
    expect(resolveFusionMachineFacts(config()).roleModels).toEqual([
      { role: "plan", model: "anthropic/claude-opus-5.5" },
      { role: "review", model: "deepseek/deepseek-v4.1" },
      { role: "explore", model: "qwen-14b" },
    ]);
  });
});
