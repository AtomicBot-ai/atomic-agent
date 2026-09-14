import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ToolContext } from "../tool-registry.js";
import {
  parseVerifySyntaxArgs,
  verifySyntax,
  verifySyntaxTool,
} from "./verify-syntax.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atag-verify-syntax-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return {
    workingDir: dir,
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("parseVerifySyntaxArgs", () => {
  it("requires a non-empty string array and dedupes it", () => {
    expect(() => parseVerifySyntaxArgs({})).toThrow(/files/);
    expect(() => parseVerifySyntaxArgs({ files: [] })).toThrow(/non-empty/);
    expect(() => parseVerifySyntaxArgs({ files: ["a", 1] })).toThrow(/string/);
    expect(parseVerifySyntaxArgs({ files: ["a.js", "a.js", "b.js"] })).toEqual([
      "a.js",
      "b.js",
    ]);
  });
});

describe("verifySyntax", () => {
  it("reports failures first, then unchecked, then passes, and never passes an unknown extension", async () => {
    await writeFile(join(dir, "ok.js"), "var a = 1;\n");
    await writeFile(join(dir, "bad.json"), "{oops}");
    await writeFile(join(dir, "data.xyz"), "whatever");
    await writeFile(join(dir, "more.xyz"), "whatever");
    await writeFile(join(dir, "style.css"), ".a { color: red; }\n");
    const out = await verifySyntax(
      ["ok.js", "bad.json", "data.xyz", "more.xyz", "style.css", "missing.js"],
      dir,
    );
    expect(out.passed).toBe(2);
    expect(out.failed).toBe(2);
    expect(out.unchecked).toBe(2);
    const lines = out.summary.split("\n");
    expect(lines[0]).toBe(
      "verify.syntax: 2 ok, 2 failed, 2 unchecked (unchecked files do not count as passing)",
    );
    expect(lines[1]).toBe("no checker for .xyz (2 files)");
    expect(lines.slice(2, 4).every((l) => l.startsWith("FAIL "))).toBe(true);
    expect(lines.slice(4, 6).every((l) => l.startsWith("unchecked "))).toBe(true);
    expect(lines.slice(6).every((l) => l.startsWith("ok "))).toBe(true);
    const byFile = new Map(out.results.map((r) => [r.file, r]));
    expect(byFile.get("data.xyz")).toEqual({
      file: "data.xyz",
      ok: null,
      checker: "none",
      error: "no checker for .xyz",
    });
    expect(byFile.get("missing.js")).toMatchObject({ ok: false, error: "no such file" });
    expect(byFile.get("bad.json")?.ok).toBe(false);
  });
});

describe("verify.syntax tool", () => {
  it("is read-only, errors when any file fails, and carries the per-file results", async () => {
    expect(verifySyntaxTool.readonly).toBe(true);
    await writeFile(join(dir, "a.js"), "var a = 1;\n");
    const ok = await verifySyntaxTool.run({ files: ["a.js"] }, ctx());
    expect(ok.status).toBe("ok");
    expect(ok.summary).toContain("ok a.js [node-vm]");
    await writeFile(join(dir, "b.js"), "var b = {\n");
    const failed = await verifySyntaxTool.run({ files: ["a.js", "b.js"] }, ctx());
    expect(failed.status).toBe("error");
    expect(failed.summary.split("\n")[1]).toMatch(/^FAIL b\.js \[node-vm\] — SyntaxError/);
    expect(failed.details.failed).toBe(1);
  });
});
