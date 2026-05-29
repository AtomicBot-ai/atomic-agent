import { describe, expect, it, vi } from "vitest";

import {
  AimlapiProvider,
  DEFAULT_AIMLAPI_BASE,
  normalizeAimlapiBaseUrl,
} from "./aimlapi-provider.js";

describe("normalizeAimlapiBaseUrl", () => {
  it("strips a trailing /v1 from legacy configs", () => {
    expect(normalizeAimlapiBaseUrl("https://api.aimlapi.com/v1")).toBe(
      "https://api.aimlapi.com",
    );
  });

  it("strips a trailing slash without touching the rest of the path", () => {
    expect(normalizeAimlapiBaseUrl("https://api.aimlapi.com/")).toBe(
      "https://api.aimlapi.com",
    );
  });
});

describe("AimlapiProvider", () => {
  it("defaults to https://api.aimlapi.com and POSTs to /v1/chat/completions", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${DEFAULT_AIMLAPI_BASE}/v1/chat/completions`);
      const headers = new Headers(init?.headers ?? {});
      expect(headers.get("authorization")).toBe("Bearer test-key");
      expect(headers.get("http-referer")).toBeNull();
      expect(headers.get("x-title")).toBeNull();
      return new Response(
        JSON.stringify({
          id: "gen-1",
          model: "openai/gpt-5-2",
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const provider = new AimlapiProvider({
      id: "aimlapi",
      apiKey: "test-key",
      defaultChatModel: "openai/gpt-5-2",
      fetchImpl: fetchImpl as typeof fetch,
      requestTimeoutMs: 5000,
    });

    const result = await provider.complete({
      prompt: "hi",
      maxTokens: 16,
      temperature: 0,
    });

    expect(result.content).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("normalises a base URL with a trailing /v1 to avoid /v1/v1", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.aimlapi.com/v1/chat/completions");
      return new Response(
        JSON.stringify({
          id: "gen-2",
          model: "openai/gpt-5-2",
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const provider = new AimlapiProvider({
      id: "aimlapi",
      baseUrl: "https://api.aimlapi.com/v1",
      apiKey: "test-key",
      defaultChatModel: "openai/gpt-5-2",
      fetchImpl: fetchImpl as typeof fetch,
      requestTimeoutMs: 5000,
    });

    await provider.complete({ prompt: "hi", maxTokens: 16, temperature: 0 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
