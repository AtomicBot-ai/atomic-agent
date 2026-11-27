/**
 * ATO-2333: live meeting recording, the pure half of the chunking.
 *
 * The renderer sends the microphone as 100 ms frames of 16 kHz mono s16le
 * (renderer/voice-worklet.js, the same tap voice input uses), each with its
 * peak. Main appends every frame to `chunk-NNNN.pcm` on disk at once, so a
 * crash or a power cut loses at most the frame in flight. A chunk is closed
 * (sealed into a WAV and handed to the transcriber) at the first quiet
 * moment after MIN_CHUNK_SECONDS, and at MAX_CHUNK_SECONDS whatever is
 * being said, so the live transcript never trails by more than that.
 *
 * Recovery: what a meeting folder holds after a crash says what is left to
 * do. `.pcm` is a chunk still being written (sealed on recovery), `.wav` is
 * a sealed chunk not yet transcribed, `.json` is a transcribed chunk (its
 * audio is deleted as soon as the JSON is written).
 *
 * Nothing here touches electron or the disk; test/meeting-plan.test.mjs
 * loads it from the build.
 */

/** 16 kHz, 16-bit, mono. */
export const MEETING_BYTES_PER_SECOND = 32_000;
/** The worklet's frame: 1600 samples. Main refuses anything bigger than a few of these. */
export const MEETING_MAX_FRAME_BYTES = 65_536;
export const MIN_CHUNK_SECONDS = 20;
export const MAX_CHUNK_SECONDS = 40;
/** A frame whose peak is under this is "quiet" (about -34 dBFS). */
export const QUIET_PEAK = 0.02;
/** Half a second of quiet frames in a row is a pause worth cutting at. */
export const QUIET_FRAMES_TO_CUT = 5;
/** The RIFF header pcmToWav writes in front of the samples. */
export const WAV_HEADER_BYTES = 44;

/**
 * Decides, frame by frame, where one chunk ends. `push` answers true when
 * the chunk should be closed right after this frame; the caller seals it
 * and the planner starts counting the next one.
 */
export class ChunkPlanner {
  private bytes = 0;
  private quietRun = 0;

  constructor(
    private readonly minBytes = MIN_CHUNK_SECONDS * MEETING_BYTES_PER_SECOND,
    private readonly maxBytes = MAX_CHUNK_SECONDS * MEETING_BYTES_PER_SECOND,
  ) {}

  push(frameBytes: number, peak: number): boolean {
    const n = Number.isFinite(frameBytes) && frameBytes > 0 ? frameBytes : 0;
    this.bytes += n;
    const p = Number.isFinite(peak) ? Math.abs(peak) : 1;
    this.quietRun = p < QUIET_PEAK ? this.quietRun + 1 : 0;
    const cut = this.bytes >= this.maxBytes || (this.bytes >= this.minBytes && this.quietRun >= QUIET_FRAMES_TO_CUT);
    if (cut) this.reset();
    return cut;
  }

  /** Bytes in the chunk being written now (0 right after a cut). */
  pending(): number {
    return this.bytes;
  }

  reset(): void {
    this.bytes = 0;
    this.quietRun = 0;
  }
}

/** `3` → `chunk-0003`. */
export function chunkBase(index: number): string {
  const i = Number.isInteger(index) && index >= 0 ? index : 0;
  return `chunk-${String(i).padStart(4, "0")}`;
}

/** `chunk-0003.wav` → `{index: 3, ext: "wav"}`; anything else → null. */
export function parseChunkName(name: string): { index: number; ext: "pcm" | "wav" | "json" } | null {
  const m = /^chunk-(\d{4,})\.(pcm|wav|json)$/.exec(String(name || ""));
  if (!m) return null;
  return { index: Number(m[1]), ext: m[2] as "pcm" | "wav" | "json" };
}

export interface RecoveryPlan {
  /** Chunks cut short by a crash: seal these into WAVs first. */
  seal: number[];
  /** Sealed but not transcribed. */
  transcribe: number[];
  /** Transcribed already. */
  done: number[];
  /** `.pcm` files whose WAV was written (the crash came between the two): delete. */
  stale: number[];
  /** The next free chunk index. */
  next: number;
}

/**
 * What is left to do in a meeting folder, from its file names alone. A
 * chunk counts once, at its most advanced state: json over wav over pcm.
 */
export function planRecovery(names: readonly string[]): RecoveryPlan {
  const by = new Map<number, Set<string>>();
  for (const n of names) {
    const c = parseChunkName(n);
    if (!c) continue;
    const s = by.get(c.index) ?? new Set<string>();
    s.add(c.ext);
    by.set(c.index, s);
  }
  const plan: RecoveryPlan = { seal: [], transcribe: [], done: [], stale: [], next: 0 };
  for (const index of [...by.keys()].sort((a, b) => a - b)) {
    const s = by.get(index)!;
    if (s.has("json")) plan.done.push(index);
    else if (s.has("wav")) plan.transcribe.push(index);
    else plan.seal.push(index);
    if (s.has("pcm") && (s.has("wav") || s.has("json"))) plan.stale.push(index);
    plan.next = Math.max(plan.next, index + 1);
  }
  return plan;
}

/** Seconds of audio in a WAV of this size on disk. */
export function wavSeconds(fileBytes: number): number {
  return pcmSeconds(fileBytes - WAV_HEADER_BYTES);
}

/** Seconds of audio in this many raw s16le bytes. */
export function pcmSeconds(bytes: number): number {
  return Number.isFinite(bytes) && bytes > 0 ? bytes / MEETING_BYTES_PER_SECOND : 0;
}

/** Each chunk's start in the meeting: the sum of the durations before it. */
export function chunkOffsets(durations: readonly number[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const d of durations) {
    out.push(at);
    at += Number.isFinite(d) && d > 0 ? d : 0;
  }
  return out;
}

/**
 * A frame the renderer sent, checked: a Uint8Array of whole samples, not
 * empty and not huge. Anything else is dropped (null).
 */
export function checkFrame(chunk: unknown): Uint8Array | null {
  if (!(chunk instanceof Uint8Array)) return null;
  if (chunk.byteLength === 0 || chunk.byteLength > MEETING_MAX_FRAME_BYTES || chunk.byteLength % 2 !== 0) return null;
  return chunk;
}

/**
 * ATO-2514: the 44-byte RIFF header of a 16 kHz mono s16le WAV holding
 * `dataBytes` of samples. The whole-channel recording the diarizer reads is
 * written header first and appended to; its sizes are set at Make notes.
 */
export function wavHeader(dataBytes: number): Buffer {
  const n = Number.isFinite(dataBytes) && dataBytes > 0 ? Math.floor(dataBytes) : 0;
  const h = Buffer.alloc(WAV_HEADER_BYTES);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(Math.min(36 + n, 0xffffffff), 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16_000, 24);
  h.writeUInt32LE(MEETING_BYTES_PER_SECOND, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(Math.min(n, 0xffffffff), 40);
  return h;
}
