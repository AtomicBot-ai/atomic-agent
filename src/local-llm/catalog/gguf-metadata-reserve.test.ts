import { describe, expect, it } from "vitest";

import {
  parseGgufHeader,
  recurrentStateBytesPerSequence,
  vocabSizeFromMetadata,
} from "./gguf-metadata.js";
import {
  densePairs,
  encodeSyntheticGguf,
  gemma4Pairs,
  qwen35Pairs,
} from "./gguf-metadata.fixtures.js";

const parse = (pairs: Parameters<typeof encodeSyntheticGguf>[0]) =>
  parseGgufHeader(encodeSyntheticGguf(pairs));

describe("vocabSizeFromMetadata (ATO-333)", () => {
  it("reads the stated vocab_size first", () => {
    expect(vocabSizeFromMetadata(parse({ ...densePairs(), "llama.vocab_size": 128_256 }))).toBe(128_256);
  });

  it("counts the tokenizer's tokens when the array is too long to keep", () => {
    const tokens = Array.from({ length: 5_000 }, (_, i) => `t${i}`);
    const meta = parse({ ...qwen35Pairs(), "tokenizer.ggml.tokens": tokens });
    expect(meta.keys["tokenizer.ggml.tokens"]).toBeUndefined();
    expect(meta.arrayLengths?.["tokenizer.ggml.tokens"]).toBe(5_000);
    expect(vocabSizeFromMetadata(meta)).toBe(5_000);
  });

  it("knows the count even when the byte budget runs out inside the array", () => {
    const tokens = Array.from({ length: 5_000 }, (_, i) => `token-${i}`);
    const buf = encodeSyntheticGguf({ ...qwen35Pairs(), "tokenizer.ggml.tokens": tokens });
    const meta = parseGgufHeader(buf.subarray(0, buf.length - 1_000));
    expect(meta.truncated).toBe(true);
    expect(vocabSizeFromMetadata(meta)).toBe(5_000);
  });

  it("is null when the header says neither", () => {
    expect(vocabSizeFromMetadata(parse(gemma4Pairs()))).toBeNull();
  });
});

describe("recurrentStateBytesPerSequence (ATO-333)", () => {
  it("costs a gated delta-net hybrid's conv and recurrent state over its recurrent layers", () => {
    const meta = parse({
      ...qwen35Pairs(),
      "qwen35.ssm.inner_size": 4096,
      "qwen35.ssm.group_count": 16,
    });
    // 24 of 32 layers are recurrent (every fourth attends):
    // 3 × (4096 + 2 × 16 × 128) conv values + 128 × 4096 state values, f32.
    expect(recurrentStateBytesPerSequence(meta)).toBe(24 * (3 * (4096 + 2 * 16 * 128) + 128 * 4096) * 4);
  });

  it("costs RWKV's token shift and state from wkv.head_size", () => {
    const meta = parse({
      "general.architecture": "rwkv6",
      "rwkv6.block_count": 24,
      "rwkv6.embedding_length": 2048,
      "rwkv6.wkv.head_size": 64,
    });
    expect(recurrentStateBytesPerSequence(meta)).toBe(24 * (2 * 2048 + 2048 * 64) * 4);
  });

  it("is zero for a model with no recurrent layers, or whose header lacks the dimensions", () => {
    expect(recurrentStateBytesPerSequence(parse(densePairs()))).toBe(0);
    expect(recurrentStateBytesPerSequence(parse(gemma4Pairs()))).toBe(0);
    // The fixture's Qwen 3.5 header has ssm keys but no inner size.
    expect(recurrentStateBytesPerSequence(parse(qwen35Pairs()))).toBe(0);
  });
});
