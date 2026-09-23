import { afterEach, describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig } from "../../../config/index.js";
import { registerBuiltInProviderKinds } from "./register-built-in-providers.js";
import {
  getProviderFactory,
  type LlmProviderConfigEntry,
} from "./provider-types.js";

const PREFERENCES = { order: ["z-ai"], allow_fallbacks: false };

/**
 * Builds the provider exactly as config does — through the registered
 * factory — and returns the chat body its first completion sent.
 */
async function firstBody(
  entry: LlmProviderConfigEntry,
): Promise<Record<string, unknown>> {
  registerBuiltInProviderKinds();
  const factory = getProviderFactory(entry.kind);
  if (!factory) throw new Error(`${entry.kind} is not registered`);
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  const provider = await factory({
    config: {} as AtomicAgentConfig,
    entry,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never,
  });
  await provider.complete({ prompt: "hi" });
  const body = bodies[0];
  if (!body) throw new Error(`${entry.kind} sent no request`);
  return body;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("providerPreferences through the built-in factories", () => {
  it("the openrouter factory forwards them as `provider`", async () => {
    const body = await firstBody({
      id: "openrouter",
      kind: "openrouter",
      apiKey: "test-key",
      defaultChatModel: "z-ai/glm-5.3-flash",
      providerPreferences: PREFERENCES,
    });
    expect(body.provider).toEqual(PREFERENCES);
  });

  // `provider` is OpenRouter's field. Sent to any other OpenAI-shaped
  // service it is at best ignored and at worst a 400, so the other
  // kinds must keep their bodies untouched even with the key present.
  it.each(["openai-compatible", "qwen-openai-compatible", "aimlapi", "gemini"])(
    "%s does not send them",
    async (kind) => {
      const body = await firstBody({
        id: kind,
        kind,
        apiKey: "test-key",
        baseUrl: "https://example.invalid",
        defaultChatModel: "some-model",
        providerPreferences: PREFERENCES,
      });
      expect(body).not.toHaveProperty("provider");
    },
  );
});

describe("vision capability through the built-in factories", () => {
  async function build(entry: LlmProviderConfigEntry) {
    registerBuiltInProviderKinds();
    const factory = getProviderFactory(entry.kind);
    if (!factory) throw new Error(`${entry.kind} is not registered`);
    return factory({
      config: {} as AtomicAgentConfig,
      entry,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
  }

  /* The field session: `deepseek/deepseek-v4-flash` on AI/ML API, no
     `supportsVision` on the entry, three `400 Validation failed` from
     `vision.describe` in one turn. */
  it("a text-only catalogue model is not declared vision-capable", async () => {
    const provider = await build({
      id: "aimlapi", kind: "aimlapi", apiKey: "k", defaultChatModel: "deepseek/deepseek-v4-flash",
    });
    expect(provider.capabilities.vision).toBe(false);
    await expect(
      provider.describeImage({ prompt: "x", images: [{ id: 1, bytes: new Uint8Array([1]), mimeType: "image/png" }] }),
    ).rejects.toMatchObject({ name: "VisionUnsupportedError" });
  });

  it.each([
    ["aimlapi", "openai/gpt-5.4-2026-03-05", true],
    ["aimlapi", "some/model-the-catalogue-does-not-know", true],
    ["openrouter", "deepseek/deepseek-v4-flash", false],
    ["openrouter", "anthropic/claude-sonnet-5", true],
  ] as const)("%s %s → vision %s", async (kind, model, vision) => {
    const provider = await build({ id: kind, kind, apiKey: "k", defaultChatModel: model });
    expect(provider.capabilities.vision).toBe(vision);
  });

  it("an explicit supportsVision on the entry still wins", async () => {
    const provider = await build({
      id: "aimlapi", kind: "aimlapi", apiKey: "k", defaultChatModel: "deepseek/deepseek-v4-flash", supportsVision: true,
    });
    expect(provider.capabilities.vision).toBe(true);
  });
});
