import { describe, expect, it, vi } from "vitest";

import type { ProviderContractProbeTarget } from "./contract-probe-types.js";
import { runProviderContractProbe } from "./run-contract-probe.js";

/** ATO-1216: the probe's temperature follows the model's own rule. */

const TEXT_STREAM =
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  "data: [DONE]\n\n";

function target(model: string): ProviderContractProbeTarget {
  return {
    label: "Route",
    baseUrl: "https://route.example",
    apiPathPrefix: "/v1",
    apiKey: "sk-probe",
    model,
  };
}

async function firstBody(model: string): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(TEXT_STREAM, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
  await runProviderContractProbe(target(model), { fetchImpl });
  return bodies[0]!;
}

describe("runProviderContractProbe — temperature per model", () => {
  it("sends 0 to a model that takes any value", async () => {
    expect((await firstBody("vendor/some-model")).temperature).toBe(0);
  });

  it("sends Kimi K3.1 its one allowed value", async () => {
    expect((await firstBody("moonshotai/kimi-k3.1-pro")).temperature).toBe(1);
  });

  it("sends an OpenAI reasoning model no temperature", async () => {
    expect(await firstBody("openai/gpt-5")).not.toHaveProperty("temperature");
  });
});
