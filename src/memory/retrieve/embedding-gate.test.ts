import { describe, expect, it, vi } from "vitest";

import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import {
  EmbeddingUnavailableError,
  type EmbeddingClient,
  type EmbedResult,
} from "../embeddings/embedding-client.js";

import { createEmbeddingGate } from "./embedding-gate.js";
import { DEFAULT_REWRITER_EXEMPLARS } from "./default-rewriter-exemplars.js";

function unit(v: readonly number[]): Float32Array {
  const out = new Float32Array(v);
  let norm = 0;
  for (let i = 0; i < out.length; i += 1) norm += out[i]! * out[i]!;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < out.length; i += 1) out[i] = out[i]! * inv;
  return out;
}

function mockEmbedder(vectors: Map<string, Float32Array>): EmbeddingClient {
  return {
    dim: 4,
    model: "mock",
    async embed(req): Promise<EmbedResult> {
      const key = req.text.trim().toLowerCase();
      const hit = vectors.get(key);
      if (!hit) {
        throw new EmbeddingUnavailableError(`no vector for ${key}`);
      }
      return { vector: hit, model: "mock" };
    },
  };
}

describe("createEmbeddingGate", () => {
  it("returns false when history is empty", async () => {
    const gate = createEmbeddingGate({
      embedder: mockEmbedder(new Map()),
      exemplars: ["tell me more about it"],
      threshold: 0.65,
    });
    expect(
      await gate.check({
        message: "tell me more",
        historyTurnCount: 0,
        signal: new AbortController().signal,
      }),
    ).toBe(false);
  });

  it("returns false for an empty message", async () => {
    const gate = createEmbeddingGate({
      embedder: mockEmbedder(new Map()),
      exemplars: ["tell me more about it"],
      threshold: 0.65,
    });
    expect(
      await gate.check({
        message: "   ",
        historyTurnCount: 2,
        signal: new AbortController().signal,
      }),
    ).toBe(false);
  });

  it("warms exemplars once and fires when cosine exceeds threshold", async () => {
    const ref = unit([1, 0, 0, 0]);
    const vectors = new Map<string, Float32Array>([
      ["tell me more about it", ref],
      ["tell me more about it", ref],
    ]);
    const embed = vi.fn(mockEmbedder(vectors).embed);
    const gate = createEmbeddingGate({
      embedder: { dim: 4, model: "mock", embed },
      exemplars: ["tell me more about it"],
      threshold: 0.99,
    });
    const signal = new AbortController().signal;
    const input = {
      message: "tell me more about it",
      historyTurnCount: 2,
      signal,
    };
    expect(await gate.check(input)).toBe(true);
    expect(await gate.check(input)).toBe(true);
    // one warm embed + two message embeds (second check reuses warm)
    expect(embed).toHaveBeenCalledTimes(3);
  });

  it("skips when cosine is below threshold", async () => {
    const orthoA = unit([1, 0, 0, 0]);
    const orthoB = unit([0, 1, 0, 0]);
    const vectors = new Map([
      ["tell me more about it", orthoA],
      ["unrelated technical bm25 ranking walkthrough", orthoB],
    ]);
    const metrics: AgentMetrics = {
      recordRetrieveRewriterGateSkipped: vi.fn(),
      recordRetrieveRewriterGateCosine: vi.fn(),
      recordRetrieveRewriterGateFired: vi.fn(),
    } as unknown as AgentMetrics;
    const gate = createEmbeddingGate({
      embedder: mockEmbedder(vectors),
      exemplars: ["tell me more about it"],
      threshold: 0.65,
      metrics,
    });
    expect(
      await gate.check({
        message: "unrelated technical bm25 ranking walkthrough",
        historyTurnCount: 2,
        signal: new AbortController().signal,
      }),
    ).toBe(false);
    expect(metrics.recordRetrieveRewriterGateSkipped).toHaveBeenCalledWith({
      gateMode: "embedding",
      reason: "below_threshold",
    });
  });

  it("fail-safe: warm failure returns false (skip + no throw)", async () => {
    const embedder: EmbeddingClient = {
      dim: 4,
      model: "mock",
      async embed() {
        throw new EmbeddingUnavailableError("daemon down");
      },
    };
    const gate = createEmbeddingGate({
      embedder,
      exemplars: DEFAULT_REWRITER_EXEMPLARS.slice(0, 2),
      threshold: 0.65,
    });
    expect(
      await gate.check({
        message: "tell me more",
        historyTurnCount: 2,
        signal: new AbortController().signal,
      }),
    ).toBe(false);
  });

  it("fail-safe: per-call embed failure returns false", async () => {
    const ref = unit([1, 0, 0, 0]);
    const vectors = new Map([["tell me more about it", ref]]);
    const base = mockEmbedder(vectors);
    let calls = 0;
    const embedder: EmbeddingClient = {
      dim: 4,
      model: "mock",
      async embed(req) {
        calls += 1;
        if (calls > 1) {
          throw new EmbeddingUnavailableError("transient");
        }
        return base.embed(req);
      },
    };
    const gate = createEmbeddingGate({
      embedder,
      exemplars: ["tell me more about it"],
      threshold: 0.5,
    });
    expect(
      await gate.check({
        message: "tell me more about it",
        historyTurnCount: 2,
        signal: new AbortController().signal,
      }),
    ).toBe(false);
  });

  it("returns false when the caller signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const gate = createEmbeddingGate({
      embedder: mockEmbedder(new Map([["x", unit([1, 0, 0, 0])]])),
      exemplars: ["x"],
      threshold: 0.1,
    });
    expect(
      await gate.check({
        message: "x",
        historyTurnCount: 2,
        signal: ac.signal,
      }),
    ).toBe(false);
  });
});
