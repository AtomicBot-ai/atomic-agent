import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveCloudModelAudio } from "./model-audio.js";
import { refreshOpenRouterChatCatalogFromApi } from "./openrouter/fetch-openrouter-chat-catalog.js";
import type { LlmProviderConfigEntry } from "./registry/provider-types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const custom = (extra: Partial<LlmProviderConfigEntry> = {}): LlmProviderConfigEntry => ({
  id: "custom",
  kind: "openai-compatible",
  baseUrl: "https://x.invalid",
  defaultChatModel: "house-7",
  ...extra,
});

describe("resolveCloudModelAudio (ATO-497)", () => {
  it("is off for a model nobody describes: audio is never assumed", () => {
    expect(resolveCloudModelAudio(custom(), "house-7")).toEqual({
      audio: false,
      audioSource: "unknown",
    });
  });

  it("a userModels row outranks the provider flag", () => {
    const entry = custom({
      supportsAudio: false,
      userModels: [{ id: "house-7", kind: "chat", supportsAudio: true }],
    });
    expect(resolveCloudModelAudio(entry, "house-7")).toEqual({
      audio: true,
      audioSource: "config.userModels",
    });
    expect(resolveCloudModelAudio(custom({ supportsAudio: true }), "house-7")).toEqual({
      audio: true,
      audioSource: "config.provider",
    });
    // A row for another model says nothing about this one.
    expect(
      resolveCloudModelAudio(
        custom({ userModels: [{ id: "other", kind: "chat", supportsAudio: true }] }),
        "house-7",
      ).audioSource,
    ).toBe("unknown");
  });

  it("uses OpenRouter's live input_modalities, and ignores silence", async () => {
    vi.stubGlobal("fetch", (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "acme/ear-1", architecture: { input_modalities: ["text", "audio"] } },
            { id: "acme/seer-1", architecture: { input_modalities: ["text", "image"] } },
            { id: "acme/quiet-1" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch);
    expect(await refreshOpenRouterChatCatalogFromApi()).toBe(true);
    const entry = (model: string): LlmProviderConfigEntry => ({
      id: "openrouter",
      kind: "openrouter",
      defaultChatModel: model,
    });
    expect(resolveCloudModelAudio(entry("acme/ear-1"), "acme/ear-1")).toEqual({
      audio: true,
      audioSource: "catalog.live",
    });
    expect(resolveCloudModelAudio(entry("acme/seer-1"), "acme/seer-1")).toEqual({
      audio: false,
      audioSource: "catalog.live",
    });
    expect(resolveCloudModelAudio(entry("acme/quiet-1"), "acme/quiet-1").audioSource).toBe(
      "unknown",
    );
  });
});
