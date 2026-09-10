import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  downloadFile,
  readPartialDownload,
  resolvePartialMetaPath,
  resolvePartialPath,
} from "./download-file.js";
import { writePartialMeta } from "./download-partial.js";

/** 64 distinct bytes: any misplaced segment shows up as a wrong byte. */
const DATA = Buffer.from(Array.from({ length: 64 }, (_, i) => 0x30 + (i % 64)));
const URL = "https://example.com/model.gguf";
const ETAG = '"v1"';
const CHUNK = 5;
/** Tiny segments so a 64-byte "file" exercises the fan-out. */
const FAST = { retryDelayMs: 1, stallTimeoutMs: 0, minSegmentBytes: 8 };

interface Call {
  range: string | null;
  ifRange: string | null;
}

/** Body that delivers `data` in `CHUNK`-byte pieces, then closes. */
function chunked(data: Buffer): ReadableStream {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= data.length) {
        controller.close();
        return;
      }
      controller.enqueue(data.subarray(at, Math.min(at + CHUNK, data.length)));
      at += CHUNK;
    },
  });
}

/** Body that delivers `data` in pieces and then dies. */
function dying(data: Buffer, error: Error): ReadableStream {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= data.length) {
        controller.error(error);
        return;
      }
      controller.enqueue(data.subarray(at, Math.min(at + CHUNK, data.length)));
      at += CHUNK;
    },
  });
}

/** Body that delivers `data` and then never says another word. */
function parked(data: Buffer): ReadableStream {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(data);
        return;
      }
      return new Promise<void>(() => undefined);
    },
  });
}

function parseRange(header: string | null, total: number): [number, number] | null {
  if (!header) return null;
  const m = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!m) return null;
  return [Number(m[1]), m[2] ? Number(m[2]) + 1 : total];
}

/**
 * A range-capable origin serving `DATA`. `override` swaps the answer to
 * the n-th request (1-based) for a fault; `body` shapes an honest
 * answer's stream for that request.
 */
function rangeServer(opts?: {
  acceptRanges?: boolean;
  override?: Record<number, (req: Call, slice: Buffer, range: [number, number]) => Response>;
}): { calls: Call[]; fn: typeof fetch } {
  const calls: Call[] = [];
  const acceptRanges = opts?.acceptRanges ?? true;
  const fn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = { range: headers.get("range"), ifRange: headers.get("if-range") };
    calls.push(call);
    const range = parseRange(call.range, DATA.length);
    const [start, end] = range ?? [0, DATA.length];
    const slice = DATA.subarray(start, end);
    const custom = opts?.override?.[calls.length];
    if (custom) return custom(call, slice, [start, end]);
    if (!range) {
      return new Response(chunked(slice), {
        status: 200,
        headers: {
          "content-length": String(DATA.length),
          etag: ETAG,
          ...(acceptRanges ? { "accept-ranges": "bytes" } : {}),
        },
      });
    }
    return new Response(chunked(slice), {
      status: 206,
      headers: {
        "content-range": `bytes ${start}-${end - 1}/${DATA.length}`,
        "content-length": String(slice.length),
        etag: ETAG,
      },
    });
  }) as unknown as typeof fetch;
  return { calls, fn };
}

function partial206(slice: Buffer, [start, end]: [number, number], etag = ETAG): Response {
  return new Response(chunked(slice), {
    status: 206,
    headers: { "content-range": `bytes ${start}-${end - 1}/${DATA.length}`, etag },
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("download-file parallel segments", () => {
  let dir: string;
  let dest: string;
  let prevFetch: typeof fetch;
  let prevEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "local-llm-par-"));
    dest = join(dir, "model.gguf");
    prevFetch = globalThis.fetch;
    prevEnv = process.env.ATOMIC_AGENT_DOWNLOAD_CONNECTIONS;
    delete process.env.ATOMIC_AGENT_DOWNLOAD_CONNECTIONS;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    if (prevEnv === undefined) delete process.env.ATOMIC_AGENT_DOWNLOAD_CONNECTIONS;
    else process.env.ATOMIC_AGENT_DOWNLOAD_CONNECTIONS = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it("splits a range-capable file across connections and reassembles it byte for byte", async () => {
    const { calls, fn } = rangeServer();
    globalThis.fetch = fn;
    const seen: Array<[number, number, number]> = [];

    await downloadFile(URL, dest, {
      ...FAST,
      connections: 4,
      onProgress: (p, t, tot) => seen.push([p, t, tot]),
    });

    // The plain GET doubles as segment 0; the other three ask for their
    // slices with closed ranges bound to the lead's validator.
    expect(calls.map((c) => c.range)).toEqual([null, "bytes=16-31", "bytes=32-47", "bytes=48-63"]);
    expect(calls.slice(1).every((c) => c.ifRange === ETAG)).toBe(true);
    expect(readFileSync(dest).equals(DATA)).toBe(true);
    expect(seen.at(-1)).toEqual([100, 64, 64]);
    expect(existsSync(resolvePartialPath(dest))).toBe(false);
    expect(existsSync(resolvePartialMetaPath(dest))).toBe(false);
  });

  it("stays on one stream when the server does not advertise ranges", async () => {
    const { calls, fn } = rangeServer({ acceptRanges: false });
    globalThis.fetch = fn;
    await downloadFile(URL, dest, { ...FAST, connections: 4 });
    expect(calls).toHaveLength(1);
    expect(readFileSync(dest).equals(DATA)).toBe(true);
  });

  it("honours ATOMIC_AGENT_DOWNLOAD_CONNECTIONS when no option is given", async () => {
    process.env.ATOMIC_AGENT_DOWNLOAD_CONNECTIONS = "2";
    const { calls, fn } = rangeServer();
    globalThis.fetch = fn;
    await downloadFile(URL, dest, FAST);
    expect(calls.map((c) => c.range)).toEqual([null, "bytes=32-63"]);
    expect(readFileSync(dest).equals(DATA)).toBe(true);
  });

  it("asks only for the holes of a segmented partial and opens the bar at its share", async () => {
    // Two of four slices already on disk, from an earlier run.
    const part = Buffer.alloc(48);
    DATA.copy(part, 0, 0, 16);
    DATA.copy(part, 32, 32, 48);
    writeFileSync(resolvePartialPath(dest), part);
    writePartialMeta(dest, {
      url: URL,
      total: 64,
      etag: ETAG,
      lastModified: null,
      done: [
        [0, 16],
        [32, 48],
      ],
    });
    const { calls, fn } = rangeServer();
    globalThis.fetch = fn;
    const seen: Array<[number, number, number]> = [];

    await downloadFile(URL, dest, {
      ...FAST,
      connections: 4,
      onProgress: (p, t, tot) => seen.push([p, t, tot]),
    });

    expect(calls[0]).toEqual({ range: "bytes=16-", ifRange: ETAG });
    expect(calls.slice(1).map((c) => c.range)).toEqual(["bytes=24-31", "bytes=48-55", "bytes=56-63"]);
    expect(seen[0]).toEqual([50, 32, 64]);
    expect(readFileSync(dest).equals(DATA)).toBe(true);
  });

  it("keeps the prefix of a pre-segment partial and splits only the remainder", async () => {
    writeFileSync(resolvePartialPath(dest), DATA.subarray(0, 16));
    writeFileSync(
      resolvePartialMetaPath(dest),
      JSON.stringify({ url: URL, total: 64, etag: ETAG, lastModified: null }),
    );
    const { calls, fn } = rangeServer();
    globalThis.fetch = fn;

    await downloadFile(URL, dest, { ...FAST, connections: 4 });

    expect(calls.map((c) => c.range)).toEqual([
      "bytes=16-",
      "bytes=28-39",
      "bytes=40-51",
      "bytes=52-63",
    ]);
    expect(readFileSync(dest).equals(DATA)).toBe(true);
  });

  it("records every written interval on abort, in a sidecar an old build will not misread", async () => {
    const { fn } = rangeServer({
      // Segment [48, 64) delivers four bytes and then hangs.
      override: { 4: (_req, slice, range) => partialParked(slice.subarray(0, 4), range) },
    });
    globalThis.fetch = fn;
    const controller = new AbortController();
    const pending = downloadFile(URL, dest, {
      ...FAST,
      connections: 4,
      signal: controller.signal,
    });
    await waitUntil(() => {
      try {
        const bytes = readFileSync(resolvePartialPath(dest));
        return bytes.length >= 52 && bytes.subarray(0, 52).equals(DATA.subarray(0, 52));
      } catch {
        return false;
      }
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    expect(existsSync(dest)).toBe(false);
    expect(readPartialDownload(dest)).toEqual({ transferred: 52, total: 64 });
    const raw = JSON.parse(readFileSync(resolvePartialMetaPath(dest), "utf-8"));
    expect(raw.done).toEqual([[0, 52]]);
    expect(raw.url).toBeUndefined();

    // The next call needs exactly the twelve missing bytes.
    const resume = rangeServer();
    globalThis.fetch = resume.fn;
    await downloadFile(URL, dest, { ...FAST, connections: 4 });
    expect(resume.calls.map((c) => c.range)).toEqual(["bytes=52-"]);
    expect(readFileSync(dest).equals(DATA)).toBe(true);
  });

  it("re-requests only the remainder of a segment whose body died, while the others finish", async () => {
    const { calls, fn } = rangeServer({
      override: {
        3: (_req, slice, [start, end]) =>
          new Response(dying(slice.subarray(0, 5), new Error("read ECONNRESET")), {
            status: 206,
            headers: { "content-range": `bytes ${start}-${end - 1}/${DATA.length}`, etag: ETAG },
          }),
      },
    });
    globalThis.fetch = fn;
    const retries: Array<{ attempt: number; message: string }> = [];

    await downloadFile(URL, dest, {
      ...FAST,
      connections: 4,
      onRetry: (info) => retries.push({ attempt: info.attempt, message: info.error.message }),
    });

    expect(calls.map((c) => c.range)).toEqual([
      null,
      "bytes=16-31",
      "bytes=32-47",
      "bytes=48-63",
      "bytes=37-47",
    ]);
    expect(retries).toEqual([{ attempt: 1, message: "read ECONNRESET" }]);
    expect(readFileSync(dest).equals(DATA)).toBe(true);
  });

  it("restarts from zero when a segment comes back with a different ETag", async () => {
    const { calls, fn } = rangeServer({
      override: { 2: (_req, slice, range) => partial206(slice, range, '"v2"') },
    });
    globalThis.fetch = fn;

    await downloadFile(URL, dest, { ...FAST, connections: 4, maxRetries: 1 });

    // Four requests for the first attempt, then a plain GET (the partial
    // was discarded) that fans out again.
    expect(calls[4]).toEqual({ range: null, ifRange: null });
    expect(calls).toHaveLength(8);
    expect(readFileSync(dest).equals(DATA)).toBe(true);
  });

  it("falls back to one stream, keeping its bytes, when a segment's Range is ignored", async () => {
    const { calls, fn } = rangeServer({
      override: {
        2: () =>
          new Response(chunked(DATA), {
            status: 200,
            headers: { "content-length": "64", etag: ETAG, "accept-ranges": "bytes" },
          }),
      },
    });
    globalThis.fetch = fn;

    await downloadFile(URL, dest, { ...FAST, connections: 4, maxRetries: 1 });

    // The first attempt was torn down after the 200 and a second attempt
    // resumed from whatever the sidecar vouched for — never from zero,
    // and as exactly one open-ended stream: no closed range may follow,
    // since this server has shown it ignores them.
    const afterFallback = calls.slice(4);
    expect(afterFallback).toHaveLength(1);
    expect(afterFallback[0]?.range).toMatch(/^bytes=\d+-$/);
    expect(afterFallback[0]?.ifRange).toBe(ETAG);
    expect(readFileSync(dest).equals(DATA)).toBe(true);
  });

  it("resumes a partial whose first hole starts at byte 0 instead of starting over", async () => {
    // The lead never delivered before the last run died; everything
    // else did.
    const part = Buffer.alloc(64);
    DATA.copy(part, 16, 16, 64);
    writeFileSync(resolvePartialPath(dest), part);
    writePartialMeta(dest, { url: URL, total: 64, etag: ETAG, lastModified: null, done: [[16, 64]] });
    const { calls, fn } = rangeServer();
    globalThis.fetch = fn;

    await downloadFile(URL, dest, { ...FAST, connections: 4 });

    // The 16-byte hole is worth two pieces; the lead covers the first.
    expect(calls.map((c) => c.range)).toEqual(["bytes=0-", "bytes=8-15"]);
    expect(calls.every((c) => c.ifRange === ETAG)).toBe(true);
    expect(readFileSync(dest).equals(DATA)).toBe(true);
  });

  it("refuses a sidecar that claims bytes the .part file does not have", async () => {
    // `.part` gone (deleted to free space), sidecar left behind.
    writePartialMeta(dest, { url: URL, total: 64, etag: ETAG, lastModified: null, done: [[0, 52]] });
    expect(readPartialDownload(dest)).toBeNull();
    const { calls, fn } = rangeServer();
    globalThis.fetch = fn;

    await downloadFile(URL, dest, { ...FAST, connections: 4 });

    expect(calls[0]?.range).toBeNull();
    expect(readFileSync(dest).equals(DATA)).toBe(true);

    // Truncated `.part`: the same answer.
    rmSync(dest);
    writeFileSync(resolvePartialPath(dest), DATA.subarray(0, 20));
    writePartialMeta(dest, { url: URL, total: 64, etag: ETAG, lastModified: null, done: [[0, 52]] });
    expect(readPartialDownload(dest)).toBeNull();
  });

  it("publishes a complete partial of unknown length when the server answers 416", async () => {
    writeFileSync(resolvePartialPath(dest), DATA);
    writeFileSync(
      resolvePartialMetaPath(dest),
      JSON.stringify({ url: URL, total: 0, etag: ETAG, lastModified: null }),
    );
    const { calls, fn } = rangeServer({
      override: {
        1: () =>
          new Response(null, {
            status: 416,
            statusText: "Range Not Satisfiable",
            headers: { "content-range": "bytes */64" },
          }),
      },
    });
    globalThis.fetch = fn;

    await downloadFile(URL, dest, { ...FAST, connections: 4 });
    expect(calls.map((c) => c.range)).toEqual(["bytes=64-"]);
    expect(readFileSync(dest).equals(DATA)).toBe(true);
  });
});

function partialParked(slice: Buffer, [start, end]: [number, number]): Response {
  return new Response(parked(slice), {
    status: 206,
    headers: { "content-range": `bytes ${start}-${end - 1}/${DATA.length}`, etag: ETAG },
  });
}
