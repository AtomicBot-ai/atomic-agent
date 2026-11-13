/**
 * Voice input (item 2) — the main-process side.
 *
 * The renderer opens the microphone and posts 100 ms of 16 kHz mono s16le
 * over the context bridge; this module owns the one child process that turns
 * it into text, and nothing else in the app may spawn it. Transcription is
 * Apple's on-device SpeechAnalyzer inside native/atomic-speech.swift: no
 * network, no API key, no account. Measured, not assumed — see the header of
 * that file for the nettop run, which was repeated on a two-analyzer
 * Russian take and again found no network row for the helper.
 *
 * The audio is never written to disk and never leaves this process tree: a
 * chunk goes straight into the child's stdin and is dropped.
 *
 * Windows and Linux (ATO-1049) take a different branch with the same IPC
 * contract: the take is held in memory, written once as a WAV into a private
 * temp folder on stop, transcribed by whisper.cpp and the folder deleted
 * (whisper-dictation.ts). Still on this computer. The one network step is
 * the first-use download of whisper.cpp and the speech model (decision 75),
 * which the agent's `whisper install` does when the user turns voice on.
 */
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { managedDataDirNow, whisperInstall, type CliResult } from "./agent-cli.js";
import {
  cleanTranscript,
  managedWhisperBinary,
  pcmToWav,
  resolveWhisperBinary,
  resolveWhisperModel,
  whisperArgs,
  whisperLanguage,
  whisperDownloadable,
  WHISPER_LOCALES,
  type LookupEnv,
} from "./whisper-dictation.js";

/** Why the microphone button is off, when it is. The renderer owns the
 *  sentence each of these prints; main only ever names the case. */
export type VoiceReason =
  | "voice-not-macos"
  | "voice-os-too-old"
  | "voice-helper-missing"
  | "voice-helper-failed"
  /** Windows/Linux (ATO-1049): no whisper.cpp binary found. */
  | "voice-whisper-missing"
  /** Windows/Linux: whisper.cpp is there, no ggml speech model is. */
  | "voice-whisper-model-missing";

export interface VoiceProbe {
  ok: boolean;
  reason?: VoiceReason;
  detail?: string;
  os?: string;
  /** BCP-47 ids the helper can transcribe at all (SpeechTranscriber ∪ DictationTranscriber). */
  supported: string[];
  /** Those with a model already on this Mac. Everything else is a download. */
  installed: string[];
  /** Which module serves a locale: better punctuation from `speech`, wider coverage from `dictation`. */
  speech: string[];
  dictation: string[];
  maxReserved: number;
  /** Kept as a forward-compatible field: this route is on-device, always false. */
  offMachine: boolean;
  /** True on the whisper.cpp route: no partials, the text comes after the take ends. */
  batch?: boolean;
  /** Whisper route, not ready yet: `install` can fetch what is missing (decision 75). */
  canDownload?: boolean;
}

/** The whisper reasons a download or a manual install can clear while the app runs. */
const WHISPER_RETRY_REASONS: ReadonlySet<VoiceReason | undefined> = new Set(["voice-whisper-missing", "voice-whisper-model-missing"]);

/** Seams for test/speech-whisper.test.mjs; the app passes none. */
export interface VoiceDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  lookup?: () => LookupEnv;
  modelsDir?: () => string;
  install?: (onLine: (line: string) => void) => { done: Promise<CliResult>; cancel: () => void };
}

/** 100 ms of 16 kHz mono s16le is 3200 bytes; anything near 64 KB is a fault. */
const MAX_CHUNK = 65536;
/** Five minutes of audio at 32 KB/s. A session past this is a stuck renderer. */
const MAX_SESSION_BYTES = 5 * 60 * 32_000;
const PROBE_TIMEOUT_MS = 8000;
/** whisper.cpp on a CPU takes a while on five minutes of speech. */
const WHISPER_TIMEOUT_MS = 180_000;

/** What the whisper.cpp lookups read: this process's environment. */
function whisperLookup(): LookupEnv {
  return { env: process.env, platform: process.platform, home: homedir() };
}

export function helperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "native", "atomic-speech")
    : join(__dirname, "..", "native", "atomic-speech");
}

/** The macOS major version, or 0 when the answer is not knowable. */
function macosMajor(): number {
  try {
    const v = typeof process.getSystemVersion === "function" ? process.getSystemVersion() : "";
    const n = Number.parseInt(String(v).split(".")[0] ?? "", 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

type Emit = (payload: Record<string, unknown>) => void;

export class VoiceSession {
  /** True only between voice:start and stop/cancel. The permission handlers
   *  in createWindow() read this: the renderer may take the microphone
   *  exactly inside a session the user asked for, and never the camera. */
  armed = false;
  private child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private bytes = 0;
  private emit: Emit = () => {};
  private cached: VoiceProbe | null = null;
  /* The whisper.cpp route (not darwin): the take in memory while armed,
     the binary and model the probe found, and the running transcription. */
  private takes: Uint8Array[] | null = null;
  private whisper: { bin: string; model: string } | null = null;
  private whisperRun: AbortController | null = null;
  private takeLocales: string[] = [];
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;

  constructor(private readonly deps: VoiceDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.arch = deps.arch ?? process.arch;
  }

  private empty(reason: VoiceReason, detail?: string): VoiceProbe {
    return {
      ok: false, reason, detail, os: macosMajor() ? String(macosMajor()) : undefined,
      supported: [], installed: [], speech: [], dictation: [], maxReserved: 0, offMachine: false,
    };
  }

  /**
   * What the button may claim. Every impossible case is decided BEFORE a
   * spawn is attempted: the helper is compiled for macOS 26, so on macOS 15
   * the file exists and dyld refuses it — an exec error there would read as
   * "helper missing" instead of the true reason.
   */
  async probe(force = false): Promise<VoiceProbe> {
    // A missing whisper.cpp or model is not final: the first-use download,
    // or the user's own install, clears it while the app runs, so those two
    // answers are asked again instead of served from the cache.
    if (this.cached && !force && !WHISPER_RETRY_REASONS.has(this.cached.reason)) return this.cached;
    if (this.platform !== "darwin") return (this.cached = this.probeWhisper());
    const major = macosMajor();
    if (major > 0 && major < 26) return (this.cached = this.empty("voice-os-too-old", String(major)));
    const path = helperPath();
    if (!existsSync(path)) return (this.cached = this.empty("voice-helper-missing", path));

    const line = await new Promise<string>((resolve) => {
      let out = "";
      let done = false;
      const finish = (s: string) => { if (!done) { done = true; resolve(s); } };
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn(path, ["--probe"], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        finish(`ERR ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const timer = setTimeout(() => { child.kill("SIGKILL"); finish("ERR timeout"); }, PROBE_TIMEOUT_MS);
      child.stdout.on("data", (b: Buffer) => { out += b.toString("utf8"); });
      child.on("error", (err) => { clearTimeout(timer); finish(`ERR ${err.message}`); });
      child.on("close", () => { clearTimeout(timer); finish(out); });
    });

    if (line.startsWith("ERR ")) return (this.cached = this.empty("voice-helper-failed", line.slice(4)));
    try {
      const obj = JSON.parse(line.split("\n").find((l) => l.trim().startsWith("{")) ?? "") as Partial<VoiceProbe>;
      const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      const supported = strings(obj.supported);
      if (!supported.length) return (this.cached = this.empty("voice-helper-failed", "no locales"));
      this.cached = {
        ok: true, os: typeof obj.os === "string" ? obj.os : undefined,
        supported, installed: strings(obj.installed),
        speech: strings(obj.speech), dictation: strings(obj.dictation),
        maxReserved: typeof obj.maxReserved === "number" ? obj.maxReserved : 0,
        offMachine: false,
      };
      return this.cached;
    } catch {
      return (this.cached = this.empty("voice-helper-failed", "unreadable probe"));
    }
  }

  /** Windows/Linux: whisper.cpp and a model on disk, or the case that is missing. */
  private probeWhisper(): VoiceProbe {
    const lookup = (this.deps.lookup ?? whisperLookup)();
    const modelsDir = (this.deps.modelsDir ?? managedDataDirNow)();
    const bin = resolveWhisperBinary(lookup, managedWhisperBinary(modelsDir, this.platform));
    if (!bin.found) {
      // No upstream build for this machine: the install line stays the route.
      return { ...this.empty("voice-whisper-missing", bin.detail), canDownload: whisperDownloadable(this.platform, this.arch) };
    }
    const model = resolveWhisperModel(modelsDir, lookup);
    if (!model.found) return { ...this.empty("voice-whisper-model-missing", model.detail), canDownload: true };
    this.whisper = { bin: bin.path, model: model.path };
    const all = [...WHISPER_LOCALES];
    return {
      ok: true, os: this.platform, supported: all, installed: all,
      speech: [], dictation: all, maxReserved: 0, offMachine: false, batch: true,
    };
  }

  /** Start listening. `locales[0]` drives the live text; a second one is
   *  heard in parallel and can win the session (the helper's `replace`). */
  async start(locales: string[], emit: Emit): Promise<{ ok: boolean; error?: string; locales?: string[] }> {
    const probe = await this.probe();
    if (!probe.ok) return { ok: false, error: probe.reason };
    const wanted = locales.filter((l) => typeof l === "string" && probe.supported.includes(l)).slice(0, 2);
    if (!wanted.length) return { ok: false, error: "unsupported-locale" };
    this.kill();
    this.emit = emit;
    this.bytes = 0;
    if (this.platform !== "darwin") {
      // No child to feed: the take is kept until stop() hands it to whisper.
      this.takes = [];
      this.takeLocales = wanted;
      this.armed = true;
      emit({ type: "ready", locales: wanted });
      return { ok: true, locales: wanted };
    }
    // Every handler below closes over THIS session's emit, not over
    // `this.emit`. A child killed by the next start() still delivers its
    // `close` afterwards, and reading `this.emit` at fire time would post a
    // dead session's "stopped unexpectedly" into the live one — which the
    // renderer would turn into an error toast for a take that was fine.
    const emitFor = emit;
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(helperPath(), wanted, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    this.child = child;
    this.armed = true;

    // One JSON object per line, relayed exactly as AgentClient relays SSE.
    let buf = "";
    child.stdout.on("data", (b: Buffer) => {
      buf += b.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          try { emitFor(JSON.parse(line) as Record<string, unknown>); }
          catch { /* a non-JSON line is the helper's own noise, not an event */ }
        }
        nl = buf.indexOf("\n");
      }
    });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr = (stderr + b.toString("utf8")).slice(-2000); });
    child.on("error", (err) => {
      if (this.child === child) this.armed = false;
      emitFor({ type: "error", code: "spawn", message: err.message });
    });
    child.on("close", (code) => {
      // A close from a child this session has already replaced is somebody
      // else's news: it is neither an error here nor a reason to disarm.
      if (this.child !== child) return;
      this.child = null;
      this.armed = false;
      emitFor({ type: "closed", code, stderr: stderr.slice(-400) });
    });
    // A pipe write after the child is gone must not take the app down.
    child.stdin.on("error", () => {});
    return { ok: true, locales: wanted };
  }

  /**
   * A chunk of microphone audio. This is the bridge's only binary payload
   * and it arrives 10×/s, so it is validated rather than trusted: a
   * Uint8Array (never a Buffer — that is what actually crosses a sandboxed
   * contextBridge), under the per-chunk cap, inside an armed session, and
   * within the session's byte budget.
   */
  audio(chunk: unknown): void {
    if ((!this.child && !this.takes) || !this.armed) return;
    if (!(chunk instanceof Uint8Array)) return;
    if (chunk.byteLength === 0 || chunk.byteLength > MAX_CHUNK) return;
    this.bytes += chunk.byteLength;
    if (this.bytes > MAX_SESSION_BYTES) {
      this.emit({ type: "error", code: "too-long", message: "voice input stops after five minutes" });
      this.cancel();
      return;
    }
    if (this.takes) { this.takes.push(Uint8Array.from(chunk)); return; }
    this.child?.stdin.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }

  /** Close stdin and let the helper finalize; its `done` ends the session. */
  stop(): { ok: boolean } {
    this.armed = false;
    if (this.takes) { void this.finishWhisper(); return { ok: true }; }
    if (this.child) { try { this.child.stdin.end(); } catch { /* already gone */ } }
    return { ok: true };
  }

  /** Throw the session away. Nothing is inserted after this. */
  cancel(): { ok: boolean } {
    const had = !!this.child || !!this.takes || !!this.whisperRun;
    this.kill();
    if (had) this.emit({ type: "closed", cancelled: true });
    return { ok: true };
  }

  /** Download an on-device model. Progress is streamed on the same channel. */
  install(locale: string, emit: Emit): Promise<{ ok: boolean; error?: string }> {
    if (this.platform !== "darwin") return this.installWhisper(emit);
    return new Promise((resolve) => {
      const path = helperPath();
      if (!existsSync(path)) { resolve({ ok: false, error: "voice-helper-missing" }); return; }
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn(path, ["--install", locale], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      let buf = "";
      let ok = false;
      child.stdout.on("data", (b: Buffer) => {
        buf += b.toString("utf8");
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            try {
              const obj = JSON.parse(line) as Record<string, unknown>;
              if (obj.type === "installed") ok = true;
              emit(obj);
            } catch { /* not an event */ }
          }
          nl = buf.indexOf("\n");
        }
      });
      child.on("error", (err) => resolve({ ok: false, error: err.message }));
      child.on("close", () => {
        // The catalogue moved, so the next probe must ask again.
        this.cached = null;
        resolve(ok ? { ok: true } : { ok: false, error: "install-failed" });
      });
    });
  }

  /**
   * Windows/Linux, first use (decision 75): the agent's `whisper install`
   * fetches whisper.cpp (where upstream ships it) and the saved default
   * model, each checked against its SHA-256. Emits `install` with the
   * fraction as it goes and `installed` at the end, the events the macOS
   * language download uses; then the next probe finds both.
   */
  private async installWhisper(emit: Emit): Promise<{ ok: boolean; error?: string }> {
    const outcome: { failure: string | null; message: string } = { failure: null, message: "" };
    const run = (this.deps.install ?? whisperInstall)((line) => {
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(line) as Record<string, unknown>; } catch { return; /* not an event */ }
      if (obj.type === "progress" && typeof obj.fraction === "number") emit({ type: "install", fraction: obj.fraction });
      else if (obj.type === "error") {
        outcome.failure = typeof obj.code === "string" ? obj.code : "install-failed";
        outcome.message = String(obj.message ?? "");
      }
    });
    const res = await run.done;
    this.cached = null;
    if (res.ok && outcome.failure === null) {
      const probe = await this.probe(true);
      if (probe.ok) {
        emit({ type: "installed", locale: "whisper" });
        return { ok: true };
      }
      return { ok: false, error: probe.reason ?? "install-failed" };
    }
    emit({ type: "error", code: "install", message: outcome.message || res.error || "the download failed" });
    return { ok: false, error: outcome.failure ?? "install-failed" };
  }

  /**
   * Windows/Linux: the take as one WAV in a private temp folder, whisper.cpp
   * on it, the folder removed. Emits `final` (when words were heard) and
   * `done`, the same events the macOS helper ends a take with; a failure is
   * an `error` the renderer shows, then `done`. A cancel aborts the run and
   * nothing is emitted.
   */
  private async finishWhisper(): Promise<void> {
    const takes = this.takes ?? [];
    this.takes = null;
    const emit = this.emit;
    const tool = this.whisper;
    const ac = new AbortController();
    this.whisperRun = ac;
    let dir: string | null = null;
    try {
      if (!tool) { emit({ type: "error", code: "whisper", message: "whisper.cpp was not found" }); return; }
      if (takes.length === 0) return;
      dir = await mkdtemp(join(tmpdir(), "atomic-voice-"));
      const wav = join(dir, "take.wav");
      await writeFile(wav, pcmToWav(takes), { mode: 0o600 });
      const out = await new Promise<{ ok: boolean; stdout: string; message: string }>((resolve) => {
        execFile(tool.bin, whisperArgs(tool.model, wav, whisperLanguage(this.takeLocales)),
          { signal: ac.signal, timeout: WHISPER_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
          (err, stdout, stderr) => resolve(err
            ? { ok: false, stdout: "", message: (String(stderr || "").trim().split("\n").pop() || err.message).slice(0, 300) }
            : { ok: true, stdout, message: "" }));
      });
      if (ac.signal.aborted) return;
      if (!out.ok) { emit({ type: "error", code: "whisper", message: `whisper.cpp failed: ${out.message}` }); return; }
      const text = cleanTranscript(out.stdout);
      if (text) emit({ type: "final", text });
    } catch (err) {
      if (!ac.signal.aborted) emit({ type: "error", code: "whisper", message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      if (this.whisperRun === ac) this.whisperRun = null;
      if (!ac.signal.aborted) emit({ type: "done" });
    }
  }

  /** Unconditional teardown — quit, window close, a new session. */
  kill(): void {
    this.takes = null;
    if (this.whisperRun) { this.whisperRun.abort(); this.whisperRun = null; }
    this.armed = false;
    const child = this.child;
    this.child = null;
    if (child) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  }
}
