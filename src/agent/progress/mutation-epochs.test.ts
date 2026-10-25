import { describe, expect, it } from "vitest";
import {
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
    // A patch names its files inside the diff: every path is touched.
    expect(mutationTargets("os.fs.patch", { patch: "--- a/x" })).toBe("any");
    expect(mutationTargets("os.fs.read", { path: "a.ts" })).toBeNull();
    expect(mutationTargets("os.shell.run", { command: "sed -i" })).toBeNull();
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
    epochs.note("os.fs.edit", { path: "a.ts" });
    const first = epochs.epochFor("/repo/a.ts");
    expect(first).toBeGreaterThan(0);
    expect(epochs.epochFor("/repo/b.ts")).toBe(0);
    epochs.note("os.fs.edit", { path: "a.ts" });
    expect(epochs.epochFor("/repo/a.ts")).toBeGreaterThan(first);
  });

  it("moves every path on a patch, and ignores calls that mutate nothing", () => {
    const epochs = new MutationEpochs();
    expect(epochs.note("os.fs.read", { path: "a.ts" })).toBeNull();
    expect(epochs.epochFor("a.ts")).toBe(0);
    epochs.note("os.fs.patch", { patch: "diff" });
    expect(epochs.epochFor("a.ts")).toBeGreaterThan(0);
    expect(epochs.epochFor("/anything/else")).toBeGreaterThan(0);
  });
});
