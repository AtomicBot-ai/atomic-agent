import { describe, expect, it } from "vitest";
import type { CompressedToolResult } from "../compressor/result-compressor.js";
import {
  LOOP_VETO_DENIED_REASON,
  POLL_NO_PROGRESS_THRESHOLD,
  ToolLoopTracker,
} from "./loop-detector.js";

/**
 * Overnight runs (ATO-1110): thousands of steps of ordinary work must
 * not add up to a loop. Repetition is judged on the recent window and on
 * "nothing changed in between" (a landed write, a deliberate poll), not
 * on lifetime totals, and the tracker's memory stays bounded however
 * long the turn runs. Real loops stay caught; see
 * `loop-detector-stuck-scenarios.test.ts`.
 */

type Level = "ok" | "warn" | "critical" | "stopped";

function result(
  tool: string,
  summary: string,
  overrides: Partial<CompressedToolResult> = {},
): CompressedToolResult {
  return { tool, status: "ok", summary, details: {}, truncated: false, ...overrides };
}

function gate(
  tracker: ToolLoopTracker,
  tool: string,
  args: unknown,
  outcome: CompressedToolResult,
): Level {
  if (tracker.isBreakerTripped(tool, args)) return "stopped";
  const verdict = tracker.check(tool, args);
  tracker.recordCall(tool, args);
  if (verdict.level === "critical") {
    tracker.recordOutcome(tool, args, result(tool, "BLOCKED", {
      status: "error",
      details: { deniedReason: LOOP_VETO_DENIED_REASON },
    }));
    return "critical";
  }
  tracker.recordOutcome(tool, args, outcome);
  return verdict.level;
}

const failingTests = result("os.shell.run", "$ npm test\n1 failing: auth.test.ts", {
  status: "error",
  details: { exitCode: 1 },
});

describe("ToolLoopTracker over a many-hour turn", () => {
  it("re-runs the same failing test after every landed edit without a refusal", () => {
    const tracker = new ToolLoopTracker();
    const levels: Level[] = [];
    for (let i = 0; i < 200; i += 1) {
      gate(tracker, "os.fs.edit", { path: "src/auth.ts", oldString: `v${i}`, newString: `v${i + 1}` },
        result("os.fs.edit", "edited src/auth.ts"));
      levels.push(gate(tracker, "os.shell.run", { cmd: "npm test" }, failingTests));
    }
    expect(levels.every((level) => level === "ok")).toBe(true);
  });

  it("still refuses the same test re-run with nothing written in between", () => {
    const tracker = new ToolLoopTracker();
    const levels = Array.from({ length: 6 }, () =>
      gate(tracker, "os.shell.run", { cmd: "npm test" }, failingTests),
    );
    expect(levels[5]).toBe("critical");
  });

  it("still refuses writing the same content over and over", () => {
    const tracker = new ToolLoopTracker();
    const write = { path: "src/auth.ts", content: "same" };
    const levels = Array.from({ length: 6 }, () =>
      gate(tracker, "os.fs.write", write, result("os.fs.write", "wrote src/auth.ts")),
    );
    expect(levels[5]).toBe("critical");
  });

  it("lets a sleeping poll wait on a long build, and stops one stuck far longer", () => {
    const tracker = new ToolLoopTracker();
    const poll = { cmd: "sleep 60 && tail -1 build.log" };
    const busy = result("os.shell.run", "$ sleep 60 && tail -1 build.log\n[build] compiling...", { details: { exitCode: 0 } });
    const levels = Array.from({ length: POLL_NO_PROGRESS_THRESHOLD + 4 }, () =>
      gate(tracker, "os.shell.run", poll, busy),
    );
    expect(levels.slice(0, POLL_NO_PROGRESS_THRESHOLD)).not.toContain("critical");
    expect(levels[POLL_NO_PROGRESS_THRESHOLD]).toBe("critical");
    expect(levels.at(-1)).toBe("stopped");
  });

  it("re-reads a log and re-checks a status after each background-job wait", () => {
    const tracker = new ToolLoopTracker();
    const levels: Level[] = [];
    for (let i = 0; i < 15; i += 1) {
      gate(tracker, "os.shell.run", { wait: 4 }, result("os.shell.run", `job 4 still running (${i} min)`));
      levels.push(gate(tracker, "os.fs.read", { path: "train.log" }, result("os.fs.read", "epoch 3/10")));
      levels.push(gate(tracker, "os.shell.run", { cmd: "nvidia-smi" }, result("os.shell.run", "GPU 98%", { details: { exitCode: 0 } })));
    }
    expect(levels).not.toContain("critical");
  });

  it("reads a thousand files of a big repo without a warning", () => {
    const tracker = new ToolLoopTracker();
    const levels: Level[] = [];
    for (let i = 0; i < 1000; i += 1) {
      levels.push(gate(tracker, "os.fs.read", { path: `src/module-${i}.ts` }, result("os.fs.read", `module ${i}`)));
    }
    expect(levels.every((level) => level === "ok")).toBe(true);
  });

  it("re-reads a file after it changed and re-lists a directory after writing into it", () => {
    const tracker = new ToolLoopTracker();
    const levels: Level[] = [];
    for (let i = 0; i < 40; i += 1) {
      levels.push(gate(tracker, "os.fs.read", { path: "notes.md" }, result("os.fs.read", "# notes")));
      gate(tracker, "os.fs.write", { path: "notes.md", content: `# notes ${i}` }, result("os.fs.write", "wrote notes.md"));
      levels.push(gate(tracker, "os.fs.list", { path: "out" }, result("os.fs.list", "out/ (1 entry): report.md")));
      gate(tracker, "os.fs.write", { path: `out/part-${i}.md`, content: "x" }, result("os.fs.write", "wrote part"));
    }
    expect(levels).not.toContain("critical");
  });

  it("does not count the same answer an hour apart as a repeat", () => {
    const tracker = new ToolLoopTracker();
    const clean = result("os.shell.run", "$ git status --short\nexit: 0", { details: { exitCode: 0 } });
    const repeats: boolean[] = [];
    for (let hour = 0; hour < 8; hour += 1) {
      for (let i = 0; i < 40; i += 1) {
        const args = { url: `https://docs.example/${hour}/${i}` };
        tracker.recordCall("os.web.fetch", args);
        tracker.recordOutcome("os.web.fetch", args, result("os.web.fetch", `page ${hour}/${i}`));
      }
      tracker.recordCall("os.shell.run", { cmd: "git status --short" });
      repeats.push(tracker.recordOutcome("os.shell.run", { cmd: "git status --short" }, clean).repeat);
    }
    expect(repeats).not.toContain(true);
  });

  it("warns again about a repeat that comes back long after the first episode", () => {
    const tracker = new ToolLoopTracker();
    const status = result("os.shell.run", "$ git status\nclean", { details: { exitCode: 0 } });
    const episode = (): boolean => {
      let warned = false;
      for (let i = 0; i < 4; i += 1) {
        const verdict = tracker.check("os.shell.run", { cmd: "git status" });
        tracker.recordCall("os.shell.run", { cmd: "git status" });
        tracker.recordOutcome("os.shell.run", { cmd: "git status" }, status);
        if (verdict.level === "warn" && tracker.shouldEmitWarning(verdict.warningKey, verdict.count)) warned = true;
      }
      return warned;
    };
    expect(episode()).toBe(true);
    for (let i = 0; i < 100; i += 1) {
      gate(tracker, "os.fs.read", { path: `f${i}.ts` }, result("os.fs.read", `file ${i}`));
    }
    expect(episode()).toBe(true);
  });

  it("keeps its memory bounded over thousands of distinct calls and warnings", () => {
    const tracker = new ToolLoopTracker();
    for (let i = 0; i < 5000; i += 1) {
      gate(tracker, "os.shell.run", { cmd: `echo ${i}` }, result("os.shell.run", `out ${i}`, { details: { exitCode: 0 } }));
      tracker.shouldEmitWarning(`warn:key-${i}`, 3);
    }
    const inner = tracker as unknown as {
      history: unknown[];
      recentOutcomes: { size: number };
      warningBuckets: Map<string, unknown>;
    };
    expect(inner.history.length).toBeLessThanOrEqual(30);
    expect(inner.recentOutcomes.size).toBeLessThanOrEqual(30);
    expect(inner.warningBuckets.size).toBeLessThanOrEqual(200);
  });
});
