import { describe, expect, it } from "vitest";

import type { CompletionUsage } from "../llm/provider/completion-types.js";
import type { ResolvedModel } from "../llm/provider/model-resolver.js";
import { TurnUsageMeter } from "./turn-usage-meter.js";

const S = "session-a";

function usage(promptTokens: number, completionTokens: number): CompletionUsage {
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

function unpricedModel(): ResolvedModel {
  return {
    id: "local-llama",
    kind: "chat",
    contextWindow: 128_000,
    supportsVision: false,
    supportsTools: "none",
    supportsPromptCache: false,
    reasoningFormat: "none",
    source: "default",
  };
}

function pricedModel(input: number, output: number): ResolvedModel {
  return {
    id: "gpt-priced",
    kind: "chat",
    contextWindow: 128_000,
    supportsVision: true,
    supportsTools: "parallel",
    supportsPromptCache: true,
    reasoningFormat: "none",
    source: "catalog",
    pricing: { input, output },
  };
}

describe("TurnUsageMeter", () => {
  it("record() before any begin() is a no-op — snapshot() returns {}", () => {
    const meter = new TurnUsageMeter();
    meter.record({ sessionId: S, usage: usage(100, 50), model: pricedModel(3, 15) });
    expect(meter.snapshot(S)).toEqual({});
  });

  it("begin() with no record() calls yields {} (no usage reported, not zero)", () => {
    const meter = new TurnUsageMeter();
    meter.begin(S);
    const snap = meter.snapshot(S);
    expect(snap).toEqual({});
  });

  it("record() with usage but no model pricing accumulates tokens and omits costUsd entirely", () => {
    const meter = new TurnUsageMeter();
    meter.begin(S);
    meter.record({ sessionId: S, usage: usage(100, 50), model: unpricedModel() });
    const snap = meter.snapshot(S);
    expect(snap.promptTokens).toBe(100);
    expect(snap.completionTokens).toBe(50);
    expect(snap.costUsd).toBeUndefined();
    expect("costUsd" in snap).toBe(false);
  });

  it("record() with usage and no model at all accumulates tokens and omits costUsd", () => {
    const meter = new TurnUsageMeter();
    meter.begin(S);
    meter.record({ sessionId: S, usage: usage(10, 20) });
    const snap = meter.snapshot(S);
    expect(snap.promptTokens).toBe(10);
    expect(snap.completionTokens).toBe(20);
    expect("costUsd" in snap).toBe(false);
  });

  it("multiple record() calls within one turn sum prompt and completion tokens", () => {
    const meter = new TurnUsageMeter();
    meter.begin(S);
    meter.record({ sessionId: S, usage: usage(100, 50) });
    meter.record({ sessionId: S, usage: usage(30, 10) });
    meter.record({ sessionId: S, usage: usage(5, 5) });
    const snap = meter.snapshot(S);
    expect(snap.promptTokens).toBe(135);
    expect(snap.completionTokens).toBe(65);
  });

  it("record() with pricing computes costUsd from prompt/completion tokens", () => {
    const meter = new TurnUsageMeter();
    meter.begin(S);
    meter.record({
      sessionId: S,
      usage: usage(1_000_000, 1_000_000),
      model: pricedModel(3, 15),
    });
    const snap = meter.snapshot(S);
    expect(snap.promptTokens).toBe(1_000_000);
    expect(snap.completionTokens).toBe(1_000_000);
    expect(snap.costUsd).toBeCloseTo(18, 10);
  });

  it("mixed turn: tokens sum across priced and unpriced calls, cost counts only the priced one", () => {
    const meter = new TurnUsageMeter();
    meter.begin(S);
    meter.record({ sessionId: S, usage: usage(1_000_000, 1_000_000), model: pricedModel(3, 15) });
    meter.record({ sessionId: S, usage: usage(200, 100), model: unpricedModel() });
    const snap = meter.snapshot(S);
    expect(snap.promptTokens).toBe(1_000_200);
    expect(snap.completionTokens).toBe(1_000_100);
    expect(snap.costUsd).toBeCloseTo(18, 10);
  });

  it("snapshot() closes the turn — calling it twice returns {} the second time", () => {
    const meter = new TurnUsageMeter();
    meter.begin(S);
    meter.record({ sessionId: S, usage: usage(100, 50) });
    const first = meter.snapshot(S);
    expect(first.promptTokens).toBe(100);
    const second = meter.snapshot(S);
    expect(second).toEqual({});
  });

  it("begin() discards a previous half-finished bucket", () => {
    const meter = new TurnUsageMeter();
    meter.begin(S);
    meter.record({ sessionId: S, usage: usage(999, 999) });
    meter.begin(S);
    const snap = meter.snapshot(S);
    expect(snap).toEqual({});
  });

  describe("session keying", () => {
    it("two sessions accumulate independently — neither leaks into the other", () => {
      const meter = new TurnUsageMeter();
      meter.begin("a");
      meter.begin("b");
      meter.record({ sessionId: "a", usage: usage(100, 200) });
      meter.record({ sessionId: "b", usage: usage(7, 9) });

      const snapA = meter.snapshot("a");
      expect(snapA.promptTokens).toBe(100);
      expect(snapA.completionTokens).toBe(200);

      const snapB = meter.snapshot("b");
      expect(snapB.promptTokens).toBe(7);
      expect(snapB.completionTokens).toBe(9);
    });

    it("snapshot() for one session does not close another session's open turn", () => {
      const meter = new TurnUsageMeter();
      meter.begin("a");
      meter.begin("b");
      meter.record({ sessionId: "a", usage: usage(100, 200) });
      meter.record({ sessionId: "b", usage: usage(7, 9) });

      meter.snapshot("a");

      const snapB = meter.snapshot("b");
      expect(snapB.promptTokens).toBe(7);
      expect(snapB.completionTokens).toBe(9);
    });

    it("record() for a session with no open turn is dropped even while a different session has one open", () => {
      const meter = new TurnUsageMeter();
      meter.begin("a");
      meter.record({ sessionId: "b", usage: usage(50, 50) });

      const snapA = meter.snapshot("a");
      expect(snapA).toEqual({});

      const snapB = meter.snapshot("b");
      expect(snapB).toEqual({});
    });

    it("begin() on one session does not disturb another session's already-open bucket", () => {
      const meter = new TurnUsageMeter();
      meter.begin("a");
      meter.record({ sessionId: "a", usage: usage(11, 22) });

      meter.begin("b");
      meter.record({ sessionId: "b", usage: usage(3, 4) });

      const snapA = meter.snapshot("a");
      expect(snapA.promptTokens).toBe(11);
      expect(snapA.completionTokens).toBe(22);

      const snapB = meter.snapshot("b");
      expect(snapB.promptTokens).toBe(3);
      expect(snapB.completionTokens).toBe(4);
    });
  });
});
