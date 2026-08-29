import { describe, expect, it } from "vitest";
import {
  AIMLAPI_CHAT_MODEL_ORDER,
  AIMLAPI_DEFAULT_CHAT_MODEL,
  AIMLAPI_MODELS_CATALOG,
} from "./aimlapi-models-catalog.js";

describe("AIMLAPI_MODELS_CATALOG", () => {
  it("orders TUI chat picks with the default chat model first", () => {
    expect(AIMLAPI_CHAT_MODEL_ORDER[0]).toBe(AIMLAPI_DEFAULT_CHAT_MODEL);
    for (const id of AIMLAPI_CHAT_MODEL_ORDER) {
      expect(AIMLAPI_MODELS_CATALOG.has(id)).toBe(true);
    }
  });

  it("ships every order entry as a chat row in the catalog", () => {
    for (const id of AIMLAPI_CHAT_MODEL_ORDER) {
      const entry = AIMLAPI_MODELS_CATALOG.get(id);
      expect(entry, `missing catalog entry for ${id}`).toBeDefined();
      expect(entry?.kind).toBe("chat");
    }
  });

  it("includes the verified flagship picks across vendors", () => {
    expect(AIMLAPI_CHAT_MODEL_ORDER).toEqual(
      expect.arrayContaining([
        "openai/gpt-5.5-2026-04-23",
        "x-ai/grok-4-3",
        "moonshot/kimi-k2-7-code",
        "deepseek/deepseek-v4-pro",
      ]),
    );
  });

  it("excludes /v1/responses-only ids that 404 on chat completions", () => {
    // Verified via `/v1/models`: these rows expose `type: "responses"`
    // only and must never reach the chat-completions catalog.
    const responsesOnly = [
      "openai/gpt-5-pro",
      "openai/o3-pro",
      "openai/gpt-5-1-codex",
      "openai/gpt-5-2-codex",
      "openai/gpt-5-2-pro",
    ];
    for (const id of responsesOnly) {
      expect(AIMLAPI_MODELS_CATALOG.has(id)).toBe(false);
      expect(AIMLAPI_CHAT_MODEL_ORDER).not.toContain(id);
    }
  });

  it("lists the vendor-prefixed Claude and Gemini ids aimlapi serves today", () => {
    // The catalog used to carry no Claude and no Gemini row at all. Both
    // are on aimlapi's `openai/chat-completions` surface under
    // vendor-prefixed ids, so the provider can reach them; only the old
    // unprefixed spellings below are actually gone.
    for (const id of [
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
      "google/gemini-3.7-flash",
      "google/gemini-3.5-flash",
    ]) {
      expect(AIMLAPI_MODELS_CATALOG.get(id)?.kind).toBe("chat");
      expect(AIMLAPI_CHAT_MODEL_ORDER).toContain(id);
    }
  });

  it("keeps every chat row on the picker order, without duplicates", () => {
    expect(new Set(AIMLAPI_CHAT_MODEL_ORDER).size).toBe(
      AIMLAPI_CHAT_MODEL_ORDER.length,
    );
    const chatIds = [...AIMLAPI_MODELS_CATALOG]
      .filter(([, entry]) => entry.kind === "chat")
      .map(([id]) => id);
    expect([...AIMLAPI_CHAT_MODEL_ORDER].sort()).toEqual([...chatIds].sort());
  });

  it("keeps the retired unprefixed Claude and Gemini ids out", () => {
    const retired = [
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "google/gemini-3-flash-preview",
      "google/gemini-2.5-pro",
      "google/gemini-2.0-flash",
    ];
    for (const id of retired) {
      expect(AIMLAPI_MODELS_CATALOG.has(id)).toBe(false);
      expect(AIMLAPI_CHAT_MODEL_ORDER).not.toContain(id);
    }
  });

  it("includes at least one embedding row for cloud-side hybrid recall", () => {
    let embeddingCount = 0;
    for (const [, entry] of AIMLAPI_MODELS_CATALOG) {
      if (entry.kind === "embedding") embeddingCount += 1;
    }
    expect(embeddingCount).toBeGreaterThan(0);
  });
});
