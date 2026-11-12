import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ToolRegistry, type ToolContext } from "../../tool-registry.js";
import { checkpointBeforeInvoke, checkpointTargets } from "./fs-checkpoint-targets.js";

const WD = resolve("/work/project");
const noDirs = { isDirectory: () => false };

describe("checkpointTargets (ATO-1056)", () => {
  it("reads the path of a write, an edit and a restore against the working dir", () => {
    expect(checkpointTargets("os.fs.write", { path: "a.txt", content: "x" }, WD, noDirs)).toEqual([join(WD, "a.txt")]);
    expect(checkpointTargets("os.fs.edit", { path: resolve("/abs/b.ts"), oldString: "a", newString: "b" }, WD, noDirs)).toEqual([resolve("/abs/b.ts")]);
    expect(checkpointTargets("os.fs.restore", { path: "c.md" }, WD, noDirs)).toEqual([join(WD, "c.md")]);
  });

  it("reads every path of a trash", () => {
    expect(checkpointTargets("os.fs.trash", { paths: ["a", "b", "a"] }, WD, noDirs)).toEqual([join(WD, "a"), join(WD, "b")]);
  });

  it("reads both ends of a move, into a folder when `to` names one", () => {
    expect(checkpointTargets("os.fs.move", { from: "a.txt", to: "b.txt" }, WD, noDirs)).toEqual([join(WD, "a.txt"), join(WD, "b.txt")]);
    expect(checkpointTargets("os.fs.move", { from: "a.txt", to: "out/" }, WD, noDirs)).toEqual([join(WD, "a.txt"), join(WD, "out", "a.txt")]);
    const isDirectory = (p: string) => p === join(WD, "out");
    expect(checkpointTargets("os.fs.move", { moves: [{ from: "x", to: "out" }] }, WD, { isDirectory })).toEqual([join(WD, "x"), join(WD, "out", "x")]);
    // An argument shape the tool refuses changes nothing.
    expect(checkpointTargets("os.fs.move", { from: "a" }, WD, noDirs)).toEqual([]);
  });

  it("reads the files of an applied patch, and none of a dry run", () => {
    const patch = [
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "",
    ].join("\n");
    expect(checkpointTargets("os.fs.patch", { patch }, WD, noDirs)).toEqual([]);
    expect(checkpointTargets("os.fs.patch", { patch, apply: true }, WD, noDirs)).toEqual([
      join(WD, "src", "one.ts"),
      join(WD, "gone.txt"),
    ]);
    expect(checkpointTargets("os.fs.patch", { patchPath: "p.diff", apply: true, rootDir: "sub" }, WD, {
      ...noDirs,
      readText: () => patch,
    })).toEqual([join(WD, "sub", "src", "one.ts"), join(WD, "sub", "gone.txt")]);
  });

  it("covers nothing else", () => {
    expect(checkpointTargets("os.fs.read", { path: "a" }, WD, noDirs)).toEqual([]);
    expect(checkpointTargets("os.shell.run", { command: "rm -rf x" }, WD, noDirs)).toEqual([]);
  });
});

describe("ToolRegistry beforeInvoke + checkpointBeforeInvoke", () => {
  const ctx: ToolContext = { workingDir: WD, sessionId: "s-1", stepIndex: 0, signal: new AbortController().signal };

  it("saves a covered tool's target before the tool runs", async () => {
    const order: string[] = [];
    const capture = vi.fn(async (_session: string, path: string) => { order.push(`capture ${path}`); });
    const registry = new ToolRegistry({ beforeInvoke: checkpointBeforeInvoke({ capture }) });
    registry.register({
      name: "os.fs.write",
      description: "d",
      readonly: false,
      run: async () => {
        order.push("run");
        return { status: "ok", summary: "ok", details: {} } as never;
      },
    });
    await registry.invoke("os.fs.write", { path: "a.txt", content: "x" }, ctx);
    expect(order).toEqual([`capture ${join(WD, "a.txt")}`, "run"]);
    expect(capture).toHaveBeenCalledWith("s-1", join(WD, "a.txt"), "os.fs.write");
  });

  it("runs the tool when the hook throws", async () => {
    const registry = new ToolRegistry({ beforeInvoke: async () => { throw new Error("disk full"); } });
    registry.register({
      name: "os.fs.write",
      description: "d",
      readonly: false,
      run: async () => ({ status: "ok", summary: "written", details: {} }) as never,
    });
    const result = await registry.invoke("os.fs.write", { path: "a.txt", content: "x" }, ctx);
    expect(result.summary).toBe("written");
  });
});
