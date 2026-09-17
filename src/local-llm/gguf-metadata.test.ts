import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildKvLayout, estimateKvBytesPerToken } from "./context-size.js";
import {
  classifyPrefixReuse,
  countSlidingWindowLayers,
  GgufFormatError,
  isHybridArchitecture,
  kvLayoutSourceFromMetadata,
  parseGgufHeader,
  readGgufMetadata,
  readGgufMetadataSync,
  readModelPrefixReuse,
  resetPrefixReuseCache,
} from "./gguf-metadata.js";
import {
  densePairs,
  encodeSyntheticGguf,
  gemma4Pairs,
  qwen35Pairs,
} from "./gguf-metadata.fixtures.js";

describe("parseGgufHeader", () => {
  it("reads Gemma 4's attention layout, per-layer arrays and boolean pattern included", () => {
    const meta = parseGgufHeader(encodeSyntheticGguf(gemma4Pairs()));
    expect(meta.version).toBe(3);
    expect(meta.architecture).toBe("gemma4");
    expect(meta.contextLength).toBe(262_144);
    expect(meta.blockCount).toBe(60);
    expect(meta.headCount).toBe(32);
    expect(Array.isArray(meta.headCountKv)).toBe(true);
    expect((meta.headCountKv as number[]).slice(0, 6)).toEqual([16, 16, 16, 16, 16, 4]);
    expect(meta.keyLength).toBe(512);
    expect(meta.keyLengthSwa).toBe(256);
    expect(meta.valueLengthSwa).toBe(256);
    expect(meta.slidingWindow).toBe(1024);
    expect(meta.slidingWindowPattern?.length).toBe(60);
    expect(meta.slidingWindowPattern?.filter(Boolean)).toHaveLength(50);
    expect(meta.fullAttentionInterval).toBeNull();
    expect(meta.hasRecurrentState).toBe(false);
    expect(meta.truncated).toBe(false);
    expect(meta.keys["general.name"]).toBe("Gemma-4 31B IT");
  });

  it("reads every scalar type and keeps small arrays", () => {
    const meta = parseGgufHeader(
      encodeSyntheticGguf({
        "general.architecture": "x",
        "x.block_count": { u64: 7 },
        "x.rope.freq_base": 1.5,
        "x.flag": true,
        "x.names": ["a", "b"],
        "x.attention.head_count_kv": [2, 2, 2, 2, 2, 2, 2],
      }),
    );
    expect(meta.blockCount).toBe(7);
    expect(meta.keys["x.rope.freq_base"]).toBeCloseTo(1.5, 6);
    expect(meta.keys["x.flag"]).toBe(true);
    expect(meta.keys["x.names"]).toEqual(["a", "b"]);
    expect(meta.headCountKv).toEqual([2, 2, 2, 2, 2, 2, 2]);
  });

  it("skips arrays past maxArrayElements without keeping them", () => {
    const tokens = Array.from({ length: 50 }, (_, i) => `tok${i}`);
    const meta = parseGgufHeader(
      encodeSyntheticGguf({
        "general.architecture": "llama",
        "tokenizer.ggml.tokens": tokens,
        "llama.block_count": 4,
      }),
      { maxArrayElements: 10 },
    );
    expect(meta.keys["tokenizer.ggml.tokens"]).toBeUndefined();
    // Keys after the skipped array are still read.
    expect(meta.blockCount).toBe(4);
  });

  it("reports a header cut off by the byte budget as truncated, keeping what it read", () => {
    const full = encodeSyntheticGguf({
      "general.architecture": "llama",
      "llama.block_count": 4,
      "tokenizer.ggml.tokens": Array.from({ length: 2000 }, (_, i) => `t${i}`),
      "llama.context_length": 8192,
    });
    const meta = parseGgufHeader(full.subarray(0, 200));
    expect(meta.truncated).toBe(true);
    expect(meta.architecture).toBe("llama");
    expect(meta.blockCount).toBe(4);
    expect(meta.contextLength).toBeNull();
  });

  it("turns a Gemma 3 style numeric pattern into per-layer flags", () => {
    const meta = parseGgufHeader(
      encodeSyntheticGguf({
        "general.architecture": "gemma3",
        "gemma3.block_count": 12,
        "gemma3.attention.sliding_window": 512,
        "gemma3.attention.sliding_window_pattern": 6,
      }),
    );
    expect(meta.slidingWindowPattern).toEqual([
      true, true, true, true, true, false,
      true, true, true, true, true, false,
    ]);
    expect(countSlidingWindowLayers(meta)).toBe(10);
  });

  it("reads a window without a pattern as every layer sliding", () => {
    const meta = parseGgufHeader(
      encodeSyntheticGguf({
        "general.architecture": "mistral",
        "mistral.block_count": 3,
        "mistral.attention.sliding_window": 4096,
      }),
    );
    expect(meta.slidingWindowPattern).toEqual([true, true, true]);
  });

  it("rejects a file that is not GGUF and a version it does not know", () => {
    expect(() =>
      parseGgufHeader(encodeSyntheticGguf({}, { magic: 0x12345678 })),
    ).toThrow(GgufFormatError);
    expect(() => parseGgufHeader(encodeSyntheticGguf({}, { version: 1 }))).toThrow(
      /version/,
    );
    expect(() => parseGgufHeader(Buffer.from("GG"))).toThrow(/too short/);
  });
});

describe("classifyPrefixReuse", () => {
  it("is none for a sliding-window model and says which layers", () => {
    const verdict = classifyPrefixReuse(parseGgufHeader(encodeSyntheticGguf(gemma4Pairs())));
    expect(verdict.prefixReuse).toBe("none");
    expect(verdict.slidingWindowLayers).toBe(50);
    expect(verdict.hybrid).toBe(false);
    expect(verdict.reasons).toEqual(["50 of 60 layers use a sliding window of 1024"]);
  });

  it("is none for a hybrid, by architecture, by ssm keys and by interval", () => {
    const qwen = parseGgufHeader(encodeSyntheticGguf(qwen35Pairs()));
    expect(isHybridArchitecture(qwen)).toBe(true);
    expect(qwen.hasRecurrentState).toBe(true);
    expect(classifyPrefixReuse(qwen)).toMatchObject({
      prefixReuse: "none",
      hybrid: true,
      slidingWindowLayers: 0,
    });
    const byName = parseGgufHeader(
      encodeSyntheticGguf({ "general.architecture": "nemotron_h", "nemotron_h.block_count": 2 }),
    );
    expect(isHybridArchitecture(byName)).toBe(true);
    const byKeys = parseGgufHeader(
      encodeSyntheticGguf({
        "general.architecture": "newarch",
        "newarch.block_count": 2,
        "newarch.ssm.state_size": 16,
      }),
    );
    expect(isHybridArchitecture(byKeys)).toBe(true);
    const byInterval = parseGgufHeader(
      encodeSyntheticGguf({
        "general.architecture": "other",
        "other.block_count": 8,
        "other.full_attention_interval": 4,
      }),
    );
    expect(isHybridArchitecture(byInterval)).toBe(true);
  });

  it("is partial for a dense model", () => {
    const verdict = classifyPrefixReuse(parseGgufHeader(encodeSyntheticGguf(densePairs())));
    expect(verdict).toEqual({
      prefixReuse: "partial",
      reasons: [],
      slidingWindowLayers: 0,
      hybrid: false,
    });
  });
});

describe("kvLayoutSourceFromMetadata", () => {
  it("hands the context sizer Gemma 4's shape, and it costs what the measurement says", () => {
    const source = kvLayoutSourceFromMetadata(
      parseGgufHeader(encodeSyntheticGguf(gemma4Pairs())),
    );
    expect(source).not.toBeNull();
    const perToken = estimateKvBytesPerToken(buildKvLayout(source!), "turbo3", 131_072);
    const measured = (1_342 * 1024 * 1024) / 98_304;
    expect(perToken).toBeGreaterThan(measured / 2);
    expect(perToken).toBeLessThan(measured * 2);
  });

  it("infers head dims from embedding / heads when the header omits them", () => {
    const source = kvLayoutSourceFromMetadata(
      parseGgufHeader(encodeSyntheticGguf(densePairs())),
    );
    expect(source).toMatchObject({
      blockCount: 32,
      headCountKv: 8,
      keyLength: 128,
      valueLength: 128,
    });
  });

  it("marks the hybrid's recurrent layers through the interval", () => {
    const source = kvLayoutSourceFromMetadata(
      parseGgufHeader(encodeSyntheticGguf(qwen35Pairs())),
    );
    const layout = buildKvLayout(source!);
    expect(layout.layers.filter((l) => l.kind === "recurrent")).toHaveLength(24);
  });

  it("is null when the header cannot cost a token", () => {
    expect(
      kvLayoutSourceFromMetadata(
        parseGgufHeader(encodeSyntheticGguf({ "general.architecture": "x", "x.block_count": 2 })),
      ),
    ).toBeNull();
    expect(
      kvLayoutSourceFromMetadata(
        parseGgufHeader(
          encodeSyntheticGguf({
            "general.architecture": "x",
            "x.block_count": 2,
            "x.attention.head_count_kv": 2,
          }),
        ),
      ),
    ).toBeNull();
  });
});

describe("readGgufMetadata / readModelPrefixReuse", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-gguf-"));
    resetPrefixReuseCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a header from disk within the byte budget, weights never loaded", async () => {
    const path = join(dir, "model.gguf");
    // A large "weights" tail the reader must never need.
    writeFileSync(
      path,
      Buffer.concat([encodeSyntheticGguf(gemma4Pairs()), Buffer.alloc(3 * 1024 * 1024, 7)]),
    );
    const meta = await readGgufMetadata(path, { maxBytes: 64 * 1024 });
    expect(meta.architecture).toBe("gemma4");
    expect(meta.truncated).toBe(false);
    // The launch path's synchronous twin reads the same header.
    const sync = readGgufMetadataSync(path, { maxBytes: 64 * 1024 });
    expect(sync).toEqual(meta);
  });

  it("returns a truncated read when the budget ends inside the header", async () => {
    const path = join(dir, "big-header.gguf");
    writeFileSync(
      path,
      encodeSyntheticGguf({
        "general.architecture": "llama",
        "llama.block_count": 4,
        "tokenizer.ggml.tokens": Array.from({ length: 20_000 }, (_, i) => `token-${i}`),
        "llama.context_length": 8192,
      }),
    );
    const meta = await readGgufMetadata(path, { maxBytes: 4096 });
    expect(meta.truncated).toBe(true);
    expect(meta.blockCount).toBe(4);
  });

  it("memoises the verdict per path and answers null for what it cannot read", async () => {
    const path = join(dir, "gemma.gguf");
    writeFileSync(path, encodeSyntheticGguf(gemma4Pairs()));
    const first = await readModelPrefixReuse(path);
    expect(first?.prefixReuse).toBe("none");
    // Rewriting the file does not change the memoised answer.
    writeFileSync(path, encodeSyntheticGguf(densePairs()));
    expect((await readModelPrefixReuse(path))?.prefixReuse).toBe("none");
    resetPrefixReuseCache();
    expect((await readModelPrefixReuse(path))?.prefixReuse).toBe("partial");
    expect(await readModelPrefixReuse(join(dir, "missing.gguf"))).toBeNull();
    const notGguf = join(dir, "notes.txt");
    writeFileSync(notGguf, "hello");
    expect(await readModelPrefixReuse(notGguf)).toBeNull();
  });
});
