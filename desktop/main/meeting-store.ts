/**
 * ATO-2333: live meeting recording, the folder on disk.
 *
 *   <userData>/meetings/<id>/meta.json        {id, startedAt, locale}
 *   <userData>/meetings/<id>/chunk-0000.pcm   the chunk being recorded (raw s16le, appended per frame)
 *   <userData>/meetings/<id>/chunk-0000.wav   a sealed chunk waiting for the transcriber
 *   <userData>/meetings/<id>/chunk-0000.json  a transcribed chunk; its audio is gone by then
 *   <userData>/meetings/<id>/them/chunk-*     ATO-2514: the same for the other side of
 *                                             the call (system audio), when it was recorded
 *
 * Audio lives here only until it is transcribed: each chunk's WAV is deleted
 * as soon as its JSON is written, and the whole folder is deleted once the
 * transcript is saved (or the person presses Delete). Writes are synchronous
 * so a crash loses at most the frame in flight; a WAV is written beside and
 * renamed into place, so a half-written one is never read.
 *
 * No electron: test/meeting-store.test.mjs runs it in a temp folder.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chunkBase, pcmSeconds, planRecovery, wavSeconds, type RecoveryPlan } from "./meeting-plan.js";
import type { ChunkTranscript } from "./meeting-transcript.js";
import type { TranscriptSegment } from "./transcribe-file.js";
import { pcmToWav } from "./whisper-dictation.js";

/** ATO-2514: "me" is the microphone, "them" the other side of the call (system audio). */
export type MeetingChannel = "me" | "them";

export interface MeetingMeta {
  id: string;
  startedAt: number;
  locale: string;
  /** ATO-2514: seconds after the start when the other side's first frame came; absent when it never did. */
  themLead?: number;
}

export interface StoredMeeting {
  meta: MeetingMeta;
  plan: RecoveryPlan;
  /** Seconds of audio the folder accounts for (transcribed, sealed and unsealed). */
  seconds: number;
}

const ID = /^m-\d{6,}(-\d+)?$/;

export function isMeetingId(id: unknown): id is string {
  return typeof id === "string" && ID.test(id);
}

export class MeetingStore {
  constructor(private readonly root: () => string) {}

  dir(id: string): string {
    if (!isMeetingId(id)) throw new Error("bad meeting id");
    return join(this.root(), id);
  }

  /** Where a channel's chunks live: the meeting folder for "me", its `them/` for the other side. */
  channelDir(id: string, ch: MeetingChannel = "me"): string {
    return ch === "them" ? join(this.dir(id), "them") : this.dir(id);
  }

  /** A new, empty meeting folder. */
  create(startedAt: number, locale: string): MeetingMeta {
    let id = `m-${Math.floor(startedAt)}`;
    for (let n = 1; existsSync(join(this.root(), id)); n++) id = `m-${Math.floor(startedAt)}-${n}`;
    const meta: MeetingMeta = { id, startedAt, locale };
    mkdirSync(this.dir(id), { recursive: true });
    writeFileSync(join(this.dir(id), "meta.json"), JSON.stringify(meta));
    return meta;
  }

  meta(id: string): MeetingMeta | null {
    try {
      const raw = JSON.parse(readFileSync(join(this.dir(id), "meta.json"), "utf8")) as Partial<MeetingMeta>;
      if (raw.id !== id || typeof raw.startedAt !== "number") return null;
      const meta: MeetingMeta = { id, startedAt: raw.startedAt, locale: typeof raw.locale === "string" ? raw.locale : "" };
      if (typeof raw.themLead === "number" && Number.isFinite(raw.themLead) && raw.themLead >= 0) meta.themLead = raw.themLead;
      return meta;
    } catch {
      return null;
    }
  }

  /** ATO-2514: the meta file rewritten (beside and renamed, like a chunk). */
  writeMeta(meta: MeetingMeta): void {
    const path = join(this.dir(meta.id), "meta.json");
    writeFileSync(`${path}.part`, JSON.stringify(meta));
    renameSync(`${path}.part`, path);
  }

  /** One frame onto the chunk being recorded. */
  appendPcm(id: string, index: number, frame: Uint8Array, ch: MeetingChannel = "me"): void {
    if (ch === "them") mkdirSync(this.channelDir(id, ch), { recursive: true });
    appendFileSync(join(this.channelDir(id, ch), `${chunkBase(index)}.pcm`), frame);
  }

  /**
   * The chunk's raw audio becomes a WAV; the raw file goes. Answers the WAV
   * and its length, or null when there was nothing recorded in it.
   */
  seal(id: string, index: number, ch: MeetingChannel = "me"): { path: string; duration: number } | null {
    const base = join(this.channelDir(id, ch), chunkBase(index));
    let pcm: Buffer;
    try { pcm = readFileSync(`${base}.pcm`); } catch { return null; }
    const even = pcm.byteLength - (pcm.byteLength % 2);
    if (even <= 0) { rmSync(`${base}.pcm`, { force: true }); return null; }
    const wav = pcmToWav([pcm.subarray(0, even)]);
    writeFileSync(`${base}.wav.part`, wav);
    renameSync(`${base}.wav.part`, `${base}.wav`);
    rmSync(`${base}.pcm`, { force: true });
    return { path: `${base}.wav`, duration: pcmSeconds(even) };
  }

  wavPath(id: string, index: number, ch: MeetingChannel = "me"): string {
    return join(this.channelDir(id, ch), `${chunkBase(index)}.wav`);
  }

  /** Seconds in a sealed chunk's WAV (0 when it is not there). */
  wavDuration(id: string, index: number, ch: MeetingChannel = "me"): number {
    try { return wavSeconds(statSync(this.wavPath(id, index, ch)).size); } catch { return 0; }
  }

  /** The chunk is transcribed: its text is kept and its audio deleted. */
  writeTranscript(id: string, index: number, duration: number, segments: TranscriptSegment[], ch: MeetingChannel = "me"): void {
    const base = join(this.channelDir(id, ch), chunkBase(index));
    const body: ChunkTranscript = { index, duration, segments };
    writeFileSync(`${base}.json.part`, JSON.stringify(body));
    renameSync(`${base}.json.part`, `${base}.json`);
    rmSync(`${base}.wav`, { force: true });
  }

  transcripts(id: string, ch: MeetingChannel = "me"): ChunkTranscript[] {
    const out: ChunkTranscript[] = [];
    for (const index of planRecovery(this.names(id, ch)).done) {
      try {
        const raw = JSON.parse(readFileSync(join(this.channelDir(id, ch), `${chunkBase(index)}.json`), "utf8")) as Partial<ChunkTranscript>;
        out.push({
          index,
          duration: typeof raw.duration === "number" ? raw.duration : 0,
          segments: Array.isArray(raw.segments) ? raw.segments.filter(isSegment) : [],
        });
      } catch {
        out.push({ index, duration: 0, segments: [] });
      }
    }
    return out;
  }

  names(id: string, ch: MeetingChannel = "me"): string[] {
    try { return readdirSync(this.channelDir(id, ch)); } catch { return []; }
  }

  /** Raw files left by a crash next to their WAV or JSON: deleted. */
  dropStale(id: string, ch: MeetingChannel = "me"): void {
    for (const index of planRecovery(this.names(id, ch)).stale) rmSync(join(this.channelDir(id, ch), `${chunkBase(index)}.pcm`), { force: true });
  }

  /** Every meeting folder with a readable meta.json, oldest first. */
  list(): StoredMeeting[] {
    let ids: string[];
    try { ids = readdirSync(this.root()).filter(isMeetingId); } catch { return []; }
    const out: StoredMeeting[] = [];
    for (const id of ids) {
      const meta = this.meta(id);
      if (!meta) continue;
      const plan = planRecovery(this.names(id));
      let seconds = 0;
      for (const t of this.transcripts(id)) seconds += t.duration;
      for (const i of plan.transcribe) seconds += this.wavDuration(id, i);
      for (const i of plan.seal) {
        try { seconds += pcmSeconds(statSync(join(this.dir(id), `${chunkBase(i)}.pcm`)).size); } catch { /* gone */ }
      }
      out.push({ meta, plan, seconds });
    }
    return out.sort((a, b) => a.meta.startedAt - b.meta.startedAt);
  }

  /** The meeting's folder and everything in it (audio and text) is deleted. */
  remove(id: string): void {
    rmSync(this.dir(id), { recursive: true, force: true });
  }
}

function isSegment(s: unknown): s is TranscriptSegment {
  const o = s as Partial<TranscriptSegment> | null;
  return !!o && typeof o.start === "number" && typeof o.end === "number" && typeof o.text === "string";
}
