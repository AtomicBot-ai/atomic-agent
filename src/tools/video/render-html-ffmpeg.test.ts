import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  FFMPEG_MISSING,
  FfmpegMissingError,
  buildFfmpegArgs,
  probeFfmpeg,
  startFfmpegEncoder,
  type SpawnFn,
} from "./render-html-ffmpeg.js";

/** A child process double: stdin collects what is written, the test decides how it ends. */
function fakeChild(): ChildProcess & { written: Buffer[]; stdinEnded: Promise<void> } {
  const child = new EventEmitter() as ChildProcess & { written: Buffer[]; stdinEnded: Promise<void> };
  const stdin = new PassThrough();
  const written: Buffer[] = [];
  stdin.on("data", (chunk: Buffer) => written.push(chunk));
  Object.assign(child, {
    stdin,
    stderr: new PassThrough(),
    written,
    stdinEnded: new Promise<void>((resolve) => stdin.on("end", () => resolve())),
    kill: vi.fn(() => true),
  });
  return child;
}

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
}

describe("buildFfmpegArgs", () => {
  it("reads PNG frames from stdin and writes H.264 yuv420p without overwriting", () => {
    const args = buildFfmpegArgs({ fps: 24, outputPath: "/work/out.mp4" });
    expect(args).toEqual([
      "-hide_banner", "-loglevel", "error", "-n",
      "-f", "image2pipe", "-framerate", "24", "-c:v", "png", "-i", "-",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
      "-r", "24", "-movflags", "+faststart",
      "/work/out.mp4",
    ]);
    // The output is last, so a path that starts with "-" is never read as a flag after it.
    expect(args.at(-1)).toBe("/work/out.mp4");
    expect(args).not.toContain("-y");
  });
});

describe("probeFfmpeg", () => {
  it("resolves when ffmpeg -version exits 0", async () => {
    const child = fakeChild();
    const spawn = vi.fn<SpawnFn>(() => {
      setImmediate(() => child.emit("close", 0, null));
      return child;
    });
    await expect(probeFfmpeg("ffmpeg", spawn)).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledWith("ffmpeg", ["-version"], expect.anything());
  });

  it("says how to install ffmpeg when it is not on PATH", async () => {
    const child = fakeChild();
    const spawn: SpawnFn = () => {
      setImmediate(() => child.emit("error", enoent()));
      return child;
    };
    const err = await probeFfmpeg("ffmpeg", spawn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FfmpegMissingError);
    expect((err as Error).message).toBe(FFMPEG_MISSING);
    expect(FFMPEG_MISSING).toMatch(/brew install ffmpeg/);
    expect(FFMPEG_MISSING).toMatch(/apt-get install ffmpeg/);
  });

  it("treats a synchronous spawn failure and a failing -version as missing", async () => {
    const throwing: SpawnFn = () => { throw enoent(); };
    await expect(probeFfmpeg("ffmpeg", throwing)).rejects.toBeInstanceOf(FfmpegMissingError);
    const child = fakeChild();
    const failing: SpawnFn = () => {
      setImmediate(() => child.emit("close", 1, null));
      return child;
    };
    await expect(probeFfmpeg("ffmpeg", failing)).rejects.toBeInstanceOf(FfmpegMissingError);
  });
});

describe("startFfmpegEncoder", () => {
  it("pipes every frame to stdin and resolves when ffmpeg exits 0", async () => {
    const child = fakeChild();
    void child.stdinEnded.then(() => child.emit("close", 0, null));
    const spawn = vi.fn<SpawnFn>(() => child);
    const encoder = startFfmpegEncoder({ binary: "/opt/ffmpeg", fps: 30, outputPath: "/work/a.mp4", spawn });
    await encoder.write(Buffer.from("one"));
    await encoder.write(Buffer.from("two"));
    await encoder.finish();
    expect(Buffer.concat(child.written).toString()).toBe("onetwo");
    expect(spawn).toHaveBeenCalledWith("/opt/ffmpeg", buildFfmpegArgs({ fps: 30, outputPath: "/work/a.mp4" }), expect.objectContaining({ stdio: ["pipe", "ignore", "pipe"] }));
  });

  it("rejects with ffmpeg's own stderr when it fails", async () => {
    const child = fakeChild();
    void child.stdinEnded.then(() => {
      child.stderr!.emit("data", Buffer.from("Unknown encoder 'libx264'\n"));
      child.emit("close", 1, null);
    });
    const encoder = startFfmpegEncoder({ binary: "ffmpeg", fps: 30, outputPath: "/work/a.mp4", spawn: () => child });
    await encoder.write(Buffer.from("frame"));
    await expect(encoder.finish()).rejects.toThrow(/exit 1: Unknown encoder 'libx264'/);
  });

  it("reports a missing binary as FfmpegMissingError", async () => {
    const child = fakeChild();
    const encoder = startFfmpegEncoder({ binary: "ffmpeg", fps: 30, outputPath: "/work/a.mp4", spawn: () => child });
    child.emit("error", enoent());
    await expect(encoder.write(Buffer.from("frame"))).rejects.toBeInstanceOf(FfmpegMissingError);
  });

  it("kills ffmpeg on abort", () => {
    const child = fakeChild();
    const encoder = startFfmpegEncoder({ binary: "ffmpeg", fps: 30, outputPath: "/work/a.mp4", spawn: () => child });
    encoder.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
