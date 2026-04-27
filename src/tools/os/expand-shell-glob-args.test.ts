import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandShellGlobArgs } from "./expand-shell-glob-args.js";

describe("expandShellGlobArgs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-glob-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("expands * for rm with cwd-relative pattern", async () => {
    await writeFile(join(dir, "a.png"), "1", "utf8");
    await writeFile(join(dir, "b.png"), "2", "utf8");
    await writeFile(join(dir, "c.txt"), "3", "utf8");
    const out = expandShellGlobArgs("rm", ["-f", "*.png"], dir);
    expect(out[0]).toBe("-f");
    expect(new Set(out.slice(1))).toEqual(
      new Set([join(dir, "a.png"), join(dir, "b.png")]),
    );
  });

  it("omits argv when glob matches nothing (nullglob-style)", async () => {
    await writeFile(join(dir, "c.txt"), "3", "utf8");
    const out = expandShellGlobArgs("rm", ["-f", "*.png"], dir);
    expect(out).toEqual(["-f"]);
  });

  it("does not expand bare *.py for find", async () => {
    await writeFile(join(dir, "a.py"), "x", "utf8");
    const out = expandShellGlobArgs("find", [".", "-name", "*.py"], dir);
    expect(out).toEqual([".", "-name", "*.py"]);
  });

  it("does not expand flag-like tokens", () => {
    const out = expandShellGlobArgs("rm", ["-f"], dir);
    expect(out).toEqual(["-f"]);
  });
});
