import { afterEach, describe, expect, it, vi } from "vitest";

import { refreshOpenRouterChatCatalogFromApi } from "./openrouter/fetch-openrouter-chat-catalog.js";
import {
  resolveCloudModelVision,
  visionCapableAlternatives,
} from "./model-vision.js";
import {
  isImageRejection,
  markModelCannotSee,
  resetModelVisionRejections,
} from "./model-vision-rejections.js";
import { OpenAiProvider } from "./openai/openai-provider.js";
import { ModelCannotSeeError } from "./llm-provider.js";
import type { LlmProviderConfigEntry } from "./registry/provider-types.js";

const aimlapi = (
  model: string,
  extra: Partial<LlmProviderConfigEntry> = {},
): LlmProviderConfigEntry => ({
  id: "aimlapi",
  kind: "aimlapi",
  defaultChatModel: model,
  ...extra,
});

afterEach(() => {
  resetModelVisionRejections();
  vi.unstubAllGlobals();
});

describe("resolveCloudModelVision", () => {
  it("reads the catalogue per model: text-only and vision rows on one provider", () => {
    expect(
      resolveCloudModelVision(aimlapi("deepseek/deepseek-v4-flash"), "deepseek/deepseek-v4-flash"),
    ).toEqual({ vision: false, visionSource: "catalog" });
    expect(
      resolveCloudModelVision(aimlapi("anthropic/claude-opus-5"), "anthropic/claude-opus-5"),
    ).toEqual({ vision: true, visionSource: "catalog" });
  });

  it("a userModels row outranks the provider flag, which outranks the catalogue", () => {
    const entry = aimlapi("deepseek/deepseek-v4-flash", {
      supportsVision: false,
      userModels: [
        { id: "deepseek/deepseek-v4-flash", kind: "chat", supportsVision: true },
      ],
    });
    expect(resolveCloudModelVision(entry, "deepseek/deepseek-v4-flash")).toEqual({
      vision: true,
      visionSource: "config.userModels",
    });
    expect(
      resolveCloudModelVision(
        aimlapi("anthropic/claude-opus-5", { supportsVision: false }),
        "anthropic/claude-opus-5",
      ),
    ).toEqual({ vision: false, visionSource: "config.provider" });
  });

  it("a row for another model says nothing about this one", () => {
    const entry = aimlapi("deepseek/deepseek-v4-flash", {
      userModels: [{ id: "other", kind: "chat", supportsVision: true }],
    });
    expect(resolveCloudModelVision(entry, "deepseek/deepseek-v4-flash").visionSource).toBe(
      "catalog",
    );
  });

  it("a model nobody describes is assumed, until it has rejected an image", () => {
    const entry: LlmProviderConfigEntry = {
      id: "custom",
      kind: "openai-compatible",
      baseUrl: "https://x.invalid",
      defaultChatModel: "house-7",
    };
    expect(resolveCloudModelVision(entry, "house-7")).toEqual({
      vision: true,
      visionSource: "assumed",
    });
    markModelCannotSee("custom", "house-7");
    expect(resolveCloudModelVision(entry, "house-7")).toEqual({
      vision: false,
      visionSource: "rejected-images",
    });
    // Config still wins over what was learned.
    expect(
      resolveCloudModelVision({ ...entry, supportsVision: true }, "house-7"),
    ).toEqual({ vision: true, visionSource: "config.provider" });
  });

  it("uses the live OpenRouter list when it states input_modalities, and ignores silence", async () => {
    vi.stubGlobal("fetch", (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "acme/seer-1", architecture: { input_modalities: ["text", "image"] } },
            { id: "acme/scribe-1", architecture: { input_modalities: ["text"] } },
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
    expect(resolveCloudModelVision(entry("acme/seer-1"), "acme/seer-1")).toEqual({
      vision: true,
      visionSource: "catalog.live",
    });
    expect(resolveCloudModelVision(entry("acme/scribe-1"), "acme/scribe-1")).toEqual({
      vision: false,
      visionSource: "catalog.live",
    });
    expect(resolveCloudModelVision(entry("acme/quiet-1"), "acme/quiet-1")).toEqual({
      vision: true,
      visionSource: "assumed",
    });
  });
});

describe("isImageRejection", () => {
  it.each([
    [400, "openai provider 400: {\"message\":\"Validation failed\"}"],
    [400, "openai provider 400: image input is not supported for this model"],
    [404, "openai provider 404: No endpoints found that support image input"],
    [422, "openai provider 422: messages[0].content: Expected string, received array"],
  ])("%i %s is about the image", (status, message) => {
    expect(isImageRejection(status, message)).toBe(true);
  });

  it.each([
    [401, "openai provider 401: invalid api key"],
    [429, "openai provider 429: image rate limit"],
    [500, "openai provider 500: image pipeline crashed"],
    [null, "openai provider network error: ECONNREFUSED"],
    [400, "openai provider 400: max_tokens is too large"],
  ])("%s %s is not", (status, message) => {
    expect(isImageRejection(status, message)).toBe(false);
  });
});

describe("OpenAiProvider learns from an image rejection", () => {
  const answer400 = () =>
    vi.fn(async () =>
      new Response(JSON.stringify({ message: "Validation failed" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
  const image = { id: 1, bytes: new Uint8Array([0x89, 0x50]), mimeType: "image/png" };
  const build = (fetchImpl: typeof fetch, supportsVision?: boolean) =>
    new OpenAiProvider({
      id: "custom",
      baseUrl: "https://x.invalid",
      apiKey: "k",
      defaultChatModel: "house-7",
      fetchImpl,
      ...(supportsVision !== undefined ? { supportsVision } : {}),
    });

  it("an assumed model is marked text-only, and a rebuild keeps the verdict", async () => {
    const fetchImpl = answer400();
    const provider = build(fetchImpl as unknown as typeof fetch);
    expect(provider.capabilities).toMatchObject({ vision: true, visionSource: "assumed" });
    await expect(
      provider.describeImage({ prompt: "x", images: [image] }),
    ).rejects.toBeInstanceOf(ModelCannotSeeError);
    expect(provider.capabilities).toMatchObject({
      vision: false,
      visionSource: "rejected-images",
    });
    expect(build(fetchImpl as unknown as typeof fetch).capabilities.vision).toBe(false);
  });

  it("a model the operator declared vision-capable is not overruled by one 400", async () => {
    const fetchImpl = answer400();
    const provider = build(fetchImpl as unknown as typeof fetch, true);
    await expect(
      provider.describeImage({ prompt: "x", images: [image] }),
    ).rejects.not.toBeInstanceOf(ModelCannotSeeError);
    expect(provider.capabilities.vision).toBe(true);
  });
});

describe("visionCapableAlternatives", () => {
  it("names only vision rows, in curated order", () => {
    const names = visionCapableAlternatives({ id: "aimlapi", kind: "aimlapi" });
    expect(names).toHaveLength(3);
    for (const id of names) {
      expect(resolveCloudModelVision(aimlapi(id), id)).toEqual({
        vision: true,
        visionSource: "catalog",
      });
    }
  });

  it("is empty for a kind without a catalogue", () => {
    expect(visionCapableAlternatives({ id: "c", kind: "openai-compatible" })).toEqual([]);
  });
});
