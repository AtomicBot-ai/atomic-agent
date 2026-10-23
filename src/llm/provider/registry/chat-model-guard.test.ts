import { describe, expect, it } from "vitest";

import { entryHasNoChatModel } from "./chat-model-guard.js";
import type { LlmProviderConfigEntry } from "./provider-types.js";

const entry = (over: Partial<LlmProviderConfigEntry>): LlmProviderConfigEntry =>
  ({ id: "p", kind: "openai-compatible", ...over }) as LlmProviderConfigEntry;

describe("entryHasNoChatModel", () => {
  it("flags an embedding-only openai-compatible entry", () => {
    expect(
      entryHasNoChatModel(entry({ defaultEmbeddingModel: "nomic-embed-text" })),
    ).toBe(true);
  });

  it("flags the qwen-openai-compatible kind the same way", () => {
    expect(entryHasNoChatModel(entry({ kind: "qwen-openai-compatible" }))).toBe(
      true,
    );
  });

  it("passes an openai-compatible entry that pins a chat model", () => {
    expect(entryHasNoChatModel(entry({ defaultChatModel: "gpt-x" }))).toBe(
      false,
    );
  });

  it("passes a llama-server entry, which never names a chat model", () => {
    expect(
      entryHasNoChatModel(
        entry({ kind: "llama-server", url: "http://127.0.0.1:19091" }),
      ),
    ).toBe(false);
  });

  it("passes a cloud kind that falls back to its own default model", () => {
    expect(entryHasNoChatModel(entry({ kind: "aimlapi" }))).toBe(false);
  });
});
