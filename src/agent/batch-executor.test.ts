import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../tools/tool-registry.js";
import {
  compressToolResult,
  type CompressedToolResult,
} from "../compressor/result-compressor.js";
import {
  FINAL_STEP_REFUSAL,
  executeBatch,
  planBatch,
  toBatchInputs,
  type BatchLoopSignal,
} from "./batch-executor.js";
import {
  LOOP_VETO_DENIED_REASON,
  ToolLoopTracker,
  formatVetoInstruction,
} from "./loop-detector.js";
import { reviewStallToolSet } from "./review-stall.js";
import { toolSetRefusal } from "./step-tool-set.js";
import { createTraceRecorder } from "../tracing/trace/trace-recorder.js";
import type { TraceEvent } from "../tracing/trace/trace-event.js";

function ctx(signal: AbortSignal) {
  return {
    workingDir: "/tmp",
    sessionId: "s1",
    stepIndex: 0,
    signal,
  };
}

function buildRegistry(
  tools: Record<
    string,
    (args: Record<string, unknown>) => Promise<CompressedToolResult>
  >,
  readonly = true,
): ToolRegistry {
  const reg = new ToolRegistry();
  for (const [name, fn] of Object.entries(tools)) {
    reg.register({
      name,
      description: name,
      readonly,
      run: (args) => fn(args),
    });
  }
  return reg;
}

function okResult(name: string, summary = "ok"): CompressedToolResult {
  return compressToolResult({ tool: name, status: "ok", output: summary });
}

/**
 * Drive `n` identical completed cycles through the tracker so a
 * subsequent `check(tool, args)` returns `critical`. Uses the same
 * `check → recordCall → recordOutcome` order as the production gate.
 */
function seedCriticalStreak(
  tracker: ToolLoopTracker,
  tool: string,
  args: unknown,
  n: number,
): void {
  const result = okResult(tool, "same");
  for (let i = 0; i < n; i += 1) {
    tracker.check(tool, args);
    tracker.recordCall(tool, args);
    tracker.recordOutcome(tool, args, result);
  }
}

describe("planBatch", () => {
  it("groups inputs by resource class while preserving batch-index order", () => {
    const inputs = toBatchInputs([
      { tool: "os.fs.read", args: { path: "a" } },
      { tool: "browser.click", args: { ref: "x" } },
      { tool: "os.fs.read", args: { path: "b" } },
      { tool: "browser.scroll", args: { direction: "down" } },
    ]);
    const groups = planBatch(inputs);
    expect([...groups.keys()].sort()).toEqual(["browser", "pure_read"]);
    expect(groups.get("pure_read")!.map((i) => i.batchIndex)).toEqual([0, 2]);
    expect(groups.get("browser")!.map((i) => i.batchIndex)).toEqual([1, 3]);
  });
});

describe("executeBatch", () => {
  it("runs pure_read calls in parallel (wall ≈ max latency)", async () => {
    const calls = vi.fn(
      async (_args: Record<string, unknown>): Promise<CompressedToolResult> => {
        await new Promise((r) => setTimeout(r, 80));
        return okResult("os.fs.read");
      },
    );
    const registry = buildRegistry({
      "os.fs.read": calls,
    });
    const inputs = toBatchInputs([
      { tool: "os.fs.read", args: { path: "a" } },
      { tool: "os.fs.read", args: { path: "b" } },
      { tool: "os.fs.read", args: { path: "c" } },
      { tool: "os.fs.read", args: { path: "d" } },
    ]);
    const ctrl = new AbortController();
    const startedAt = Date.now();
    const out = await executeBatch(inputs, registry, ctx(ctrl.signal));
    const elapsed = Date.now() - startedAt;

    expect(out.results).toHaveLength(4);
    expect(out.results.every((r) => r.compressed?.status === "ok")).toBe(true);
    expect(out.cancelled).toBe(false);
    expect(calls).toHaveBeenCalledTimes(4);
    // Parallel: all four 80ms calls should fit well under 4 * 80 = 320ms.
    // Allow generous slack for CI scheduler jitter.
    expect(elapsed).toBeLessThan(250);
  });

  it("hands the step's readRoots to every call's tool context, unchanged", async () => {
    // The read scope (`src/tools/read-scope/`) widens by what the user
    // named; the step computes that once and the batch must not lose it.
    const seen: (readonly string[] | undefined)[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "read",
      readonly: true,
      run: async (_args, toolCtx) => {
        seen.push(toolCtx.readRoots);
        return okResult("os.fs.read");
      },
    });
    const inputs = toBatchInputs([
      { tool: "os.fs.read", args: { path: "a" } },
      { tool: "os.fs.read", args: { path: "b" } },
    ]);
    const ctrl = new AbortController();
    await executeBatch(inputs, registry, {
      ...ctx(ctrl.signal),
      readRoots: ["/named/one"],
    });
    expect(seen).toEqual([["/named/one"], ["/named/one"]]);
    await executeBatch(inputs.slice(0, 1), registry, ctx(ctrl.signal));
    expect(seen[2]).toBeUndefined();
  });

  it("chunks pure_read fan-out into bounded waves when maxWaveSize is set", async () => {
    // 5 reads with a wave size of 2 → waves of [0,1], [2,3], [4]. Track
    // peak concurrency: it must never exceed 2, and all 5 must run.
    let inflight = 0;
    let peak = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "read",
      readonly: true,
      run: async () => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 30));
        inflight -= 1;
        return okResult("os.fs.read");
      },
    });
    const inputs = toBatchInputs(
      [0, 1, 2, 3, 4].map((i) => ({
        tool: "os.fs.read",
        args: { path: String(i) },
      })),
    );
    const out = await executeBatch(inputs, registry, {
      ...ctx(new AbortController().signal),
      maxWaveSize: 2,
    });
    expect(out.results).toHaveLength(5);
    expect(out.results.every((r) => r.compressed?.status === "ok")).toBe(true);
    expect(out.cancelled).toBe(false);
    expect(peak).toBeLessThanOrEqual(2);
    // Result order still matches the original batch-index order.
    expect(out.results.map((r) => r.batchIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it("runs a single wave when maxWaveSize covers the whole group", async () => {
    let inflight = 0;
    let peak = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "read",
      readonly: true,
      run: async () => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 30));
        inflight -= 1;
        return okResult("os.fs.read");
      },
    });
    const inputs = toBatchInputs(
      [0, 1, 2].map((i) => ({
        tool: "os.fs.read",
        args: { path: String(i) },
      })),
    );
    const out = await executeBatch(inputs, registry, {
      ...ctx(new AbortController().signal),
      maxWaveSize: 10,
    });
    expect(out.results).toHaveLength(3);
    expect(out.results.every((r) => r.compressed?.status === "ok")).toBe(true);
    // All three ran concurrently — a single wave.
    expect(peak).toBe(3);
  });

  it("preserves batch-index correlation across waves", async () => {
    const order: number[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "read",
      readonly: true,
      run: async (args) => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(args.path as number);
        return okResult("os.fs.read", `read ${args.path}`);
      },
    });
    const inputs = toBatchInputs(
      [3, 1, 4, 0, 2].map((p) => ({
        tool: "os.fs.read",
        args: { path: p },
      })),
    );
    const out = await executeBatch(inputs, registry, {
      ...ctx(new AbortController().signal),
      maxWaveSize: 2,
    });
    // `results[i]` must correspond to `inputs[i]` regardless of wave
    // execution order.
    expect(out.results.map((r) => r.batchIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(out.results.map((r) => r.compressed?.summary)).toEqual([
      "read 3",
      "read 1",
      "read 4",
      "read 0",
      "read 2",
    ]);
  });

  it("serialises browser calls in batch-index order", async () => {
    const order: number[] = [];
    const make =
      (idx: number) =>
      async (_args: Record<string, unknown>): Promise<CompressedToolResult> => {
        await new Promise((r) => setTimeout(r, 30));
        order.push(idx);
        return okResult("browser.click");
      };
    const registry = new ToolRegistry();
    registry.register({
      name: "browser.click",
      description: "click",
      readonly: false,
      run: async (args) => {
        // Fixtures carry their index under a key the tool's schema knows
        // (`ref`, `offset`): an unknown key is refused before dispatch (F40).
        const idx = (args.ref as number) ?? -1;
        return await make(idx)(args);
      },
    });
    const inputs = toBatchInputs([
      { tool: "browser.click", args: { ref: 0 } },
      { tool: "browser.click", args: { ref: 1 } },
      { tool: "browser.click", args: { ref: 2 } },
    ]);
    const ctrl = new AbortController();
    const startedAt = Date.now();
    await executeBatch(inputs, registry, ctx(ctrl.signal));
    const elapsed = Date.now() - startedAt;
    expect(order).toEqual([0, 1, 2]);
    // Serialised ⇒ at least 3 * 30 = 90ms.
    expect(elapsed).toBeGreaterThanOrEqual(85);
  });

  it("runs distinct groups concurrently with each other", async () => {
    const reads: number[] = [];
    const clicks: number[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "read",
      readonly: true,
      run: async (args) => {
        await new Promise((r) => setTimeout(r, 60));
        reads.push((args.offset as number) ?? -1);
        return okResult("os.fs.read");
      },
    });
    registry.register({
      name: "browser.click",
      description: "click",
      readonly: false,
      run: async (args) => {
        await new Promise((r) => setTimeout(r, 60));
        clicks.push((args.ref as number) ?? -1);
        return okResult("browser.click");
      },
    });
    const inputs = toBatchInputs([
      { tool: "os.fs.read", args: { offset: 0 } },
      { tool: "browser.click", args: { ref: 1 } },
      { tool: "os.fs.read", args: { offset: 2 } },
      { tool: "browser.click", args: { ref: 3 } },
    ]);
    const ctrl = new AbortController();
    const startedAt = Date.now();
    const out = await executeBatch(inputs, registry, ctx(ctrl.signal));
    const elapsed = Date.now() - startedAt;
    expect(out.results).toHaveLength(4);
    // Reads run in parallel ~60ms; clicks serialise ~120ms. Wall ≈ 120ms.
    expect(elapsed).toBeGreaterThanOrEqual(115);
    expect(elapsed).toBeLessThan(220);
    expect(reads.sort()).toEqual([0, 2]);
    expect(clicks).toEqual([1, 3]);
  });

  it("folds a thrown error into a CompressedToolResult without aborting siblings", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "r",
      readonly: true,
      run: async (args) => {
        if ((args.fail as boolean) === true) {
          throw new Error("boom");
        }
        return okResult("os.fs.read");
      },
    });
    const inputs = toBatchInputs([
      { tool: "os.fs.read", args: { path: "a", fail: true } },
      { tool: "os.fs.read", args: { path: "b" } },
      { tool: "os.fs.read", args: { path: "c" } },
    ]);
    const out = await executeBatch(
      inputs,
      registry,
      ctx(new AbortController().signal),
    );
    expect(out.results[0]!.compressed?.status).toBe("error");
    expect(out.results[1]!.compressed?.status).toBe("ok");
    expect(out.results[2]!.compressed?.status).toBe("ok");
    expect(out.cancelled).toBe(false);
  });

  it("appends the received and expected keys to a thrown argument error (F33)", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "r",
      readonly: true,
      run: async () => {
        throw new Error("os.fs.read: `path` must be a non-empty string");
      },
    });
    // A misspelt key (`patth`) no longer reaches the tool at all — F40
    // refuses it before dispatch — so the thrown path is exercised with
    // a known key the tool rejects.
    const inputs = toBatchInputs([
      { tool: "os.fs.read", args: { path: "" } },
    ]);
    const out = await executeBatch(
      inputs,
      registry,
      ctx(new AbortController().signal),
    );
    const result = out.results[0]!.compressed!;
    expect(result.status).toBe("error");
    expect(result.summary).toBe(
      "os.fs.read: `path` must be a non-empty string — received keys: path; expected: path, maxBytes, offset, limit, lineNumbers",
    );
    expect(result.details.receivedKeys).toEqual(["path"]);
    expect(result.details.expectedKeys).toEqual([
      "path",
      "maxBytes",
      "offset",
      "limit",
      "lineNumbers",
    ]);
  });

  it("leaves a thrown runtime error without a key report", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "r",
      readonly: true,
      run: async () => {
        throw new Error("ENOENT: no such file or directory, open 'a'");
      },
    });
    const out = await executeBatch(
      toBatchInputs([{ tool: "os.fs.read", args: { path: "a" } }]),
      registry,
      ctx(new AbortController().signal),
    );
    const result = out.results[0]!.compressed!;
    expect(result.summary).toBe("ENOENT: no such file or directory, open 'a'");
    expect(result.details.receivedKeys).toBeUndefined();
  });

  it("preserves batch-index order in the returned slots", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "r",
      readonly: true,
      run: async (args) => {
        // Fast call when idx==2, slow otherwise — verifies that result
        // ordering is by batchIndex regardless of completion order.
        await new Promise((r) =>
          setTimeout(r, (args.offset as number) === 2 ? 5 : 60),
        );
        return okResult("os.fs.read", `done-${args.offset}`);
      },
    });
    const inputs = toBatchInputs([
      { tool: "os.fs.read", args: { offset: 0 } },
      { tool: "os.fs.read", args: { offset: 1 } },
      { tool: "os.fs.read", args: { offset: 2 } },
    ]);
    const out = await executeBatch(
      inputs,
      registry,
      ctx(new AbortController().signal),
    );
    expect(out.results.map((r) => r.batchIndex)).toEqual([0, 1, 2]);
    expect(out.results.map((r) => r.compressed?.summary)).toEqual([
      "done-0",
      "done-1",
      "done-2",
    ]);
  });

  it("emits onCallStarted/onCallFinished for every call with batchIndex", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "r",
      readonly: true,
      run: async () => okResult("os.fs.read"),
    });
    const started: number[] = [];
    const finished: number[] = [];
    const inputs = toBatchInputs([
      { tool: "os.fs.read", args: { path: "a" } },
      { tool: "os.fs.read", args: { path: "b" } },
    ]);
    await executeBatch(inputs, registry, {
      ...ctx(new AbortController().signal),
      onCallStarted: ({ batchIndex }) => started.push(batchIndex),
      onCallFinished: ({ batchIndex }) => finished.push(batchIndex),
    });
    expect(started.sort()).toEqual([0, 1]);
    expect(finished.sort()).toEqual([0, 1]);
  });

  it(
    "runs a terminal-tail call strictly AFTER every non-terminal call " +
      "completes (tail-terminal barrier)",
    async () => {
      const order: string[] = [];
      const registry = new ToolRegistry();
      registry.register({
        name: "memory.notes.store",
        description: "store",
        readonly: false,
        run: async () => {
          await new Promise((r) => setTimeout(r, 40));
          order.push("store");
          return okResult("memory.notes.store");
        },
      });
      registry.register({
        name: "reply",
        description: "reply",
        readonly: true,
        run: async () => {
          order.push("reply");
          return okResult("reply", "ok");
        },
      });
      const inputs = toBatchInputs([
        { tool: "memory.notes.store", args: { content: "x" } },
        { tool: "reply", args: { text: "done" } },
      ]);
      const out = await executeBatch(
        inputs,
        registry,
        ctx(new AbortController().signal),
      );
      expect(out.results).toHaveLength(2);
      expect(out.results.map((r) => r.batchIndex)).toEqual([0, 1]);
      expect(out.results.every((r) => r.compressed?.status === "ok")).toBe(
        true,
      );
      // Barrier guarantee: even though the store is slow (40ms) and
      // the reply is instant, the reply must observe the store finish
      // before it starts.
      expect(order).toEqual(["store", "reply"]);
    },
  );

  it(
    "fires the tail reply even when an earlier non-terminal call errors " +
      "(non-terminal failure does not suppress the terminal)",
    async () => {
      const order: string[] = [];
      const registry = new ToolRegistry();
      registry.register({
        name: "memory.notes.store",
        description: "store",
        readonly: false,
        run: async () => {
          order.push("store-attempt");
          throw new Error("store boom");
        },
      });
      registry.register({
        name: "reply",
        description: "reply",
        readonly: true,
        run: async () => {
          order.push("reply");
          return okResult("reply", "ok");
        },
      });
      const inputs = toBatchInputs([
        { tool: "memory.notes.store", args: { content: "x" } },
        { tool: "reply", args: { text: "done despite error" } },
      ]);
      const out = await executeBatch(
        inputs,
        registry,
        ctx(new AbortController().signal),
      );
      expect(out.results[0]!.compressed?.status).toBe("error");
      expect(out.results[1]!.compressed?.status).toBe("ok");
      expect(order).toEqual(["store-attempt", "reply"]);
      expect(out.cancelled).toBe(false);
    },
  );

  it("vetoes a critically-looping single call without invoking the tool", async () => {
    const fn = vi.fn(async () => okResult("os.fs.read"));
    const registry = buildRegistry({ "os.fs.read": fn });
    const tracker = new ToolLoopTracker({
      warningThreshold: 2,
      criticalThreshold: 2,
    });
    seedCriticalStreak(tracker, "os.fs.read", { path: "a" }, 2);
    const inputs = toBatchInputs([{ tool: "os.fs.read", args: { path: "a" } }]);
    const out = await executeBatch(inputs, registry, {
      ...ctx(new AbortController().signal),
      tracker,
    });
    expect(fn).not.toHaveBeenCalled();
    expect(out.results[0]!.compressed?.status).toBe("error");
    expect(out.results[0]!.compressed?.details.deniedReason).toBe(
      LOOP_VETO_DENIED_REASON,
    );
    expect(out.loopSignals.some((s) => s.kind === "critical")).toBe(true);
  });

  it("vetoes the looping call but lets fresh siblings run", async () => {
    const fn = vi.fn(async (args: Record<string, unknown>) =>
      okResult("os.fs.read", `read-${String(args.path)}`),
    );
    const registry = buildRegistry({ "os.fs.read": fn });
    const tracker = new ToolLoopTracker({
      warningThreshold: 2,
      criticalThreshold: 2,
    });
    seedCriticalStreak(tracker, "os.fs.read", { path: "a" }, 2);
    const inputs = toBatchInputs([
      { tool: "os.fs.read", args: { path: "a" } }, // looping → vetoed
      { tool: "os.fs.read", args: { path: "b" } }, // fresh → runs
    ]);
    const out = await executeBatch(inputs, registry, {
      ...ctx(new AbortController().signal),
      tracker,
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(out.results[0]!.compressed?.status).toBe("error");
    expect(out.results[0]!.compressed?.details.deniedReason).toBe(
      LOOP_VETO_DENIED_REASON,
    );
    expect(out.results[1]!.compressed?.status).toBe("ok");
    expect(out.results[1]!.compressed?.summary).toContain("read-b");
  });

  it("never vetoes a terminal verb even when its signature loops", async () => {
    const fn = vi.fn(async () => okResult("reply", "done"));
    const registry = buildRegistry({ reply: fn });
    const tracker = new ToolLoopTracker({
      warningThreshold: 2,
      criticalThreshold: 2,
    });
    // Seed the tracker directly (bypassing the terminal-skipping gate) so
    // `reply` WOULD be critical if it were ever checked.
    seedCriticalStreak(tracker, "reply", { text: "x" }, 2);
    const inputs = toBatchInputs([{ tool: "reply", args: { text: "x" } }]);
    const out = await executeBatch(inputs, registry, {
      ...ctx(new AbortController().signal),
      tracker,
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(out.results[0]!.compressed?.status).toBe("ok");
    expect(out.loopSignals.length).toBe(0);
  });

  it("escalates to a breaker signal after consecutive vetoes", async () => {
    const fn = vi.fn(async () => okResult("os.fs.read"));
    const registry = buildRegistry({ "os.fs.read": fn });
    const tracker = new ToolLoopTracker({
      warningThreshold: 2,
      criticalThreshold: 2,
      breakerVetoStreak: 2,
    });
    seedCriticalStreak(tracker, "os.fs.read", { path: "a" }, 2);
    const inputs = toBatchInputs([{ tool: "os.fs.read", args: { path: "a" } }]);
    const run = () =>
      executeBatch(inputs, registry, {
        ...ctx(new AbortController().signal),
        tracker,
      });
    expect((await run()).loopSignals[0]!.kind).toBe("critical"); // veto #1
    expect((await run()).loopSignals[0]!.kind).toBe("critical"); // veto #2
    expect((await run()).loopSignals[0]!.kind).toBe("breaker"); // tripped
    expect(fn).not.toHaveBeenCalled();
  });

  it("emits a wandering warn without vetoing the unique call", async () => {
    const fn = vi.fn(async () => okResult("os.web.fetch"));
    const registry = buildRegistry({ "os.web.fetch": fn });
    const tracker = new ToolLoopTracker({
      wanderingThreshold: 2,
      wanderingEscalation: 5,
    });
    tracker.check("os.web.fetch", { url: "u1" });
    tracker.recordCall("os.web.fetch", { url: "u1" });
    tracker.recordOutcome(
      "os.web.fetch",
      { url: "u1" },
      okResult("os.web.fetch", "u1"),
    );
    const inputs = toBatchInputs([
      { tool: "os.web.fetch", args: { url: "u2" } },
    ]);
    const out = await executeBatch(inputs, registry, {
      ...ctx(new AbortController().signal),
      tracker,
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(out.loopSignals[0]!.kind).toBe("warn");
    expect(out.loopSignals[0]!.detector).toBe("wandering");
  });

  it("escalates a wandering loop to a breaker signal and vetoes the call", async () => {
    const fn = vi.fn(async () => okResult("os.web.fetch"));
    const registry = buildRegistry({ "os.web.fetch": fn });
    const tracker = new ToolLoopTracker({
      wanderingThreshold: 2,
      wanderingEscalation: 3,
    });
    for (const url of ["u1", "u2"]) {
      tracker.check("os.web.fetch", { url });
      tracker.recordCall("os.web.fetch", { url });
      tracker.recordOutcome(
        "os.web.fetch",
        { url },
        okResult("os.web.fetch", url),
      );
    }
    const inputs = toBatchInputs([
      { tool: "os.web.fetch", args: { url: "u3" } },
    ]);
    const out = await executeBatch(inputs, registry, {
      ...ctx(new AbortController().signal),
      tracker,
    });
    expect(fn).not.toHaveBeenCalled();
    expect(out.loopSignals[0]!.kind).toBe("breaker");
    expect(out.loopSignals[0]!.detector).toBe("wandering");
  });

  // Issue #458: a parallel batch is gated before any of its calls record,
  // so the spread can pass the cap with nothing refused. A verbatim repeat
  // after that is still vetoed by the escalation, but what ended the turn
  // is the wandering cap: the breaker signal must say so with the spread,
  // not hand the forced reply a repeat verdict with a count of 0.
  it("reports the wandering cap, not a 0-count repeat, when a repeat is stopped past the cap", async () => {
    const fn = vi.fn(async () => okResult("os.web.fetch"));
    const registry = buildRegistry({ "os.web.fetch": fn });
    const tracker = new ToolLoopTracker({
      wanderingThreshold: 2,
      wanderingEscalation: 3,
    });
    // Four distinct fetches recorded: one past the cap of 3.
    for (const url of ["u1", "u2", "u3", "u4"]) {
      tracker.check("os.web.fetch", { url });
      tracker.recordCall("os.web.fetch", { url });
      tracker.recordOutcome(
        "os.web.fetch",
        { url },
        okResult("os.web.fetch", url),
      );
    }
    const out = await executeBatch(
      toBatchInputs([{ tool: "os.web.fetch", args: { url: "u1" } }]),
      registry,
      { ...ctx(new AbortController().signal), tracker },
    );
    expect(fn).not.toHaveBeenCalled();
    expect(out.loopSignals[0]).toMatchObject({
      kind: "breaker",
      detector: "wandering",
      count: 4,
    });
    // The veto body still describes the call as the repeat it is.
    expect(out.results[0]!.compressed!.summary).not.toContain(
      "different attempts",
    );
  });

  it("quotes the spread, not the cap, when a batch carried the spread past the cap", async () => {
    const fn = vi.fn(async (args: unknown) =>
      okResult("os.web.fetch", (args as { url: string }).url),
    );
    const registry = buildRegistry({ "os.web.fetch": fn });
    const tracker = new ToolLoopTracker({
      wanderingThreshold: 2,
      wanderingEscalation: 3,
    });
    tracker.check("os.web.fetch", { url: "u1" });
    tracker.recordCall("os.web.fetch", { url: "u1" });
    tracker.recordOutcome(
      "os.web.fetch",
      { url: "u1" },
      okResult("os.web.fetch", "u1"),
    );
    const run = (urls: string[]) =>
      executeBatch(
        toBatchInputs(
          urls.map((url) => ({ tool: "os.web.fetch", args: { url } })),
        ),
        registry,
        { ...ctx(new AbortController().signal), tracker },
      );
    // Every call in the batch is gated against the same recorded history,
    // so all three run and the spread ends at 4, past the cap of 3.
    await run(["u2", "u3", "u4"]);
    expect(fn).toHaveBeenCalledTimes(3);
    const out = await run(["u5"]);
    expect(fn).toHaveBeenCalledTimes(3);
    // The signal quotes the spread (5, counting u5), not the cap, which
    // is why the forced reply does not call its count "the cap".
    expect(out.loopSignals.find((s) => s.kind === "breaker")).toMatchObject({
      detector: "wandering",
      count: 5,
    });
  });

  // Issue #186: the veto body must name the invariant that held across
  // the blocked attempts and offer a concrete alternative.
  it("veto body names the repeated host and offers the search-first alternative", async () => {
    const registry = buildRegistry({
      "os.web.fetch": async () => okResult("os.web.fetch"),
    });
    const tracker = new ToolLoopTracker({
      warningThreshold: 2,
      criticalThreshold: 2,
    });
    const args = {
      url: "https://web.archive.org/web/2020/https://x.test/a?k=SECRET",
    };
    seedCriticalStreak(tracker, "os.web.fetch", args, 2);
    const out = await executeBatch(
      toBatchInputs([{ tool: "os.web.fetch", args }]),
      registry,
      { ...ctx(new AbortController().signal), tracker },
    );
    const body = out.results[0]!.compressed!.summary;
    expect(body).toContain("web.archive.org");
    expect(body).toContain("`os.web.search`");
    // The full URL — path, query, secret — must NOT reach model context.
    expect(body).not.toContain("SECRET");
    expect(body).not.toContain("/web/2020/");
  });

  // The veto is an instruction, not tool output. At the compressor's bare
  // defaults it is 479-588 chars and `capSummary` cuts at 385, so the
  // bullet that names the rule never reached the model — the message
  // whose whole purpose is to end a loop lost the sentence saying how.
  it("delivers the whole veto instruction, including the rule it ends on", async () => {
    const seen: string[] = [];
    for (const [tool, args] of [
      ["os.web.fetch", { url: "https://x.test/a" }],
      ["os.shell.run", { command: "npm test" }],
      ["os.fs.read", { path: "/tmp/a.txt" }],
    ] as const) {
      const registry = buildRegistry({ [tool]: async () => okResult(tool) });
      const tracker = new ToolLoopTracker({
        warningThreshold: 2,
        criticalThreshold: 2,
      });
      seedCriticalStreak(tracker, tool, args, 2);
      const out = await executeBatch(
        toBatchInputs([{ tool, args }]),
        registry,
        { ...ctx(new AbortController().signal), tracker },
      );
      const body = out.results[0]!.compressed!.summary;
      // The rule, in full: on main this is cut mid-sentence, and for
      // os.web.fetch the bullet does not survive at all.
      expect(body).toContain(
        "Do NOT repeat this exact call. Either try a different approach or close the turn with `reply`",
      );
      expect(body).toContain("honestly report you could not complete the task");
      expect(body).not.toContain("… [truncated]");
      expect(body).not.toContain("[omitted");
      expect(out.results[0]!.compressed!.truncated).toBe(false);
      seen.push(body);
    }
    // Asserting on the compressed body here would be tautological — the
    // compressor cannot return more than `maxSummaryLength`. The bound
    // that means something is on the RAW instruction: the longest shape
    // this file produces is an `os.http.request` veto with a target at
    // `sanitizeLoopTarget`'s 60-char cap.
    const longest = formatVetoInstruction({
      tool: "os.http.request",
      count: 5,
      target: "m".repeat(60),
    });
    expect(longest.length).toBeGreaterThan(400);
    expect(longest.length).toBeLessThan(1_000);
    expect(Math.max(...seen.map((b) => b.length))).toBeGreaterThan(400);
  });

  it("veto body names the command for a shell loop", async () => {
    const registry = buildRegistry({
      "os.shell.run": async () => okResult("os.shell.run"),
    });
    const tracker = new ToolLoopTracker({
      warningThreshold: 2,
      criticalThreshold: 2,
    });
    const args = {
      command: "curl -s https://x.test --header 'Authorization: Bearer SECRET'",
    };
    seedCriticalStreak(tracker, "os.shell.run", args, 2);
    const out = await executeBatch(
      toBatchInputs([{ tool: "os.shell.run", args }]),
      registry,
      { ...ctx(new AbortController().signal), tracker },
    );
    const body = out.results[0]!.compressed!.summary;
    expect(body).toContain("`curl`");
    expect(body).not.toContain("SECRET");
  });

  it("veto body degrades to generic wording when args carry no extractable target", async () => {
    const registry = buildRegistry({
      "os.fs.read": async () => okResult("os.fs.read"),
    });
    const tracker = new ToolLoopTracker({
      warningThreshold: 2,
      criticalThreshold: 2,
    });
    seedCriticalStreak(tracker, "os.fs.read", { path: "a" }, 2);
    const out = await executeBatch(
      toBatchInputs([{ tool: "os.fs.read", args: { path: "a" } }]),
      registry,
      { ...ctx(new AbortController().signal), tracker },
    );
    const body = out.results[0]!.compressed!.summary;
    expect(body).toContain("BLOCKED");
    expect(body).toContain(
      "2 consecutive calls returned the same no-progress outcome",
    );
    expect(body).not.toContain("undefined");
  });

  // The wandering spread is a property of the history window, so it stays
  // above the threshold once the model stops varying its argument. Reporting
  // a verbatim repeat as "N different attempts" is the same false statement
  // the wandering wording exists to avoid, in the mirror case.
  it("stops claiming different attempts once a wandering model settles on one url", async () => {
    const registry = buildRegistry({
      "os.web.fetch": async () => okResult("os.web.fetch"),
    });
    const tracker = new ToolLoopTracker({
      warningThreshold: 2,
      criticalThreshold: 3,
      wanderingThreshold: 3,
      wanderingEscalation: 4,
    });
    // Wander first: four distinct URLs on one host crosses the escalation.
    for (const path of ["a", "b", "c", "d"]) {
      const wandered = { url: `https://web.archive.org/${path}` };
      tracker.check("os.web.fetch", wandered);
      tracker.recordCall("os.web.fetch", wandered);
      tracker.recordOutcome(
        "os.web.fetch",
        wandered,
        okResult("os.web.fetch", path),
      );
    }
    // Then settle: the same URL, twice, so the second call is a repeat.
    const settled = { url: "https://web.archive.org/same" };
    tracker.check("os.web.fetch", settled);
    tracker.recordCall("os.web.fetch", settled);
    tracker.recordOutcome(
      "os.web.fetch",
      settled,
      okResult("os.web.fetch", "same"),
    );

    const out = await executeBatch(
      toBatchInputs([{ tool: "os.web.fetch", args: settled }]),
      registry,
      { ...ctx(new AbortController().signal), tracker },
    );
    const body = out.results[0]!.compressed!.summary;
    expect(body).toContain("BLOCKED");
    expect(body).toContain("web.archive.org");
    expect(body).not.toContain("different attempts");
    // A count the verdict cannot substantiate must not be quoted either.
    expect(body).not.toContain("0 consecutive");
  });

  it("does not throw and stays generic when args are malformed", async () => {
    const registry = buildRegistry({
      "os.web.fetch": async () => okResult("os.web.fetch"),
    });
    const tracker = new ToolLoopTracker({
      warningThreshold: 2,
      criticalThreshold: 2,
    });
    const args = { url: "://not a url" };
    seedCriticalStreak(tracker, "os.web.fetch", args, 2);
    const out = await executeBatch(
      toBatchInputs([{ tool: "os.web.fetch", args }]),
      registry,
      { ...ctx(new AbortController().signal), tracker },
    );
    const body = out.results[0]!.compressed!.summary;
    expect(body).toContain("BLOCKED");
    expect(body).not.toContain("undefined");
  });

  it("marks tail calls as cancelled when the signal aborts mid-serialised-group", async () => {
    const ctrl = new AbortController();
    const registry = new ToolRegistry();
    registry.register({
      name: "browser.click",
      description: "c",
      readonly: false,
      run: async (args) => {
        await new Promise((r) => setTimeout(r, 30));
        if ((args.ref as number) === 0) {
          ctrl.abort();
        }
        return okResult("browser.click");
      },
    });
    const inputs = toBatchInputs([
      { tool: "browser.click", args: { ref: 0 } },
      { tool: "browser.click", args: { ref: 1 } },
      { tool: "browser.click", args: { ref: 2 } },
    ]);
    const out = await executeBatch(inputs, registry, ctx(ctrl.signal));
    expect(out.cancelled).toBe(true);
    expect(out.results[0]!.compressed?.status).toBe("ok");
    expect(out.results[1]!.cancelled).toBe(true);
    expect(out.results[2]!.cancelled).toBe(true);
  });
});

describe("executeBatch — skill.view short-circuit", () => {
  it("short-circuits skill.view for an already-loaded skill without invoking the registry", async () => {
    const fn = vi.fn(
      async (_args: Record<string, unknown>): Promise<CompressedToolResult> =>
        compressToolResult({
          tool: "skill.view",
          status: "ok",
          output: "FULL SKILL BODY",
          details: { skillLoaded: { name: "exa", version: "1", body: "..." } },
        }),
    );
    const registry = buildRegistry({ "skill.view": fn });
    const inputs = toBatchInputs([
      { tool: "skill.view", args: { name: "exa" } },
    ]);
    const out = await executeBatch(inputs, registry, {
      ...ctx(new AbortController().signal),
      loadedSkillNames: new Set(["exa"]),
    });
    expect(fn).not.toHaveBeenCalled();
    const result = out.results[0]!.compressed!;
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("already loaded");
    // No skillLoaded detail ⇒ applyStateEffects will not re-dump the body.
    expect(
      (result.details as Record<string, unknown> | undefined)?.skillLoaded,
    ).toBeUndefined();
    expect(
      (result.details as Record<string, unknown> | undefined)
        ?.skillAlreadyLoaded,
    ).toBe("exa");
  });

  it("invokes the registry for a skill.view that is not already loaded", async () => {
    const fn = vi.fn(
      async (_args: Record<string, unknown>): Promise<CompressedToolResult> =>
        compressToolResult({
          tool: "skill.view",
          status: "ok",
          output: "FULL SKILL BODY",
        }),
    );
    const registry = buildRegistry({ "skill.view": fn });
    const inputs = toBatchInputs([
      { tool: "skill.view", args: { name: "other" } },
    ]);
    const out = await executeBatch(inputs, registry, {
      ...ctx(new AbortController().signal),
      loadedSkillNames: new Set(["exa"]),
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(out.results[0]!.compressed?.summary).toContain("FULL SKILL BODY");
  });

  it("records the short-circuit outcome so repeated re-views feed the loop veto", async () => {
    const fn = vi.fn(
      async (_args: Record<string, unknown>): Promise<CompressedToolResult> =>
        okResult("skill.view"),
    );
    const registry = buildRegistry({ "skill.view": fn });
    const tracker = new ToolLoopTracker();
    // Drive enough identical short-circuited re-views to cross the
    // no-progress critical threshold; the next check must veto.
    for (let i = 0; i < 6; i += 1) {
      const inputs = toBatchInputs([
        { tool: "skill.view", args: { name: "exa" } },
      ]);
      await executeBatch(inputs, registry, {
        ...ctx(new AbortController().signal),
        loadedSkillNames: new Set(["exa"]),
        tracker,
      });
    }
    expect(fn).not.toHaveBeenCalled();
    expect(tracker.check("skill.view", { name: "exa" }).level).toBe("critical");
  });
});

/**
 * Plan mode at the seam that matters: not "does the predicate say no",
 * which `plan-mode.test.ts` covers, but "did the tool actually not run".
 */
describe("executeBatch on the loop's final step (terminalOnly)", () => {
  it("refuses every non-terminal call with a tool result and never dispatches it", async () => {
    const read = vi.fn(async () => okResult("os.fs.read"));
    const registry = buildRegistry({ "os.fs.read": read });
    const inputs = toBatchInputs([
      { tool: "os.fs.read", args: { path: "a" } },
      { tool: "os.fs.read", args: { path: "b" } },
    ]);
    const out = await executeBatch(inputs, registry, {
      ...ctx(new AbortController().signal),
      terminalOnly: true,
    });
    expect(read).not.toHaveBeenCalled();
    for (const slot of out.results) {
      expect(slot.compressed?.status).toBe("error");
      expect(slot.compressed?.summary).toBe(FINAL_STEP_REFUSAL);
      expect(slot.compressed?.details).toMatchObject({ final_step: true });
    }
  });

  it("still runs the tail terminal of a [tool, reply] batch", async () => {
    const read = vi.fn(async () => okResult("os.fs.read"));
    const reply = vi.fn(async () => okResult("reply", "sent"));
    const registry = buildRegistry({ "os.fs.read": read, reply });
    const inputs = toBatchInputs([
      { tool: "os.fs.read", args: { path: "a" } },
      { tool: "reply", args: { text: "done" } },
    ]);
    const out = await executeBatch(inputs, registry, {
      ...ctx(new AbortController().signal),
      terminalOnly: true,
    });
    expect(read).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(out.results[0]!.compressed?.summary).toBe(FINAL_STEP_REFUSAL);
    expect(out.results[1]!.compressed?.status).toBe("ok");
  });

  it("outranks the other gates and leaves the loop tracker untouched", async () => {
    const write = vi.fn(async () => okResult("os.fs.write"));
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.write",
      description: "write",
      readonly: false,
      run: write,
    });
    const tracker = new ToolLoopTracker();
    const out = await executeBatch(
      toBatchInputs([{ tool: "os.fs.write", args: { path: "a", content: "x" } }]),
      registry,
      {
        ...ctx(new AbortController().signal),
        terminalOnly: true,
        isPlanMode: () => true,
        tracker,
      },
    );
    expect(write).not.toHaveBeenCalled();
    expect(out.results[0]!.compressed?.summary).toBe(FINAL_STEP_REFUSAL);
    expect(out.loopSignals).toEqual([]);
    // Nothing was recorded: a refused call is not a repeat.
    expect(
      tracker.check("os.fs.write", { path: "a", content: "x" }).count,
    ).toBe(0);
  });

  it("is inert off the final step", async () => {
    const read = vi.fn(async () => okResult("os.fs.read"));
    const registry = buildRegistry({ "os.fs.read": read });
    const out = await executeBatch(
      toBatchInputs([{ tool: "os.fs.read", args: { path: "a" } }]),
      registry,
      ctx(new AbortController().signal),
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(out.results[0]!.compressed?.status).toBe("ok");
  });
});

describe("executeBatch under plan mode", () => {
  it("never dispatches a mutating tool", async () => {
    const write = vi.fn(async () => okResult("os.fs.write"));
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.write",
      description: "write",
      readonly: false,
      run: write,
    });
    const inputs = toBatchInputs([
      { tool: "os.fs.write", args: { path: "a", content: "x" } },
    ]);
    const out = await executeBatch(inputs, registry, {
      ...ctx(new AbortController().signal),
      isPlanMode: () => true,
    });
    expect(write).not.toHaveBeenCalled();
    expect(out.results[0]!.compressed?.status).toBe("error");
    expect(out.results[0]!.compressed?.summary).toContain("plan mode is on");
  });

  it("still runs the read-only calls in the same batch", async () => {
    const read = vi.fn(async () => okResult("os.fs.read"));
    const write = vi.fn(async () => okResult("os.fs.write"));
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "read",
      readonly: true,
      run: read,
    });
    registry.register({
      name: "os.fs.write",
      description: "write",
      readonly: false,
      run: write,
    });
    const inputs = toBatchInputs([
      { tool: "os.fs.read", args: { path: "a" } },
      { tool: "os.fs.write", args: { path: "b", content: "x" } },
      { tool: "os.fs.read", args: { path: "c" } },
    ]);
    const out = await executeBatch(inputs, registry, {
      ...ctx(new AbortController().signal),
      isPlanMode: () => true,
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(write).not.toHaveBeenCalled();
    expect(out.results[0]!.compressed?.status).toBe("ok");
    expect(out.results[1]!.compressed?.status).toBe("error");
    expect(out.results[2]!.compressed?.status).toBe("ok");
  });

  it("does not feed a refused call to the loop detector", async () => {
    // A refused call that was recorded would let a retried tool trip the
    // loop breaker and end the turn — over an argument the model was
    // never allowed to try in the first place.
    const write = vi.fn(async () => okResult("os.fs.write"));
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.write",
      description: "write",
      readonly: false,
      run: write,
    });
    const tracker = new ToolLoopTracker();
    for (let i = 0; i < 12; i++) {
      const out = await executeBatch(
        toBatchInputs([{ tool: "os.fs.write", args: { path: "a" } }]),
        registry,
        {
          ...ctx(new AbortController().signal),
          tracker,
          isPlanMode: () => true,
        },
      );
      expect(out.results[0]!.compressed?.summary).toContain("plan mode is on");
    }
    expect(out2LoopSignals(tracker)).toBe(0);
  });

  it("runs everything again the moment plan mode goes off", async () => {
    const write = vi.fn(async () => okResult("os.fs.write"));
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.write",
      description: "write",
      readonly: false,
      run: write,
    });
    let planning = true;
    const inputs = toBatchInputs([
      { tool: "os.fs.write", args: { path: "a", content: "x" } },
    ]);
    const base = {
      ...ctx(new AbortController().signal),
      isPlanMode: () => planning,
    };
    await executeBatch(inputs, registry, base);
    expect(write).not.toHaveBeenCalled();
    // The getter is read per call, so the flip is observed by the next
    // tool call rather than by the next process.
    planning = false;
    await executeBatch(inputs, registry, base);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("is inert when no getter is supplied", async () => {
    const write = vi.fn(async () => okResult("os.fs.write"));
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.write",
      description: "write",
      readonly: false,
      run: write,
    });
    await executeBatch(
      toBatchInputs([{ tool: "os.fs.write", args: { path: "a" } }]),
      registry,
      ctx(new AbortController().signal),
    );
    expect(write).toHaveBeenCalledTimes(1);
  });
});

/** The tracker never saw a call, so it has nothing to complain about. */
function out2LoopSignals(tracker: ToolLoopTracker): number {
  return tracker.check("os.fs.write", { path: "a" }).count;
}

describe("test-repeat gate (issue #118)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-test-repeat-"));
    await writeFile(join(dir, "app.py"), "x = 1\n");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Shell stub returning a scripted summary per invocation. */
  function shellRegistry(summaries: readonly string[]): {
    registry: ToolRegistry;
    calls: () => number;
  } {
    let i = 0;
    const registry = buildRegistry(
      {
        "os.shell.run": async () =>
          okResult(
            "os.shell.run",
            summaries[Math.min(i++, summaries.length - 1)]!,
          ),
      },
      false,
    );
    return { registry, calls: () => i };
  }

  function testCtx(tracker: ToolLoopTracker) {
    return { ...ctx(new AbortController().signal), workingDir: dir, tracker };
  }

  it("warns on the 2nd equivalent run against an unchanged workspace and still executes it", async () => {
    const { registry, calls } = shellRegistry(["1 failed", "1 failed again"]);
    const tracker = new ToolLoopTracker();
    const context = testCtx(tracker);
    const call = {
      tool: "os.shell.run",
      args: { cmd: "pytest", args: ["-k", "auth"] },
    };

    const first = await executeBatch(toBatchInputs([call]), registry, context);
    expect(first.loopSignals).toEqual([]);

    const second = await executeBatch(toBatchInputs([call]), registry, context);
    const sig = second.loopSignals.find((s) => s.detector === "test_repeat");
    expect(sig).toBeDefined();
    expect(sig!.kind).toBe("warn");
    expect(sig!.count).toBe(2);
    expect(sig!.target).toBe("pytest -k auth");
    expect(sig!.previousSummary).toBe("1 failed");
    // Warn-only: the call still executed and returned the real result.
    expect(calls()).toBe(2);
    expect(second.results[0]!.compressed!.status).toBe("ok");
    expect(second.results[0]!.compressed!.summary).toContain("again");
  });

  it("warns even when only timeoutMs changed (defeats the raw-args hash)", async () => {
    const { registry } = shellRegistry(["3 passed"]);
    const tracker = new ToolLoopTracker();
    const context = testCtx(tracker);

    await executeBatch(
      toBatchInputs([
        { tool: "os.shell.run", args: { cmd: "pytest", timeoutMs: 30_000 } },
      ]),
      registry,
      context,
    );
    const second = await executeBatch(
      toBatchInputs([
        { tool: "os.shell.run", args: { cmd: "pytest", timeoutMs: 60_000 } },
      ]),
      registry,
      context,
    );
    // The generic detector never fires here (different raw args), which
    // is exactly the gap this detector closes.
    const sig = second.loopSignals.find((s) => s.detector === "test_repeat");
    expect(sig).toBeDefined();
    expect(sig!.previousSummary).toBe("3 passed");
  });

  it("permits the rerun when any process changed the workspace in between", async () => {
    const { registry } = shellRegistry(["1 failed"]);
    const tracker = new ToolLoopTracker();
    const context = testCtx(tracker);
    const call = { tool: "os.shell.run", args: { cmd: "pytest" } };

    await executeBatch(toBatchInputs([call]), registry, context);
    // Out-of-band mutation — an Atomic write tool, a shell command, or an
    // external editor are indistinguishable at the filesystem level.
    await writeFile(join(dir, "app.py"), "x = 2 + 2\n");
    const second = await executeBatch(toBatchInputs([call]), registry, context);
    expect(
      second.loopSignals.find((s) => s.detector === "test_repeat"),
    ).toBeUndefined();
  });

  it("treats output churn under documented ignores as no progress", async () => {
    await mkdir(join(dir, "coverage"));
    const { registry } = shellRegistry(["2 passed"]);
    const tracker = new ToolLoopTracker();
    const context = testCtx(tracker);
    const call = { tool: "os.shell.run", args: { cmd: "pytest" } };

    await executeBatch(toBatchInputs([call]), registry, context);
    // Only ignored output changed: this is not source progress.
    await writeFile(join(dir, "coverage", "index.html"), "<html>new</html>");
    const second = await executeBatch(toBatchInputs([call]), registry, context);
    expect(
      second.loopSignals.find((s) => s.detector === "test_repeat"),
    ).toBeDefined();
  });

  it("keeps distinct cwd and filter args out of each other's streaks", async () => {
    await mkdir(join(dir, "api"));
    await writeFile(join(dir, "api", "mod.py"), "y = 1\n");
    const { registry } = shellRegistry(["ok"]);
    const tracker = new ToolLoopTracker();
    const context = testCtx(tracker);

    await executeBatch(
      toBatchInputs([{ tool: "os.shell.run", args: { cmd: "pytest" } }]),
      registry,
      context,
    );
    const otherCwd = await executeBatch(
      toBatchInputs([
        { tool: "os.shell.run", args: { cmd: "pytest", cwd: "api" } },
      ]),
      registry,
      context,
    );
    const otherFilter = await executeBatch(
      toBatchInputs([
        { tool: "os.shell.run", args: { cmd: "pytest", args: ["-k", "x"] } },
      ]),
      registry,
      context,
    );
    expect(
      otherCwd.loopSignals.find((s) => s.detector === "test_repeat"),
    ).toBeUndefined();
    expect(
      otherFilter.loopSignals.find((s) => s.detector === "test_repeat"),
    ).toBeUndefined();
  });

  it("never vetoes: every equivalent run still executes (warn-only)", async () => {
    const { registry, calls } = shellRegistry(["same result"]);
    const tracker = new ToolLoopTracker();
    const context = testCtx(tracker);

    for (let t = 0; t < 3; t += 1) {
      // Distinct timeoutMs keeps the generic no-progress streak silent, so
      // any signal below is the test-repeat detector's alone.
      const out = await executeBatch(
        toBatchInputs([
          {
            tool: "os.shell.run",
            args: { cmd: "pytest", timeoutMs: 1_000 + t },
          },
        ]),
        registry,
        context,
      );
      expect(out.results[0]!.compressed!.status).toBe("ok");
      for (const sig of out.loopSignals) {
        expect(sig.kind).toBe("warn");
      }
    }
    expect(calls()).toBe(3);
  });

  it("leaves unrecognized commands entirely to the generic detector", async () => {
    const { registry } = shellRegistry(["listing"]);
    const tracker = new ToolLoopTracker();
    const context = testCtx(tracker);
    const call = { tool: "os.shell.run", args: { cmd: "ls", args: ["-la"] } };

    await executeBatch(toBatchInputs([call]), registry, context);
    const second = await executeBatch(toBatchInputs([call]), registry, context);
    expect(
      second.loopSignals.find((s) => s.detector === "test_repeat"),
    ).toBeUndefined();
  });
});

describe("the fusion orchestrator gate in the executor", () => {
  const ctrl = new AbortController();

  it("fills a held-back mutation's slot instead of dispatching it", async () => {
    // The refusal has to arrive as this call's RESULT: the model reads
    // tool results, not runtime state, and a dropped call would leave it
    // waiting for an answer that never comes.
    const run = vi.fn(async () => okResult("os.fs.write"));
    const registry = buildRegistry({ "os.fs.write": run }, false);
    const out = await executeBatch(
      toBatchInputs([{ tool: "os.fs.write", args: { path: "a" } }]),
      registry,
      {
        ...ctx(ctrl.signal),
        isFusionOrchestrator: () => true,
        fusionState: () => ({ delegations: 0 }),
      },
    );
    expect(run).not.toHaveBeenCalled();
    expect(out.results[0]?.compressed?.status).toBe("error");
    expect(out.results[0]?.compressed?.summary).toContain("fusion.delegate");
  });

  it("keeps refusing after a fan-out — there is no circumstance", async () => {
    // The gate had two escapes before this: a latch on any completed
    // fan-out, then an allowance for tasks a worker handed up. At
    // approval level 1 four of six tasks came back handed up, so the
    // second escape was the main road. Neither exists now.
    const run = vi.fn(async () => okResult("os.fs.write"));
    const registry = buildRegistry({ "os.fs.write": run }, false);
    const out = await executeBatch(
      toBatchInputs([{ tool: "os.fs.write", args: { path: "a" } }]),
      registry,
      {
        ...ctx(ctrl.signal),
        isFusionOrchestrator: () => true,
        fusionState: () => ({ delegations: 3 }),
      },
    );
    expect(run).not.toHaveBeenCalled();
    expect(out.results[0]?.compressed?.status).toBe("error");
  });

  it("leaves reads alone while the turn is still planning", async () => {
    const run = vi.fn(async () => okResult("os.fs.read"));
    const registry = buildRegistry({ "os.fs.read": run }, true);
    await executeBatch(
      toBatchInputs([{ tool: "os.fs.read", args: { path: "a" } }]),
      registry,
      {
        ...ctx(ctrl.signal),
        isFusionOrchestrator: () => true,
        fusionState: () => ({ delegations: 0 }),
      },
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("hands the fan-out's own result to the turn's ledger", async () => {
    // The result, not a flag: what unlocks a mutation is how many tasks
    // came back `needs_orchestrator`, and the ledger must read the same
    // per-task statuses the model is about to read.
    let seen: unknown = null;
    const registry = buildRegistry(
      { "fusion.delegate": async () => okResult("fusion.delegate") },
      false,
    );
    await executeBatch(
      toBatchInputs([{ tool: "fusion.delegate", args: { tasks: [] } }]),
      registry,
      {
        ...ctx(ctrl.signal),
        isFusionOrchestrator: () => true,
        fusionState: () => ({ delegations: 0 }),
        onDelegated: (result) => {
          seen = result;
        },
      },
    );
    expect(seen).toMatchObject({ tool: "fusion.delegate" });
  });

  it("gates nothing when the turn is not the orchestrator's", async () => {
    // A worker's own turn, and every non-fusion run mode.
    const run = vi.fn(async () => okResult("os.fs.write"));
    const registry = buildRegistry({ "os.fs.write": run }, false);
    await executeBatch(
      toBatchInputs([{ tool: "os.fs.write", args: { path: "a" } }]),
      registry,
      { ...ctx(ctrl.signal), isFusionOrchestrator: () => false },
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("executeBatch outcome-repeat detector (F25)", () => {
  it("warns on the third identical result across differently-argued calls and never vetoes", async () => {
    const calls = vi.fn(
      async (_args: Record<string, unknown>): Promise<CompressedToolResult> =>
        okResult("os.fs.glob", "src/a.ts src/b.ts"),
    );
    const registry = buildRegistry({ "os.fs.glob": calls });
    const tracker = new ToolLoopTracker();
    const signals: BatchLoopSignal[] = [];
    for (const pattern of ["src/*.ts", "src/**/*.ts", "./src/*.ts"]) {
      const out = await executeBatch(
        toBatchInputs([{ tool: "os.fs.glob", args: { pattern } }]),
        registry,
        { ...ctx(new AbortController().signal), tracker },
      );
      signals.push(...out.loopSignals);
      // Never a veto: the call ran every time.
      expect(out.results[0]!.compressed?.status).toBe("ok");
    }
    expect(calls).toHaveBeenCalledTimes(3);
    const outcome = signals.filter((s) => s.detector === "outcome_repeat");
    expect(outcome).toHaveLength(1);
    expect(outcome[0]).toMatchObject({
      kind: "warn",
      tool: "os.fs.glob",
      count: 3,
    });
    expect(outcome[0]!.warningKey.startsWith("outcome_repeat:os.fs.glob|ok|")).toBe(
      true,
    );
  });
});

describe("executeBatch refuses a corrupted call (F37)", () => {
  /** The live Gemma 4 call: a thought channel opened inside `path`. */
  const LIVE_PATH = ".}}]<tool_call|>thought<|channel>thought---<channel|>";

  it("does not run a call whose argument carries a control marker and answers with the error shape", async () => {
    const run = vi.fn(async () => okResult("os.fs.list", "(empty)"));
    const registry = buildRegistry({ "os.fs.list": run });
    const out = await executeBatch(
      toBatchInputs([{ tool: "os.fs.list", args: { path: LIVE_PATH } }]),
      registry,
      ctx(new AbortController().signal),
    );
    expect(run).not.toHaveBeenCalled();
    const result = out.results[0]!.compressed!;
    expect(result.status).toBe("error");
    expect(result.summary).toBe(
      'corrupted tool call: argument `path` contains a model control marker (`<tool_call|>` at char 4: ".}}]<tool_call|>thought<|channel…"). The call was not run — re-emit it with clean arguments.',
    );
    expect(result.details).toEqual({
      corrupted: true,
      markers: [
        {
          path: "path",
          marker: "<tool_call|>",
          index: 4,
          excerpt: ".}}]<tool_call|>thought<|channel…",
        },
      ],
    });
    expect(out.cancelled).toBe(false);
  });

  it("lands details.corrupted on the tool_invocation trace row", async () => {
    const registry = buildRegistry({
      "os.fs.list": async () => okResult("os.fs.list"),
    });
    const events: TraceEvent[] = [];
    const recorder = createTraceRecorder({
      sessionId: "s1",
      emit: (event) => events.push(event),
      now: () => 0,
    });
    recorder.onAgentEvent({ type: "turn_started", turnIndex: 0 });
    recorder.onAgentEvent({ type: "step_started", stepIndex: 0 });
    const call = { tool: "os.fs.list", args: { path: LIVE_PATH } };
    recorder.onAgentEvent({
      type: "llm_event",
      event: { type: "tool_call_parsed", call, batchIndex: 0, batchSize: 1 },
    });
    await executeBatch(toBatchInputs([call]), registry, {
      ...ctx(new AbortController().signal),
      onCallFinished: ({ result, batchIndex, batchSize }) =>
        recorder.onAgentEvent({
          type: "llm_event",
          event: { type: "tool_call_executed", result, batchIndex, batchSize },
        }),
    });
    const row = events.find((e) => e.type === "tool_invocation");
    expect(row).toMatchObject({
      type: "tool_invocation",
      tool: "os.fs.list",
      status: "error",
      args: { path: LIVE_PATH },
      details: { corrupted: true },
    });
  });

  it("counts toward the loop detector like any other error", async () => {
    const run = vi.fn(async () => okResult("os.fs.list"));
    const registry = buildRegistry({ "os.fs.list": run });
    const tracker = new ToolLoopTracker({ criticalThreshold: 3 });
    const signals: BatchLoopSignal[] = [];
    for (let i = 0; i < 4; i += 1) {
      const out = await executeBatch(
        toBatchInputs([{ tool: "os.fs.list", args: { path: LIVE_PATH } }]),
        registry,
        { ...ctx(new AbortController().signal), tracker },
      );
      signals.push(...out.loopSignals);
    }
    expect(run).not.toHaveBeenCalled();
    // The same refused call, repeated, is a no-progress loop: the
    // refusals were recorded as outcomes and the gate eventually vetoes.
    expect(signals.some((s) => s.kind === "critical")).toBe(true);
  });

  it("runs a write whose content mentions a marker mid-line, refuses one whose line starts with it", async () => {
    const run = vi.fn(async () => okResult("os.fs.write", "wrote"));
    const registry = buildRegistry({ "os.fs.write": run }, false);
    const clean = await executeBatch(
      toBatchInputs([
        {
          tool: "os.fs.write",
          args: { path: "a.ts", content: "// wraps <think> tags\nconst x = 1;" },
        },
      ]),
      registry,
      ctx(new AbortController().signal),
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(clean.results[0]!.compressed?.status).toBe("ok");

    const corrupted = await executeBatch(
      toBatchInputs([
        {
          tool: "os.fs.write",
          args: { path: "a.ts", content: "const x = 1;\n<|channel>thought\n" },
        },
      ]),
      registry,
      ctx(new AbortController().signal),
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(corrupted.results[0]!.compressed).toMatchObject({
      status: "error",
      details: { corrupted: true, markers: [{ path: "content", marker: "<|channel>" }] },
    });
  });

  it("refuses only the corrupted call of a batch; its siblings and the tail reply run", async () => {
    const list = vi.fn(async () => okResult("os.fs.list"));
    const read = vi.fn(async () => okResult("os.fs.read"));
    const reply = vi.fn(async () => okResult("reply"));
    const registry = buildRegistry({
      "os.fs.list": list,
      "os.fs.read": read,
      reply,
    });
    const out = await executeBatch(
      toBatchInputs([
        { tool: "os.fs.read", args: { path: "README.md" } },
        { tool: "os.fs.list", args: { path: LIVE_PATH } },
        { tool: "reply", args: { text: "the tag is spelled <think>" } },
      ]),
      registry,
      ctx(new AbortController().signal),
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    // A terminal's text is shown, not run; the turn must be able to close.
    expect(reply).toHaveBeenCalledTimes(1);
    expect(out.results.map((r) => r.compressed?.status)).toEqual([
      "ok",
      "error",
      "ok",
    ]);
  });
});

describe("executeBatch refuses a call with unknown argument keys (F40)", () => {
  /** The live Gemma 4 worker call: the script under a flag used as a key. */
  const LIVE_CALL = {
    tool: "os.shell.run",
    args: { cmd: "python3", "-e": "import os\nos.rename('a', 'b')" },
  };

  it("does not run the call and answers with the error shape", async () => {
    const run = vi.fn(async () => okResult("os.shell.run", "$ python3\nexit: 0"));
    const registry = buildRegistry({ "os.shell.run": run }, false);
    const out = await executeBatch(
      toBatchInputs([LIVE_CALL]),
      registry,
      ctx(new AbortController().signal),
    );
    expect(run).not.toHaveBeenCalled();
    const result = out.results[0]!.compressed!;
    expect(result.status).toBe("error");
    expect(result.summary).toBe(
      'unknown argument `-e` for os.shell.run (expected: cmd, args, cwd, timeoutMs, keep, wait, kill, jobs; put the script in args: ["-c", "…"]) — the call was not run; re-emit it with the right keys',
    );
    expect(result.summary).not.toContain("rename");
    expect(result.details).toEqual({
      unknownKeys: ["-e"],
      expectedKeys: ["cmd", "args", "cwd", "timeoutMs", "keep", "wait", "kill", "jobs"],
    });
    expect(out.cancelled).toBe(false);
  });

  it("names the key the model most likely meant", async () => {
    const run = vi.fn(async () => okResult("os.shell.run"));
    const registry = buildRegistry({ "os.shell.run": run }, false);
    const out = await executeBatch(
      toBatchInputs([
        {
          tool: "os.shell.run",
          args: { cmd: "python3", "-args": ["-c", "print(1)"] },
        },
      ]),
      registry,
      ctx(new AbortController().signal),
    );
    expect(run).not.toHaveBeenCalled();
    expect(out.results[0]!.compressed!.summary).toBe(
      "unknown argument `-args` for os.shell.run (expected: cmd, args, cwd, timeoutMs, keep, wait, kill, jobs; did you mean `args`?) — the call was not run; re-emit it with the right keys",
    );
  });

  it("lands details.unknownKeys on the tool_invocation trace row", async () => {
    const registry = buildRegistry(
      { "os.shell.run": async () => okResult("os.shell.run") },
      false,
    );
    const events: TraceEvent[] = [];
    const recorder = createTraceRecorder({
      sessionId: "s1",
      emit: (event) => events.push(event),
      now: () => 0,
    });
    recorder.onAgentEvent({ type: "turn_started", turnIndex: 0 });
    recorder.onAgentEvent({ type: "step_started", stepIndex: 0 });
    recorder.onAgentEvent({
      type: "llm_event",
      event: {
        type: "tool_call_parsed",
        call: LIVE_CALL,
        batchIndex: 0,
        batchSize: 1,
      },
    });
    await executeBatch(toBatchInputs([LIVE_CALL]), registry, {
      ...ctx(new AbortController().signal),
      onCallFinished: ({ result, batchIndex, batchSize }) =>
        recorder.onAgentEvent({
          type: "llm_event",
          event: { type: "tool_call_executed", result, batchIndex, batchSize },
        }),
    });
    const row = events.find((e) => e.type === "tool_invocation");
    expect(row).toMatchObject({
      type: "tool_invocation",
      tool: "os.shell.run",
      status: "error",
      details: { unknownKeys: ["-e"] },
    });
  });

  it("counts toward the loop detector like any other error", async () => {
    const run = vi.fn(async () => okResult("os.shell.run"));
    const registry = buildRegistry({ "os.shell.run": run }, false);
    const tracker = new ToolLoopTracker({ criticalThreshold: 3 });
    const signals: BatchLoopSignal[] = [];
    for (let i = 0; i < 4; i += 1) {
      const out = await executeBatch(toBatchInputs([LIVE_CALL]), registry, {
        ...ctx(new AbortController().signal),
        tracker,
      });
      signals.push(...out.loopSignals);
    }
    expect(run).not.toHaveBeenCalled();
    expect(signals.some((s) => s.kind === "critical")).toBe(true);
  });

  it("runs a valid call untouched", async () => {
    const run = vi.fn(async () => okResult("os.shell.run", "$ ls -la\nexit: 0"));
    const registry = buildRegistry({ "os.shell.run": run }, false);
    const out = await executeBatch(
      toBatchInputs([
        { tool: "os.shell.run", args: { cmd: "ls", args: ["-la"], cwd: "." } },
      ]),
      registry,
      ctx(new AbortController().signal),
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ cmd: "ls", args: ["-la"], cwd: "." });
    expect(out.results[0]!.compressed?.status).toBe("ok");
  });

  it("runs a tool without a registered schema whatever its keys", async () => {
    const run = vi.fn(async () => okResult("mcp.srv.search"));
    const registry = buildRegistry({ "mcp.srv.search": run });
    const out = await executeBatch(
      toBatchInputs([
        { tool: "mcp.srv.search", args: { query: "x", "-e": "y" } },
      ]),
      registry,
      ctx(new AbortController().signal),
    );
    expect(run).toHaveBeenCalledWith({ query: "x", "-e": "y" });
    expect(out.results[0]!.compressed?.status).toBe("ok");
  });

  it("does not refuse a quoted key that F33 normalises at dispatch", async () => {
    const run = vi.fn(async () => okResult("os.fs.read"));
    const registry = buildRegistry({ "os.fs.read": run });
    const out = await executeBatch(
      toBatchInputs([{ tool: "os.fs.read", args: { '"path"': "a.txt" } }]),
      registry,
      ctx(new AbortController().signal),
    );
    // The registry's own normalisation renamed the key before the tool ran.
    expect(run).toHaveBeenCalledWith({ path: "a.txt" });
    expect(out.results[0]!.compressed?.status).toBe("ok");
  });

  it("refuses only the unknown-key call of a batch; its siblings and the tail reply run", async () => {
    const list = vi.fn(async () => okResult("os.fs.list"));
    const read = vi.fn(async () => okResult("os.fs.read"));
    const reply = vi.fn(async () => okResult("reply"));
    const registry = buildRegistry({
      "os.fs.list": list,
      "os.fs.read": read,
      reply,
    });
    const out = await executeBatch(
      toBatchInputs([
        { tool: "os.fs.read", args: { path: "README.md" } },
        { tool: "os.fs.list", args: { Path: "." } },
        { tool: "reply", args: { text: "done", extra: "shown, not run" } },
      ]),
      registry,
      ctx(new AbortController().signal),
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    // A terminal is never gated: the turn must be able to close.
    expect(reply).toHaveBeenCalledTimes(1);
    expect(out.results.map((r) => r.compressed?.status)).toEqual([
      "ok",
      "error",
      "ok",
    ]);
    expect(out.results[1]!.compressed!.summary).toContain(
      "unknown argument `Path` for os.fs.list",
    );
  });
});

/**
 * A per-step tool set at the seam that matters (F41): a call outside
 * the set never reaches the registry, a call inside runs as usual.
 */
describe("executeBatch under a step tool set", () => {
  it("refuses a call outside the set with the set's refusal and never dispatches it; a call inside runs", async () => {
    const read = vi.fn(async () => okResult("os.fs.read"));
    const delegate = vi.fn(async () => okResult("fusion.delegate", "fanned out"));
    const registry = buildRegistry({
      "os.fs.read": read,
      "fusion.delegate": delegate,
    });
    const set = reviewStallToolSet();
    const signal = new AbortController().signal;
    const refused = await executeBatch(
      toBatchInputs([{ tool: "os.fs.read", args: { path: "a" } }]),
      registry,
      { ...ctx(signal), toolSet: set },
    );
    expect(read).not.toHaveBeenCalled();
    expect(refused.results[0]!.compressed?.status).toBe("error");
    expect(refused.results[0]!.compressed?.summary).toBe(
      toolSetRefusal("os.fs.read", set).summary,
    );
    expect(refused.results[0]!.compressed?.details).toMatchObject({
      tool_set: true,
      admitted: ["fusion.delegate", "reply", "finish"],
    });
    const ran = await executeBatch(
      toBatchInputs([{ tool: "fusion.delegate", args: { tasks: [] } }]),
      registry,
      { ...ctx(signal), toolSet: set },
    );
    expect(delegate).toHaveBeenCalledTimes(1);
    expect(ran.results[0]!.compressed?.status).toBe("ok");
  });

  it("keeps the tail reply of a [read, reply] batch and leaves the loop tracker untouched", async () => {
    const read = vi.fn(async () => okResult("os.fs.read"));
    const reply = vi.fn(async () => okResult("reply", "sent"));
    const registry = buildRegistry({ "os.fs.read": read, reply });
    const tracker = new ToolLoopTracker();
    const out = await executeBatch(
      toBatchInputs([
        { tool: "os.fs.read", args: { path: "a" } },
        { tool: "reply", args: { text: "done" } },
      ]),
      registry,
      { ...ctx(new AbortController().signal), toolSet: reviewStallToolSet(), tracker },
    );
    expect(read).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(out.results[0]!.compressed?.details).toMatchObject({ tool_set: true });
    expect(out.results[1]!.compressed?.status).toBe("ok");
    expect(out.loopSignals).toEqual([]);
    expect(tracker.check("os.fs.read", { path: "a" }).count).toBe(0);
  });
});
