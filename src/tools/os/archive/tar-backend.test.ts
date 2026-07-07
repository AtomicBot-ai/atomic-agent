import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TarBackend } from "./tar-backend.js";
import { DEFAULT_EXTRACT_LIMITS } from "./archive-types.js";

const TAR_FIXTURE = resolve(
  fileURLToPath(new URL("../test-fixtures/sample.tar", import.meta.url)),
);
const TGZ_FIXTURE = resolve(
  fileURLToPath(new URL("../test-fixtures/sample.tar.gz", import.meta.url)),
);

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "tar-backend-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("TarBackend", () => {
  it("lists entries from a plain .tar", async () => {
    const backend = new TarBackend("tar");
    const entries = await backend.list(readFileSync(TAR_FIXTURE));
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("hello.txt");
    expect(paths).toContain("nested/world.txt");
  });

  it("lists entries from a .tar.gz", async () => {
    const backend = new TarBackend("tar.gz");
    const entries = await backend.list(readFileSync(TGZ_FIXTURE));
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("hello.txt");
  });

  it("reads a single entry from tar", async () => {
    const backend = new TarBackend("tar");
    const body = await backend.readEntry(readFileSync(TAR_FIXTURE), "hello.txt");
    expect(body.toString("utf8")).toBe("Hello from the archive.\n");
  });

  it("reads a single entry from tar.gz", async () => {
    const backend = new TarBackend("tar.gz");
    const body = await backend.readEntry(
      readFileSync(TGZ_FIXTURE),
      "nested/world.txt",
    );
    expect(body.toString("utf8")).toBe("Nested payload.\n");
  });

  it("extracts from a plain tar", async () => {
    const backend = new TarBackend("tar");
    await withTmp(async (dir) => {
      const report = await backend.extract(readFileSync(TAR_FIXTURE), {
        destDir: dir,
        overwrite: false,
        followSymlinks: false,
        limits: DEFAULT_EXTRACT_LIMITS,
      });
      expect(report.extractedEntries).toBeGreaterThanOrEqual(2);
      expect(await readFile(join(dir, "hello.txt"), "utf8")).toBe(
        "Hello from the archive.\n",
      );
    });
  });

  it("extracts from a tar.gz", async () => {
    const backend = new TarBackend("tar.gz");
    await withTmp(async (dir) => {
      const report = await backend.extract(readFileSync(TGZ_FIXTURE), {
        destDir: dir,
        overwrite: false,
        followSymlinks: false,
        limits: DEFAULT_EXTRACT_LIMITS,
      });
      expect(report.extractedEntries).toBeGreaterThanOrEqual(2);
      expect(await readFile(join(dir, "nested/world.txt"), "utf8")).toBe(
        "Nested payload.\n",
      );
    });
  });

  it("honours the maxEntries cap", async () => {
    const backend = new TarBackend("tar");
    await withTmp(async (dir) => {
      const report = await backend.extract(readFileSync(TAR_FIXTURE), {
        destDir: dir,
        overwrite: false,
        followSymlinks: false,
        limits: { maxTotalBytes: 1_000_000, maxEntryBytes: 1_000_000, maxEntries: 1 },
      });
      expect(
        report.skippedEntries.some((s) => /max_entries_exceeded/.test(s.reason)),
      ).toBe(true);
    });
  });
});
