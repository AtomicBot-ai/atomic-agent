import { describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../config/config-schema.js";
import {
  buildFusionGuidance,
  formatFusionPastRunsLine,
} from "./fusion-guidance.js";
import { resolveFusionMachineFacts } from "./fusion-machine-facts.js";

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
        { id: "openrouter", kind: "openrouter", defaultChatModel: "sonnet" },
      ],
      runMode: { mode: "fusion", fusion: {} },
    },
  } as unknown as AtomicAgentConfig;
}

const PAST = [
  "`qwen-14b` (local) on large tasks: failed 3 of 3 here; split them or send them to a cloud model",
  "`qwen-14b` (local) on small tasks: 5 of 5 ok, ~1 min each",
];

describe("### fusion past runs line (ATO-949)", () => {
  it("adds nothing without a summary: the block is byte for byte as before", () => {
    const before = buildFusionGuidance(resolveFusionMachineFacts(config()));
    for (const pastRuns of [undefined, null, []]) {
      const facts = resolveFusionMachineFacts(config(), { pastRuns });
      expect(facts).not.toHaveProperty("pastRuns");
      expect(formatFusionPastRunsLine(facts)).toBeNull();
      expect(buildFusionGuidance(facts)).toBe(before);
    }
    expect(before).not.toContain("Past runs here");
  });

  it("states the outcome log's facts as the block's last line", () => {
    const facts = resolveFusionMachineFacts(config(), { pastRuns: PAST });
    expect(facts.pastRuns).toEqual(PAST);
    const block = buildFusionGuidance(facts);
    const line = formatFusionPastRunsLine(facts)!;
    expect(line).toBe(
      `Past runs here: ${PAST[0]}; ${PAST[1]}. Plan the split and pick models by these.`,
    );
    expect(block.endsWith(`\n${line}`)).toBe(true);
    // The other machine facts are untouched.
    expect(block).toContain("This machine: workers run `qwen-14b` on a local llama-server");
  });

  it("is deterministic for the same summary", () => {
    const a = buildFusionGuidance(resolveFusionMachineFacts(config(), { pastRuns: PAST }));
    const b = buildFusionGuidance(resolveFusionMachineFacts(config(), { pastRuns: [...PAST] }));
    expect(a).toBe(b);
  });
});
