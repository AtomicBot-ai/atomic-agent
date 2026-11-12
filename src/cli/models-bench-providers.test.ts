import { describe, expect, it } from "vitest";

import type { LlmProviderConfigEntry } from "../llm/provider/registry/provider-types.js";

import { entryForSpec, parseModelSpecs } from "./models-bench-providers.js";

describe("parseModelSpecs (ATO-1092)", () => {
  it("falls back to the active provider when --models is absent or empty", () => {
    expect(parseModelSpecs(undefined, "or")).toEqual([{ spec: "or", providerId: "or" }]);
    expect(parseModelSpecs(" , ", "or")).toEqual([{ spec: "or", providerId: "or" }]);
  });

  it("splits provider and model at the first colon only", () => {
    expect(parseModelSpecs("or:anthropic/claude-x, ollama:qwen3:8b,groq", "x")).toEqual([
      { spec: "or:anthropic/claude-x", providerId: "or", model: "anthropic/claude-x" },
      { spec: "ollama:qwen3:8b", providerId: "ollama", model: "qwen3:8b" },
      { spec: "groq", providerId: "groq" },
    ]);
  });

  it("treats a trailing colon as the configured model", () => {
    expect(parseModelSpecs("or:", "x")).toEqual([{ spec: "or:", providerId: "or" }]);
  });
});

describe("entryForSpec", () => {
  const providers: LlmProviderConfigEntry[] = [
    { id: "local-llama", kind: "llama-server" },
    { id: "or", kind: "openrouter", defaultChatModel: "openrouter/auto" },
  ];

  it("swaps the named model into a copy of the entry", () => {
    const entry = entryForSpec({ spec: "or:a/b", providerId: "or", model: "a/b" }, providers);
    expect(entry).toMatchObject({ id: "or", defaultChatModel: "a/b", model: "a/b" });
    expect(providers[1]!.defaultChatModel).toBe("openrouter/auto");
  });

  it("keeps the configured model when none is named", () => {
    expect(entryForSpec({ spec: "or", providerId: "or" }, providers)).toBe(providers[1]);
  });

  it("refuses an unknown provider and lists the configured ones", () => {
    expect(entryForSpec({ spec: "nope", providerId: "nope" }, providers)).toBe(
      'no provider "nope" in the config (configured: local-llama, or)',
    );
  });

  it("refuses the built-in grammar link", () => {
    expect(entryForSpec({ spec: "local-llama", providerId: "local-llama" }, providers)).toMatch(
      /built-in local link/,
    );
  });
});
