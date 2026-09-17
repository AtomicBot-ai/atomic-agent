import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyDeclaredFileReport,
  inspectDeclaredFiles,
  MTIME_SLACK_MS,
} from "./declared-files.js";
import type { WorkerTaskResult } from "./worker-result.js";

describe("inspectDeclaredFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-declared-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sorts declared paths into missing and unchanged, resolving against the working directory", async () => {
    const startedAt = Date.now();
    mkdirSync(join(dir, "js"));
    writeFileSync(join(dir, "js", "main.js"), "written by the task");
    writeFileSync(join(dir, "spec.md"), "an input");
    const past = new Date(startedAt - 60_000);
    utimesSync(join(dir, "spec.md"), past, past);
    const absoluteMissing = join(dir, "style.css");

    const report = await inspectDeclaredFiles(
      [
        "js/main.js",
        "js/scene.js",
        "spec.md",
        absoluteMissing,
        // A path under a FILE is as absent as one under nothing.
        "spec.md/child.txt",
        // A pattern is not a path; whether it "exists" is meaningless.
        "src/**/*.ts",
      ],
      dir,
      startedAt,
    );
    expect(report).toEqual({
      missing: ["js/scene.js", absoluteMissing, "spec.md/child.txt"],
      unchanged: ["spec.md"],
    });
  });

  it("gives a file stamped just before the recorded start the mtime slack", async () => {
    const startedAt = Date.now();
    writeFileSync(join(dir, "out.js"), "x");
    const justBefore = new Date(startedAt - MTIME_SLACK_MS / 2);
    utimesSync(join(dir, "out.js"), justBefore, justBefore);
    expect(await inspectDeclaredFiles(["out.js"], dir, startedAt)).toEqual({
      missing: [],
      unchanged: [],
    });
  });
});

function row(over: Partial<WorkerTaskResult> = {}): WorkerTaskResult {
  return {
    id: "t1",
    title: "Scene",
    status: "ok",
    reply: "Implemented `js/scene.js`",
    stepCount: 5,
    durationMs: 1000,
    tools: { calls: 0, errors: 0, byTool: {} },
    ...over,
  };
}

describe("applyDeclaredFileReport", () => {
  it("fails an ok row whose declared file is absent — the reply is contradicted", () => {
    expect(
      applyDeclaredFileReport(row(), {
        missing: ["js/scene.js"],
        unchanged: [],
      }),
    ).toMatchObject({
      status: "failed",
      error: "declared file js/scene.js does not exist after the task",
    });
    expect(
      applyDeclaredFileReport(row(), {
        missing: ["a.js", "b.js"],
        unchanged: [],
      }).error,
    ).toBe(
      "declared file a.js does not exist after the task; declared file b.js does not exist after the task",
    );
  });

  it("keeps a status that already says the work is incomplete, and notes the absence", () => {
    for (const status of ["max_steps", "needs_orchestrator"] as const) {
      const result = applyDeclaredFileReport(
        row({ status, notes: ["earlier note"] }),
        { missing: ["js/scene.js"], unchanged: [] },
      );
      expect(result.status).toBe(status);
      expect(result).not.toHaveProperty("error");
      expect(result.notes).toEqual([
        "earlier note",
        "declared file js/scene.js does not exist after the task",
      ]);
    }
  });

  it("only notes a declared file the task never touched — it may be an input", () => {
    const result = applyDeclaredFileReport(row(), {
      missing: [],
      unchanged: ["spec.md", "README.md"],
    });
    expect(result.status).toBe("ok");
    expect(result.notes).toEqual(["spec.md, README.md unchanged by this task"]);
  });

  it("returns the row untouched when there is nothing to report", () => {
    const original = row();
    expect(
      applyDeclaredFileReport(original, { missing: [], unchanged: [] }),
    ).toBe(original);
  });
});
