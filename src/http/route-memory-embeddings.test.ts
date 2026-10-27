import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

describe("POST /api/memory/embeddings/reconnect", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  const post = () => fetch(`${harness.baseUrl}/api/memory/embeddings/reconnect`, { method: "POST" });

  it("reattaches through the runtime and answers where memory stands", async () => {
    // The method is optional on AgentRuntime, so it is replaced rather than spied on.
    const reconnect = vi.fn(async () => ({ health: "ok" as const, modelId: "embeddinggemma-2", changed: true }));
    (harness.runtime as { reconnectMemoryEmbeddings?: typeof reconnect }).reconnectMemoryEmbeddings = reconnect;
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ health: "ok", modelId: "embeddinggemma-2", changed: true });
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("answers the real switch's verdict on a runtime with embeddings off", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { health: string };
    expect(["ok", "unreachable", "disabled"]).toContain(body.health);
  });
});
