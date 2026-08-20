import { describe, expect, it, vi } from "vitest";

import { verifyProviderKey } from "./verify-provider-key.js";
import type { ProviderVerifyTarget } from "./verify-types.js";

function target(
  overrides: Partial<ProviderVerifyTarget> = {},
): ProviderVerifyTarget {
  return {
    label: "testprov",
    baseUrl: "https://api.example.com",
    apiPathPrefix: "/v1",
    apiKey: "sk-secret-key",
    probeModels: ["cheap-model"],
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(call: Parameters<typeof fetch>[]): Record<string, unknown> {
  return JSON.parse(String((call[1] as RequestInit).body)) as Record<
    string,
    unknown
  >;
}

describe("verifyProviderKey", () => {
  it("spends one token on the cheapest model and reports ok", async () => {
    const fetchImpl = vi.fn(async () => response({ choices: [] }));
    const result = await verifyProviderKey(target(), { fetchImpl });

    expect(result).toMatchObject({ status: "ok", probedModel: "cheap-model" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(
      (init.headers as Record<string, string>).authorization,
    ).toBe("Bearer sk-secret-key");
    expect(bodyOf(fetchImpl.mock.calls[0] as never)).toMatchObject({
      model: "cheap-model",
      max_tokens: 1,
      stream: false,
    });
  });

  it("does not retry a refused key", async () => {
    // The shared HTTP client retries three times with backoff; a key
    // check must answer at the first no.
    const fetchImpl = vi.fn(async () =>
      response({ error: "No auth credentials found" }, 401),
    );
    const result = await verifyProviderKey(target(), { fetchImpl });

    expect(result.status).toBe("invalid_key");
    expect(result.httpStatus).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports an empty account", async () => {
    const fetchImpl = vi.fn(async () => response("Insufficient credits", 402));
    const result = await verifyProviderKey(target(), { fetchImpl });
    expect(result.status).toBe("no_balance");
  });

  it("falls back to the second candidate when the first is gone", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      return body.model === "gone-model"
        ? response({ error: "no such model" }, 404)
        : response({ choices: [] });
    });
    const result = await verifyProviderKey(
      target({ probeModels: ["gone-model", "live-model"] }),
      { fetchImpl },
    );

    expect(result).toMatchObject({ status: "ok", probedModel: "live-model" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("resends with max_completion_tokens when the model demands it", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return "max_tokens" in body
        ? response(
            { error: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens'." },
            400,
          )
        : response({ choices: [] });
    });
    const result = await verifyProviderKey(target(), { fetchImpl });

    expect(result.status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchImpl.mock.calls[1] as never)).toMatchObject({
      max_completion_tokens: 1,
    });
  });

  it("gives up after three requests", async () => {
    const fetchImpl = vi.fn(async () => response({ error: "not found" }, 404));
    const result = await verifyProviderKey(
      target({ probeModels: ["a", "b"] }),
      { fetchImpl },
    );

    expect(result.status).toBe("model_unavailable");
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("reports our own deadline as a timeout, not a bad key", async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const result = await verifyProviderKey(target(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10,
    });
    expect(result.status).toBe("timeout");
  });

  it("reports a caller abort as a cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => response({ choices: [] }));
    const result = await verifyProviderKey(target(), {
      fetchImpl,
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
  });

  it("reports an unreachable host without blaming the key", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await verifyProviderKey(target(), { fetchImpl });
    expect(result.status).toBe("unreachable");
  });

  it("never puts the key in the reported detail", async () => {
    const fetchImpl = vi.fn(async () =>
      response("Bearer sk-secret-key rejected", 403),
    );
    const result = await verifyProviderKey(
      target({ apiKey: "sk-secret-key" }),
      { fetchImpl },
    );
    expect(result.detail).not.toContain("sk-secret-key");
  });
});
