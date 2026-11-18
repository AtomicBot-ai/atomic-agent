import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "../config/index.js";
import type { PerformanceSample } from "../llm/llama-performance-samples.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import { startTestHarness, type Harness } from "./test-harness.js";

type SlotsReply = { status: number; body: string } | "hang";

/** A stand-in llama-server that answers `GET /slots` and counts the requests. */
async function startSlotsServer(
  reply: SlotsReply,
): Promise<{ url: string; hits: () => number; stop: () => Promise<void> }> {
  let hits = 0;
  const srv: Server = createServer((req, res) => {
    if (req.url !== "/slots") {
      res.writeHead(404).end();
      return;
    }
    hits += 1;
    if (reply === "hang") return;
    res.writeHead(reply.status, { "content-type": "application/json" }).end(reply.body);
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const address = srv.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    stop: () =>
      new Promise((resolve) => {
        srv.closeAllConnections();
        srv.close(() => resolve());
      }),
  };
}

const SAMPLE: PerformanceSample = {
  at: 1794329429000,
  modelId: "Qwen3.6-35B-A3B-MXFP4_MOE.gguf",
  streamed: true,
  promptTokens: 2,
  cacheTokens: 0,
  promptMs: 32.969,
  promptPerSecond: 60.663047104856076,
  predictedTokens: 40,
  predictedMs: 1158.29,
  generationPerSecond: 33.67032435745798,
  ttftMs: 412,
  contextTokens: 42,
  concurrent: 1,
};

/** Rewrite the harness's config file with an `llm` block and drop the cache. */
function setProviders(
  harness: Harness,
  activeTextProvider: string,
  providers: Array<Record<string, unknown>>,
): void {
  const path = join(harness.stateDir, "config.json");
  const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(
    path,
    JSON.stringify({ ...current, llm: { activeTextProvider, providers } }, null, 2),
    "utf8",
  );
  resetConfigCache();
}

async function getPerformance(
  harness: Harness,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${harness.baseUrl}/api/local-model/performance`, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/local-model/performance (issue #996)", () => {
  let harness: Harness | null = null;
  let server: Awaited<ReturnType<typeof startSlotsServer>> | null = null;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
    if (server) await server.stop();
    server = null;
  });

  async function withSlots(reply: SlotsReply): Promise<Harness> {
    server = await startSlotsServer(reply);
    harness = await startTestHarness({ localModelsUrl: server.url });
    return harness;
  }

  it("answers a fresh agent with no samples and the live slots", async () => {
    const h = await withSlots({
      status: 200,
      body: JSON.stringify([
        { id: 0, n_ctx: 262144, is_processing: true },
        { id: 1, n_ctx: 262144, is_processing: false },
      ]),
    });
    const { status, body } = await getPerformance(h);
    expect(status).toBe(200);
    expect(body).toEqual({
      local: true,
      url: server!.url,
      capacity: 300,
      samples: [],
      slots: { total: 2, busy: 1, contextPerSlot: 262144 },
    });
    expect(server!.hits()).toBe(1);
  });

  it("reports slots as null when /slots hangs past its bound", async () => {
    const h = await withSlots("hang");
    const started = Date.now();
    const { status, body } = await getPerformance(h);
    expect(status).toBe(200);
    expect(body.slots).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  const unreadable: Array<[string, SlotsReply]> = [
    ["a 404", { status: 404, body: "{}" }],
    ["a non-array body", { status: 200, body: JSON.stringify({ slots: [] }) }],
    ["an array of no slots", { status: 200, body: JSON.stringify([null]) }],
  ];
  for (const [name, reply] of unreadable) {
    it(`reports slots as null for ${name}`, async () => {
      const h = await withSlots(reply);
      const { status, body } = await getPerformance(h);
      expect(status).toBe(200);
      expect(body.slots).toBeNull();
      expect(body.local).toBe(true);
    });
  }

  it("keeps the load when a slot has no n_ctx", async () => {
    const h = await withSlots({
      status: 200,
      body: JSON.stringify([{ id: 0, is_processing: true }]),
    });
    const { body } = await getPerformance(h);
    expect(body.slots).toEqual({ total: 1, busy: 1, contextPerSlot: null });
  });

  it("asks nothing of the local server while the chat is on a cloud model", async () => {
    const h = await withSlots({ status: 200, body: JSON.stringify([{ id: 0, n_ctx: 8 }]) });
    let slotsCalls = 0;
    const runtime = h.runtime as AgentRuntime;
    runtime.localPerformance = () => ({
      capacity: 300,
      samples: [SAMPLE],
      fetchSlots: async () => {
        slotsCalls += 1;
        return [];
      },
    });
    setProviders(h, "cloud", [
      { id: "local", kind: "llama-server" },
      { id: "cloud", kind: "openrouter" },
    ]);
    const { status, body } = await getPerformance(h);
    expect(status).toBe(200);
    expect(body).toEqual({
      local: false,
      url: server!.url,
      capacity: 300,
      samples: [SAMPLE],
      slots: null,
    });
    expect(slotsCalls).toBe(0);
    expect(server!.hits()).toBe(0);
  });

  it("counts a custom provider of kind llama-server as local", async () => {
    const h = await withSlots({ status: 200, body: JSON.stringify([{ id: 0, n_ctx: 4096 }]) });
    setProviders(h, "box", [
      { id: "box", kind: "llama-server" },
      { id: "cloud", kind: "openrouter" },
    ]);
    const { body } = await getPerformance(h);
    expect(body.local).toBe(true);
    expect(body.slots).toEqual({ total: 1, busy: 0, contextPerSlot: 4096 });
  });

  it("answers without samples or slots on a runtime that has no local performance", async () => {
    const h = await withSlots({ status: 200, body: JSON.stringify([{ id: 0, n_ctx: 8 }]) });
    const runtime = h.runtime as AgentRuntime;
    delete runtime.localPerformance;
    const { status, body } = await getPerformance(h);
    expect(status).toBe(200);
    expect(body).toMatchObject({ local: true, capacity: 300, samples: [], slots: null });
    expect(server!.hits()).toBe(0);
  });

  it("sits behind the API key", async () => {
    server = await startSlotsServer({ status: 200, body: "[]" });
    harness = await startTestHarness({ apiKey: "secret", localModelsUrl: server.url });
    const missing = await fetch(`${harness.baseUrl}/api/local-model/performance`);
    expect(missing.status).toBe(401);
    const { status, body } = await getPerformance(harness, { authorization: "Bearer secret" });
    expect(status).toBe(200);
    expect(body.capacity).toBe(300);
  });
});
