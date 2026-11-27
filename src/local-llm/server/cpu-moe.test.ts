import { describe, expect, it } from "vitest";
import type { GgufMetadata } from "../catalog/gguf-metadata.js";
import { buildLlamaServerArgs, type DaemonStartOptions } from "./daemon-lifecycle.js";
import {
  CPU_MOE_MARGIN_BYTES,
  cpuMoeRetryOptions,
  decideCpuMoeLayers,
  moeShapeFromMetadata,
  type MoeShape,
} from "./cpu-moe.js";

const GIB = 1024 ** 3;

function header(arch: string, keys: Record<string, number>, blockCount: number, d: number): GgufMetadata {
  const prefixed: Record<string, number> = {};
  for (const [k, v] of Object.entries(keys)) prefixed[`${arch}.${k}`] = v;
  return {
    version: 3,
    tensorCount: 0,
    architecture: arch,
    contextLength: 262_144,
    blockCount,
    embeddingLength: d,
    headCount: 32,
    headCountKv: 4,
    keyLength: 128,
    valueLength: 128,
    keyLengthSwa: null,
    valueLengthSwa: null,
    slidingWindow: null,
    slidingWindowPattern: null,
    fullAttentionInterval: null,
    recurrentLayerPattern: null,
    hasRecurrentState: false,
    keys: prefixed,
    arrayLengths: { "tokenizer.ggml.tokens": 151_936 },
    truncated: false,
  };
}

/** Qwen3-30B-A3B's published shape; its Q4_K_M file is ~18.6 GB. */
const QWEN3_30B_A3B = header("qwen3moe", { expert_count: 128, expert_used_count: 8, expert_feed_forward_length: 768 }, 48, 2048);
const QWEN3_30B_BYTES = 18.6e9;
const DENSE = header("qwen3", { feed_forward_length: 12_288 }, 36, 4096);

describe("moeShapeFromMetadata", () => {
  it("is null for a dense model", () => {
    expect(moeShapeFromMetadata(DENSE, 8e9)).toBeNull();
  });

  it("puts almost all of a 30B-A3B file in its experts, ~0.36 GiB a layer", () => {
    const shape = moeShapeFromMetadata(QWEN3_30B_A3B, QWEN3_30B_BYTES)!;
    expect(shape.blockCount).toBe(48);
    expect(shape.leadingDenseLayers).toBe(0);
    expect(shape.expertBytesPerLayer * 48).toBeGreaterThan(0.9 * QWEN3_30B_BYTES);
    expect(shape.expertBytesPerLayer * 48).toBeLessThan(QWEN3_30B_BYTES);
    expect(shape.expertBytesPerLayer / GIB).toBeGreaterThan(0.3);
    expect(shape.expertBytesPerLayer / GIB).toBeLessThan(0.42);
  });

  it("counts the leading dense layers of a DeepSeek-style model", () => {
    const meta = header("deepseek2", { expert_count: 64, expert_feed_forward_length: 1408, leading_dense_block_count: 1, feed_forward_length: 10_944 }, 27, 2048);
    expect(moeShapeFromMetadata(meta, 10e9)!.leadingDenseLayers).toBe(1);
  });
});

const SHAPE: MoeShape = { blockCount: 48, leadingDenseLayers: 0, expertCount: 128, expertBytesPerLayer: 1 * GIB };
const base = {
  preference: "auto" as const,
  shape: SHAPE,
  device: "CUDA0",
  sharesSystemMemory: false,
  kvBytes: 1 * GIB,
};

describe("decideCpuMoeLayers", () => {
  it("adds nothing when the model and its cache fit the GPU", () => {
    const d = decideCpuMoeLayers({ ...base, deviceBudgetBytes: 2 * GIB });
    expect(d.layers).toBe(0);
    expect(d.reason).toMatch(/fits the GPU/);
  });

  it("moves the fewest layers that cover the shortfall, cache and margin", () => {
    // Weights overflow by 10 GiB; +1 GiB cache +0.5 GiB margin = 11.5 GiB → 12 layers of 1 GiB.
    const d = decideCpuMoeLayers({ ...base, deviceBudgetBytes: -10 * GIB });
    expect(d.layers).toBe(Math.ceil((11 * GIB + CPU_MOE_MARGIN_BYTES) / GIB));
    expect(d.layers).toBe(12);
    expect(d.reason).toMatch(/first 12\/48 layers/);
  });

  it("never asks for more layers than the model has, and counts dense layers first", () => {
    expect(decideCpuMoeLayers({ ...base, deviceBudgetBytes: -500 * GIB }).layers).toBe(48);
    const dense = decideCpuMoeLayers({ ...base, shape: { ...SHAPE, leadingDenseLayers: 3 }, deviceBudgetBytes: -10 * GIB });
    expect(dense.layers).toBe(15);
  });

  it("stays off for a dense model, CPU-only, unified memory and an unknown budget", () => {
    expect(decideCpuMoeLayers({ ...base, shape: null, deviceBudgetBytes: -10 * GIB }).layers).toBe(0);
    expect(decideCpuMoeLayers({ ...base, device: "cpu", deviceBudgetBytes: -10 * GIB }).layers).toBe(0);
    expect(decideCpuMoeLayers({ ...base, sharesSystemMemory: true, deviceBudgetBytes: -10 * GIB }).layers).toBe(0);
    expect(decideCpuMoeLayers({ ...base, deviceBudgetBytes: null }).layers).toBe(0);
  });

  it("honours off and a pinned count", () => {
    expect(decideCpuMoeLayers({ ...base, preference: "off", deviceBudgetBytes: -10 * GIB }).layers).toBe(0);
    expect(decideCpuMoeLayers({ ...base, preference: 20, deviceBudgetBytes: 100 * GIB }).layers).toBe(20);
    expect(decideCpuMoeLayers({ ...base, preference: 99, deviceBudgetBytes: null }).layers).toBe(48);
  });
});

describe("buildLlamaServerArgs --n-cpu-moe", () => {
  const opts: DaemonStartOptions = { dataDir: "/tmp/data", modelId: "qwen-3.5-4b", port: 19091 };
  const build = (o: DaemonStartOptions) => buildLlamaServerArgs(o, "/m.gguf", "qwen-3.5-4b");

  it("appends the resolved layer count", () => {
    const args = build({ ...opts, device: "CUDA0", cpuMoeLayers: 12 });
    expect(args[args.indexOf("--n-cpu-moe") + 1]).toBe("12");
  });

  it("leaves the launch byte-identical with no layers and on CPU-only", () => {
    expect(build({ ...opts, cpuMoeLayers: 0 })).toEqual(build(opts));
    expect(build({ ...opts, device: "cpu", cpuMoeLayers: 12 })).not.toContain("--n-cpu-moe");
  });
});

describe("cpuMoeRetryOptions (one retry without the flag)", () => {
  const boom = new Error("llama-server exited: failed to allocate CUDA0 buffer");

  it("retries an auto-chosen flag once, with cpuMoe off", () => {
    expect(cpuMoeRetryOptions({ port: 1 }, 12, boom)).toEqual({ port: 1, cpuMoe: "off" });
    expect(cpuMoeRetryOptions({ cpuMoe: "auto" as const }, 12, boom)).toEqual({ cpuMoe: "off" });
  });

  it("does not retry without a flag, a pinned count, off, or a cancelled start", () => {
    expect(cpuMoeRetryOptions({}, 0, boom)).toBeNull();
    expect(cpuMoeRetryOptions({ cpuMoe: 20 }, 20, boom)).toBeNull();
    expect(cpuMoeRetryOptions({ cpuMoe: "off" as const }, 12, boom)).toBeNull();
    const ac = new AbortController();
    ac.abort();
    expect(cpuMoeRetryOptions({ signal: ac.signal }, 12, boom)).toBeNull();
    expect(cpuMoeRetryOptions({}, 12, Object.assign(new Error("x"), { name: "AbortError" }))).toBeNull();
  });

  it("cannot loop: the retry it returns never retries again", () => {
    const retry = cpuMoeRetryOptions({}, 12, boom)!;
    expect(cpuMoeRetryOptions(retry, 12, boom)).toBeNull();
  });
});
