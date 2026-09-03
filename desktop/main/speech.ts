/**
 * Voice input (item 2) — the main-process side.
 *
 * The renderer opens the microphone and posts 100 ms of 16 kHz mono s16le
 * over the context bridge; this module owns the one child process that turns
 * it into text, and nothing else in the app may spawn it. Transcription is
 * Apple's on-device SpeechAnalyzer inside native/atomic-speech.swift: no
 * network, no API key, no account. Measured, not assumed — see the header of
 * that file for the nettop run.
 *
 * The audio is never written to disk and never leaves this process tree: a
 * chunk goes straight into the child's stdin and is dropped.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/** Why the microphone button is off, when it is. The renderer owns the
 *  sentence each of these prints; main only ever names the case. */
export type VoiceReason =
  | "voice-not-macos"
  | "voice-os-too-old"
  | "voice-helper-missing"
  | "voice-helper-failed";

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
}

/** 100 ms of 16 kHz mono s16le is 3200 bytes; anything near 64 KB is a fault. */
const MAX_CHUNK = 65536;
/** Five minutes of audio at 32 KB/s. A session past this is a stuck renderer. */
const MAX_SESSION_BYTES = 5 * 60 * 32_000;
const PROBE_TIMEOUT_MS = 8000;

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
    if (this.cached && !force) return this.cached;
    if (process.platform !== "darwin") return (this.cached = this.empty("voice-not-macos", process.platform));
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
          try { this.emit(JSON.parse(line) as Record<string, unknown>); }
          catch { /* a non-JSON line is the helper's own noise, not an event */ }
        }
        nl = buf.indexOf("\n");
      }
    });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr = (stderr + b.toString("utf8")).slice(-2000); });
    child.on("error", (err) => {
      this.armed = false;
      this.emit({ type: "error", code: "spawn", message: err.message });
    });
    child.on("close", (code) => {
      if (this.child === child) { this.child = null; this.armed = false; }
      this.emit({ type: "closed", code, stderr: stderr.slice(-400) });
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
    if (!this.child || !this.armed) return;
    if (!(chunk instanceof Uint8Array)) return;
    if (chunk.byteLength === 0 || chunk.byteLength > MAX_CHUNK) return;
    this.bytes += chunk.byteLength;
    if (this.bytes > MAX_SESSION_BYTES) {
      this.emit({ type: "error", code: "too-long", message: "voice input stops after five minutes" });
      this.cancel();
      return;
    }
    this.child.stdin.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }

  /** Close stdin and let the helper finalize; its `done` ends the session. */
  stop(): { ok: boolean } {
    this.armed = false;
    if (this.child) { try { this.child.stdin.end(); } catch { /* already gone */ } }
    return { ok: true };
  }

  /** Throw the session away. Nothing is inserted after this. */
  cancel(): { ok: boolean } {
    const had = !!this.child;
    this.kill();
    if (had) this.emit({ type: "closed", cancelled: true });
    return { ok: true };
  }

  /** Download an on-device model. Progress is streamed on the same channel. */
  install(locale: string, emit: Emit): Promise<{ ok: boolean; error?: string }> {
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

  /** Unconditional teardown — quit, window close, a new session. */
  kill(): void {
    this.armed = false;
    const child = this.child;
    this.child = null;
    if (child) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  }
}
