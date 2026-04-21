import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GzipBackend } from "./gz-backend.js";
import { DEFAULT_EXTRACT_LIMITS } from "./archive-types.js";

const FIXTURE = resolve(
  new URL("../test-fixtures/sample.txt.gz", import.meta.url).pathname,
);

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "gz-backend-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("GzipBackend", () => {
  it("lists a single synthetic entry", async () => {
    const backend = new GzipBackend("sample.txt.gz");
    const entries = await backend.list(readFileSync(FIXTURE));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("sample.txt");
    expect(entries[0]?.kind).toBe("file");
    expect(entries[0]?.size).toBe(25);
  });

  it("reads the synthetic entry body", async () => {
    const backend = new GzipBackend("sample.txt.gz");
    const body = await backend.readEntry(readFileSync(FIXTURE), "sample.txt");
    expect(body.toString("utf8")).toBe("single file gzip payload\n");
  });

  it("rejects an unknown entry name", async () => {
    const backend = new GzipBackend("sample.txt.gz");
    await expect(
      backend.readEntry(readFileSync(FIXTURE), "other.txt"),
    ).rejects.toThrow(/entry not found/);
  });

  it("extracts to destDir with the stripped name", async () => {
    const backend = new GzipBackend("sample.txt.gz");
    await withTmp(async (dir) => {
      const report = await backend.extract(readFileSync(FIXTURE), {
        destDir: dir,
        overwrite: false,
        followSymlinks: false,
        limits: DEFAULT_EXTRACT_LIMITS,
      });
      expect(report.extractedEntries).toBe(1);
      const body = await readFile(join(dir, "sample.txt"), "utf8");
      expect(body).toBe("single file gzip payload\n");
    });
  });

  it("refuses to overwrite", async () => {
    const backend = new GzipBackend("sample.txt.gz");
    await withTmp(async (dir) => {
      await backend.extract(readFileSync(FIXTURE), {
        destDir: dir,
        overwrite: false,
        followSymlinks: false,
        limits: DEFAULT_EXTRACT_LIMITS,
      });
      const second = await backend.extract(readFileSync(FIXTURE), {
        destDir: dir,
        overwrite: false,
        followSymlinks: false,
        limits: DEFAULT_EXTRACT_LIMITS,
      });
      expect(second.extractedEntries).toBe(0);
    });
  });

  it("honours maxEntryBytes", async () => {
    const backend = new GzipBackend("sample.txt.gz");
    await withTmp(async (dir) => {
      const report = await backend.extract(readFileSync(FIXTURE), {
        destDir: dir,
        overwrite: false,
        followSymlinks: false,
        limits: { maxTotalBytes: 1_000_000, maxEntryBytes: 2, maxEntries: 10 },
      });
      expect(report.extractedEntries).toBe(0);
      expect(
        report.skippedEntries.some((s) => /entry_exceeds_max_entry_bytes/.test(s.reason)),
      ).toBe(true);
    });
  });
});
