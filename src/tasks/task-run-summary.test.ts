import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "../agent/agent-contract.js";
import type { CompressedToolResult } from "../compressor/result-compressor.js";

import {
  createTaskRunSummaryCollector,
  openChecklistItems,
  questionsIn,
  SUMMARY_MAX_ERRORS,
} from "./task-run-summary.js";
import { countDiffLines, isTestCommand } from "./task-run-summary-tools.js";

function tool(result: Partial<CompressedToolResult> & { tool: string }): AgentLoopEvent {
  return {
    type: "llm_event",
    event: {
      type: "tool_call_executed",
      result: {
        status: "ok",
        summary: "",
        details: {},
        truncated: false,
        ...result,
      },
      batchIndex: 0,
      batchSize: 1,
    },
  };
}

function reply(text: string, progressNote = false): AgentLoopEvent {
  return {
    type: "llm_event",
    event: {
      type: "assistant_reply",
      text,
      ...(progressNote ? { progressNote: true as const } : {}),
    },
  };
}

function shell(cmd: string, args: string[], exitCode: number | null, extra: Record<string, unknown> = {}): AgentLoopEvent {
  return tool({
    tool: "os.shell.run",
    status: exitCode === 0 ? "ok" : "error",
    details: { cmd, args, exitCode, timedOut: false, ...extra },
  });
}

describe("createTaskRunSummaryCollector", () => {
  it("records created, rewritten and edited files with line counts", () => {
    const c = createTaskRunSummaryCollector();
    c.onEvent(tool({ tool: "os.fs.write", details: { path: "/w/new.ts", lines: 10, mode: "replace", existed: false } }));
    c.onEvent(tool({ tool: "os.fs.write", details: { path: "/w/big.csv", lines: 3, mode: "replace", existed: true, previousLines: 2401 } }));
    c.onEvent(
      tool({
        tool: "os.fs.edit",
        summary: "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+newer\n ctx",
        details: { path: "/w/x.ts" },
      }),
    );
    const s = c.snapshot();
    expect(s.files).toEqual([
      { path: "/w/new.ts", kind: "created", added: 10, removed: 0, approximate: false, writes: 1 },
      { path: "/w/big.csv", kind: "rewritten", added: 3, removed: 2401, approximate: true, writes: 1 },
      { path: "/w/x.ts", kind: "edited", added: 2, removed: 1, approximate: false, writes: 1 },
    ]);
  });

  it("merges repeated edits of one path and flags a clipped diff as approximate", () => {
    const c = createTaskRunSummaryCollector();
    c.onEvent(tool({ tool: "os.fs.write", details: { path: "/w/a.ts", lines: 5, mode: "replace", existed: false } }));
    c.onEvent(
      tool({
        tool: "os.fs.edit",
        summary: "+a\n+b\n… [diff truncated]",
        details: { path: "/w/a.ts" },
      }),
    );
    const [file] = c.snapshot().files;
    expect(file).toMatchObject({ kind: "created", added: 7, writes: 2, approximate: true });
  });

  it("counts applied os.fs.patch files only", () => {
    const c = createTaskRunSummaryCollector();
    c.onEvent(
      tool({
        tool: "os.fs.patch",
        details: {
          files: [
            { path: "a", absolute: "/w/a", applied: true, addedLines: 4, removedLines: 1 },
            { path: "b", absolute: "/w/b", applied: false, addedLines: 9, removedLines: 9 },
          ],
        },
      }),
    );
    expect(c.snapshot().files.map((f) => f.path)).toEqual(["/w/a"]);
  });

  it("ignores failed writes", () => {
    const c = createTaskRunSummaryCollector();
    c.onEvent(tool({ tool: "os.fs.write", status: "error", summary: "EACCES", details: { path: "/w/a" } }));
    const s = c.snapshot();
    expect(s.files).toEqual([]);
    expect(s.errors).toEqual(["os.fs.write: EACCES"]);
  });

  it("keeps the last outcome of a repeated command and marks test runs", () => {
    const c = createTaskRunSummaryCollector();
    c.onEvent(shell("npx", ["vitest", "run"], 1));
    c.onEvent(shell("npx", ["vitest", "run"], 0));
    c.onEvent(shell("ls", ["-la"], 0));
    expect(c.snapshot().commands).toEqual([
      { command: "npx vitest run", exitCode: 0, timedOut: false, test: true, runs: 2 },
      { command: "ls -la", exitCode: 0, timedOut: false, test: false, runs: 1 },
    ]);
  });

  it("skips a command that is still running (no exit code yet)", () => {
    const c = createTaskRunSummaryCollector();
    c.onEvent(tool({ tool: "os.shell.run", details: { cmd: "sleep", args: ["100"], jobId: 3 } }));
    expect(c.snapshot().commands).toEqual([]);
  });

  it("separates a declined approval from one nobody answered", () => {
    const c = createTaskRunSummaryCollector();
    c.onEvent(
      tool({
        tool: "os.fs.trash",
        status: "error",
        approvals: [{ verdict: "denied", category: "fs_write" as never, at: 1 }],
      }),
    );
    c.onEvent(
      tool({
        tool: "os.shell.run",
        status: "error",
        details: { errorName: "ApprovalDeniedError" },
      }),
    );
    const s = c.snapshot();
    expect(s.approvals).toEqual([
      { tool: "os.fs.trash", byUser: true },
      { tool: "os.shell.run", byUser: false },
    ]);
    expect(s.errors).toEqual([]);
  });

  it("takes the final reply, not a progress note, and finish's full summary", () => {
    const a = createTaskRunSummaryCollector();
    a.onEvent(reply("working on it", true));
    a.onEvent(reply("all done"));
    expect(a.snapshot().replyText).toBe("all done");

    const b = createTaskRunSummaryCollector();
    b.onEvent(tool({ tool: "finish", summary: "short", details: { summary: "full summary" } }));
    expect(b.snapshot().replyText).toBe("full summary");
  });

  it("reads open checklist items from a progress note and questions from the final reply", () => {
    const c = createTaskRunSummaryCollector();
    c.onEvent(reply("Plan:\n- [x] read code\n- [ ] write tests\n- [ ] update docs", true));
    c.onEvent(reply("Done with the fix.\nShould I also bump the version?"));
    const s = c.snapshot();
    expect(s.openItems).toEqual(["write tests", "update docs"]);
    expect(s.questions).toEqual(["Should I also bump the version?"]);
  });

  it("records turn and step failures, credit exhaustion and steps", () => {
    const c = createTaskRunSummaryCollector();
    c.onEvent({ type: "step_finished", stepIndex: 0, summary: "read files", durationMs: 5 });
    c.onEvent({ type: "credit_exhausted", provider: "openrouter", code: "402", message: "no credit" });
    c.onEvent({ type: "loop_failed", error: new Error("boom"), category: "transport" });
    const s = c.snapshot();
    expect(s.steps).toBe(1);
    expect(s.lastStep).toBe("read files");
    expect(s.creditExhausted).toBe(true);
    expect(s.errors).toEqual(["turn failed [transport]: boom"]);
  });

  it("caps errors and counts the rest", () => {
    const c = createTaskRunSummaryCollector();
    for (let i = 0; i < SUMMARY_MAX_ERRORS + 5; i += 1) {
      c.onEvent(tool({ tool: "os.http.request", status: "error", summary: `fail ${i}` }));
    }
    const s = c.snapshot();
    expect(s.errors).toHaveLength(SUMMARY_MAX_ERRORS);
    expect(s.errorsOmitted).toBe(5);
  });

  it("returns copies, so a snapshot does not change under later events", () => {
    const c = createTaskRunSummaryCollector();
    c.onEvent(shell("make", ["test"], 1));
    const before = c.snapshot();
    c.onEvent(shell("make", ["test"], 0));
    expect(before.commands[0]?.exitCode).toBe(1);
    expect(c.snapshot().commands[0]?.exitCode).toBe(0);
  });
});

describe("helpers", () => {
  it("countDiffLines skips headers", () => {
    expect(countDiffLines("--- a\n+++ b\n@@\n+x\n-y\n-z\n ctx")).toEqual({ added: 1, removed: 2 });
  });

  it("isTestCommand recognises common runners", () => {
    for (const cmd of ["npm test", "npm run test", "pnpm test", "npx vitest run", "pytest -q", "go test ./...", "cargo test", "make check"]) {
      expect(isTestCommand(cmd), cmd).toBe(true);
    }
    for (const cmd of ["ls", "npm run build", "cat test.txt"]) {
      expect(isTestCommand(cmd), cmd).toBe(false);
    }
  });

  it("openChecklistItems and questionsIn handle null and bullets", () => {
    expect(openChecklistItems(null)).toEqual([]);
    expect(questionsIn(null)).toEqual([]);
    expect(questionsIn("1. Which branch?\n- Keep it?\nok.")).toEqual(["Which branch?", "Keep it?"]);
  });
});
