import { closeSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";

import type { KvLayoutSource } from "./context-size.js";

/**
 * A GGUF header reader for the handful of facts a launch needs to know
 * about a model before llama-server has loaded it: its architecture,
 * trained context, layer count, the attention shape the KV cache is
 * sized from, and whether any of its layers keep state llama.cpp cannot
 * roll back — a sliding window or a recurrent (SSM / linear-attention)
 * block. Those are the layers that make a prompt cache reusable only as
 * a whole: a history trim or a prefix change on such a model re-reads
 * the entire prompt (`--swa-full` restores partial reuse for the sliding
 * kind, at full-size KV for those layers).
 *
 * Pure TypeScript over the documented container format (magic `GGUF`,
 * little-endian, v2/v3): the KV section only, never the tensor table or
 * the weights. Bounded: `maxBytes` (default 8 MiB) caps what is read.
 * llama.cpp's converter writes `general.*` and the `<arch>.*`
 * hyper-parameters before the tokenizer, whose token and merge arrays
 * are the bulk of a header (~15 MB on Gemma 4), so the budget is
 * normally spent on exactly the keys wanted; a header that runs past it
 * comes back with `truncated: true` and whatever was read.
 */

export type GgufScalar = number | string | boolean;
export type GgufValue = GgufScalar | GgufScalar[];

export interface GgufMetadata {
  version: number;
  tensorCount: number;
  /** `general.architecture`, e.g. `gemma4`, `qwen35`, `llama`. */
  architecture: string;
  /** `<arch>.context_length` — the trained context. */
  contextLength: number | null;
  /** `<arch>.block_count` — transformer layers. */
  blockCount: number | null;
  embeddingLength: number | null;
  /** `<arch>.attention.head_count`, one figure or one per layer. */
  headCount: number | number[] | null;
  /** `<arch>.attention.head_count_kv`, one figure or one per layer. */
  headCountKv: number | number[] | null;
  /** Head dims; absent on models where `embedding / heads` is meant. */
  keyLength: number | null;
  valueLength: number | null;
  /** Head dims of the sliding layers when they differ (Gemma 4). */
  keyLengthSwa: number | null;
  valueLengthSwa: number | null;
  /** `<arch>.attention.sliding_window`, tokens; `null` when absent. */
  slidingWindow: number | null;
  /**
   * `true` on each layer that slides. A boolean array in the header is
   * taken as is; a number `N` (Gemma 3 style) means every N-th layer is
   * global; a window without a pattern means every layer slides.
   */
  slidingWindowPattern: boolean[] | null;
  /** Hybrids: every N-th layer attends, the rest are recurrent. */
  fullAttentionInterval: number | null;
  /** `true` on each recurrent layer, when the header lists them. */
  recurrentLayerPattern: boolean[] | null;
  /** Any `<arch>.ssm.*` / `wkv` / recurrent key — a hybrid's tell. */
  hasRecurrentState: boolean;
  /** Every scalar and every array of at most `maxArrayElements`, by key. */
  keys: Record<string, GgufValue>;
  /** The byte budget ran out before the last KV pair; `keys` is partial. */
  truncated: boolean;
}

export class GgufFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GgufFormatError";
  }
}

export interface ReadGgufMetadataOptions {
  /** Bytes of the file to read at most. Default 8 MiB. */
  maxBytes?: number;
  /** Arrays longer than this are counted but not kept. Default 4096. */
  maxArrayElements?: number;
}

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ARRAY_ELEMENTS = 4096;

const enum GgufType {
  UINT8 = 0,
  INT8 = 1,
  UINT16 = 2,
  INT16 = 3,
  UINT32 = 4,
  INT32 = 5,
  FLOAT32 = 6,
  BOOL = 7,
  STRING = 8,
  ARRAY = 9,
  UINT64 = 10,
  INT64 = 11,
  FLOAT64 = 12,
}

const FIXED_SIZE: Partial<Record<number, number>> = {
  [GgufType.UINT8]: 1,
  [GgufType.INT8]: 1,
  [GgufType.UINT16]: 2,
  [GgufType.INT16]: 2,
  [GgufType.UINT32]: 4,
  [GgufType.INT32]: 4,
  [GgufType.FLOAT32]: 4,
  [GgufType.BOOL]: 1,
  [GgufType.UINT64]: 8,
  [GgufType.INT64]: 8,
  [GgufType.FLOAT64]: 8,
};

/** Thrown internally when the buffer ends before a value does. */
class OutOfBytes extends Error {}

class Cursor {
  pos = 0;
  constructor(private readonly buf: Buffer) {}

  need(n: number): void {
    if (this.pos + n > this.buf.length) throw new OutOfBytes();
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  u64(): number {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return Number(v);
  }
  scalar(type: number): GgufScalar {
    switch (type) {
      case GgufType.UINT8:
        this.need(1);
        return this.buf[this.pos++]!;
      case GgufType.INT8:
        this.need(1);
        return this.buf.readInt8(this.pos++);
      case GgufType.UINT16: {
        this.need(2);
        const v = this.buf.readUInt16LE(this.pos);
        this.pos += 2;
        return v;
      }
      case GgufType.INT16: {
        this.need(2);
        const v = this.buf.readInt16LE(this.pos);
        this.pos += 2;
        return v;
      }
      case GgufType.UINT32:
        return this.u32();
      case GgufType.INT32: {
        this.need(4);
        const v = this.buf.readInt32LE(this.pos);
        this.pos += 4;
        return v;
      }
      case GgufType.FLOAT32: {
        this.need(4);
        const v = this.buf.readFloatLE(this.pos);
        this.pos += 4;
        return v;
      }
      case GgufType.BOOL:
        this.need(1);
        return this.buf[this.pos++] !== 0;
      case GgufType.STRING: {
        const n = this.u64();
        this.need(n);
        const s = this.buf.toString("utf8", this.pos, this.pos + n);
        this.pos += n;
        return s;
      }
      case GgufType.UINT64:
        return this.u64();
      case GgufType.INT64: {
        this.need(8);
        const v = this.buf.readBigInt64LE(this.pos);
        this.pos += 8;
        return Number(v);
      }
      case GgufType.FLOAT64: {
        this.need(8);
        const v = this.buf.readDoubleLE(this.pos);
        this.pos += 8;
        return v;
      }
      default:
        throw new GgufFormatError(`unknown GGUF value type ${type}`);
    }
  }
  skipScalar(type: number): void {
    const size = FIXED_SIZE[type];
    if (size !== undefined) {
      this.need(size);
      this.pos += size;
      return;
    }
    if (type === GgufType.STRING) {
      const n = this.u64();
      this.need(n);
      this.pos += n;
      return;
    }
    throw new GgufFormatError(`unknown GGUF value type ${type}`);
  }
}

/**
 * Parse the KV section of a GGUF header held in `buf` (which may be a
 * prefix of the file). Pure; the reader below feeds it the bytes.
 */
export function parseGgufHeader(
  buf: Buffer,
  options: ReadGgufMetadataOptions = {},
): GgufMetadata {
  const maxArray = options.maxArrayElements ?? DEFAULT_MAX_ARRAY_ELEMENTS;
  const c = new Cursor(buf);
  let version: number;
  let tensorCount: number;
  let kvCount: number;
  try {
    const magic = c.u32();
    if (magic !== GGUF_MAGIC) {
      throw new GgufFormatError(
        `not a GGUF file (magic 0x${magic.toString(16)})`,
      );
    }
    version = c.u32();
    if (version < 2 || version > 3) {
      throw new GgufFormatError(`unsupported GGUF version ${version}`);
    }
    tensorCount = c.u64();
    kvCount = c.u64();
  } catch (err) {
    if (err instanceof OutOfBytes) {
      throw new GgufFormatError("file too short for a GGUF header");
    }
    throw err;
  }

  const keys: Record<string, GgufValue> = {};
  let truncated = false;
  try {
    for (let i = 0; i < kvCount; i += 1) {
      const key = c.scalar(GgufType.STRING) as string;
      const type = c.u32();
      if (type !== GgufType.ARRAY) {
        keys[key] = c.scalar(type);
        continue;
      }
      const elementType = c.u32();
      const count = c.u64();
      if (elementType === GgufType.ARRAY) {
        throw new GgufFormatError(`nested arrays are not supported (${key})`);
      }
      if (count > maxArray) {
        // Not kept — skip. Fixed-size elements skip in one hop; strings
        // have to be walked, which is where the tokenizer's arrays spend
        // the byte budget.
        const size = FIXED_SIZE[elementType];
        if (size !== undefined) {
          c.need(size * count);
          c.pos += size * count;
        } else {
          for (let j = 0; j < count; j += 1) c.skipScalar(elementType);
        }
        continue;
      }
      const values: GgufScalar[] = [];
      for (let j = 0; j < count; j += 1) values.push(c.scalar(elementType));
      keys[key] = values;
    }
  } catch (err) {
    if (!(err instanceof OutOfBytes)) throw err;
    truncated = true;
  }

  return interpret(keys, { version, tensorCount, truncated });
}

function num(value: GgufValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numOrArray(value: GgufValue | undefined): number | number[] | null {
  if (typeof value === "number") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "number")) {
    return value as number[];
  }
  return null;
}

function boolArray(value: GgufValue | undefined): boolean[] | null {
  if (Array.isArray(value) && value.every((v) => typeof v === "boolean")) {
    return value as boolean[];
  }
  return null;
}

/** Key names llama.cpp uses for hybrid / recurrent state. */
const RECURRENT_KEY_MARKERS = [".ssm.", ".wkv.", ".recurrent", ".rescale_every_n_layers"];

function interpret(
  keys: Record<string, GgufValue>,
  head: { version: number; tensorCount: number; truncated: boolean },
): GgufMetadata {
  const architecture =
    typeof keys["general.architecture"] === "string"
      ? keys["general.architecture"]
      : "";
  const k = (suffix: string): GgufValue | undefined =>
    keys[`${architecture}.${suffix}`];

  const blockCount = num(k("block_count"));
  const slidingWindow = num(k("attention.sliding_window"));
  const rawPattern = k("attention.sliding_window_pattern");
  let slidingWindowPattern: boolean[] | null = boolArray(rawPattern);
  if (
    slidingWindowPattern === null &&
    typeof rawPattern === "number" &&
    rawPattern > 0 &&
    blockCount !== null
  ) {
    // Gemma 3 style: every N-th layer is global, the rest slide.
    slidingWindowPattern = Array.from(
      { length: blockCount },
      (_, i) => (i + 1) % rawPattern !== 0,
    );
  }
  if (
    slidingWindowPattern === null &&
    slidingWindow !== null &&
    slidingWindow > 0 &&
    blockCount !== null
  ) {
    slidingWindowPattern = Array.from({ length: blockCount }, () => true);
  }

  const hasRecurrentState = Object.keys(keys).some(
    (key) =>
      key.startsWith(`${architecture}.`) &&
      RECURRENT_KEY_MARKERS.some((marker) => key.includes(marker)),
  );
  const recurrentPattern =
    boolArray(k("recurrent_layer_arr")) ?? boolArray(k("layer_is_recurrent"));

  return {
    version: head.version,
    tensorCount: head.tensorCount,
    architecture,
    contextLength: num(k("context_length")),
    blockCount,
    embeddingLength: num(k("embedding_length")),
    headCount: numOrArray(k("attention.head_count")),
    headCountKv: numOrArray(k("attention.head_count_kv")),
    keyLength: num(k("attention.key_length")),
    valueLength: num(k("attention.value_length")),
    keyLengthSwa: num(k("attention.key_length_swa")),
    valueLengthSwa: num(k("attention.value_length_swa")),
    slidingWindow,
    slidingWindowPattern,
    fullAttentionInterval: num(k("full_attention_interval")),
    recurrentLayerPattern: recurrentPattern,
    hasRecurrentState,
    keys,
    truncated: head.truncated,
  };
}

/**
 * Read the header of the GGUF at `path`. Reads at most `maxBytes`; never
 * loads weights. Throws `GgufFormatError` for a file that is not GGUF,
 * and whatever the filesystem throws for one that cannot be opened.
 */
export async function readGgufMetadata(
  path: string,
  options: ReadGgufMetadataOptions = {},
): Promise<GgufMetadata> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const handle = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const chunkSize = 1024 * 1024;
    while (total < maxBytes) {
      const want = Math.min(chunkSize, maxBytes - total);
      const chunk = Buffer.alloc(want);
      const { bytesRead } = await handle.read(chunk, 0, want, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      // Parse as soon as a chunk is in: most headers are done in the
      // first megabyte, and a complete parse needs no more bytes.
      const parsed = parseGgufHeader(Buffer.concat(chunks), options);
      if (!parsed.truncated || bytesRead < want) return parsed;
    }
    return parseGgufHeader(Buffer.concat(chunks), options);
  } finally {
    await handle.close();
  }
}

/**
 * `readGgufMetadata` for a caller that must not yield — the managed
 * daemon's launch path, whose health wait is driven by timers a test
 * fakes; a real read in between would let the clock run past the wait
 * before it starts. Same budget, same result.
 */
export function readGgufMetadataSync(
  path: string,
  options: ReadGgufMetadataOptions = {},
): GgufMetadata {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const chunkSize = 1024 * 1024;
    while (total < maxBytes) {
      const want = Math.min(chunkSize, maxBytes - total);
      const chunk = Buffer.alloc(want);
      const bytesRead = readSync(fd, chunk, 0, want, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      const parsed = parseGgufHeader(Buffer.concat(chunks), options);
      if (!parsed.truncated || bytesRead < want) return parsed;
    }
    return parseGgufHeader(Buffer.concat(chunks), options);
  } finally {
    closeSync(fd);
  }
}

/**
 * Architectures llama.cpp implements with recurrent or hybrid blocks —
 * state that cannot be rolled back to an earlier position, so a prompt
 * cache is reusable only as a whole. The `ssm.` / `wkv.` key markers
 * catch new ones the list does not name.
 */
export const HYBRID_ARCHITECTURES: ReadonlySet<string> = new Set([
  "mamba",
  "mamba2",
  "jamba",
  "falcon_h1",
  "nemotron_h",
  "granite_hybrid",
  "granitehybrid",
  "granitemoehybrid",
  "rwkv6",
  "rwkv6qwen2",
  "rwkv7",
  "arwkv7",
  "plamo2",
  "lfm2",
  "lfm2moe",
  "qwen35",
  "qwen35moe",
  "qwen3next",
]);

export function isHybridArchitecture(meta: GgufMetadata): boolean {
  return (
    HYBRID_ARCHITECTURES.has(meta.architecture) ||
    meta.hasRecurrentState ||
    (meta.fullAttentionInterval !== null && meta.fullAttentionInterval > 1) ||
    (meta.recurrentLayerPattern?.some(Boolean) ?? false)
  );
}

export function countSlidingWindowLayers(meta: GgufMetadata): number {
  if (meta.slidingWindow === null || meta.slidingWindow <= 0) return 0;
  return meta.slidingWindowPattern?.filter(Boolean).length ?? meta.blockCount ?? 0;
}

export type PrefixReuse = "partial" | "none";

export interface PrefixReuseVerdict {
  prefixReuse: PrefixReuse;
  /** Why, for the log line. Empty for `partial`. */
  reasons: string[];
  slidingWindowLayers: number;
  hybrid: boolean;
}

/**
 * Whether llama-server can reuse the part of a cached prompt that
 * matches a new one (`partial`) or only an identical prompt (`none`).
 * Sliding-window layers hold only the last `window` tokens and cannot be
 * rolled back; recurrent layers hold one state. Either makes a history
 * trim a full re-read — which the packer plans around by cutting less
 * often and deeper when reuse is `none`.
 */
export function classifyPrefixReuse(meta: GgufMetadata): PrefixReuseVerdict {
  const slidingWindowLayers = countSlidingWindowLayers(meta);
  const hybrid = isHybridArchitecture(meta);
  const reasons: string[] = [];
  if (slidingWindowLayers > 0) {
    reasons.push(
      `${slidingWindowLayers} of ${meta.blockCount ?? "?"} layers use a sliding window of ${meta.slidingWindow}`,
    );
  }
  if (hybrid) {
    reasons.push(`hybrid/recurrent architecture (${meta.architecture})`);
  }
  return {
    prefixReuse: reasons.length > 0 ? "none" : "partial",
    reasons,
    slidingWindowLayers,
    hybrid,
  };
}

/**
 * The attention shape `buildKvLayout` needs, from the header — or `null`
 * when the header does not say enough to cost a token (no layer count,
 * no KV head count, or no way to know the head dims).
 */
export function kvLayoutSourceFromMetadata(
  meta: GgufMetadata,
): KvLayoutSource | null {
  if (meta.blockCount === null || meta.blockCount <= 0) return null;
  if (meta.headCountKv === null) return null;
  const headCount =
    typeof meta.headCount === "number"
      ? meta.headCount
      : (meta.headCount?.[0] ?? null);
  const inferredDim =
    meta.embeddingLength !== null && headCount !== null && headCount > 0
      ? Math.floor(meta.embeddingLength / headCount)
      : null;
  const keyLength = meta.keyLength ?? inferredDim;
  const valueLength = meta.valueLength ?? keyLength;
  if (keyLength === null || valueLength === null) return null;
  return {
    blockCount: meta.blockCount,
    headCountKv: meta.headCountKv,
    keyLength,
    valueLength,
    slidingWindow: meta.slidingWindow,
    slidingWindowPattern: meta.slidingWindowPattern,
    keyLengthSwa: meta.keyLengthSwa,
    valueLengthSwa: meta.valueLengthSwa,
    fullAttentionInterval: meta.fullAttentionInterval,
    recurrentLayerPattern: meta.recurrentLayerPattern,
  };
}

const prefixReuseCache = new Map<string, Promise<PrefixReuseVerdict | null>>();

/**
 * `classifyPrefixReuse` for the model file at `path`, memoised per path
 * for the life of the process (a model file does not change under a
 * running server). `null` when the file cannot be read or is not GGUF —
 * the caller keeps its default.
 */
export function readModelPrefixReuse(
  path: string,
): Promise<PrefixReuseVerdict | null> {
  let pending = prefixReuseCache.get(path);
  if (!pending) {
    pending = readGgufMetadata(path)
      .then((meta) => classifyPrefixReuse(meta))
      .catch(() => null);
    prefixReuseCache.set(path, pending);
  }
  return pending;
}

/** Test seam: forget memoised verdicts. */
export function resetPrefixReuseCache(): void {
  prefixReuseCache.clear();
}
