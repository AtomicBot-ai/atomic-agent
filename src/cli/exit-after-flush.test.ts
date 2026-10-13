import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { exitAfterFlush, type Flushable } from "./exit-after-flush.js";

function stream(flush: (cb: () => void) => void): Flushable & { write: ReturnType<typeof vi.fn> } {
  return { write: vi.fn((_chunk: string, cb: () => void) => { flush(cb); return true; }) };
}

describe("exitAfterFlush", () => {
  it("exits only after every stream has flushed what was written before", () => {
    const callbacks: Array<() => void> = [];
    const out = stream((cb) => callbacks.push(cb));
    const err = stream((cb) => callbacks.push(cb));
    const exit = vi.fn();
    exitAfterFlush(3, [out, err], exit, 60_000);
    expect(exit).not.toHaveBeenCalled();
    callbacks[0]!();
    expect(exit).not.toHaveBeenCalled();
    callbacks[1]!();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(3);
  });

  it("exits anyway once the grace period passes (a reader that never drains)", () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      exitAfterFlush(0, [stream(() => {})], exit, 100);
      vi.advanceTimersByTime(99);
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait on a stream whose write throws, and exits once", () => {
    const exit = vi.fn();
    const broken: Flushable = { write: () => { throw new Error("EPIPE"); } };
    exitAfterFlush(1, [broken, stream((cb) => cb())], exit, 60_000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("hands a pipe reader all of a large stdout before the process exits (ATO-355)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exit-after-flush-"));
    try {
      const helper = pathToFileURL(resolve(fileURLToPath(new URL(".", import.meta.url)), "exit-after-flush.ts")).href;
      const script = join(dir, "child.ts");
      // 300 KB, well past the 64 KB a pipe takes before a write goes asynchronous.
      writeFileSync(script, `import { exitAfterFlush } from ${JSON.stringify(helper)};\nprocess.stdout.write("x".repeat(300_000) + "END");\nexitAfterFlush(0);\n`);
      const stdout = await new Promise<string>((done, fail) => {
        execFile(process.execPath, ["--import", "tsx", script], { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 }, (error, out) => (error ? fail(error) : done(out)));
      });
      expect(stdout.length).toBe(300_003);
      expect(stdout.endsWith("END")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
