import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createVerifyWorkspace,
  measureTree,
  VERIFY_COPY_EXCLUDED,
} from "./verify-workspace-copy.js";

let root: string;
let work: string;
let tmpRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atag-verify-copy-"));
  work = join(root, "work");
  tmpRoot = join(root, "tmp");
  await mkdir(work);
  await mkdir(tmpRoot);
  await writeFile(join(work, "index.html"), "<html></html>");
  await mkdir(join(work, "src"));
  await writeFile(join(work, "src", "app.js"), "var a = 1;");
  await writeFile(join(work, "run.sh"), "#!/bin/sh\necho hi\n");
  await chmod(join(work, "run.sh"), 0o755);
  await mkdir(join(work, "node_modules", "dep"), { recursive: true });
  await writeFile(join(work, "node_modules", "dep", "index.js"), "module.exports = 1;");
  await mkdir(join(work, ".git"));
  await writeFile(join(work, ".git", "HEAD"), "ref: refs/heads/main");
  await symlink("src/app.js", join(work, "link.js"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("measureTree", () => {
  it("sums file sizes without the excluded directories and stops early past the limit", async () => {
    const size = await measureTree(work, Number.MAX_SAFE_INTEGER);
    // index.html (13) + app.js (10) + run.sh (18); node_modules and .git skipped.
    expect(size).toBe(13 + 10 + 18);
    expect(await measureTree(work, 5)).toBeGreaterThan(5);
    expect(await measureTree(work, 5)).toBeLessThan(13 + 10 + 18);
  });
});

describe("createVerifyWorkspace", () => {
  it("copies the tree, symlinks the excluded directories, keeps modes and symlinks", async () => {
    const ws = await createVerifyWorkspace(work, { platform: "linux", tmpRoot });
    try {
      expect(ws.isolated).toBe(true);
      expect(ws.method).toBe("copy");
      expect(ws.dir.startsWith(join(tmpRoot, "atag-verify-"))).toBe(true);
      expect(await readFile(join(ws.dir, "src", "app.js"), "utf8")).toBe("var a = 1;");
      expect((await lstat(join(ws.dir, "run.sh"))).mode & 0o111).not.toBe(0);
      expect((await lstat(join(ws.dir, "link.js"))).isSymbolicLink()).toBe(true);
      for (const name of ["node_modules", ".git"]) {
        expect(VERIFY_COPY_EXCLUDED.has(name)).toBe(true);
        expect((await lstat(join(ws.dir, name))).isSymbolicLink()).toBe(true);
      }
      expect(await readFile(join(ws.dir, "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports = 1;");
      // A write in the copy never reaches the source.
      await writeFile(join(ws.dir, "evidence.txt"), "x");
      expect(await readdir(work)).not.toContain("evidence.txt");
    } finally {
      await ws.cleanup();
    }
    expect(await readdir(tmpRoot)).toEqual([]);
    // Cleanup removed the links, not their targets.
    expect(await readFile(join(work, "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports = 1;");
  });

  it("runs in place, not isolated, when the tree is over the byte limit", async () => {
    const ws = await createVerifyWorkspace(work, { platform: "linux", tmpRoot, maxBytes: 10 });
    expect(ws).toMatchObject({ dir: work, isolated: false, method: "in-place" });
    await ws.cleanup();
    expect(await readdir(work)).toContain("index.html");
  });

  it("uses clonefile on macOS and falls back to the copy when the clone fails", async () => {
    let cloneCalls = 0;
    const cloned = await createVerifyWorkspace(work, {
      platform: "darwin",
      tmpRoot,
      clone: async (src, dest) => {
        cloneCalls += 1;
        await mkdir(dest);
        await writeFile(join(dest, "cloned"), src);
        return true;
      },
    });
    expect(cloneCalls).toBe(1);
    expect(cloned.method).toBe("clonefile");
    expect(await readFile(join(cloned.dir, "cloned"), "utf8")).toBe(work);
    await cloned.cleanup();

    const fallback = await createVerifyWorkspace(work, {
      platform: "darwin",
      tmpRoot,
      clone: async () => false,
    });
    expect(fallback.method).toBe("copy");
    expect(await readFile(join(fallback.dir, "index.html"), "utf8")).toBe("<html></html>");
    await fallback.cleanup();
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it.skipIf(process.platform !== "darwin")("the real cp -c clone is complete and separate from the source", async () => {
    const ws = await createVerifyWorkspace(work, { tmpRoot });
    try {
      expect(ws.method).toBe("clonefile");
      expect(await readFile(join(ws.dir, "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports = 1;");
      expect((await lstat(join(ws.dir, "node_modules"))).isSymbolicLink()).toBe(false);
      await writeFile(join(ws.dir, "src", "app.js"), "changed");
      expect(await readFile(join(work, "src", "app.js"), "utf8")).toBe("var a = 1;");
    } finally {
      await ws.cleanup();
    }
    expect(await readdir(tmpRoot)).toEqual([]);
  });
});
