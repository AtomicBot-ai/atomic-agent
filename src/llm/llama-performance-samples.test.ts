import { describe, expect, it } from "vitest";

import {
  PERFORMANCE_CAPACITY,
  PerformanceRing,
  count,
  generationRate,
  num,
  sampleFromPayload,
  type PerformanceSample,
} from "./llama-performance-samples.js";

/** A real final `/completion` event from llama.cpp b11028, with a neutral path. */
const FINAL_EVENT: Record<string, unknown> = {
  content: "",
  stop: true,
  timings: {
    cache_n: 0,
    prompt_n: 2,
    prompt_ms: 32.969,
    prompt_per_token_ms: 16.4845,
    prompt_per_second: 60.663047104856076,
    predicted_n: 40,
    predicted_ms: 1158.29,
    predicted_per_token_ms: 29.699743589743587,
    predicted_per_second: 33.67032435745798,
    draft_n: 96,
    draft_n_accepted: 13,
  },
  tokens_predicted: 40,
  tokens_evaluated: 2,
  tokens_cached: 41,
  model: "/home/user/models/Qwen3.6-35B-A3B-MXFP4_MOE.gguf",
};

const CONTEXT = { streamed: true, ttftMs: 412, concurrent: 1, at: 1794329429000 };

function withTimings(
  timings: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { stop: true, timings, ...extra };
}

function sample(payload: Record<string, unknown>): PerformanceSample {
  const s = sampleFromPayload(payload, CONTEXT);
  if (s === null) throw new Error("expected a sample");
  return s;
}

describe("sampleFromPayload", () => {
  it("maps llama.cpp's final event exactly", () => {
    expect(sampleFromPayload(FINAL_EVENT, CONTEXT)).toEqual({
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
    });
  });

  it("passes the call's own facts through", () => {
    const s = sampleFromPayload(FINAL_EVENT, {
      streamed: false,
      ttftMs: null,
      concurrent: 3,
      at: 5,
    });
    expect(s).toMatchObject({ streamed: false, ttftMs: null, concurrent: 3, at: 5 });
  });

  it("computes the prompt speed when the server does not state it", () => {
    const s = sample(withTimings({ prompt_n: 100, prompt_ms: 400, cache_n: 8 }));
    expect(s.promptPerSecond).toBe(250);
    expect(s.cacheTokens).toBe(8);
  });

  it("gives a fully cached prompt no speed, whatever prompt_per_second says", () => {
    const s = sample(
      withTimings({ prompt_n: 0, prompt_ms: 1, prompt_per_second: 999, cache_n: 50 }),
    );
    expect(s.promptTokens).toBe(0);
    expect(s.promptPerSecond).toBeNull();
    expect(s.contextTokens).toBe(50);
  });

  it("leaves the prompt and context unknown without prompt_n", () => {
    const s = sample(withTimings({ predicted_n: 4, cache_n: 9, prompt_per_second: 10 }));
    expect(s.promptTokens).toBeNull();
    expect(s.promptPerSecond).toBeNull();
    expect(s.contextTokens).toBeNull();
  });

  it("falls back to tokens_predicted for both the count and the context", () => {
    const s = sample(withTimings({ prompt_n: 3, cache_n: 2 }, { tokens_predicted: 7 }));
    expect(s.predictedTokens).toBe(7);
    expect(s.contextTokens).toBe(12);
  });

  it("never reads top-level tokens_cached into the context", () => {
    const s = sample(withTimings({ prompt_n: 3 }, { tokens_cached: 1000 }));
    expect(s.cacheTokens).toBe(0);
    expect(s.contextTokens).toBe(3);
  });

  it("turns NaN, negative and string values into null", () => {
    const s = sample(
      withTimings({
        prompt_n: Number.NaN,
        cache_n: -4,
        prompt_ms: "32",
        prompt_per_second: "60",
        predicted_n: -1,
        predicted_ms: Number.POSITIVE_INFINITY,
        predicted_per_second: "33",
      }),
    );
    expect(s).toMatchObject({
      promptTokens: null,
      cacheTokens: 0,
      promptMs: null,
      promptPerSecond: null,
      predictedTokens: 0,
      predictedMs: null,
      generationPerSecond: null,
      contextTokens: null,
    });
    expect(
      sample(withTimings({ prompt_n: "5", predicted_n: "2" }, { tokens_predicted: "2" })),
    ).toMatchObject({ promptTokens: null, predictedTokens: 0 });
  });

  it("records nothing without a timings object", () => {
    expect(sampleFromPayload({ stop: true }, CONTEXT)).toBeNull();
    expect(sampleFromPayload({ stop: true, timings: null }, CONTEXT)).toBeNull();
    expect(sampleFromPayload({ stop: true, timings: 5 }, CONTEXT)).toBeNull();
  });

  it("strips a model path to its file name, on either separator", () => {
    expect(sample(withTimings({}, { model: "/a/b/m.gguf" })).modelId).toBe("m.gguf");
    expect(sample(withTimings({}, { model: "C:\\models\\w.gguf" })).modelId).toBe("w.gguf");
    expect(sample(withTimings({}, { model: "bare-alias" })).modelId).toBe("bare-alias");
    expect(sample(withTimings({}, { model: "" })).modelId).toBeNull();
    expect(sample(withTimings({}, { model: 42 })).modelId).toBeNull();
    expect(sample(withTimings({})).modelId).toBeNull();
  });
});

describe("num / count", () => {
  it("accept only finite numbers, and counts only non-negative ones", () => {
    expect(num(1.5)).toBe(1.5);
    expect(num("1.5")).toBeNull();
    expect(num(Number.NaN)).toBeNull();
    expect(count(2.9)).toBe(2);
    expect(count(0)).toBe(0);
    expect(count(-1)).toBeNull();
    expect(count(undefined)).toBeNull();
  });
});

describe("generationRate", () => {
  // The arithmetic `recordThroughput` used before it called this helper,
  // for numeric input: the stated rate when positive, else n / ms.
  function before(t: Record<string, unknown>): number | null {
    const stated = typeof t.predicted_per_second === "number" ? t.predicted_per_second : Number.NaN;
    if (Number.isFinite(stated) && stated > 0) return stated;
    const n = typeof t.predicted_n === "number" && Number.isFinite(t.predicted_n) ? t.predicted_n : 0;
    const ms = typeof t.predicted_ms === "number" && Number.isFinite(t.predicted_ms) ? t.predicted_ms : 0;
    const rate = n > 0 && ms > 0 ? (n / ms) * 1000 : Number.NaN;
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  }

  const cases: Array<[string, Record<string, unknown>, number | null]> = [
    ["stated", { predicted_per_second: 33.67032435745798, predicted_n: 1, predicted_ms: 1 }, 33.67032435745798],
    ["absent: from n and ms", { predicted_n: 100, predicted_ms: 10_000 }, 10],
    ["zero", { predicted_per_second: 0, predicted_n: 0, predicted_ms: 0 }, null],
    ["missing", {}, null],
  ];

  for (const [name, timings, expected] of cases) {
    it(`matches the old arithmetic: ${name}`, () => {
      expect(generationRate(timings)).toBe(expected);
      expect(generationRate(timings)).toBe(before(timings));
    });
  }
});

describe("PerformanceRing", () => {
  function at(n: number): PerformanceSample {
    return { ...sample(FINAL_EVENT), at: n };
  }

  it("keeps the newest 300, oldest first", () => {
    const ring = new PerformanceRing();
    expect(ring.capacity).toBe(PERFORMANCE_CAPACITY);
    expect(PERFORMANCE_CAPACITY).toBe(300);
    for (let i = 1; i <= 305; i += 1) ring.push(at(i));
    const list = ring.list();
    expect(list).toHaveLength(300);
    expect(list[0]?.at).toBe(6);
    expect(list[299]?.at).toBe(305);
  });

  it("hands out a copy", () => {
    const ring = new PerformanceRing(2);
    ring.push(at(1));
    const list = ring.list();
    list.pop();
    list.push(at(99));
    expect(ring.list().map((s) => s.at)).toEqual([1]);
  });
});
