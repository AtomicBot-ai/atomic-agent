import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  completedRanges,
  discardPartialDownload,
  holesIn,
  mergeRanges,
  readPartialDownload,
  readPartialMeta,
  resolvePartialMetaPath,
  resolvePartialPath,
  sumRanges,
  writePartialMeta,
} from "./download-partial.js";

describe("download-partial ranges", () => {
  it("mergeRanges sorts, drops empties and joins touching intervals", () => {
    expect(
      mergeRanges([
        [40, 50],
        [0, 10],
        [10, 20],
        [30, 30],
        [15, 25],
      ]),
    ).toEqual([
      [0, 25],
      [40, 50],
    ]);
  });

  it("sumRanges counts bytes", () => {
    expect(
      sumRanges([
        [0, 10],
        [20, 25],
      ]),
    ).toBe(15);
    expect(sumRanges([])).toBe(0);
  });

  it("holesIn returns the complement inside the declared length", () => {
    expect(holesIn([], 100)).toEqual([[0, 100]]);
    expect(holesIn([[0, 100]], 100)).toEqual([]);
    expect(
      holesIn(
        [
          [0, 10],
          [30, 40],
        ],
        100,
      ),
    ).toEqual([
      [10, 30],
      [40, 100],
    ]);
    expect(holesIn([[20, 100]], 100)).toEqual([[0, 20]]);
  });
});

describe("download-partial sidecar", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "local-llm-partial-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a current sidecar and never writes a `url` key", () => {
    const dest = join(dir, "out.bin");
    writePartialMeta(dest, {
      url: "https://example.com/x",
      total: 64,
      etag: '"v1"',
      lastModified: null,
      done: [
        [32, 48],
        [0, 16],
      ],
    });
    const raw = JSON.parse(readFileSync(resolvePartialMetaPath(dest), "utf-8"));
    // A pre-segment build reads `url` and would resume by file size onto
    // a sparse partial; without the key it starts over instead.
    expect(raw.url).toBeUndefined();
    expect(raw.source).toBe("https://example.com/x");
    expect(raw.version).toBe(2);
    expect(readPartialMeta(dest)).toEqual({
      url: "https://example.com/x",
      total: 64,
      etag: '"v1"',
      lastModified: null,
      done: [
        [0, 16],
        [32, 48],
      ],
    });
    expect(existsSync(`${resolvePartialMetaPath(dest)}.tmp`)).toBe(false);
  });

  it("reads a pre-segment sidecar as a prefix measured by file size", () => {
    const dest = join(dir, "out.bin");
    writeFileSync(resolvePartialPath(dest), "abcde");
    writeFileSync(
      resolvePartialMetaPath(dest),
      JSON.stringify({
        url: "https://example.com/x",
        total: 10,
        etag: null,
        lastModified: null,
      }),
    );
    const meta = readPartialMeta(dest);
    expect(meta?.done).toBeNull();
    expect(completedRanges(dest, meta!)).toEqual([[0, 5]]);
    expect(readPartialDownload(dest)).toEqual({ transferred: 5, total: 10 });
  });

  it("treats bytes past the declared total as unusable", () => {
    const dest = join(dir, "out.bin");
    writeFileSync(resolvePartialPath(dest), "toolongforthis");
    writeFileSync(
      resolvePartialMetaPath(dest),
      JSON.stringify({
        url: "https://example.com/x",
        total: 4,
        etag: null,
        lastModified: null,
      }),
    );
    expect(completedRanges(dest, readPartialMeta(dest)!)).toEqual([]);
    expect(readPartialDownload(dest)).toBeNull();
  });

  it("rejects a malformed interval list rather than guessing", () => {
    const dest = join(dir, "out.bin");
    writeFileSync(
      resolvePartialMetaPath(dest),
      JSON.stringify({
        version: 2,
        source: "https://example.com/x",
        total: 8,
        done: [[4, 2]],
      }),
    );
    expect(readPartialMeta(dest)).toBeNull();
    writeFileSync(resolvePartialMetaPath(dest), "{ not json");
    expect(readPartialMeta(dest)).toBeNull();
  });

  it("sums a segmented partial's intervals, not its file size", () => {
    const dest = join(dir, "out.bin");
    // 64 bytes on disk, but only 32 of them vouched for.
    writeFileSync(resolvePartialPath(dest), Buffer.alloc(64));
    writePartialMeta(dest, {
      url: "https://example.com/x",
      total: 64,
      etag: null,
      lastModified: null,
      done: [
        [0, 16],
        [48, 64],
      ],
    });
    expect(readPartialDownload(dest)).toEqual({ transferred: 32, total: 64 });
    discardPartialDownload(dest);
    expect(readPartialDownload(dest)).toBeNull();
  });
});
