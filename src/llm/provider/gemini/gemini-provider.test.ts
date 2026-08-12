import { describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig } from "../../../config/index.js";
import { GeminiProvider } from "./gemini-provider.js";
import { registerBuiltInProviderKinds } from "../registry/register-built-in-providers.js";
import { getProviderFactory } from "../registry/provider-types.js";

const GEMINI_CHAT_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_MODELS_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/models";

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function buildGeminiProvider(fetchImpl: typeof fetch) {
  registerBuiltInProviderKinds();
  const factory = getProviderFactory("gemini");
  expect(factory).toBeTypeOf("function");
  if (!factory) throw new Error("gemini provider kind is not registered");
  vi.stubGlobal("fetch", fetchImpl);
  return factory({
    config: {} as AtomicAgentConfig,
    entry: {
      id: "gemini",
      kind: "gemini",
      apiKey: "test-gemini-key",
      defaultChatModel: "gemini-2.5-flash",
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

describe("GeminiProvider", () => {
  it("posts chat requests to Google's OpenAI-compatible path", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(GEMINI_CHAT_URL);
      return jsonResponse({
        id: "gen-1",
        model: "gemini-2.5-flash",
        choices: [
          {
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      });
    });
    const provider = await buildGeminiProvider(fetchImpl as unknown as typeof fetch);

    const result = await provider.complete({
      prompt: "hi",
      maxTokens: 16,
      temperature: 0,
    });

    expect(result.content).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("accepts Google's full documented OpenAI-compatible root without duplicating it", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(GEMINI_CHAT_URL);
      return jsonResponse({
        model: "gemini-2.5-flash",
        choices: [{ message: { role: "assistant", content: "ok" } }],
      });
    });
    const provider = new GeminiProvider({
      id: "gemini",
      baseUrl:
        "https://generativelanguage.googleapis.com/v1beta/openai/",
      apiKey: "test-...ey",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.complete({ prompt: "hi" });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("opens streams at Google's OpenAI-compatible path", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(GEMINI_CHAT_URL);
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const provider = await buildGeminiProvider(fetchImpl as unknown as typeof fetch);

    const stream = provider.completeStream({ prompt: "hello" });
    await stream.next();

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("posts vision requests to Google's OpenAI-compatible path", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(GEMINI_CHAT_URL);
      return jsonResponse({ choices: [{ message: { content: "image" } }] });
    });
    const provider = await buildGeminiProvider(fetchImpl as unknown as typeof fetch);

    await provider.describeImage({
      prompt: "describe",
      images: [{ bytes: new Uint8Array([1]), mimeType: "image/png" }],
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("lists models from Google's OpenAI-compatible path", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(GEMINI_MODELS_URL);
      return jsonResponse({ data: [{ id: "gemini-2.5-flash" }] });
    });
    const provider = await buildGeminiProvider(fetchImpl as unknown as typeof fetch);

    await expect(provider.listModels?.()).resolves.toEqual(["gemini-2.5-flash"]);
  });

  it("checks health at Google's OpenAI-compatible models path", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(GEMINI_MODELS_URL);
      return jsonResponse({ data: [] });
    });
    const provider = await buildGeminiProvider(fetchImpl as unknown as typeof fetch);

    await expect(provider.health()).resolves.toMatchObject({ reachable: true, status: 200 });
  });

  it("does not expose the API key in provider errors", async () => {
    const key = "gemini-secret-marker";
    registerBuiltInProviderKinds();
    const factory = getProviderFactory("gemini");
    expect(factory).toBeTypeOf("function");
    if (!factory) throw new Error("gemini provider kind is not registered");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    const provider = await factory({
      config: {} as AtomicAgentConfig,
      entry: { id: "gemini", kind: "gemini", apiKey: key },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const error = await provider
      .complete({ prompt: "hi", maxTokens: 16, temperature: 0 })
      .catch((caught: unknown) => caught);

    expect(String(error)).not.toContain(key);
  });
});
