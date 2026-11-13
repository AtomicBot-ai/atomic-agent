import { describe, expect, it } from "vitest";

import { WrittenFilesTracker } from "./worker-files-written.js";

describe("WrittenFilesTracker (ATO-1364)", () => {
  it("counts distinct files, not write calls", () => {
    const t = new WrittenFilesTracker();
    t.observeParsed({ tool: "os.fs.write", args: { path: "src/a.ts" } }, 0);
    expect(t.observeExecuted({ tool: "os.fs.write", status: "ok" }, 0)).toBe(true);
    t.observeParsed({ tool: "os.fs.edit", args: { path: "./src/a.ts" } }, 0);
    expect(t.observeExecuted({ tool: "os.fs.edit", status: "ok" }, 0)).toBe(false);
    expect(t.count).toBe(1);
  });

  it("pairs a batch's calls with their results by batch index", () => {
    const t = new WrittenFilesTracker();
    t.observeParsed({ tool: "os.fs.write", args: { path: "a" } }, 0);
    t.observeParsed({ tool: "os.fs.write", args: { path: "b" } }, 1);
    t.observeExecuted({ tool: "os.fs.write", status: "error" }, 0);
    t.observeExecuted({ tool: "os.fs.write", status: "ok" }, 1);
    expect(t.count).toBe(1);
  });

  it("ignores reads, failed writes and results it never saw parsed", () => {
    const t = new WrittenFilesTracker();
    t.observeParsed({ tool: "os.fs.read", args: { path: "a" } }, 0);
    expect(t.observeExecuted({ tool: "os.fs.read", status: "ok" }, 0)).toBe(false);
    t.observeParsed({ tool: "os.fs.write", args: { path: "a" } }, 0);
    expect(t.observeExecuted({ tool: "os.fs.write", status: "error" }, 0)).toBe(false);
    expect(t.observeExecuted({ tool: "os.fs.write", status: "ok" }, 3)).toBe(false);
    expect(t.count).toBe(0);
  });

  it("counts an applied patch by its diff headers, and a dry run not at all", () => {
    const patch = [
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1 +1 @@",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "--- a/src/y.ts",
      "+++ b/src/y.ts\t2026-11-12",
    ].join("\n");
    const t = new WrittenFilesTracker();
    t.observeParsed({ tool: "os.fs.patch", args: { patch } }, 0);
    t.observeExecuted({ tool: "os.fs.patch", status: "ok" }, 0);
    expect(t.count).toBe(0);
    t.observeParsed({ tool: "os.fs.patch", args: { patch, apply: true } }, 0);
    t.observeExecuted({ tool: "os.fs.patch", status: "ok" }, 0);
    expect(t.count).toBe(2);
  });

  it("counts a write it cannot name as one file of its own", () => {
    const t = new WrittenFilesTracker();
    t.observeParsed({ tool: "os.fs.patch", args: { patchPath: "p.diff", apply: true } }, 0);
    t.observeExecuted({ tool: "os.fs.patch", status: "ok" }, 0);
    t.observeParsed({ tool: "os.fs.write", args: {} }, 0);
    t.observeExecuted({ tool: "os.fs.write", status: "ok" }, 0);
    expect(t.count).toBe(2);
  });
});
