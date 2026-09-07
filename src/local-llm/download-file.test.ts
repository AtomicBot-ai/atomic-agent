import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  discardPartialDownload,
  downloadFile,
  readPartialDownload,
  resolvePartialMetaPath,
  resolvePartialPath,
} from "./download-file.js";

/** A body that hands out `chunks` one per pull, then closes. */
function bodyOf(chunks: readonly (string | Buffer)[]): ReadableStream {
  const queue = chunks.map((c) => (typeof c === "string" ? Buffer.from(c) : c));
  return new ReadableStream({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(next);
    },
  });
}

/** A body that delivers `chunks` and then dies with a transport error. */
function dyingBodyOf(chunks: readonly string[], error: Error): ReadableStream {
  const queue = [...chunks];
  return new ReadableStream({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) {
        controller.error(error);
        return;
      }
      controller.enqueue(Buffer.from(next));
    },
  });
}

/** Records each request's headers; answers from `responders` in order. */
function mockFetch(
  responders: readonly ((headers: Headers) => Response)[],
): { calls: Headers[]; fn: typeof fetch } {
  const calls: Headers[] = [];
  const fn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push(headers);
    const responder = responders[calls.length - 1];
    if (!responder) throw new Error(`unexpected fetch #${calls.length}`);
    return responder(headers);
  }) as unknown as typeof fetch;
  return { calls, fn };
}

const FAST = { retryDelayMs: 1, stallTimeoutMs: 0 };

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

  it("streams body to dest with progress and leaves no partial on success", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(bodyOf(["a", "b", "c"]), {
        status: 200,
        headers: { "content-length": "3" },
      });
    }) as typeof fetch;

    const dest = join(dir, "out.bin");
    const progress: number[] = [];
    await downloadFile("https://example.com/x", dest, {
      ...FAST,
      onProgress: (p) => progress.push(p),
    });

    expect(readFileSync(dest, "utf-8")).toBe("abc");
    expect(progress.includes(100)).toBe(true);
    expect(existsSync(resolvePartialPath(dest))).toBe(false);
    expect(existsSync(resolvePartialMetaPath(dest))).toBe(false);
  });

  it("keeps the partial and its sidecar when aborted, and does not publish it", async () => {
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
        headers: { "content-length": "2", etag: '"v1"' },
      });
    }) as typeof fetch;

    const dest = join(dir, "out.bin");
    const controller = new AbortController();
    const pending = downloadFile("https://example.com/x", dest, {
      ...FAST,
      signal: controller.signal,
    });

    await waitFor(() => releaseSecondChunk !== null);
    controller.abort();
    releaseSecondChunk?.();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(dest)).toBe(false);
    // The bytes that made it to disk are the whole point: they are what
    // the next run resumes from.
    expect(readFileSync(resolvePartialPath(dest), "utf-8")).toBe("a");
    expect(readPartialDownload(dest)).toEqual({ transferred: 1, total: 2 });
  });

  it("resumes a partial with a Range request and appends the 206 body", async () => {
    const dest = join(dir, "out.bin");
    seedPartial(dest, "https://example.com/x", "abc", { total: 6, etag: '"v1"' });

    const { calls, fn } = mockFetch([
      () =>
        new Response(bodyOf(["de", "f"]), {
          status: 206,
          headers: {
            "content-range": "bytes 3-5/6",
            "content-length": "3",
            etag: '"v1"',
          },
        }),
    ]);
    globalThis.fetch = fn;

    const seen: Array<[number, number, number]> = [];
    await downloadFile("https://example.com/x", dest, {
      ...FAST,
      onProgress: (p, t, tot) => seen.push([p, t, tot]),
    });

    expect(calls[0].get("range")).toBe("bytes=3-");
    expect(calls[0].get("if-range")).toBe('"v1"');
    expect(readFileSync(dest, "utf-8")).toBe("abcdef");
    // The bar opens at the partial's position, not at zero.
    expect(seen[0]).toEqual([50, 3, 6]);
    expect(seen.at(-1)).toEqual([100, 6, 6]);
    expect(existsSync(resolvePartialPath(dest))).toBe(false);
    expect(existsSync(resolvePartialMetaPath(dest))).toBe(false);
  });

  it("starts over when the server ignores the Range and answers 200", async () => {
    const dest = join(dir, "out.bin");
    seedPartial(dest, "https://example.com/x", "OLD", { total: 6, etag: '"v1"' });

    globalThis.fetch = mockFetch([
      () =>
        new Response(bodyOf(["new", "six"]), {
          status: 200,
          headers: { "content-length": "6", etag: '"v2"' },
        }),
    ]).fn;

    await downloadFile("https://example.com/x", dest, FAST);
    expect(readFileSync(dest, "utf-8")).toBe("newsix");
  });

  it("refuses to append a 206 whose ETag differs from the partial's, then re-downloads", async () => {
    const dest = join(dir, "out.bin");
    seedPartial(dest, "https://example.com/x", "abc", { total: 6, etag: '"v1"' });

    const { calls, fn } = mockFetch([
      () =>
        new Response(bodyOf(["XYZ"]), {
          status: 206,
          headers: { "content-range": "bytes 3-5/6", etag: '"v2"' },
        }),
      () =>
        new Response(bodyOf(["fresh1"]), {
          status: 200,
          headers: { "content-length": "6", etag: '"v2"' },
        }),
    ]);
    globalThis.fetch = fn;

    await downloadFile("https://example.com/x", dest, { ...FAST, maxRetries: 1 });

    expect(calls).toHaveLength(2);
    // The partial was discarded, so the second request is a plain GET.
    expect(calls[1].has("range")).toBe(false);
    expect(readFileSync(dest, "utf-8")).toBe("fresh1");
  });

  it("ignores a partial that belongs to a different URL", async () => {
    const dest = join(dir, "out.bin");
    seedPartial(dest, "https://example.com/other", "abc", { total: 6, etag: '"v1"' });

    const { calls, fn } = mockFetch([
      () =>
        new Response(bodyOf(["abcdef"]), {
          status: 200,
          headers: { "content-length": "6" },
        }),
    ]);
    globalThis.fetch = fn;

    await downloadFile("https://example.com/x", dest, FAST);
    expect(calls[0].has("range")).toBe(false);
    expect(readFileSync(dest, "utf-8")).toBe("abcdef");
  });

  it("retries a mid-body transport failure from the partial", async () => {
    const dest = join(dir, "out.bin");
    const { calls, fn } = mockFetch([
      () =>
        new Response(dyingBodyOf(["ab"], new Error("read ECONNRESET")), {
          status: 200,
          headers: { "content-length": "5", etag: '"v1"' },
        }),
      () =>
        new Response(bodyOf(["cde"]), {
          status: 206,
          headers: { "content-range": "bytes 2-4/5", etag: '"v1"' },
        }),
    ]);
    globalThis.fetch = fn;

    const retries: number[] = [];
    await downloadFile("https://example.com/x", dest, {
      ...FAST,
      onRetry: (info) => retries.push(info.attempt),
    });

    expect(calls).toHaveLength(2);
    expect(calls[1].get("range")).toBe("bytes=2-");
    expect(retries).toEqual([1]);
    expect(readFileSync(dest, "utf-8")).toBe("abcde");
  });

  it("treats a body that ends short of content-length as retryable", async () => {
    const dest = join(dir, "out.bin");
    const { calls, fn } = mockFetch([
      () =>
        new Response(bodyOf(["ab"]), {
          status: 200,
          headers: { "content-length": "4", etag: '"v1"' },
        }),
      () =>
        new Response(bodyOf(["cd"]), {
          status: 206,
          headers: { "content-range": "bytes 2-3/4", etag: '"v1"' },
        }),
    ]);
    globalThis.fetch = fn;

    await downloadFile("https://example.com/x", dest, FAST);
    expect(calls).toHaveLength(2);
    expect(readFileSync(dest, "utf-8")).toBe("abcd");
  });

  it("gives up after maxRetries and keeps the partial for the next call", async () => {
    const dest = join(dir, "out.bin");
    globalThis.fetch = mockFetch([
      () =>
        new Response(dyingBodyOf(["ab"], new Error("read ECONNRESET")), {
          status: 200,
          headers: { "content-length": "5", etag: '"v1"' },
        }),
      () =>
        new Response(dyingBodyOf([], new Error("read ECONNRESET")), {
          status: 206,
          headers: { "content-range": "bytes 2-4/5", etag: '"v1"' },
        }),
    ]).fn;

    await expect(
      downloadFile("https://example.com/x", dest, { ...FAST, maxRetries: 1 }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(existsSync(dest)).toBe(false);
    expect(readPartialDownload(dest)).toEqual({ transferred: 2, total: 5 });
  });

  it("does not retry a 404", async () => {
    const dest = join(dir, "out.bin");
    const { calls, fn } = mockFetch([
      () => new Response(null, { status: 404, statusText: "Not Found" }),
    ]);
    globalThis.fetch = fn;

    await expect(
      downloadFile("https://example.com/x", dest, FAST),
    ).rejects.toThrow(/HTTP 404/);
    expect(calls).toHaveLength(1);
  });

  it("retries a 503", async () => {
    const dest = join(dir, "out.bin");
    const { calls, fn } = mockFetch([
      () => new Response(null, { status: 503, statusText: "Unavailable" }),
      () =>
        new Response(bodyOf(["ok"]), {
          status: 200,
          headers: { "content-length": "2" },
        }),
    ]);
    globalThis.fetch = fn;

    await downloadFile("https://example.com/x", dest, FAST);
    expect(calls).toHaveLength(2);
    expect(readFileSync(dest, "utf-8")).toBe("ok");
  });

  it("does not retry after the caller aborts during the backoff", async () => {
    const dest = join(dir, "out.bin");
    const { calls, fn } = mockFetch([
      () => new Response(null, { status: 503, statusText: "Unavailable" }),
      () => new Response(bodyOf(["ok"]), { status: 200 }),
    ]);
    globalThis.fetch = fn;

    const controller = new AbortController();
    const pending = downloadFile("https://example.com/x", dest, {
      stallTimeoutMs: 0,
      retryDelayMs: 10_000,
      signal: controller.signal,
    });
    await waitFor(() => calls.length === 1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(1);
  });

  it("declares a silent connection stalled and resumes from the partial", async () => {
    const dest = join(dir, "out.bin");
    // First body: one chunk, then silence forever.
    const silent = new ReadableStream({
      pull(controller) {
        controller.enqueue(Buffer.from("ab"));
        return new Promise<void>(() => undefined);
      },
    });
    const { calls, fn } = mockFetch([
      () =>
        new Response(silent, {
          status: 200,
          headers: { "content-length": "4", etag: '"v1"' },
        }),
      () =>
        new Response(bodyOf(["cd"]), {
          status: 206,
          headers: { "content-range": "bytes 2-3/4", etag: '"v1"' },
        }),
    ]);
    globalThis.fetch = fn;

    const retries: string[] = [];
    await downloadFile("https://example.com/x", dest, {
      retryDelayMs: 1,
      stallTimeoutMs: 50,
      onRetry: (info) => retries.push(info.error.message),
    });

    expect(calls).toHaveLength(2);
    expect(calls[1].get("range")).toBe("bytes=2-");
    expect(retries[0]).toMatch(/stalled/);
    expect(readFileSync(dest, "utf-8")).toBe("abcd");
  });

  it("publishes a partial that already holds every byte when the server answers 416", async () => {
    const dest = join(dir, "out.bin");
    seedPartial(dest, "https://example.com/x", "abcdef", { total: 6, etag: '"v1"' });

    const { calls, fn } = mockFetch([
      () =>
        new Response(null, {
          status: 416,
          statusText: "Range Not Satisfiable",
          headers: { "content-range": "bytes */6" },
        }),
    ]);
    globalThis.fetch = fn;

    const seen: number[] = [];
    await downloadFile("https://example.com/x", dest, {
      ...FAST,
      onProgress: (p) => seen.push(p),
    });
    expect(calls[0].get("range")).toBe("bytes=6-");
    expect(readFileSync(dest, "utf-8")).toBe("abcdef");
    expect(seen).toEqual([100]);
  });

  it("removes a pre-resume .tmp leftover", async () => {
    const dest = join(dir, "out.bin");
    writeFileSync(`${dest}.tmp`, "junk");
    globalThis.fetch = mockFetch([
      () => new Response(bodyOf(["ok"]), { status: 200 }),
    ]).fn;

    await downloadFile("https://example.com/x", dest, FAST);
    expect(existsSync(`${dest}.tmp`)).toBe(false);
    expect(readFileSync(dest, "utf-8")).toBe("ok");
  });

  it("discardPartialDownload drops both files and readPartialDownload sees nothing", () => {
    const dest = join(dir, "out.bin");
    seedPartial(dest, "https://example.com/x", "abc", { total: 6, etag: null });
    expect(readPartialDownload(dest)).toEqual({ transferred: 3, total: 6 });
    discardPartialDownload(dest);
    expect(readPartialDownload(dest)).toBeNull();
    expect(existsSync(resolvePartialPath(dest))).toBe(false);
    expect(existsSync(resolvePartialMetaPath(dest))).toBe(false);
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
    await expect(
      downloadFile("https://example.invalid/big.bin", join(dir, "big.bin"), {
        ...FAST,
        maxRetries: 0,
        onProgress: (percent, transferred) => {
          seen.push({ percent, transferred });
        },
      }),
    ).rejects.toThrow(/ended early/);

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
      ...FAST,
      onProgress: (_percent, transferred) => {
        seen.push(transferred);
      },
    });

    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(5_000);
  });
});

function seedPartial(
  dest: string,
  url: string,
  bytes: string,
  meta: { total: number; etag: string | null },
): void {
  writeFileSync(resolvePartialPath(dest), bytes);
  writeFileSync(
    resolvePartialMetaPath(dest),
    JSON.stringify({ url, total: meta.total, etag: meta.etag, lastModified: null }),
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("waitFor timed out");
}
