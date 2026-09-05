import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintWorkspace } from "./workspace-fingerprint.js";

describe("fingerprintWorkspace", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-fp-"));
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "app.py"), "print('a')\n");
    await writeFile(join(dir, "README.md"), "# readme\n");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is stable across calls when nothing changes", () => {
    const first = fingerprintWorkspace(dir);
    const second = fingerprintWorkspace(dir);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("changes when a file's content changes (any writer: tool, shell, external)", async () => {
    const before = fingerprintWorkspace(dir);
    // The fingerprint observes the filesystem itself, so a write from an
    // Atomic tool, a shell command, or an external process all look the
    // same: the file's size/mtime moved.
    await writeFile(join(dir, "src", "app.py"), "print('changed')\n");
    expect(fingerprintWorkspace(dir)).not.toBe(before);
  });

  it("changes on a same-size replacement via mtime", async () => {
    const path = join(dir, "src", "app.py");
    await writeFile(path, "print('a')\n");
    await utimes(path, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const before = fingerprintWorkspace(dir);
    // Same byte length, different content — only mtime distinguishes it.
    await writeFile(path, "print('b')\n");
    await utimes(path, new Date(1_700_000_111_000), new Date(1_700_000_111_000));
    expect(fingerprintWorkspace(dir)).not.toBe(before);
  });

  it("changes when a file is added or removed", async () => {
    const before = fingerprintWorkspace(dir);
    await writeFile(join(dir, "src", "new_test.py"), "def test(): pass\n");
    const withFile = fingerprintWorkspace(dir);
    expect(withFile).not.toBe(before);
    await rm(join(dir, "src", "new_test.py"));
    expect(fingerprintWorkspace(dir)).toBe(before);
  });

  it("ignores churn in cache/output directories (documented ignores)", async () => {
    await mkdir(join(dir, "coverage"));
    await mkdir(join(dir, ".pytest_cache"));
    await mkdir(join(dir, "node_modules"));
    const before = fingerprintWorkspace(dir);
    await writeFile(join(dir, "coverage", "index.html"), "<html>1</html>");
    await writeFile(join(dir, ".pytest_cache", "v"), "cache");
    await writeFile(join(dir, "node_modules", "pkg.js"), "module");
    expect(fingerprintWorkspace(dir)).toBe(before);
  });

  it("ignores root-level coverage artifact files", async () => {
    const before = fingerprintWorkspace(dir);
    await writeFile(join(dir, ".coverage"), "data-1");
    await writeFile(join(dir, ".coverage.host.123"), "data-2");
    await writeFile(join(dir, "coverage.xml"), "<xml/>");
    expect(fingerprintWorkspace(dir)).toBe(before);
  });

  it("returns null for a missing root or a non-directory", async () => {
    expect(fingerprintWorkspace(join(dir, "does-not-exist"))).toBeNull();
    expect(fingerprintWorkspace(join(dir, "README.md"))).toBeNull();
  });
});
