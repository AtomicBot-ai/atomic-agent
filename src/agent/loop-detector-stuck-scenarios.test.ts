import { describe, expect, it } from "vitest";
import type { CompressedToolResult } from "../compressor/result-compressor.js";
import { LlamaServerError } from "../llm/llama-server-client.js";
import { GrammarError } from "../llm/reliability/llm-failures.js";
import {
  LOOP_VETO_DENIED_REASON,
  ToolLoopTracker,
  formatForcedLoopReply,
} from "./loop-detector.js";
import { planOverflowCompaction } from "./turn/overflow-compaction.js";

/**
 * The five kinds of "stuck" the OpenHands stuck detector (MIT) knows,
 * checked against our own guards (ATO-611). Their thresholds differ
 * from ours on purpose: OpenHands calls an agent stuck after 4 identical
 * action/observation pairs or 3 identical action/error pairs; here a
 * repeat is warned about from the 4th call and refused from the 6th
 * (warning 3, critical 5 on the history so far), and the turn ends after
 * 3 refusals. What matters is that every shape is caught, and in a
 * bounded number of calls.
 *
 * The monologue scenario lives with the loop it needs: a reply-only
 * step ends the turn, see `agent-loop-progress-note.test.ts`.
 */

type Level = "ok" | "warn" | "critical" | "stopped";

function result(
  tool: string,
  summary: string,
  overrides: Partial<CompressedToolResult> = {},
): CompressedToolResult {
  return { tool, status: "ok", summary, details: {}, truncated: false, ...overrides };
}

/** One call through the tracker the way the dispatch gate drives it. */
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
    tracker.recordOutcome(
      tool,
      args,
      result(tool, "BLOCKED", {
        status: "error",
        details: { deniedReason: LOOP_VETO_DENIED_REASON },
      }),
    );
    return "critical";
  }
  tracker.recordOutcome(tool, args, outcome);
  return verdict.level;
}

describe("OpenHands stuck scenarios (ATO-611)", () => {
  it("1. the same action with the same observation is warned, refused, then stopped", () => {
    const tracker = new ToolLoopTracker();
    const call = { cmd: "curl -s http://localhost:3000/health" };
    const down = result("os.shell.run", "$ curl ...\nexit: 7", { details: { exitCode: 7 } });
    const levels = Array.from({ length: 10 }, () =>
      gate(tracker, "os.shell.run", call, down),
    );
    expect(levels.slice(0, 6)).toEqual(["ok", "ok", "ok", "warn", "warn", "critical"]);
    expect(levels.slice(6, 8)).toEqual(["critical", "critical"]);
    expect(levels[8]).toBe("stopped");
  });

  it("1b. the third identical observation is flagged even when the arguments vary", () => {
    const tracker = new ToolLoopTracker();
    const same = result("os.fs.list", "src/ (3 entries): a.ts b.ts c.ts");
    const repeats = ["src", "./src", "src/"].map((path) => {
      tracker.recordCall("os.fs.list", { path });
      return tracker.recordOutcome("os.fs.list", { path }, same).repeat;
    });
    expect(repeats).toEqual([false, false, true]);
  });

  it("2. the same action failing with the same error is refused and then stopped", () => {
    const tracker = new ToolLoopTracker();
    const call = { cmd: "python app.py" };
    const crash = result("os.shell.run", "ModuleNotFoundError: No module named 'flask'", {
      status: "error",
      details: { exitCode: 1 },
    });
    const levels = Array.from({ length: 9 }, () => gate(tracker, "os.shell.run", call, crash));
    expect(levels.indexOf("critical")).toBe(5);
    expect(levels[8]).toBe("stopped");
  });

  it("2b. the stop tells the person in one plain line why", () => {
    const text = formatForcedLoopReply("os.shell.run", 5, "no_progress", 3);
    expect(text.startsWith("(stopped: `os.shell.run` kept returning the same no-progress outcome")).toBe(true);
    expect(text).toContain("refused 3 times in a row");
    expect(text).toContain("the task may be incomplete");
  });

  it("3. an A-B-A-B alternation with nothing new coming back is refused", () => {
    const tracker = new ToolLoopTracker();
    const read = { path: "src/app.ts" };
    const run = { cmd: "node src/app.ts" };
    const text = result("os.fs.read", "export const port = 3000;");
    const fail = result("os.shell.run", "Error: EADDRINUSE", { status: "error", details: { exitCode: 1 } });
    const a: Level[] = [];
    const b: Level[] = [];
    for (let i = 0; i < 6; i += 1) {
      a.push(gate(tracker, "os.fs.read", read, text));
      b.push(gate(tracker, "os.shell.run", run, fail));
    }
    expect(a[5]).toBe("critical");
    expect(b[5]).toBe("critical");
    expect(a.slice(0, 3)).toEqual(["ok", "ok", "ok"]);
  });

  it("3b. the alternation is not excused by edits that keep failing", () => {
    const tracker = new ToolLoopTracker();
    const run = { cmd: "node src/app.ts" };
    const fail = result("os.shell.run", "Error: EADDRINUSE", { status: "error", details: { exitCode: 1 } });
    const notFound = result("os.fs.edit", "oldString was not found", { status: "error" });
    const levels: Level[] = [];
    for (let i = 0; i < 6; i += 1) {
      levels.push(gate(tracker, "os.shell.run", run, fail));
      gate(tracker, "os.fs.edit", { path: "src/app.ts", oldString: `x${i}`, newString: "y" }, notFound);
    }
    expect(levels[5]).toBe("critical");
  });

  it("4. a context-window error is compacted once, and the second one ends the turn instead of looping", () => {
    const sentence = "llama-server returned http 400: the request exceeds the available context size";
    const overflow = new GrammarError(sentence, "", {
      cause: new LlamaServerError(sentence, 400, "http://127.0.0.1:8080/completion", false, undefined, {
        body: { type: "exceed_context_size_error", contextWindow: 16_384 },
      }),
    });
    const base = { error: overflow, aborted: false, canCompact: true, promptTokens: 20_000, believedWindow: 32_768 };
    expect(planOverflowCompaction({ ...base, attempted: false })).not.toBeNull();
    expect(planOverflowCompaction({ ...base, attempted: true })).toBeNull();
  });
});
