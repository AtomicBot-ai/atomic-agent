/**
 * ATO-1074: transcribe an audio file the person already has, on this machine,
 * with timestamps.
 *
 * The voice-input helper (native/atomic-speech.swift) gained a file mode:
 *
 *   atomic-speech --file <path> <locale>
 *
 * It reads the file with AVAudioFile, runs the same on-device SpeechAnalyzer
 * as dictation, and prints one JSON object per line:
 *
 *   {"type":"file-ready","locale":"en-US","engine":"speech","duration":812.4}
 *   {"type":"segment","start":1.2,"end":4.8,"text":"..."}
 *   {"type":"progress","fraction":0.42}
 *   {"type":"error","code":"open-file","message":"..."}
 *   {"type":"done","duration":812.4}
 *
 * Main owns the child, relays progress, supports cancel and answers with the
 * segments plus a ready-to-save `[HH:MM:SS] text` transcript.
 *
 * Kept engine-agnostic on purpose: `FileTranscriber` only knows the
 * `TranscribeEngine` shape, so a Windows whisper.cpp engine (ATO-1076) plugs
 * in beside the Apple one without touching the IPC or the renderer. Nothing
 * in this file imports electron, so the unit suite loads it directly.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, extname, isAbsolute } from "node:path";

/** One timed piece of the transcript, in seconds from the start of the file. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/** Why transcription is not offered, when it is not. The renderer owns the words. */
export type TranscribeReason =
  | "voice-not-macos"
  | "voice-os-too-old"
  | "voice-helper-missing"
  | "voice-helper-failed"
  | "voice-model-missing";

export interface TranscribeAvailability {
  ok: boolean;
  reason?: TranscribeReason | string;
  /** The language the file will be heard in (BCP-47). */
  locale?: string;
  /** Which engine answers: "apple-speech" today, "whisper" later. */
  engine?: string;
}

export interface TranscribeResult {
  ok: boolean;
  error?: string;
  message?: string;
  cancelled?: boolean;
  locale?: string;
  engine?: string;
  duration?: number;
  segments?: TranscriptSegment[];
  /** The whole transcript, one `[HH:MM:SS] text` line per segment. */
  text?: string;
  /** What the renderer saves as a text attachment, and its file name. */
  document?: string;
  fileName?: string;
}

/** What the engine streams while it works (relayed to the renderer). */
export type TranscribeEvent =
  | { type: "progress"; fraction: number; segments: number }
  | { type: "segment"; segment: TranscriptSegment; segments: number };

export interface TranscribeRun {
  cancel(): void;
  done: Promise<TranscribeResult>;
}

export interface TranscribeEngine {
  id: string;
  available(): Promise<TranscribeAvailability>;
  run(path: string, locale: string, onEvent: (ev: TranscribeEvent) => void): TranscribeRun;
}

/* ------------------------------------------------------------- pure --- */

/** What AVAudioFile opens (and what a later whisper engine is expected to take). */
export const TRANSCRIBE_AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "aif", "aiff", "caf"]);

export function isTranscribableAudio(path: string): boolean {
  return TRANSCRIBE_AUDIO_EXTS.has(extname(String(path || "")).slice(1).toLowerCase());
}

/** `83.4` → `00:01:23`. Always hours, so a list of lines lines up. */
export function formatTimestamp(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(h)}:${two(m)}:${two(sec)}`;
}

/** `[00:01:23] text` per segment; empty segments are dropped. */
export function formatTranscript(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => ({ ...s, text: String(s.text || "").replace(/\s+/g, " ").trim() }))
    .filter((s) => s.text)
    .map((s) => `[${formatTimestamp(s.start)}] ${s.text}`)
    .join("\n");
}

/** The saved transcript file: a short header, then the lines. */
export function transcriptDocument(fileName: string, locale: string, segments: TranscriptSegment[]): string {
  const body = formatTranscript(segments);
  const head = `Transcript of ${fileName || "an audio file"} (${locale || "unknown language"}, made on this computer)`;
  return `${head}\n\n${body || "(no speech was heard)"}\n`;
}

/** `meeting.m4a` → `meeting transcript.txt`. */
export function transcriptFileName(audioName: string): string {
  const base = basename(String(audioName || "audio")).replace(/\.[^.]+$/, "") || "audio";
  return `${base} transcript.txt`;
}

/**
 * One line of helper output → a typed event, or null for anything that is
 * not one (blank lines, the helper's own noise, a malformed segment).
 */
export type HelperLine =
  | { type: "file-ready"; locale?: string; engine?: string; duration?: number }
  | { type: "segment"; segment: TranscriptSegment }
  | { type: "progress"; fraction: number }
  | { type: "error"; code: string; message?: string }
  | { type: "done"; duration?: number };

export function parseHelperLine(line: string): HelperLine | null {
  const t = String(line || "").trim();
  if (!t.startsWith("{")) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(t) as Record<string, unknown>; } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  switch (o.type) {
    case "file-ready":
      return {
        type: "file-ready",
        locale: typeof o.locale === "string" ? o.locale : undefined,
        engine: typeof o.engine === "string" ? o.engine : undefined,
        duration: num(o.duration),
      };
    case "segment": {
      const text = typeof o.text === "string" ? o.text : "";
      const start = num(o.start);
      if (start === undefined || !text.trim()) return null;
      const end = num(o.end);
      return { type: "segment", segment: { start: Math.max(0, start), end: Math.max(start, end ?? start), text } };
    }
    case "progress": {
      const f = num(o.fraction);
      return f === undefined ? null : { type: "progress", fraction: Math.min(1, Math.max(0, f)) };
    }
    case "error":
      return { type: "error", code: typeof o.code === "string" ? o.code : "error", message: typeof o.message === "string" ? o.message : undefined };
    case "done":
      return { type: "done", duration: num(o.duration) };
    default:
      return null;
  }
}

/** Splits a byte stream into lines; a line split across two reads is kept whole. */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: string): void; end(): void } {
  let buf = "";
  return {
    push(chunk: string) {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) onLine(line);
        nl = buf.indexOf("\n");
      }
    },
    end() {
      if (buf.trim()) onLine(buf);
      buf = "";
    },
  };
}

/**
 * The language a file is heard in: the first voice-input language that has
 * its model on this Mac, else American English when installed, else any
 * installed one. Null when nothing is installed (the helper cannot run).
 */
export function pickFileLocale(chosen: string[], installed: string[]): string | null {
  const have = new Set(installed);
  for (const l of chosen) if (have.has(l)) return l;
  if (have.has("en-US")) return "en-US";
  return installed[0] ?? null;
}

/* ------------------------------------------------- the Apple engine --- */

export interface AppleProbe {
  ok: boolean;
  reason?: string;
  installed: string[];
}

export interface AppleEngineDeps {
  /** The helper binary (speech.ts helperPath()). */
  command: () => string;
  /** Put before `--file` (the tests run a fake helper through node). */
  prefixArgs?: string[];
  /** The voice session's cached probe: platform, macOS version, models. */
  probe: () => Promise<AppleProbe>;
  /** The voice-input languages the person chose (userData/voice.json). */
  chosen: () => string[];
  exists?: (path: string) => boolean;
}

export function appleSpeechEngine(deps: AppleEngineDeps): TranscribeEngine {
  const exists = deps.exists ?? existsSync;
  return {
    id: "apple-speech",
    async available() {
      const p = await deps.probe();
      if (!p.ok) return { ok: false, reason: p.reason ?? "voice-helper-failed", engine: "apple-speech" };
      const locale = pickFileLocale(deps.chosen(), p.installed);
      if (!locale) return { ok: false, reason: "voice-model-missing", engine: "apple-speech" };
      return { ok: true, locale, engine: "apple-speech" };
    },
    run(path, locale, onEvent) {
      const segments: TranscriptSegment[] = [];
      let child: ChildProcess | null = null;
      let cancelled = false;
      let settle: (r: TranscribeResult) => void = () => {};
      const done = new Promise<TranscribeResult>((resolve) => {
        let settled = false;
        settle = (r) => { if (!settled) { settled = true; resolve(r); } };
      });
      const command = deps.command();
      if (!exists(command)) {
        settle({ ok: false, error: "voice-helper-missing" });
        return { cancel() {}, done };
      }
      try {
        child = spawn(command, [...(deps.prefixArgs ?? []), "--file", path, locale], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        settle({ ok: false, error: "spawn", message: err instanceof Error ? err.message : String(err) });
        return { cancel() {}, done };
      }
      let duration: number | undefined;
      let engineKind: string | undefined;
      let sawDone = false;
      let lastError: { code: string; message?: string } | null = null;
      const lines = lineSplitter((line) => {
        const ev = parseHelperLine(line);
        if (!ev) return;
        if (ev.type === "file-ready") { duration = ev.duration; engineKind = ev.engine; }
        else if (ev.type === "segment") { segments.push(ev.segment); onEvent({ type: "segment", segment: ev.segment, segments: segments.length }); }
        else if (ev.type === "progress") onEvent({ type: "progress", fraction: ev.fraction, segments: segments.length });
        else if (ev.type === "error") lastError = { code: ev.code, message: ev.message };
        else if (ev.type === "done") { sawDone = true; if (ev.duration !== undefined) duration = ev.duration; }
      });
      let stderr = "";
      child.stdout?.on("data", (b: Buffer) => lines.push(b.toString("utf8")));
      child.stderr?.on("data", (b: Buffer) => { stderr = (stderr + b.toString("utf8")).slice(-2000); });
      child.on("error", (err) => settle({ ok: false, error: "spawn", message: err.message }));
      child.on("close", () => {
        lines.end();
        if (cancelled) { settle({ ok: false, cancelled: true, error: "cancelled" }); return; }
        if (!sawDone) {
          const e = lastError as { code: string; message?: string } | null;
          settle({ ok: false, error: e?.code ?? "helper-stopped", message: e?.message ?? (stderr.trim().slice(-400) || undefined) });
          return;
        }
        settle({
          ok: true, locale, engine: engineKind ? `apple-${engineKind}` : "apple-speech", duration,
          segments, text: formatTranscript(segments),
        });
      });
      return {
        cancel() {
          cancelled = true;
          try { child?.kill("SIGKILL"); } catch { /* already gone */ }
        },
        done,
      };
    },
  };
}

/* --------------------------------------------------- the supervisor --- */

export interface TranscribeFileRequest {
  /** The renderer's own id for this job: progress and cancel name it. */
  job: string;
  path: string;
}

/**
 * At most one file at a time: SpeechAnalyzer on a long recording keeps the
 * Neural Engine busy, and two meetings side by side would only both be slow.
 */
export class FileTranscriber {
  private current: { job: string; run: TranscribeRun } | null = null;

  constructor(private readonly engine: TranscribeEngine, private readonly fileOk: (path: string) => boolean = defaultFileOk) {}

  available(): Promise<TranscribeAvailability> {
    return this.engine.available().catch((err) => ({
      ok: false, reason: "voice-helper-failed", engine: this.engine.id,
      ...(err instanceof Error ? { message: err.message } : {}),
    }));
  }

  async transcribe(req: TranscribeFileRequest, emit: (job: string, ev: TranscribeEvent) => void): Promise<TranscribeResult> {
    if (!req || typeof req.job !== "string" || !req.job || typeof req.path !== "string") return { ok: false, error: "bad-request" };
    if (!isAbsolute(req.path) || !isTranscribableAudio(req.path)) return { ok: false, error: "not-audio" };
    if (!this.fileOk(req.path)) return { ok: false, error: "missing" };
    if (this.current) return { ok: false, error: "busy" };
    const avail = await this.available();
    if (!avail.ok || !avail.locale) return { ok: false, error: avail.reason ?? "unavailable" };
    if (this.current) return { ok: false, error: "busy" };
    const run = this.engine.run(req.path, avail.locale, (ev) => emit(req.job, ev));
    this.current = { job: req.job, run };
    try {
      const res = await run.done;
      if (!res.ok) return res;
      const segments = res.segments ?? [];
      const name = basename(req.path);
      return { ...res, document: transcriptDocument(name, res.locale ?? avail.locale, segments), fileName: transcriptFileName(name) };
    } finally {
      if (this.current?.run === run) this.current = null;
    }
  }

  cancel(job: unknown): { ok: boolean } {
    if (!this.current || (typeof job === "string" && job && job !== this.current.job)) return { ok: false };
    this.current.run.cancel();
    return { ok: true };
  }

  /** Quit, window close. */
  kill(): void {
    this.current?.run.cancel();
  }
}

function defaultFileOk(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}
