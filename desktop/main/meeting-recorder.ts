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
 * ATO-2514: two channels. "me" is the microphone; "them" is the other side
 * of the call (system audio, meeting-system-audio.ts), recorded the same
 * way into the meeting's `them/` folder, its clock starting `themLead`
 * seconds into the meeting. Finish puts both on one clock and names the
 * speakers (meeting-speakers.ts).
 *
 * No electron: test/meeting-recorder.test.mjs drives it with a fake engine.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChunkPlanner, checkFrame, pcmSeconds, planRecovery } from "./meeting-plan.js";
import { buildTurns } from "./meeting-speakers.js";
import { isMeetingId, type MeetingChannel, type MeetingMeta } from "./meeting-store.js";
import { assembleSegments, meetingDocument, meetingFileName, minutesPrompt, shiftSegments } from "./meeting-transcript.js";
import type { TranscribeRun } from "./transcribe-file.js";
import type { MeetingFinish, MeetingRecorderDeps } from "./meeting-types.js";

export type { MeetingEvent, MeetingFinish, MeetingRecorderDeps } from "./meeting-types.js";

interface ChannelState {
  index: number;
  planner: ChunkPlanner;
  /** Seconds sealed so far in this channel, the next chunk's start. */
  offset: number;
}

interface Recording {
  meta: MeetingMeta;
  me: ChannelState;
  /** The other side of the call, from its first frame on. */
  them: ChannelState | null;
}

const CHANNELS: readonly MeetingChannel[] = ["me", "them"];

function channel(): ChannelState {
  return { index: 0, planner: new ChunkPlanner(), offset: 0 };
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
    return { recording: true, id: c.meta.id, startedAt: c.meta.startedAt, seconds: c.me.offset + pcmSeconds(c.me.planner.pending()) };
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
    this.current = { meta, me: channel(), them: null };
    return { ok: true, id: meta.id, startedAt: meta.startedAt, locale: meta.locale };
  }

  /** One frame from the renderer (or the macOS system-audio helper). Dropped unless a recording is open and the frame is sane. */
  audio(chunk: unknown, peak: unknown, ch: MeetingChannel = "me"): void {
    const cur = this.current;
    if (!cur) return;
    const frame = checkFrame(chunk);
    if (!frame) return;
    let state = ch === "them" ? cur.them : cur.me;
    if (!state) {
      // The other side's clock starts where the microphone's is now.
      state = cur.them = channel();
      cur.meta = { ...cur.meta, themLead: cur.me.offset + pcmSeconds(cur.me.planner.pending()) };
      try { this.deps.store.writeMeta(cur.meta); } catch { /* the lead is also kept in memory for Finish */ }
    }
    try {
      this.deps.store.appendPcm(cur.meta.id, state.index, frame, ch);
    } catch {
      // The disk refused (full, folder gone): stop rather than pretend to record.
      this.stop("disk");
      return;
    }
    if (state.planner.push(frame.byteLength, typeof peak === "number" ? peak : 1)) this.cut(cur, ch);
  }

  stop(reason = "user"): { ok: boolean; error?: string; id?: string } {
    const cur = this.current;
    if (!cur) return { ok: false, error: "not-recording" };
    this.current = null;
    this.cut(cur, "me");
    if (cur.them) this.cut(cur, "them");
    this.deps.emit({ type: "stopped", id: cur.meta.id, reason });
    return { ok: true, id: cur.meta.id };
  }

  /** The channel's chunk being written is sealed and queued; the next frame starts the next one. */
  private cut(cur: Recording, ch: MeetingChannel): void {
    const state = ch === "them" ? cur.them : cur.me;
    if (!state) return;
    const index = state.index;
    state.index += 1;
    state.planner.reset();
    let sealed: { path: string; duration: number } | null = null;
    try { sealed = this.deps.store.seal(cur.meta.id, index, ch); } catch { sealed = null; }
    if (!sealed) return;
    // On the meeting's clock: the other side's chunks start after its lead.
    const offset = state.offset + (ch === "them" ? cur.meta.themLead ?? 0 : 0);
    const duration = sealed.duration;
    state.offset += duration;
    const { id, locale } = cur.meta;
    void this.serial(() => this.transcribeChunk(id, index, offset, duration, locale, ch)).catch(() => false);
  }

  /** Runs `fn` after everything queued before it; the queue survives a failure. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** One sealed chunk through the engine; its text kept, its audio deleted. True when it was heard. */
  private async transcribeChunk(id: string, index: number, offset: number, duration: number, locale: string, ch: MeetingChannel = "me"): Promise<boolean> {
    if (this.killed) return false;
    let run: TranscribeRun;
    try {
      run = this.deps.engine.run(this.deps.store.wavPath(id, index, ch), locale, () => {});
    } catch {
      this.deps.emit({ type: "chunk-failed", id, index, error: "spawn", channel: ch });
      return false;
    }
    this.running = { id, run };
    const res = await run.done.finally(() => { if (this.running?.run === run) this.running = null; });
    if (!res.ok) {
      if (!res.cancelled) this.deps.emit({ type: "chunk-failed", id, index, error: res.error ?? "failed", channel: ch });
      return false;
    }
    const segments = res.segments ?? [];
    try {
      this.deps.store.writeTranscript(id, index, duration, segments, ch);
    } catch {
      return false;   // the meeting was deleted meanwhile
    }
    this.deps.emit({ type: "segments", id, index, segments: shiftSegments(segments, offset), channel: ch });
    return true;
  }

  async finish(id: unknown): Promise<MeetingFinish> {
    if (!isMeetingId(id)) return { ok: false, error: "bad-request" };
    const live = this.current?.meta.id === id ? this.current.meta : null;
    if (live) this.stop("user");
    if (this.finishing.has(id)) return { ok: false, error: "busy" };
    const { store } = this.deps;
    const stored = store.meta(id);
    if (!stored) return { ok: false, error: "missing" };
    // The other side's lead, even when meta.json could not be rewritten.
    const meta: MeetingMeta = live?.themLead !== undefined && stored.themLead === undefined ? { ...stored, themLead: live.themLead } : stored;
    this.finishing.add(id);
    try {
      await this.queue;
      let locale = meta.locale;
      if (!locale) locale = (await this.available()).locale ?? "";
      let failed = 0;
      for (const ch of CHANNELS) failed += await this.recoverChannel(id, ch, locale, ch === "them" ? meta.themLead ?? 0 : 0);
      if (this.killed) return { ok: false, error: "cancelled" };

      const mine = store.transcripts(id, "me");
      const theirs = store.transcripts(id, "them");
      const duration = mine.reduce((n, c) => n + c.duration, 0);
      const recordedThem = meta.themLead !== undefined || theirs.length > 0;
      const { turns, method } = buildTurns({
        me: assembleSegments(mine),
        them: recordedThem ? shiftSegments(assembleSegments(theirs), meta.themLead ?? 0) : null,
      });
      if (!turns.length && !failed) {
        store.remove(id);
        return { ok: true, id, empty: true, duration };
      }
      const fileName = meetingFileName(meta.startedAt);
      const document = meetingDocument({ startedAt: meta.startedAt, duration, locale, turns, method });
      const folder = this.deps.saveDir();
      mkdirSync(folder, { recursive: true });
      const path = join(folder, fileName);
      writeFileSync(path, document);
      // The audio goes once every chunk is text; a refused chunk keeps the folder for another Finish.
      if (!failed) store.remove(id);
      return { ok: true, id, path, folder, fileName, document, prompt: minutesPrompt(fileName, method), turns: turns.length, duration, failed, method };
    } catch (err) {
      return { ok: false, error: "disk", message: err instanceof Error ? err.message : String(err) };
    } finally {
      this.finishing.delete(id);
    }
  }

  /** What a crash or a refused chunk left in one channel: sealed and transcribed. Answers the chunks still refused. */
  private async recoverChannel(id: string, ch: MeetingChannel, locale: string, lead: number): Promise<number> {
    const { store } = this.deps;
    store.dropStale(id, ch);
    for (const i of planRecovery(store.names(id, ch)).seal) {
      try { store.seal(id, i, ch); } catch { /* unreadable: left as it is */ }
    }
    const pending = planRecovery(store.names(id, ch)).transcribe;
    const durations = new Map<number, number>();
    for (const t of store.transcripts(id, ch)) durations.set(t.index, t.duration);
    for (const i of pending) durations.set(i, store.wavDuration(id, i, ch));
    const offsetOf = (i: number) => lead + [...durations].reduce((n, [k, d]) => (k < i ? n + d : n), 0);
    let failed = 0;
    for (const i of pending) {
      const heard = await this.serial(() => this.transcribeChunk(id, i, offsetOf(i), durations.get(i) ?? 0, locale, ch));
      if (!heard) failed++;
    }
    return failed;
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
