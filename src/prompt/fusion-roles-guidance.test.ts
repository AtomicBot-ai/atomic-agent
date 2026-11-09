import { describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../config/config-schema.js";
import { buildFusionGuidance, formatFusionRolesLine } from "./fusion-guidance.js";
import {
  NO_FUSION_MACHINE_FACTS,
  resolveFusionMachineFacts,
} from "./fusion-machine-facts.js";

function config(roles?: Record<string, string>): AtomicAgentConfig {
  return {
    localModels: {
      mode: "managed",
      managed: { parallel: 2, contextSize: 0, modelId: "qwen-14b" },
    },
    llm: {
      activeTextProvider: "openrouter",
      providers: [
        { id: "local-llama", kind: "llama-server" },
        { id: "small-llama", kind: "llama-server", model: "qwen3-8b" },
        { id: "openrouter", kind: "openrouter", defaultChatModel: "sonnet" },
        { id: "or-coder", kind: "openrouter", defaultChatModel: "qwen-coder" },
      ],
      runMode: {
        mode: "fusion",
        fusion: roles === undefined ? {} : { roles },
      },
    },
  } as unknown as AtomicAgentConfig;
}

describe("### fusion roles line (ATO-943)", () => {
  it("adds nothing without roles: the block is byte for byte as before", () => {
    const facts = resolveFusionMachineFacts(config());
    expect(facts).not.toHaveProperty("roleModels");
    expect(formatFusionRolesLine(facts)).toBeNull();
    expect(buildFusionGuidance(NO_FUSION_MACHINE_FACTS)).not.toContain("Models by role");
  });

  it("lists the role models in role order, the worker leg by its own name", () => {
    const facts = resolveFusionMachineFacts(
      config({ utility: "small-llama", build: "or-coder", explore: "local-llama" }),
    );
    expect(facts.roleModels).toEqual([
      { role: "build", model: "qwen-coder" },
      { role: "explore", model: "qwen-14b" },
      { role: "utility", model: "qwen3-8b" },
    ]);
    const block = buildFusionGuidance(facts);
    expect(block).toContain(
      "Models by role: build `qwen-coder`, explore `qwen-14b`, utility `qwen3-8b`.",
    );
    expect(block.endsWith(formatFusionRolesLine(facts)!)).toBe(true);
  });
});
