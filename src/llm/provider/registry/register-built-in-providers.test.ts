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
