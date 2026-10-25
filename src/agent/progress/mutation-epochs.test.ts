import { describe, expect, it } from "vitest";
import {
  MAX_FAILED_EPOCHS,
  MutationEpochs,
  mutationTargets,
  normalizeLoopPath,
  readTargetPath,
  samePathTarget,
} from "./mutation-epochs.js";

describe("normalizeLoopPath / samePathTarget", () => {
  it("makes the spellings of one path comparable", () => {
    expect(normalizeLoopPath("./src//a.ts")).toBe("src/a.ts");
    expect(normalizeLoopPath("C:\\Repo\\Src\\A.ts")).toBe("c:/repo/src/a.ts");
    expect(normalizeLoopPath("/repo/src/a.ts/")).toBe("/repo/src/a.ts");
  });

  it("matches a relative path to its resolved form on whole segments", () => {
    expect(samePathTarget("/repo/src/a.ts", "src/a.ts")).toBe(true);
    expect(samePathTarget("src/a.ts", "/repo/src/a.ts")).toBe(true);
    expect(samePathTarget("/repo/src/data.ts", "a.ts")).toBe(false);
    expect(samePathTarget("/x/a.ts", "/y/a.ts")).toBe(false);
    expect(samePathTarget("", "a.ts")).toBe(false);
  });
});

describe("mutationTargets / readTargetPath", () => {
  it("names the paths a mutating call targets, and nothing for other tools", () => {
    expect(mutationTargets("os.fs.edit", { path: "./a.ts", oldString: "x" })).toEqual(["a.ts"]);
    expect(mutationTargets("os.fs.write", { path: "b.md", content: "" })).toEqual(["b.md"]);
    expect(mutationTargets("os.fs.move", { from: "a", to: "b" })).toEqual(["a", "b"]);
    expect(
      mutationTargets("os.fs.move", { moves: [{ from: "a", to: "d/" }] }),
    ).toEqual(["a", "d"]);
    expect(mutationTargets("os.fs.read", { path: "a.ts" })).toBeNull();
    expect(mutationTargets("os.shell.run", { command: "sed -i" })).toBeNull();
  });

  it("reads an applied patch's files from its headers, and a dry run as nothing", () => {
    const patch = [
      "--- a/src/a.ts\t2026-10-25",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "--- /dev/null",
      "+++ b/docs/new.md",
    ].join("\n");
    expect(mutationTargets("os.fs.patch", { patch, apply: true })).toEqual([
      "src/a.ts",
      "docs/new.md",
    ]);
    expect(
      mutationTargets("os.fs.patch", { patch, apply: true, stripComponents: 0, rootDir: "/Repo" }),
    ).toEqual(["/repo/a/src/a.ts", "/repo/b/src/a.ts", "/repo/b/docs/new.md"]);
    // A dry run (the default) writes nothing, so it opens no epoch.
    expect(mutationTargets("os.fs.patch", { patch })).toBeNull();
    expect(mutationTargets("os.fs.patch", { patch, apply: false })).toBeNull();
    // Unreadable targets fall back to every path.
    expect(mutationTargets("os.fs.patch", { patchPath: "fix.diff", apply: true })).toBe("any");
    expect(mutationTargets("os.fs.patch", { patch: "garbage", apply: true })).toBe("any");
  });

  it("reads the target of an os.fs.read only", () => {
    expect(readTargetPath("os.fs.read", { path: "./src/a.ts" })).toBe("src/a.ts");
    expect(readTargetPath("os.fs.read", {})).toBeNull();
    expect(readTargetPath("os.fs.list", { path: "." })).toBeNull();
  });
});

describe("MutationEpochs", () => {
  it("opens a new epoch for a path on each attempt, and only for that path", () => {
    const epochs = new MutationEpochs();
    expect(epochs.epochFor("/repo/a.ts")).toBe(0);
    epochs.note("os.fs.edit", { path: "a.ts" }, false);
    const first = epochs.epochFor("/repo/a.ts");
    expect(first).toBeGreaterThan(0);
    expect(epochs.epochFor("/repo/b.ts")).toBe(0);
    epochs.note("os.fs.edit", { path: "a.ts" }, false);
    expect(epochs.epochFor("/repo/a.ts")).toBeGreaterThan(first);
  });

  it("stops opening epochs after MAX_FAILED_EPOCHS failures in a row, until a change lands", () => {
    const epochs = new MutationEpochs();
    const seen: number[] = [];
    for (let i = 0; i < MAX_FAILED_EPOCHS + 2; i += 1) {
      const opened = epochs.note("os.fs.edit", { path: "a.ts" }, false);
      expect(opened === null).toBe(i >= MAX_FAILED_EPOCHS);
      seen.push(epochs.epochFor("a.ts"));
    }
    expect(new Set(seen).size).toBe(MAX_FAILED_EPOCHS);
    const stuck = epochs.epochFor("a.ts");
    // Another file keeps its own count.
    expect(epochs.note("os.fs.edit", { path: "b.ts" }, false)).toEqual(["b.ts"]);
    // A landed change opens an epoch and resets the count.
    expect(epochs.note("os.fs.write", { path: "a.ts" }, true)).toEqual(["a.ts"]);
    expect(epochs.epochFor("a.ts")).toBeGreaterThan(stuck);
    expect(epochs.note("os.fs.edit", { path: "a.ts" }, false)).toEqual(["a.ts"]);
  });

  it("never moves an epoch backwards when a path is evicted", () => {
    const epochs = new MutationEpochs();
    epochs.note("os.fs.edit", { path: "first.ts" }, true);
    const before = epochs.epochFor("first.ts");
    for (let i = 0; i < 250; i += 1) {
      epochs.note("os.fs.write", { path: `f${i}.ts` }, true);
    }
    expect(epochs.epochFor("first.ts")).toBeGreaterThanOrEqual(before);
    expect(epochs.epochFor("first.ts")).toBeGreaterThan(0);
  });

  it("moves every path on a patch, and ignores calls that mutate nothing", () => {
    const epochs = new MutationEpochs();
    expect(epochs.note("os.fs.read", { path: "a.ts" }, true)).toBeNull();
    expect(epochs.note("os.fs.patch", { patch: "diff" }, true)).toBeNull();
    expect(epochs.epochFor("a.ts")).toBe(0);
    epochs.note("os.fs.patch", { patchPath: "fix.diff", apply: true }, false);
    expect(epochs.epochFor("a.ts")).toBeGreaterThan(0);
    expect(epochs.epochFor("/anything/else")).toBeGreaterThan(0);
  });
});
