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
  executeBatch,
  planBatch,
  toBatchInputs,
} from "./batch-executor.js";
import {
  LOOP_VETO_DENIED_REASON,
  ToolLoopTracker,
} from "./loop-detector.js";

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
    const make = (idx: number) =>
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
        const idx = (args.idx as number) ?? -1;
        return await make(idx)(args);
      },
    });
    const inputs = toBatchInputs([
      { tool: "browser.click", args: { idx: 0 } },
      { tool: "browser.click", args: { idx: 1 } },
      { tool: "browser.click", args: { idx: 2 } },
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
        reads.push((args.idx as number) ?? -1);
        return okResult("os.fs.read");
      },
    });
    registry.register({
      name: "browser.click",
      description: "click",
      readonly: false,
      run: async (args) => {
        await new Promise((r) => setTimeout(r, 60));
        clicks.push((args.idx as number) ?? -1);
        return okResult("browser.click");
      },
    });
    const inputs = toBatchInputs([
      { tool: "os.fs.read", args: { idx: 0 } },
      { tool: "browser.click", args: { idx: 1 } },
      { tool: "os.fs.read", args: { idx: 2 } },
      { tool: "browser.click", args: { idx: 3 } },
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
          setTimeout(r, (args.idx as number) === 2 ? 5 : 60),
        );
        return okResult("os.fs.read", `done-${args.idx}`);
      },
    });
    const inputs = toBatchInputs([
      { tool: "os.fs.read", args: { idx: 0 } },
      { tool: "os.fs.read", args: { idx: 1 } },
      { tool: "os.fs.read", args: { idx: 2 } },
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
      expect(out.results.every((r) => r.compressed?.status === "ok")).toBe(true);
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

  // Issue #186: the veto body must name the invariant that held across
  // the blocked attempts and offer a concrete alternative.
  it("veto body names the repeated host and offers the search-first alternative", async () => {
    const registry = buildRegistry({ "os.web.fetch": async () => okResult("os.web.fetch") });
    const tracker = new ToolLoopTracker({
      warningThreshold: 2,
      criticalThreshold: 2,
    });
    const args = { url: "https://web.archive.org/web/2020/https://x.test/a?k=SECRET" };
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

  it("veto body names the command for a shell loop", async () => {
    const registry = buildRegistry({ "os.shell.run": async () => okResult("os.shell.run") });
    const tracker = new ToolLoopTracker({
      warningThreshold: 2,
      criticalThreshold: 2,
    });
    const args = { command: "curl -s https://x.test --header 'Authorization: Bearer SECRET'" };
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
    const registry = buildRegistry({ "os.fs.read": async () => okResult("os.fs.read") });
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
    expect(body).toContain("2 consecutive calls returned the same no-progress outcome");
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
    const registry = buildRegistry({ "os.web.fetch": async () => okResult("os.web.fetch") });
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
        if ((args.idx as number) === 0) {
          ctrl.abort();
        }
        return okResult("browser.click");
      },
    });
    const inputs = toBatchInputs([
      { tool: "browser.click", args: { idx: 0 } },
      { tool: "browser.click", args: { idx: 1 } },
      { tool: "browser.click", args: { idx: 2 } },
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
    const base = { ...ctx(new AbortController().signal), isPlanMode: () => planning };
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
