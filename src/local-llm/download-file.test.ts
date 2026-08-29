import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadFile } from "./download-file.js";

describe("download-file", () => {
  let dir: string;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "local-llm-dl-"));
    prevFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  it("streams body to dest with progress and removes tmp on success", async () => {
    const chunks = [Buffer.from("a"), Buffer.from("b"), Buffer.from("c")];
    const body = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });

    globalThis.fetch = vi.fn(async () => {
      return new Response(body, {
        status: 200,
        headers: { "content-length": "3" },
      });
    }) as typeof fetch;

    const dest = join(dir, "out.bin");
    const progress: number[] = [];
    await downloadFile("https://example.com/x", dest, {
      onProgress: (p) => progress.push(p),
    });

    expect(readFileSync(dest, "utf-8")).toBe("abc");
    expect(progress.includes(100)).toBe(true);
  });

  it("removes tmp and does not publish partial file when aborted", async () => {
    let releaseSecondChunk: (() => void) | null = null;
    let chunkIndex = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (chunkIndex === 0) {
          chunkIndex += 1;
          controller.enqueue(Buffer.from("a"));
          return;
        }
        if (chunkIndex === 1) {
          chunkIndex += 1;
          await new Promise<void>((resolve) => {
            releaseSecondChunk = resolve;
          });
          controller.enqueue(Buffer.from("b"));
          controller.close();
          return;
        }
        controller.close();
      },
    });

    globalThis.fetch = vi.fn(async () => {
      return new Response(body, {
        status: 200,
        headers: { "content-length": "2" },
      });
    }) as typeof fetch;

    const dest = join(dir, "out.bin");
    const controller = new AbortController();
    const pending = downloadFile("https://example.com/x", dest, {
      signal: controller.signal,
    });

    await waitFor(() => releaseSecondChunk !== null);
    controller.abort();
    releaseSecondChunk?.();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.tmp`)).toBe(false);
  });

  it("keeps the byte counter moving when chunks are smaller than one percent", async () => {
    // A real GGUF pull: one percent of the declared total is far larger than
    // a single chunk, so tying updates to whole-percent changes leaves the
    // counter frozen for seconds. Here the transfer never even reaches 1%.
    const declaredTotal = 1_000_000_000;
    const chunkSize = 1_000;
    const count = 5;
    let emitted = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (emitted >= count) {
          controller.close();
          return;
        }
        emitted += 1;
        await new Promise((resolve) => setTimeout(resolve, 250));
        controller.enqueue(Buffer.alloc(chunkSize));
      },
    });

    globalThis.fetch = vi.fn(async () => {
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(declaredTotal) },
      });
    }) as typeof fetch;

    const seen: Array<{ percent: number; transferred: number }> = [];
    await downloadFile("https://example.invalid/big.bin", join(dir, "big.bin"), {
      onProgress: (percent, transferred) => {
        seen.push({ percent, transferred });
      },
    });

    // Percent rounds to 0 throughout — the bytes are the only signal the
    // user has, and they must keep arriving.
    expect(seen.every((s) => s.percent === 0)).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(count);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].transferred).toBeGreaterThan(seen[i - 1].transferred);
    }
    expect(seen.at(-1)?.transferred).toBe(chunkSize * count);
  });

  it("still reports progress when the server sends no content-length", async () => {
    // total === 0 pins percent at 0 forever, which used to wedge the old
    // guard shut after the very first chunk.
    let emitted = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (emitted >= 5) {
          controller.close();
          return;
        }
        emitted += 1;
        await new Promise((resolve) => setTimeout(resolve, 250));
        controller.enqueue(Buffer.alloc(1_000));
      },
    });

    globalThis.fetch = vi.fn(async () => {
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const seen: number[] = [];
    await downloadFile("https://example.invalid/nolen.bin", join(dir, "nolen.bin"), {
      onProgress: (_percent, transferred) => {
        seen.push(transferred);
      },
    });

    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(5_000);
  });

});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("waitFor timed out");
}
