import { describe, expect, it } from "vitest";
import { completionDefectLogFields } from "./completion-defect-log.js";
import type { CompletionResult } from "../../llm/provider/completion-types.js";

const base: CompletionResult = {
  content: "",
  reasoningContent: "",
  stop: true,
  truncated: false,
  timing: { promptMs: 1, predictedMs: 1, promptTokens: 900, predictedTokens: 0 },
  cacheHitTokens: 0,
  slotId: 0,
  modelId: null,
};
const prompt = {
  messages: { system: "s", droppedSummary: "dropped", turns: [{}, {}, {}], tail: "t" },
  tokens: { total: 4321 },
} as unknown as Parameters<typeof completionDefectLogFields>[1];

describe("completionDefectLogFields (ATO-1572)", () => {
  it("falls back to the timing's tokens and the served mode's model when usage is missing", () => {
    expect(completionDefectLogFields({
      ...base,
      servedModelMode: { mode: "cloud", source: "provider", providerId: "openrouter", modelId: "m" },
    }, prompt)).toEqual({
      finishReason: null,
      providerId: "openrouter",
      model: "m",
      promptTokens: 900,
      completionTokens: 0,
      requestMessages: 6,
      requestTokens: 4321,
    });
  });

  it("adds the stop type, transport, tool-call count and the cap that was sent when known", () => {
    const fields = completionDefectLogFields({
      ...base,
      finishReason: "length",
      stopType: "limit",
      servedTransport: "native_tools",
      toolCalls: [],
      sentMaxTokens: 8192,
      generationId: "gen-1",
    }, prompt);
    expect(fields).toMatchObject({ finishReason: "length", stopType: "limit", transport: "native_tools", toolCalls: 0, sentMaxTokens: 8192, generationId: "gen-1" });
  });

  it("carries only numbers and short identifiers", () => {
    const fields = completionDefectLogFields({ ...base, content: "secret reply", reasoningContent: "secret thought" }, prompt);
    expect(JSON.stringify(fields)).not.toMatch(/secret/);
  });
});
