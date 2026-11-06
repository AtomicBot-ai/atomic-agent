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
  applyNoChangesRule,
  describeDegenerateContent,
  inspectDeclaredFiles,
  isPlaceholderReply,
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
      modified: ["js/main.js"],
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
      modified: ["out.js"],
    });
  });
});

describe("inspectDeclaredFiles: what a written file contains (ATO-883)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-declared-content-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("flags a written file that is only a placeholder or one escaped line", async () => {
    const startedAt = Date.now();
    writeFileSync(join(dir, "scene.js"), "...\n");
    writeFileSync(join(dir, "app.js"), "<full file content>");
    const escaped = Array.from({ length: 12 }, (_, i) => `const v${i} = ${i};`).join("\\n");
    writeFileSync(join(dir, "workshop.js"), escaped);
    writeFileSync(join(dir, "ok.js"), "export const a = 1;\n// ... more later\n");

    const report = await inspectDeclaredFiles(
      ["scene.js", "app.js", "workshop.js", "ok.js"],
      dir,
      startedAt,
    );
    expect(report.modified).toEqual(["scene.js", "app.js", "workshop.js", "ok.js"]);
    expect(report.degenerate?.map((d) => d.path)).toEqual([
      "scene.js",
      "app.js",
      "workshop.js",
    ]);
    expect(report.degenerate?.[0]?.reason).toBe('is only the placeholder "..."');
    expect(report.degenerate?.[2]?.reason).toMatch(/one line with 11 literal \\n sequences/);
    expect(report).not.toHaveProperty("emptied");
  });

  it("records an empty written file separately, and never reads an untouched input", async () => {
    const startedAt = Date.now();
    writeFileSync(join(dir, "__init__.py"), "");
    writeFileSync(join(dir, "spec.md"), "...");
    const past = new Date(startedAt - 60_000);
    utimesSync(join(dir, "spec.md"), past, past);

    const report = await inspectDeclaredFiles(["__init__.py", "spec.md"], dir, startedAt);
    expect(report.emptied).toEqual(["__init__.py"]);
    expect(report.unchanged).toEqual(["spec.md"]);
    expect(report).not.toHaveProperty("degenerate");
  });
});

describe("describeDegenerateContent", () => {
  it.each([
    "...",
    "…",
    "// ...",
    "/* ... */",
    "[...]",
    "<full file content>",
    "<content>",
    "<rest of the code here>",
    "{file content}",
  ])("catches the placeholder %j", (text) => {
    expect(describeDegenerateContent(text)).toMatch(/^is only the placeholder/);
  });

  it.each([
    "",
    "x",
    "<br>",
    "{}",
    "[1, 2, 3]",
    "export const a = 1; // ...",
    // A minified bundle: one line, the odd escaped newline in a string.
    `${"var a=1;".repeat(400)}console.log("a\\nb");`,
  ])("leaves %j alone", (text) => {
    expect(describeDegenerateContent(text)).toBeUndefined();
  });
});

describe("isPlaceholderReply", () => {
  it("is true for an empty or placeholder reply, false for a report", () => {
    expect(isPlaceholderReply("")).toBe(true);
    expect(isPlaceholderReply("  ...  ")).toBe(true);
    expect(isPlaceholderReply("<full file content>")).toBe(true);
    expect(isPlaceholderReply("Wrote js/scene.js (367 lines).")).toBe(false);
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
    tools: { calls: 0, errors: 0, writes: 0, byTool: {} },
    ...over,
  };
}

describe("applyNoChangesRule", () => {
  const untouched = { missing: [], unchanged: ["js/main.js"], modified: [] };

  it("turns an ok task with no write call and no changed file into no_changes, and says why", () => {
    const result = applyNoChangesRule(
      row({ reply: "I'm done!", notes: ["js/main.js unchanged by this task"] }),
      untouched,
    );
    expect(result.status).toBe("no_changes");
    expect(result).not.toHaveProperty("error");
    expect(result.notes).toEqual([
      "js/main.js unchanged by this task",
      "no write, edit or patch call succeeded and no declared file changed",
    ]);
  });

  it("leaves the task ok when either a write call succeeded or the disk shows a change", () => {
    // A successful write whose target is not among the declared files
    // (or the declared files are globs): the call is the evidence.
    const wrote = row({ tools: { calls: 1, errors: 0, writes: 1, byTool: { "os.fs.write": 1 } } });
    expect(applyNoChangesRule(wrote, untouched)).toBe(wrote);
    // A shell command wrote the file: the disk is the evidence.
    const shelled = row();
    expect(
      applyNoChangesRule(shelled, { missing: [], unchanged: [], modified: ["js/main.js"] }),
    ).toBe(shelled);
  });

  it("never touches a status that already says why the work is incomplete", () => {
    for (const status of ["failed", "cancelled", "max_steps", "needs_orchestrator"] as const) {
      const original = row({ status });
      expect(applyNoChangesRule(original, untouched)).toBe(original);
    }
  });
});

describe("applyDeclaredFileReport", () => {
  it("fails an ok row whose declared file is absent — the reply is contradicted", () => {
    expect(
      applyDeclaredFileReport(row(), {
        missing: ["js/scene.js"],
        unchanged: [],
        modified: [],
      }),
    ).toMatchObject({
      status: "failed",
      error: "declared file js/scene.js does not exist after the task",
    });
    expect(
      applyDeclaredFileReport(row(), {
        missing: ["a.js", "b.js"],
        unchanged: [],
        modified: [],
      }).error,
    ).toBe(
      "declared file a.js does not exist after the task; declared file b.js does not exist after the task",
    );
  });

  it("keeps a status that already says the work is incomplete, and notes the absence", () => {
    for (const status of ["max_steps", "needs_orchestrator"] as const) {
      const result = applyDeclaredFileReport(
        row({ status, notes: ["earlier note"] }),
        { missing: ["js/scene.js"], unchanged: [], modified: [] },
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
      modified: ["js/scene.js"],
    });
    expect(result.status).toBe("ok");
    expect(result.notes).toEqual(["spec.md, README.md unchanged by this task"]);
  });

  it("fails an ok row whose declared file is a placeholder (ATO-883)", () => {
    const result = applyDeclaredFileReport(row({ tools: { calls: 2, errors: 0, writes: 2, byTool: {} } }), {
      missing: [],
      unchanged: [],
      modified: ["js/scene.js"],
      degenerate: [{ path: "js/scene.js", reason: 'is only the placeholder "..."' }],
    });
    expect(result).toMatchObject({
      status: "failed",
      error: 'declared file js/scene.js is only the placeholder "..."',
    });
  });

  it("notes a degenerate file on a status that already says the work is incomplete", () => {
    const result = applyDeclaredFileReport(row({ status: "max_steps" }), {
      missing: [],
      unchanged: [],
      modified: ["a.js"],
      degenerate: [{ path: "a.js", reason: "is one line with 9 literal \\n sequences: the content was written escaped" }],
    });
    expect(result.status).toBe("max_steps");
    expect(result.notes).toEqual([
      "declared file a.js is one line with 9 literal \\n sequences: the content was written escaped",
    ]);
  });

  it("only notes an emptied file and an ok reply that says nothing", () => {
    const result = applyDeclaredFileReport(row({ reply: "..." }), {
      missing: [],
      unchanged: [],
      modified: ["__init__.py", "js/scene.js"],
      emptied: ["__init__.py"],
    });
    expect(result.status).toBe("ok");
    expect(result.notes).toEqual([
      "__init__.py empty after this task",
      "the worker's reply is empty or a placeholder: it reported nothing, so check its files before relying on them",
    ]);
  });

  it("returns the row untouched when there is nothing to report", () => {
    const original = row();
    expect(
      applyDeclaredFileReport(original, { missing: [], unchanged: [], modified: [] }),
    ).toBe(original);
  });
});
