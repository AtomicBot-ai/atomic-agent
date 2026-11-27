/**
 * ATO-2333: live meeting recording, the recorder main owns.
 *
 *   start()        checks the transcriber can run here, opens a meeting folder
 *                  (meeting-store.ts) and arms the microphone gate (`armed`)
 *   audio()        one 100 ms frame from the renderer: onto disk at once,
 *                  and at a pause (meeting-plan.ts ChunkPlanner) the chunk is
 *                  sealed and queued for the transcriber
 *   stop()         the last chunk is sealed; the gate closes at once
 *   finish(id)     waits for the queue, picks up what a crash left (unsealed
 *                  or untranscribed chunks), saves the transcript file into
 *                  `saveDir` and deletes the meeting's audio
 *   discard(id)    deletes the meeting folder, audio and text
 *   recoverable()  meetings left on disk by a crash or a closed window
 *
 * The transcriber is the same TranscribeEngine the composer's "Transcribe"
 * uses (transcribe-file.ts): Apple's on-device speech helper on macOS, the
 * whisper.cpp binary and model voice input found on Windows and Linux. One
 * chunk at a time, in order, so the live transcript reads top to bottom.
 *
 * No electron: test/meeting-recorder.test.mjs drives it with a fake engine.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChunkPlanner, checkFrame, pcmSeconds, planRecovery } from "./meeting-plan.js";
import { isMeetingId, type MeetingMeta, type MeetingStore } from "./meeting-store.js";
import { assembleSegments, meetingDocument, meetingFileName, minutesPrompt, shiftSegments, speakerTurns } from "./meeting-transcript.js";
import type { TranscribeEngine, TranscribeRun, TranscriptSegment } from "./transcribe-file.js";

export type MeetingEvent =
  /** A chunk was heard: its segments, on the meeting's clock. */
  | { type: "segments"; id: string; index: number; segments: TranscriptSegment[] }
  | { type: "chunk-failed"; id: string; index: number; error: string }
  /** The recording ended: the person's Stop, the window closing, the disk. */
  | { type: "stopped"; id: string; reason: string };

export interface MeetingRecorderDeps {
  store: MeetingStore;
  engine: TranscribeEngine;
  /** Where the finished transcript is saved (the person's Meetings folder). */
  saveDir: () => string;
  emit: (ev: MeetingEvent) => void;
  now?: () => number;
}

export interface MeetingFinish {
  ok: boolean;
  error?: string;
  message?: string;
  id?: string;
  /** No speech in the whole meeting: nothing saved, the folder is gone. */
  empty?: boolean;
  path?: string;
  folder?: string;
  fileName?: string;
  document?: string;
  /** The "Make notes" message sent with the transcript attached. */
  prompt?: string;
  turns?: number;
  duration?: number;
  /** Chunks the transcriber refused twice: their audio is kept for another try. */
  failed?: number;
}

interface Recording {
  meta: MeetingMeta;
  index: number;
  planner: ChunkPlanner;
  /** Seconds sealed so far, the next chunk's start. */
  offset: number;
}

export class MeetingRecorder {
  private current: Recording | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private running: { id: string; run: TranscribeRun } | null = null;
  private readonly finishing = new Set<string>();
  private killed = false;

  constructor(private readonly deps: MeetingRecorderDeps) {}

  /** True while a recording is open: the microphone permission gate reads it. */
  get armed(): boolean {
    return this.current !== null;
  }

  status(): { recording: boolean; id?: string; startedAt?: number; seconds?: number } {
    const c = this.current;
    if (!c) return { recording: false };
    return { recording: true, id: c.meta.id, startedAt: c.meta.startedAt, seconds: c.offset + pcmSeconds(c.planner.pending()) };
  }

  async available(): Promise<{ ok: boolean; reason?: string; locale?: string; engine?: string }> {
    try {
      return await this.deps.engine.available();
    } catch {
      return { ok: false, reason: "voice-helper-failed", engine: this.deps.engine.id };
    }
  }

  async start(): Promise<{ ok: boolean; error?: string; message?: string; id?: string; startedAt?: number; locale?: string }> {
    if (this.current) return { ok: false, error: "busy" };
    const av = await this.available();
    if (!av.ok || !av.locale) return { ok: false, error: av.reason ?? "unavailable" };
    if (this.current) return { ok: false, error: "busy" };
    let meta: MeetingMeta;
    try {
      meta = this.deps.store.create((this.deps.now ?? Date.now)(), av.locale);
    } catch (err) {
      return { ok: false, error: "disk", message: err instanceof Error ? err.message : String(err) };
    }
    this.killed = false;
    this.current = { meta, index: 0, planner: new ChunkPlanner(), offset: 0 };
    return { ok: true, id: meta.id, startedAt: meta.startedAt, locale: meta.locale };
  }

  /** One frame from the renderer. Dropped unless a recording is open and the frame is sane. */
  audio(chunk: unknown, peak: unknown): void {
    const cur = this.current;
    if (!cur) return;
    const frame = checkFrame(chunk);
    if (!frame) return;
    try {
      this.deps.store.appendPcm(cur.meta.id, cur.index, frame);
    } catch {
      // The disk refused (full, folder gone): stop rather than pretend to record.
      this.stop("disk");
      return;
    }
    if (cur.planner.push(frame.byteLength, typeof peak === "number" ? peak : 1)) this.cut(cur);
  }

  stop(reason = "user"): { ok: boolean; error?: string; id?: string } {
    const cur = this.current;
    if (!cur) return { ok: false, error: "not-recording" };
    this.current = null;
    this.cut(cur);
    this.deps.emit({ type: "stopped", id: cur.meta.id, reason });
    return { ok: true, id: cur.meta.id };
  }

  /** The chunk being written is sealed and queued; the next frame starts the next one. */
  private cut(cur: Recording): void {
    const index = cur.index;
    cur.index += 1;
    cur.planner.reset();
    let sealed: { path: string; duration: number } | null = null;
    try { sealed = this.deps.store.seal(cur.meta.id, index); } catch { sealed = null; }
    if (!sealed) return;
    const offset = cur.offset;
    const duration = sealed.duration;
    cur.offset += duration;
    const { id, locale } = cur.meta;
    void this.serial(() => this.transcribeChunk(id, index, offset, duration, locale)).catch(() => false);
  }

  /** Runs `fn` after everything queued before it; the queue survives a failure. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** One sealed chunk through the engine; its text kept, its audio deleted. True when it was heard. */
  private async transcribeChunk(id: string, index: number, offset: number, duration: number, locale: string): Promise<boolean> {
    if (this.killed) return false;
    let run: TranscribeRun;
    try {
      run = this.deps.engine.run(this.deps.store.wavPath(id, index), locale, () => {});
    } catch {
      this.deps.emit({ type: "chunk-failed", id, index, error: "spawn" });
      return false;
    }
    this.running = { id, run };
    const res = await run.done.finally(() => { if (this.running?.run === run) this.running = null; });
    if (!res.ok) {
      if (!res.cancelled) this.deps.emit({ type: "chunk-failed", id, index, error: res.error ?? "failed" });
      return false;
    }
    const segments = res.segments ?? [];
    try {
      this.deps.store.writeTranscript(id, index, duration, segments);
    } catch {
      return false;   // the meeting was deleted meanwhile
    }
    this.deps.emit({ type: "segments", id, index, segments: shiftSegments(segments, offset) });
    return true;
  }

  async finish(id: unknown): Promise<MeetingFinish> {
    if (!isMeetingId(id)) return { ok: false, error: "bad-request" };
    if (this.current?.meta.id === id) this.stop("user");
    if (this.finishing.has(id)) return { ok: false, error: "busy" };
    const { store } = this.deps;
    const meta = store.meta(id);
    if (!meta) return { ok: false, error: "missing" };
    this.finishing.add(id);
    try {
      await this.queue;
      // What a crash or a refused chunk left behind.
      store.dropStale(id);
      for (const i of planRecovery(store.names(id)).seal) {
        try { store.seal(id, i); } catch { /* unreadable: left as it is */ }
      }
      let locale = meta.locale;
      if (!locale) locale = (await this.available()).locale ?? "";
      const pending = planRecovery(store.names(id)).transcribe;
      const durations = new Map<number, number>();
      for (const t of store.transcripts(id)) durations.set(t.index, t.duration);
      for (const i of pending) durations.set(i, store.wavDuration(id, i));
      const offsetOf = (i: number) => [...durations].reduce((n, [k, d]) => (k < i ? n + d : n), 0);
      let failed = 0;
      for (const i of pending) {
        const heard = await this.serial(() => this.transcribeChunk(id, i, offsetOf(i), durations.get(i) ?? 0, locale));
        if (!heard) failed++;
      }
      if (this.killed) return { ok: false, error: "cancelled" };

      const chunks = store.transcripts(id);
      const duration = chunks.reduce((n, c) => n + c.duration, 0);
      const turns = speakerTurns(assembleSegments(chunks));
      if (!turns.length && !failed) {
        store.remove(id);
        return { ok: true, id, empty: true, duration };
      }
      const fileName = meetingFileName(meta.startedAt);
      const document = meetingDocument({ startedAt: meta.startedAt, duration, locale, turns });
      const folder = this.deps.saveDir();
      mkdirSync(folder, { recursive: true });
      const path = join(folder, fileName);
      writeFileSync(path, document);
      // The audio goes once every chunk is text; a refused chunk keeps the folder for another Finish.
      if (!failed) store.remove(id);
      return { ok: true, id, path, folder, fileName, document, prompt: minutesPrompt(fileName), turns: turns.length, duration, failed };
    } catch (err) {
      return { ok: false, error: "disk", message: err instanceof Error ? err.message : String(err) };
    } finally {
      this.finishing.delete(id);
    }
  }

  discard(id: unknown): { ok: boolean } {
    if (!isMeetingId(id)) return { ok: false };
    if (this.current?.meta.id === id) {
      this.current = null;
      this.deps.emit({ type: "stopped", id, reason: "discarded" });
    }
    if (this.running?.id === id) this.running.run.cancel();
    try { this.deps.store.remove(id); } catch { return { ok: false }; }
    return { ok: true };
  }

  /** Meetings on disk that are not being recorded or finished now. */
  recoverable(): Array<{ id: string; startedAt: number; seconds: number }> {
    const live = this.current?.meta.id;
    return this.deps.store.list()
      .filter((m) => m.meta.id !== live && !this.finishing.has(m.meta.id))
      .map((m) => ({ id: m.meta.id, startedAt: m.meta.startedAt, seconds: m.seconds }));
  }

  /** Quit: the gate closes and the transcriber stops. What was recorded stays on disk for next time. */
  kill(): void {
    this.killed = true;
    this.current = null;
    this.running?.run.cancel();
  }
}
