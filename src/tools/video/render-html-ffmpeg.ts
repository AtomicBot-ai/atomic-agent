import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/**
 * The ffmpeg half of `video.render_html`: PNG frames in on stdin, one
 * H.264 `.mp4` out. ffmpeg is found the way the `ffmpeg` starter skill
 * finds it — the `ffmpeg` binary on PATH — and is never downloaded here.
 */

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** The sentence the agent sees when ffmpeg is not installed. */
export const FFMPEG_MISSING =
  "ffmpeg is not installed, and it is needed to put the frames into an .mp4. " +
  "Ask the user to install it (macOS: `brew install ffmpeg`; Debian/Ubuntu: `sudo apt-get install ffmpeg`; Windows: `winget install ffmpeg`), then call video.render_html again.";

/** Thrown when ffmpeg cannot be started at all. */
export class FfmpegMissingError extends Error {
  constructor() {
    super(FFMPEG_MISSING);
    this.name = "FfmpegMissingError";
  }
}

/** How much of ffmpeg's stderr a failure quotes. */
const STDERR_TAIL_CHARS = 1_500;
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Arguments for one encode: PNG frames on stdin at `fps`, H.264 in
 * yuv420p (what every player and messenger takes), `+faststart` so the
 * file plays while it downloads. `-n`: never overwrite; the caller picks
 * a path that does not exist.
 */
export function buildFfmpegArgs(input: { fps: number; outputPath: string }): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-n",
    "-f", "image2pipe",
    "-framerate", String(input.fps),
    "-c:v", "png",
    "-i", "-",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-r", String(input.fps),
    "-movflags", "+faststart",
    input.outputPath,
  ];
}

function isMissingBinary(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "EACCES";
}

/**
 * `ffmpeg -version`, before the browser is started, so a missing ffmpeg
 * costs nothing. Throws `FfmpegMissingError` when it cannot be run.
 */
export async function probeFfmpeg(binary: string, spawn: SpawnFn = nodeSpawn): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, ["-version"], { stdio: ["ignore", "ignore", "ignore"] });
    } catch (err) {
      reject(isMissingBinary(err) ? new FfmpegMissingError() : err);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg -version did not answer in 10 s"));
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(isMissingBinary(err) ? new FfmpegMissingError() : err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new FfmpegMissingError());
    });
  });
}

export interface FfmpegEncoder {
  /** One PNG frame; resolves once ffmpeg has taken it (backpressure). */
  write(frame: Buffer): Promise<void>;
  /** Close stdin and wait for the file. Rejects with ffmpeg's own error. */
  finish(): Promise<void>;
  /** Kill ffmpeg (a cancelled or failed run). */
  abort(): void;
}

/** Start ffmpeg reading frames from stdin. */
export function startFfmpegEncoder(input: {
  binary: string;
  fps: number;
  outputPath: string;
  spawn?: SpawnFn;
}): FfmpegEncoder {
  const spawn = input.spawn ?? nodeSpawn;
  const child = spawn(input.binary, buildFfmpegArgs(input), { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS);
  });
  let failure: Error | null = null;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", (err) => {
      failure = isMissingBinary(err) ? new FfmpegMissingError() : err;
      reject(failure);
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      failure = failure ?? new Error(
        `ffmpeg failed (${code !== null ? `exit ${code}` : `signal ${signal ?? "unknown"}`})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
      );
      reject(failure);
    });
  });
  // Observed here so an early exit never surfaces as an unhandled rejection.
  exited.catch(() => {});
  // A write after ffmpeg died fails with EPIPE; the exit reason is the useful one.
  child.stdin?.on("error", () => {});

  return {
    async write(frame) {
      if (failure) throw failure;
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed) {
        await exited;
        throw new Error("ffmpeg stopped reading frames");
      }
      if (!stdin.write(frame)) {
        await Promise.race([
          new Promise<void>((resolve) => stdin.once("drain", () => resolve())),
          exited.then(() => { throw new Error("ffmpeg stopped reading frames"); }),
        ]);
      }
      if (failure) throw failure;
    },
    async finish() {
      child.stdin?.end();
      await exited;
    },
    abort() {
      child.stdin?.destroy();
      child.kill("SIGKILL");
    },
  };
}
