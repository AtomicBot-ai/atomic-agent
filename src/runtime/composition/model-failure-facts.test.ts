import { describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig } from "../../config/index.js";
import { repeatedEmptyCompletionError } from "../../agent/empty-completion-recovery.js";
import { ModelError } from "../../llm/index.js";
import { describeLlmFailure } from "./llm-failure-context.js";
import { readCompletionFacts, serverKindOf } from "./model-failure-facts.js";

/** Only the fields the description reads. */
function config(providers: Array<{ id: string; kind: string; baseUrl?: string; url?: string }>, active: string): AtomicAgentConfig {
  return {
    llm: { activeTextProvider: active, providers, activeEmbeddingProvider: "local-llama-embed", toolTransport: "auto" },
    localModels: { mode: "managed", url: "http://127.0.0.1:8080", managed: { engine: "atomic-core" } },
    paths: { localModelsDataDir: "/state/models" },
  } as unknown as AtomicAgentConfig;
}

function deps(cfg: AtomicAgentConfig) {
  return { readConfig: () => cfg, readDaemonPidState: vi.fn(() => "alive" as const) };
}

function emptyOnOllama(): ModelError {
  return new ModelError("empty", "model returned empty content", {
    transport: "native_tools",
    stage: "initial",
    completion: { finishReason: "stop", reasoningPresent: false, promptTokens: 4096, completionTokens: 0 },
  });
}

/** ATO-2421: an empty answer's shape and its server reach the report. */
describe("describeLlmFailure: completion facts (ATO-2421)", () => {
  it("carries the facts and names an Ollama server behind a custom provider id", () => {
    const cfg = config([{ id: "my-box", kind: "openai", baseUrl: "http://localhost:11434/v1" }], "my-box");
    const context = describeLlmFailure({ error: emptyOnOllama() }, deps(cfg));
    expect(context.completionFacts).toEqual({
      finishReason: "stop",
      reasoningPresent: false,
      promptTokens: 4096,
      completionTokens: 0,
    });
    expect(context.serverKind).toBe("ollama");
    expect(JSON.stringify(context)).not.toContain("model returned empty content");
  });

  it("reads the facts through the turn's doubled-empty wrapper", () => {
    const wrapped = repeatedEmptyCompletionError(emptyOnOllama());
    expect(readCompletionFacts(wrapped)?.promptTokens).toBe(4096);
  });

  it("adds no facts and no server kind for an error that is not a model failure", () => {
    const cfg = config([{ id: "my-box", kind: "openai", baseUrl: "http://localhost:11434/v1" }], "my-box");
    const context = describeLlmFailure({ error: new Error("fetch failed") }, deps(cfg));
    expect(context.completionFacts).toBeUndefined();
    expect(context.serverKind).toBeUndefined();
  });
});

describe("serverKindOf", () => {
  it("tells Ollama, llama-server and everything else apart", () => {
    const llm = {
      activeTextProvider: "local-llama",
      activeEmbeddingProvider: "local-llama-embed",
      toolTransport: "auto" as const,
      providers: [
        { id: "ollama", kind: "openai", baseUrl: "http://localhost:11434" },
        { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:9931" },
        { id: "openrouter", kind: "openrouter" },
        { id: "ollama-cloud", kind: "openai", baseUrl: "https://ollama.com" },
      ],
    };
    expect(serverKindOf(llm, "ollama")).toBe("ollama");
    expect(serverKindOf(llm, "local-llama")).toBe("llama_server");
    expect(serverKindOf(llm, "openrouter")).toBe("other");
    expect(serverKindOf(llm, "ollama-cloud")).toBe("other");
    // The synthesized local entry no config lists is the llama-server link.
    expect(serverKindOf(llm, "missing")).toBe("llama_server");
  });
});
