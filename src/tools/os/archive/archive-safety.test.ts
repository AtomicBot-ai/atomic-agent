import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ExtractBudget, sanitizeEntryPath } from "./archive-safety.js";

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "archive-safety-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("sanitizeEntryPath", () => {
  it("accepts a plain relative path", () => {
    withTmp((dir) => {
      const result = sanitizeEntryPath(dir, "foo/bar.txt");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.normalised).toBe("foo/bar.txt");
        expect(result.value.absolute.startsWith(dir + sep)).toBe(true);
      }
    });
  });

  it("rejects absolute POSIX paths", () => {
    withTmp((dir) => {
      const result = sanitizeEntryPath(dir, "/etc/passwd");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.reason).toBe("absolute_path");
    });
  });

  it("rejects Windows-drive-letter paths", () => {
    withTmp((dir) => {
      const result = sanitizeEntryPath(dir, "C:/Windows/notepad.exe");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.reason).toBe("absolute_path");
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects backslashes inside entry names (POSIX)",
    () => {
      withTmp((dir) => {
        const result = sanitizeEntryPath(dir, "foo\\bar.txt");
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.reason).toBe("backslash_in_path");
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "treats backslashes as path separators on Windows",
    () => {
      withTmp((dir) => {
        // On Windows `\` is a legitimate separator, so archive entries with
        // backslashes are normalised to `/` and validated as nested paths.
        const result = sanitizeEntryPath(dir, "foo\\bar.txt");
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.normalised).toBe("foo/bar.txt");
      });
    },
  );

  it("rejects zip-slip traversal", () => {
    withTmp((dir) => {
      const result = sanitizeEntryPath(dir, "../../etc/passwd");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.reason).toBe("traversal_escapes_dest");
    });
  });

  it("rejects null-byte smuggling", () => {
    withTmp((dir) => {
      const result = sanitizeEntryPath(dir, "foo\0bar");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.reason).toBe("null_byte");
    });
  });

  it("rejects empty paths", () => {
    withTmp((dir) => {
      expect(sanitizeEntryPath(dir, "").ok).toBe(false);
      expect(sanitizeEntryPath(dir, ".").ok).toBe(false);
      expect(sanitizeEntryPath(dir, "./").ok).toBe(false);
    });
  });

  it("strips trailing slash from directory entries", () => {
    withTmp((dir) => {
      const result = sanitizeEntryPath(dir, "foo/bar/");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.normalised).toBe("foo/bar");
    });
  });

  it("normalises a nested traversal that stays inside destDir", () => {
    withTmp((dir) => {
      const result = sanitizeEntryPath(dir, "foo/../bar.txt");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.absolute).toBe(join(dir, "bar.txt"));
    });
  });
});

describe("ExtractBudget", () => {
  const limits = { maxTotalBytes: 100, maxEntryBytes: 40, maxEntries: 3 };

  it("allows entries up to every cap", () => {
    const b = new ExtractBudget(limits);
    expect(b.chargeEntry(30).ok).toBe(true);
    expect(b.chargeEntry(30).ok).toBe(true);
    expect(b.chargeEntry(30).ok).toBe(true);
    expect(b.snapshot).toEqual({ entryCount: 3, totalBytes: 90 });
  });

  it("rejects when max entry bytes exceeded", () => {
    const b = new ExtractBudget(limits);
    const d = b.chargeEntry(50);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/entry_exceeds_max_entry_bytes/);
  });

  it("rejects when total cap would be exceeded", () => {
    const b = new ExtractBudget(limits);
    b.chargeEntry(40);
    b.chargeEntry(40);
    const d = b.chargeEntry(30);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/total_bytes_exceeds_cap/);
  });

  it("rejects when max entries exceeded", () => {
    const b = new ExtractBudget({ maxTotalBytes: 1_000_000, maxEntryBytes: 1_000, maxEntries: 2 });
    b.chargeEntry(1);
    b.chargeEntry(1);
    const d = b.chargeEntry(1);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/max_entries_exceeded/);
  });
});
