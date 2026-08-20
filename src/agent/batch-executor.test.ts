import { describe, it, expect, vi } from "vitest";
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
