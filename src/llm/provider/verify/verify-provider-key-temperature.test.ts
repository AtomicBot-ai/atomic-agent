import { afterEach, describe, expect, it, vi } from "vitest";

import { forgetLearnedModelParams } from "../openai/model-params.js";
import { verifyProviderKey } from "./verify-provider-key.js";
import type { ProviderVerifyTarget } from "./verify-types.js";

/**
 * #1554: a model that refuses the probe's temperature says nothing about
 * the key. The check sends again once without it instead of reporting a
 * provider error.
 */

afterEach(() => {
  forgetLearnedModelParams();
});

const DEPRECATED_400 = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "`temperature` is deprecated for this model.",
  },
});

function target(model: string): ProviderVerifyTarget {
  return {
    label: "gateway",
    baseUrl: "https://gateway.example.com",
    apiPathPrefix: "/v1",
    apiKey: "sk-secret-key",
    probeModels: [model],
  };
}

function response(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function recording(answer: (body: Record<string, unknown>) => Response) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    bodies.push(body);
    return answer(body);
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

describe("verifyProviderKey: refused temperature (#1554)", () => {
  it("resends without temperature and reports the key ok", async () => {
    const { fetchImpl, bodies } = recording((body) =>
      "temperature" in body
        ? response(DEPRECATED_400, 400)
        : response('{"choices":[]}', 200),
    );
    const result = await verifyProviderKey(target("gateway/claude-latest"), { fetchImpl });

    expect(result.status).toBe("ok");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.temperature).toBe(0);
    expect(bodies[1]).not.toHaveProperty("temperature");
  });

  it("resends only once when the refusal repeats", async () => {
    const { fetchImpl, bodies } = recording(() => response(DEPRECATED_400, 400));
    const result = await verifyProviderKey(target("gateway/claude-latest"), { fetchImpl });

    expect(result.status).toBe("provider_error");
    expect(bodies).toHaveLength(2);
  });

  it("sends a known new Claude id no temperature in the first place", async () => {
    const { fetchImpl, bodies } = recording(() => response('{"choices":[]}', 200));
    const result = await verifyProviderKey(target("claude-opus-5-5"), { fetchImpl });

    expect(result.status).toBe("ok");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("temperature");
  });
});
