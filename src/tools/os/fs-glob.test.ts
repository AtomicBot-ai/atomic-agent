import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tool-registry.js";
import { compileGlob, osFsGlobTool } from "./fs-glob.js";

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: "test-session",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("compileGlob", () => {
  it("matches simple filename wildcards within a single segment", () => {
    const re = compileGlob("*.ts");
    expect(re.test("foo.ts")).toBe(true);
    expect(re.test("foo.tsx")).toBe(false);
    expect(re.test("a/foo.ts")).toBe(false);
  });

  it("matches ** across any number of path segments including zero", () => {
    const re = compileGlob("**/*.ts");
    expect(re.test("foo.ts")).toBe(true);
    expect(re.test("a/foo.ts")).toBe(true);
    expect(re.test("a/b/c/foo.ts")).toBe(true);
    expect(re.test("a/foo.tsx")).toBe(false);
  });

  it("matches ? as exactly one non-separator char", () => {
    const re = compileGlob("a?.ts");
    expect(re.test("ab.ts")).toBe(true);
    expect(re.test("a.ts")).toBe(false);
    expect(re.test("abc.ts")).toBe(false);
  });

  it("expands brace alternatives", () => {
    const re = compileGlob("file.{ts,tsx,js}");
    expect(re.test("file.ts")).toBe(true);
    expect(re.test("file.tsx")).toBe(true);
    expect(re.test("file.js")).toBe(true);
    expect(re.test("file.py")).toBe(false);
  });

  it("combines ** with braces", () => {
    const re = compileGlob("src/**/*.{ts,tsx}");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/a/b.tsx")).toBe(true);
    expect(re.test("src/a/b/c.ts")).toBe(true);
    expect(re.test("src/a.py")).toBe(false);
    expect(re.test("other/a.ts")).toBe(false);
  });

  it("escapes regex metacharacters in literal segments", () => {
    const re = compileGlob("a.b+c.txt");
    expect(re.test("a.b+c.txt")).toBe(true);
    expect(re.test("aXbXcXtxt")).toBe(false);
  });

  it("is case-sensitive by default and case-insensitive with flag i", () => {
    const cs = compileGlob("**/*cv*");
    expect(cs.test("dir/Resume CV.pdf")).toBe(false);
    const ci = compileGlob("**/*cv*", "i");
    expect(ci.test("dir/Resume CV.pdf")).toBe(true);
    expect(ci.test("dir/Resume cv.pdf")).toBe(true);
  });
});

describe("os.fs.glob", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-glob-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists files matching a pattern relative to cwd", async () => {
    await writeFile(join(dir, "a.ts"), "", "utf8");
    await writeFile(join(dir, "b.ts"), "", "utf8");
    await writeFile(join(dir, "c.js"), "", "utf8");
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "d.ts"), "", "utf8");
    const result = await osFsGlobTool.run(
      { pattern: "**/*.ts" },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect((result.details.files as string[]).sort()).toEqual([
      "a.ts",
      "b.ts",
      "sub/d.ts",
    ]);
  });

  it("honours default ignore list (node_modules)", async () => {
    await mkdir(join(dir, "node_modules", "foo"), { recursive: true });
    await writeFile(join(dir, "node_modules", "foo", "skip.ts"), "", "utf8");
    await writeFile(join(dir, "keep.ts"), "", "utf8");
    const result = await osFsGlobTool.run(
      { pattern: "**/*.ts" },
      makeCtx(dir),
    );
    expect(result.details.files).toEqual(["keep.ts"]);
  });

  it("supports custom ignore list", async () => {
    await mkdir(join(dir, "build"));
    await writeFile(join(dir, "build", "out.ts"), "", "utf8");
    await writeFile(join(dir, "src.ts"), "", "utf8");
    const result = await osFsGlobTool.run(
      { pattern: "**/*.ts", ignore: ["**/build/**"] },
      makeCtx(dir),
    );
    expect(result.details.files).toEqual(["src.ts"]);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      await writeFile(join(dir, `f${i}.ts`), "", "utf8");
    }
    const result = await osFsGlobTool.run(
      { pattern: "**/*.ts", limit: 3 },
      makeCtx(dir),
    );
    const files = result.details.files as string[];
    expect(files.length).toBe(3);
    expect(result.details.truncated).toBe(true);
  });

  it("returns absolute paths when absolute=true", async () => {
    await writeFile(join(dir, "a.ts"), "", "utf8");
    const result = await osFsGlobTool.run(
      { pattern: "**/*.ts", absolute: true },
      makeCtx(dir),
    );
    const files = result.details.files as string[];
    expect(files.length).toBe(1);
    expect(files[0]).toBe(join(dir, "a.ts"));
  });

  it("sorts by mtime descending when sortByMtime=true", async () => {
    const older = join(dir, "older.ts");
    const newer = join(dir, "newer.ts");
    await writeFile(older, "", "utf8");
    await writeFile(newer, "", "utf8");
    const past = new Date(Date.now() - 60_000);
    await utimes(older, past, past);
    const result = await osFsGlobTool.run(
      { pattern: "**/*.ts", sortByMtime: true },
      makeCtx(dir),
    );
    expect(result.details.files).toEqual(["newer.ts", "older.ts"]);
  });

  it("accepts multiple patterns as an array", async () => {
    await writeFile(join(dir, "a.ts"), "", "utf8");
    await writeFile(join(dir, "b.md"), "", "utf8");
    await writeFile(join(dir, "c.py"), "", "utf8");
    const result = await osFsGlobTool.run(
      { pattern: ["**/*.ts", "**/*.md"] },
      makeCtx(dir),
    );
    expect((result.details.files as string[]).sort()).toEqual(["a.ts", "b.md"]);
  });

  it("treats path as search root when cwd is omitted (alias for os.fs.list ergonomics)", async () => {
    const target = join(dir, "target");
    const other = join(dir, "other");
    await mkdir(target);
    await mkdir(other);
    await writeFile(join(target, "found.txt"), "", "utf8");
    await writeFile(join(other, "noise.txt"), "", "utf8");
    const result = await osFsGlobTool.run(
      { pattern: "*.txt", path: target },
      makeCtx(other),
    );
    expect(result.status).toBe("ok");
    expect(result.details.files).toEqual(["found.txt"]);
    expect(result.details.cwd).toBe(target);
  });

  it("prefers cwd over path when both are set", async () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    await mkdir(a);
    await mkdir(b);
    await writeFile(join(a, "x.txt"), "", "utf8");
    await writeFile(join(b, "y.txt"), "", "utf8");
    const result = await osFsGlobTool.run(
      { pattern: "*.txt", cwd: a, path: b },
      makeCtx(dir),
    );
    expect(result.details.files).toEqual(["x.txt"]);
  });

  it("sortByMtime returns globally newest within limit, even when many noise files in alphabetically earlier dirs", async () => {
    // .cache sorts before Downloads alphabetically — this mirrors the real
    // bug where the walk filled limit on .cache files and never reached the
    // real target. With the fix the whole tree is walked and the newest
    // matches win regardless of walk order.
    await mkdir(join(dir, ".cache"));
    for (let i = 0; i < 20; i++) {
      const p = join(dir, ".cache", `noise-cv-${i}.txt`);
      await writeFile(p, "", "utf8");
      const past = new Date(Date.now() - 60 * 60_000);
      await utimes(p, past, past);
    }
    await mkdir(join(dir, "Downloads"));
    const target = join(dir, "Downloads", "Nikita CV.pdf");
    await writeFile(target, "", "utf8");
    const now = new Date();
    await utimes(target, now, now);
    const result = await osFsGlobTool.run(
      {
        pattern: ["**/*cv*", "**/*CV*"],
        ignore: [],
        sortByMtime: true,
        limit: 1,
      },
      makeCtx(dir),
    );
    const files = result.details.files as string[];
    expect(files).toEqual(["Downloads/Nikita CV.pdf"]);
    expect(result.details.truncated).toBe(true);
  });

  it("nocase=true matches mixed-case basenames in one pass", async () => {
    await mkdir(join(dir, "Downloads"));
    await writeFile(join(dir, "Downloads", "Nikita CV.pdf"), "", "utf8");
    await writeFile(join(dir, "Downloads", "alex_cv.pdf"), "", "utf8");
    const result = await osFsGlobTool.run(
      { pattern: "**/*cv*.pdf", ignore: [], nocase: true },
      makeCtx(dir),
    );
    expect((result.details.files as string[]).sort()).toEqual([
      "Downloads/Nikita CV.pdf",
      "Downloads/alex_cv.pdf",
    ]);
  });

  it("default ignore skips .cache, Library, .cargo and similar caches", async () => {
    for (const trashy of [".cache", "Library", ".cargo", "__pycache__", ".npm"]) {
      await mkdir(join(dir, trashy));
      await writeFile(join(dir, trashy, "noise.txt"), "", "utf8");
    }
    await writeFile(join(dir, "keep.txt"), "", "utf8");
    const result = await osFsGlobTool.run(
      { pattern: "**/*.txt" },
      makeCtx(dir),
    );
    expect(result.details.files).toEqual(["keep.txt"]);
  });

  it("explicit ignore=[] re-enables searching default-ignored dirs", async () => {
    await mkdir(join(dir, ".cache"));
    await writeFile(join(dir, ".cache", "found.txt"), "", "utf8");
    const result = await osFsGlobTool.run(
      { pattern: "**/*.txt", ignore: [] },
      makeCtx(dir),
    );
    expect(result.details.files).toEqual([".cache/found.txt"]);
  });
});
