/**
 * Test fixture: write a minimal GGUF v3 file — a header with the given
 * KV pairs and no tensors — so the header reader can be exercised on a
 * file the test controls. Types are inferred from the JS values: an
 * integer becomes `UINT32` (or `UINT64` past 2^32), a non-integer
 * `FLOAT32`, a boolean `BOOL`, a string `STRING`, an array an `ARRAY`
 * of its first element's type. Pass `{ u64: n }` to force a 64-bit int.
 */

export type SyntheticGgufValue =
  | number
  | string
  | boolean
  | { u64: number }
  | readonly (number | string | boolean)[];

const T = {
  UINT32: 4,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
} as const;

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

function str(s: string): Buffer {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([u64(bytes.length), bytes]);
}

function scalarType(value: number | string | boolean): number {
  if (typeof value === "string") return T.STRING;
  if (typeof value === "boolean") return T.BOOL;
  if (Number.isInteger(value)) return value > 0xffff_ffff ? T.UINT64 : T.UINT32;
  return T.FLOAT32;
}

function scalar(value: number | string | boolean, type: number): Buffer {
  switch (type) {
    case T.STRING:
      return str(value as string);
    case T.BOOL:
      return Buffer.from([value ? 1 : 0]);
    case T.UINT64:
      return u64(value as number);
    case T.FLOAT32: {
      const b = Buffer.alloc(4);
      b.writeFloatLE(value as number, 0);
      return b;
    }
    default:
      return u32(value as number);
  }
}

export function encodeSyntheticGguf(
  pairs: Record<string, SyntheticGgufValue>,
  options: { version?: number; magic?: number } = {},
): Buffer {
  const parts: Buffer[] = [
    u32(options.magic ?? 0x46554747),
    u32(options.version ?? 3),
    u64(0),
    u64(Object.keys(pairs).length),
  ];
  for (const [key, value] of Object.entries(pairs)) {
    parts.push(str(key));
    if (Array.isArray(value)) {
      const elementType = value.length > 0 ? scalarType(value[0]!) : T.UINT32;
      parts.push(u32(T.ARRAY), u32(elementType), u64(value.length));
      for (const v of value) parts.push(scalar(v, elementType));
      continue;
    }
    if (typeof value === "object" && value !== null && "u64" in value) {
      parts.push(u32(T.UINT64), u64(value.u64));
      continue;
    }
    const type = scalarType(value as number | string | boolean);
    parts.push(u32(type), scalar(value as number | string | boolean, type));
  }
  return Buffer.concat(parts);
}

/** Gemma 4 31B's header, as read from the real file (attention keys only). */
export function gemma4Pairs(
  blockCount = 60,
): Record<string, SyntheticGgufValue> {
  const pattern = Array.from({ length: blockCount }, (_, i) => (i + 1) % 6 !== 0);
  return {
    "general.architecture": "gemma4",
    "general.name": "Gemma-4 31B IT",
    "gemma4.block_count": blockCount,
    "gemma4.context_length": 262_144,
    "gemma4.embedding_length": 5376,
    "gemma4.attention.head_count": 32,
    "gemma4.attention.head_count_kv": pattern.map((slides) => (slides ? 16 : 4)),
    "gemma4.attention.key_length": 512,
    "gemma4.attention.value_length": 512,
    "gemma4.attention.sliding_window": 1024,
    "gemma4.attention.sliding_window_pattern": pattern,
    "gemma4.attention.key_length_swa": 256,
    "gemma4.attention.value_length_swa": 256,
  };
}

/** Qwen 3.5 4B's header: a hybrid with SSM keys and a full-attention interval. */
export function qwen35Pairs(): Record<string, SyntheticGgufValue> {
  return {
    "general.architecture": "qwen35",
    "qwen35.block_count": 32,
    "qwen35.context_length": 262_144,
    "qwen35.embedding_length": 2560,
    "qwen35.attention.head_count": 16,
    "qwen35.attention.head_count_kv": 4,
    "qwen35.attention.key_length": 256,
    "qwen35.attention.value_length": 256,
    "qwen35.ssm.conv_kernel": 4,
    "qwen35.ssm.state_size": 128,
    "qwen35.full_attention_interval": 4,
  };
}

/** A dense Llama-style header: every layer global, dims from embedding / heads. */
export function densePairs(): Record<string, SyntheticGgufValue> {
  return {
    "general.architecture": "llama",
    "llama.block_count": 32,
    "llama.context_length": 131_072,
    "llama.embedding_length": 4096,
    "llama.attention.head_count": 32,
    "llama.attention.head_count_kv": 8,
  };
}
