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
import { accessSync, constants, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, posix, win32 } from "node:path";
import { searchDirs, whisperLanguage, WHISPER_SAMPLE_RATE, type LookupEnv } from "./whisper-dictation.js";

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
  | "voice-model-missing"
  | "voice-whisper-missing"
  | "voice-whisper-model-missing";

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
  /** The extensions this engine takes; TRANSCRIBE_AUDIO_EXTS when absent. */
  exts?: ReadonlySet<string>;
  available(): Promise<TranscribeAvailability>;
  run(path: string, locale: string, onEvent: (ev: TranscribeEvent) => void): TranscribeRun;
}

/* ------------------------------------------------------------- pure --- */

/** What AVAudioFile opens (and what a later whisper engine is expected to take). */
export const TRANSCRIBE_AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "aif", "aiff", "caf"]);

export function isTranscribableAudio(path: string, exts: ReadonlySet<string> = TRANSCRIBE_AUDIO_EXTS): boolean {
  return exts.has(extname(String(path || "")).slice(1).toLowerCase());
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

/* ---------------------------------------- the whisper.cpp engine --- */

/*
 * ATO-1076: the same file transcription on Windows and Linux, where there is
 * no Apple speech helper. It runs the whisper.cpp binary and model that voice
 * input already found or downloaded (speech.ts probeWhisper, ATO-1049), so a
 * person who pressed the microphone once can also transcribe a recording.
 *
 *   ffmpeg -i <file> -vn -ar 16000 -ac 1 -c:a pcm_s16le <tmp>/audio.wav   (when ffmpeg is there)
 *   whisper-cli -m <model> -f <wav> -l <lang> -pp
 *
 * whisper-cli prints each segment on stdout as it is decoded,
 * `[00:01:23.400 --> 00:01:27.120]  text`, and with `-pp` its progress on
 * stderr, `whisper_print_progress_callback: progress =  42%`. Both are read
 * live, so the chip moves while a long meeting is heard.
 *
 * ffmpeg comes first, the way the agent's audio.transcribe does it
 * (src/tools/audio/whisper-args.ts): whisper.cpp reads 16 kHz WAV for sure,
 * MP3 and FLAC in its own builds, and m4a/ogg/opus not at all. Without
 * ffmpeg on PATH only those three are tried as they are; the rest end in
 * `needs-ffmpeg`, which the chip turns into a sentence.
 */

/** What the whisper route takes: everything ffmpeg turns into WAV that a recorder or a call app saves. */
export const WHISPER_TRANSCRIBE_EXTS: ReadonlySet<string> = new Set([
  "wav", "mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wma", "aif", "aiff",
]);
/** Read by whisper-cli itself, no ffmpeg needed. */
export const WHISPER_NATIVE_EXTS: ReadonlySet<string> = new Set(["wav", "mp3", "flac"]);

/** `-m <model> -f <wav> -l <lang> -pp`: timed segments on stdout, progress on stderr. */
export function whisperFileArgs(model: string, wav: string, language: string): string[] {
  return ["-m", model, "-f", wav, "-l", language, "-pp"];
}

/** `ffmpeg … -i <input> -vn -ar 16000 -ac 1 -c:a pcm_s16le <output>` (the agent's ffmpegToWavArgs). */
export function ffmpegWavArgs(input: string, output: string): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", input, "-vn", "-ar", String(WHISPER_SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", output,
  ];
}

const WHISPER_SEGMENT = /^\[(\d+):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[.,](\d{1,3})\]\s*(.*)$/;
const NOT_SPEECH = /^[[(](BLANK_AUDIO|MUSIC|NOISE|SILENCE|INAUDIBLE)[\])]$/i;

function hms(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
}

/** One stdout line of whisper-cli → a segment, or null (blank, `[BLANK_AUDIO]`, anything else). */
export function parseWhisperSegment(line: string): TranscriptSegment | null {
  const m = WHISPER_SEGMENT.exec(String(line || "").trim());
  if (!m) return null;
  const text = (m[9] ?? "").trim();
  if (!text || NOT_SPEECH.test(text)) return null;
  const start = hms(m[1]!, m[2]!, m[3]!, m[4]!);
  const end = hms(m[5]!, m[6]!, m[7]!, m[8]!);
  return { start, end: Math.max(start, end), text };
}

/** One stderr line of whisper-cli → a 0..1 fraction, or null. */
export function parseWhisperProgress(line: string): number | null {
  const m = /progress\s*=\s*(\d{1,3})\s*%/.exec(String(line || ""));
  if (!m) return null;
  return Math.min(1, Math.max(0, Number(m[1]) / 100));
}

/** Where a program is on PATH (and the installer folders a GUI app misses), or null. */
export function findOnPath(name: string, o: LookupEnv): string | null {
  const isExec = o.isExecutable ?? ((p: string) => {
    try { accessSync(p, o.platform === "win32" ? constants.F_OK : constants.X_OK); return statSync(p).isFile(); } catch { return false; }
  });
  const exts = o.platform === "win32" ? [".exe", ""] : [""];
  const joinFor = o.platform === "win32" ? win32.join : posix.join;
  for (const dir of searchDirs(o)) {
    for (const ext of exts) {
      const candidate = joinFor(dir, name + ext);
      if (isExec(candidate)) return candidate;
    }
  }
  return null;
}

export interface WhisperEngineDeps {
  /** voice.probe(): on Windows/Linux it is the whisper probe (ATO-1049). */
  probe: () => Promise<{ ok: boolean; reason?: string }>;
  /** The binary and model the last good probe found (VoiceSession.whisperPaths). */
  paths: () => { bin: string; model: string } | null;
  /** The voice-input languages the person chose (userData/voice.json). */
  chosen: () => string[];
  /** ffmpeg on PATH, or null. */
  ffmpeg: () => string | null;
  /** Put before the binary's own args (the tests run fakes through node). */
  prefixArgs?: { whisper?: string[]; ffmpeg?: string[] };
  /** Where the converted WAV goes; deleted after every run. */
  tempRoot?: () => string;
}

export function whisperFileEngine(deps: WhisperEngineDeps): TranscribeEngine {
  return {
    id: "whisper",
    exts: WHISPER_TRANSCRIBE_EXTS,
    async available() {
      const p = await deps.probe();
      if (!p.ok) return { ok: false, reason: p.reason ?? "voice-whisper-missing", engine: "whisper" };
      if (!deps.paths()) return { ok: false, reason: "voice-whisper-missing", engine: "whisper" };
      // One multilingual model hears every language; the first chosen one names the file.
      return { ok: true, locale: deps.chosen()[0] ?? "en-US", engine: "whisper" };
    },
    run(path, locale, onEvent) {
      const segments: TranscriptSegment[] = [];
      let child: ChildProcess | null = null;
      let cancelled = false;
      let work: string | null = null;
      let settle: (r: TranscribeResult) => void = () => {};
      const done = new Promise<TranscribeResult>((resolve) => {
        let settled = false;
        settle = (r) => {
          if (settled) return;
          settled = true;
          if (work) { try { rmSync(work, { recursive: true, force: true }); } catch { /* temp folder */ } }
          resolve(r);
        };
      });
      const found = deps.paths();
      if (!found) {
        settle({ ok: false, error: "voice-whisper-missing" });
        return { cancel() {}, done };
      }
      const chosen = deps.chosen();
      const language = whisperLanguage(chosen.length ? chosen : [locale]);
      const ext = extname(path).slice(1).toLowerCase();
      const ffmpeg = deps.ffmpeg();
      if (!ffmpeg && !WHISPER_NATIVE_EXTS.has(ext)) {
        settle({ ok: false, error: "needs-ffmpeg" });
        return { cancel() {}, done };
      }

      const spawnStep = (cmd: string, args: string[]): ChildProcess | null => {
        try {
          return spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        } catch (err) {
          settle({ ok: false, error: "spawn", message: err instanceof Error ? err.message : String(err) });
          return null;
        }
      };

      const transcribe = (wav: string) => {
        if (cancelled) { settle({ ok: false, cancelled: true, error: "cancelled" }); return; }
        child = spawnStep(found.bin, [...(deps.prefixArgs?.whisper ?? []), ...whisperFileArgs(found.model, wav, language)]);
        if (!child) return;
        let stderr = "";
        const out = lineSplitter((line) => {
          const seg = parseWhisperSegment(line);
          if (!seg) return;
          segments.push(seg);
          onEvent({ type: "segment", segment: seg, segments: segments.length });
        });
        const err = lineSplitter((line) => {
          const f = parseWhisperProgress(line);
          if (f !== null) onEvent({ type: "progress", fraction: f, segments: segments.length });
        });
        child.stdout?.on("data", (b: Buffer) => out.push(b.toString("utf8")));
        child.stderr?.on("data", (b: Buffer) => { const t = b.toString("utf8"); err.push(t); stderr = (stderr + t).slice(-2000); });
        child.on("error", (e) => settle({ ok: false, error: "spawn", message: e.message }));
        child.on("close", (code) => {
          out.end();
          err.end();
          if (cancelled) { settle({ ok: false, cancelled: true, error: "cancelled" }); return; }
          if (code !== 0) {
            const tail = stderr.trim().split("\n").filter((l) => !/progress\s*=/.test(l)).slice(-3).join("\n");
            settle({ ok: false, error: "whisper-failed", message: tail || `whisper exited with ${code}` });
            return;
          }
          const last = segments[segments.length - 1];
          settle({
            ok: true, locale, engine: "whisper", duration: last ? last.end : 0,
            segments, text: formatTranscript(segments),
          });
        });
      };

      if (!ffmpeg) {
        transcribe(path);
      } else {
        try {
          work = mkdtempSync(join((deps.tempRoot ?? tmpdir)(), "atomic-transcribe-"));
        } catch (e) {
          settle({ ok: false, error: "spawn", message: e instanceof Error ? e.message : String(e) });
          return { cancel() {}, done };
        }
        const wav = join(work, "audio.wav");
        child = spawnStep(ffmpeg, [...(deps.prefixArgs?.ffmpeg ?? []), ...ffmpegWavArgs(path, wav)]);
        if (child) {
          let stderr = "";
          child.stderr?.on("data", (b: Buffer) => { stderr = (stderr + b.toString("utf8")).slice(-1000); });
          child.on("error", (e) => settle({ ok: false, error: "spawn", message: e.message }));
          child.on("close", (code) => {
            if (cancelled) { settle({ ok: false, cancelled: true, error: "cancelled" }); return; }
            if (code !== 0) { settle({ ok: false, error: "open-file", message: stderr.trim().slice(-400) || undefined }); return; }
            transcribe(wav);
          });
        }
      }
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
    if (!isAbsolute(req.path) || !isTranscribableAudio(req.path, this.engine.exts)) return { ok: false, error: "not-audio" };
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
