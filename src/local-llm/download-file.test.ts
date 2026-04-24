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
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("waitFor timed out");
}
