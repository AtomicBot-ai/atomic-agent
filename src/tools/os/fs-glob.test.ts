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
});
