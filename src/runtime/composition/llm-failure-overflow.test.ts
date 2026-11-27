import { describe, expect, it } from "vitest";
import type { AtomicAgentConfig } from "../../config/index.js";
import { contextWindowExhaustedError } from "../../agent/turn/overflow-compaction.js";
import { LlamaServerError } from "../../llm/llama-server-client.js";
import { GrammarError } from "../../llm/reliability/llm-failures.js";
import { describeLlmFailure } from "./llm-failure-context.js";
import { readContextOverflow } from "./llm-failure-overflow.js";

/**
 * ATO-2420: a context-overflow report carries the server's own window and
 * prompt count and how far the overflow compaction got. Numbers and a
 * fixed word only, never the server's sentence.
 */

const SENTENCE = "llama-server returned http 400: the request exceeds the available context size, try increasing it";

function llamaOverflow(counts: { contextWindow?: number; promptTokens?: number } = {}): GrammarError {
  const cause = new LlamaServerError(SENTENCE, 400, "http://127.0.0.1:1337/v1/chat/completions", false, undefined,
    { body: { type: "exceed_context_size_error", ...counts } });
  return new GrammarError(SENTENCE, "", { cause });
}

const noConfig = {
  readConfig: (): AtomicAgentConfig => {
    throw new Error("no config in this test");
  },
  readDaemonPidState: () => "no_pid" as const,
};

describe("readContextOverflow (ATO-2420)", () => {
  it("reads the server's counts off a refusal the turn failed on directly", () => {
    expect(readContextOverflow(llamaOverflow({ contextWindow: 32_768, promptTokens: 40_123 }))).toEqual({
      serverWindow: 32_768,
      serverPromptTokens: 40_123,
      compaction: "not_attempted",
    });
  });

  it("says whether the overflow compaction freed room before the turn gave up", () => {
    const cause = llamaOverflow({ contextWindow: 8_192 });
    expect(readContextOverflow(contextWindowExhaustedError({ cause, compacted: true }))).toEqual({
      serverWindow: 8_192,
      serverPromptTokens: null,
      compaction: "compacted_still_too_large",
    });
    expect(readContextOverflow(contextWindowExhaustedError({ cause, compacted: false }))?.compaction).toBe(
      "could_not_free_room",
    );
  });

  it("is undefined for any other failure", () => {
    expect(readContextOverflow(new Error("boom"))).toBeUndefined();
    const replyCap = new LlamaServerError("llama-server returned http 400: max_tokens is too large", 400, "u");
    expect(readContextOverflow(replyCap)).toBeUndefined();
  });

  it("is on the llm_failure context, without the server's sentence", () => {
    const context = describeLlmFailure(
      { error: contextWindowExhaustedError({ cause: llamaOverflow({ contextWindow: 16_384 }), compacted: true }) },
      noConfig,
    );
    expect(context.contextOverflow).toEqual({
      serverWindow: 16_384,
      serverPromptTokens: null,
      compaction: "compacted_still_too_large",
    });
    expect(JSON.stringify(context)).not.toContain("exceeds the available context size");
  });
});
