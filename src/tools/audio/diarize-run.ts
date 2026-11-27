import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";

/**
 * Running the sherpa-onnx diarizer (ATO-2514) on a 16 kHz mono WAV.
 *
 * `sherpa-onnx-offline-speaker-diarization --segmentation.pyannote-model=…
 * --embedding.model=… [--clustering.num-clusters=N |
 * --clustering.cluster-threshold=T] <wav>` prints its config, `Started`,
 * then one line per speech turn, `0.318 -- 6.865 speaker_00`, on stdout
 * (sherpa-onnx/csrc/offline-speaker-diarization-result.cc), and
 * `progress 12.50%` lines on stderr. No shell; the libraries are found
 * beside the CLI (`../lib`) through the loader path of each OS.
 */

export interface SpeakerSpan {
  start: number;
  end: number;
  /** 0-based, in the order the diarizer numbered them. */
  speaker: number;
}

export interface DiarizeArgsInput {
  segmentation: string;
  embedding: string;
  wav: string;
  /** The number of speakers when known; otherwise the threshold decides. */
  speakers?: number;
  /** Larger means fewer speakers. Upstream's default is 0.5. */
  threshold?: number;
}

const LINE = /^\s*(\d+(?:\.\d+)?)\s+--\s+(\d+(?:\.\d+)?)\s+speaker_(\d+)\b/;
const PROGRESS = /^progress\s+(\d+(?:\.\d+)?)%/;

/** Every `start -- end speaker_NN` line of the CLI's output, in time order. */
export function parseDiarizeOutput(stdout: string): SpeakerSpan[] {
  const out: SpeakerSpan[] = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (!(end > start)) continue;
    out.push({ start, end, speaker: Number(m[3]) });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** `progress 37.50%` → 0.375; anything else → null. */
export function parseDiarizeProgress(line: string): number | null {
  const m = PROGRESS.exec(String(line || "").trim());
  return m ? Math.min(1, Number(m[1]) / 100) : null;
}

export function diarizeArgs(o: DiarizeArgsInput): string[] {
  const args = [`--segmentation.pyannote-model=${o.segmentation}`, `--embedding.model=${o.embedding}`];
  if (o.speakers !== undefined && Number.isInteger(o.speakers) && o.speakers > 0 && o.speakers <= 20) {
    args.push(`--clustering.num-clusters=${o.speakers}`);
  } else if (o.threshold !== undefined && Number.isFinite(o.threshold) && o.threshold > 0 && o.threshold < 2) {
    args.push(`--clustering.cluster-threshold=${o.threshold}`);
  }
  args.push(o.wav);
  return args;
}

/**
 * The environment the CLI runs with: its `bin` and `lib` folders on the
 * loader path (PATH on Windows, LD_LIBRARY_PATH on Linux, DYLD_LIBRARY_PATH
 * on macOS), in front of what was there.
 */
export function diarizeEnv(binary: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const bin = dirname(binary);
  const lib = join(dirname(bin), "lib");
  const key = platform === "win32" ? "Path" : platform === "darwin" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
  const sep = platform === "win32" ? ";" : ":";
  const existingKey = platform === "win32" ? Object.keys(env).find((k) => k.toLowerCase() === "path") ?? key : key;
  const before = env[existingKey];
  const next = { ...env };
  if (existingKey !== key) delete next[existingKey];
  next[key] = [bin, lib, ...(before ? [before] : [])].join(sep);
  return next;
}

export interface DiarizeRunResult {
  ok: boolean;
  spans: SpeakerSpan[];
  error?: string;
}

export interface DiarizeRunOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** One run of the CLI; never throws. */
export function runDiarize(binary: string, input: DiarizeArgsInput, opts: DiarizeRunOptions = {}): Promise<DiarizeRunResult> {
  const platform = opts.platform ?? process.platform;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let pending = "";
    let settled = false;
    const finish = (r: DiarizeRunResult) => { if (!settled) { settled = true; resolve(r); } };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binary, diarizeArgs(input), {
        env: diarizeEnv(binary, platform, opts.env ?? process.env),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      finish({ ok: false, spans: [], error: (err as Error).message });
      return;
    }
    const onAbort = () => child.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => {
      const text = c.toString("utf8");
      stderr = (stderr + text).slice(-4000);
      pending += text;
      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        const p = parseDiarizeProgress(pending.slice(0, nl));
        if (p !== null) opts.onProgress?.(p);
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
      }
    });
    child.on("error", (err) => finish({ ok: false, spans: [], error: err.message }));
    child.on("exit", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) { finish({ ok: false, spans: [], error: "cancelled" }); return; }
      if (code !== 0) { finish({ ok: false, spans: [], error: `the diarizer exited with code ${code ?? "null"}: ${stderr.trim().split("\n").pop() ?? ""}` }); return; }
      finish({ ok: true, spans: parseDiarizeOutput(stdout) });
    });
  });
}
