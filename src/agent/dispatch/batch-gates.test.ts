import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { executeBatch, toBatchInputs, FINAL_STEP_REFUSAL as publicFinalRefusal } from "../batch-executor.js";
import { ToolLoopTracker } from "../loop-detector.js";
import type { BatchExecutionContext, BatchLoopSignal } from "./batch-contract.js";
import { FINAL_STEP_REFUSAL, refuseBeforeDispatch, runSyncLoopGate, skillAlreadyLoadedResult } from "./batch-gates.js";

const context = (extra: Partial<BatchExecutionContext> = {}): BatchExecutionContext => ({ workingDir: "/tmp", sessionId: "gates-session", stepIndex: 0, signal: new AbortController().signal, ...extra });
const result = (tool: string, text = "same") => compressToolResult({ tool, status: "ok", output: text });
afterEach(() => vi.restoreAllMocks());

describe("dispatch gate owner seams", () => {
  it("preserves the public final-step constant and final→plan→tracker precedence before dispatch", async () => {
    expect(publicFinalRefusal).toBe(FINAL_STEP_REFUSAL);
    const tracker = new ToolLoopTracker(); const check = vi.spyOn(tracker, "check");
    const plan = vi.fn(() => true); const fusion = vi.fn(() => true); const run = vi.fn(async () => result("os.fs.write"));
    const registry = new ToolRegistry(); registry.register({ name: "os.fs.write", description: "fixture", readonly: false, run });
    const calls = toBatchInputs([{ tool: "os.fs.write", args: { path: "fixture", content: "x" } }]);
    const final = await executeBatch(calls, registry, context({ terminalOnly: true, tracker, isPlanMode: plan, isFusionOrchestrator: fusion }));
    expect(final.results[0]?.compressed?.summary).toBe(FINAL_STEP_REFUSAL);
    expect(plan).not.toHaveBeenCalled(); expect(fusion).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    const held = await executeBatch(calls, registry, context({ tracker, isPlanMode: plan, isFusionOrchestrator: fusion }));
    expect(held.results[0]?.compressed?.status).toBe("error"); expect(plan).toHaveBeenCalledTimes(1);
    expect(fusion).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });

  it("retains synchronous check→record visibility across sibling calls using one real tracker", () => {
    const tracker = new ToolLoopTracker({ warningThreshold: 2 });
    const events: string[] = [];
    const check = tracker.check.bind(tracker); const record = tracker.recordCall.bind(tracker);
    vi.spyOn(tracker, "check").mockImplementation((...args) => { events.push("check"); return check(...args); });
    vi.spyOn(tracker, "recordCall").mockImplementation((...args) => { events.push("record"); return record(...args); });
    const inputs = toBatchInputs(Array.from({ length: 3 }, () => ({ tool: "os.fs.stat", args: { path: "same" } })));
    const signals: BatchLoopSignal[] = [];
    for (const input of inputs) expect(runSyncLoopGate(input, context({ tracker }), signals).proceed).toBe(true);
    expect(events).toEqual(["check", "record", "check", "record", "check", "record"]);
    expect(signals).toMatchObject([{ kind: "warn", detector: "generic_repeat", count: 2 }]);
    const terminal = toBatchInputs([{ tool: "reply", args: { text: "close" } }])[0];
    if (!terminal) throw new Error("missing fixture terminal");
    runSyncLoopGate(terminal, context({ tracker }), signals); expect(events).toHaveLength(6);
  });

  it("checks control markers before unknown keys and retains ordinary typed error results", () => {
    const corrupted = refuseBeforeDispatch({ tool: "os.shell.run", args: { cmd: "python3", "-e": "<|channel>" } });
    expect(corrupted?.status).toBe("error"); expect(corrupted?.details).toMatchObject({ corrupted: true });
    expect(corrupted?.details.unknownKeys).toBeUndefined();
    const unknown = refuseBeforeDispatch({ tool: "os.shell.run", args: { cmd: "python3", "-e": "print(1)" } });
    expect(unknown?.details.unknownKeys).toEqual(["-e"]);
    expect(refuseBeforeDispatch({ tool: "mcp.fixture.custom", args: { arbitrary: "allowed by its own parser" } })).toBeNull();
  });

  it("retains the already-loaded skill shortcut without a second skillLoaded state effect", () => {
    const input = toBatchInputs([{ tool: "skill.view", args: { name: "already-present" } }])[0];
    if (!input) throw new Error("missing fixture skill");
    const synthetic = skillAlreadyLoadedResult(input, context({ loadedSkillNames: new Set(["already-present"]) }));
    expect(synthetic?.details).toEqual({ skillAlreadyLoaded: "already-present" });
    expect(synthetic?.details.skillLoaded).toBeUndefined();
    expect(skillAlreadyLoadedResult(input, context({ loadedSkillNames: new Set() }))).toBeNull();
  });

  it("keeps the same tracker after a veto: recordOutcome excludes vetoes from no-progress growth while blocked count advances", () => {
    const tracker = new ToolLoopTracker({ warningThreshold: 2, criticalThreshold: 2, breakerVetoStreak: 3 });
    const input = toBatchInputs([{ tool: "os.fs.stat", args: { path: "same" } }])[0];
    if (!input) throw new Error("missing fixture input");
    for (let i = 0; i < 2; i++) { tracker.recordCall(input.call.tool, input.call.args); tracker.recordOutcome(input.call.tool, input.call.args, result(input.call.tool)); }
    const signals: BatchLoopSignal[] = [];
    for (let i = 0; i < 2; i++) expect(runSyncLoopGate(input, context({ tracker }), signals).proceed).toBe(false);
    expect(signals.map((signal) => [signal.kind, signal.count, signal.blockedCount])).toEqual([["critical", 2, 1], ["critical", 2, 2]]);
    expect(tracker.check(input.call.tool, input.call.args).count).toBe(2);
  });
});
