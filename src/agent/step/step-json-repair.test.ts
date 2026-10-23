import { describe, expect, it } from "vitest";
import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolCallBatch } from "../../llm/grammar/tool-call-grammar.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import type { StepBatchPolicy } from "./step-batch-policy.js";
import { parseStepBatch } from "./step-batch-parsing.js";
import type { StepContext, StepDependencies } from "./step-contract.js";
import type { PreparedStepInference } from "./step-inference.js";
import { judgeRepairedBatch } from "./step-json-repair.js";

function registryWith(...names: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of names) {
    registry.register({
      name,
      description: name,
      readonly: true,
      run: async () => compressToolResult({ tool: name, status: "ok", output: "" }),
    });
  }
  return registry;
}

const clean = { truncated: false, finishReason: "stop" } as const;
const repaired = (
  calls: ToolCallBatch["calls"],
  over: Partial<NonNullable<ToolCallBatch["jsonRepair"]>> = {},
): ToolCallBatch => ({
  kind: "batch",
  calls,
  jsonRepair: { fixes: ["trailing comma"], closedString: false, closedBrackets: false, ...over },
});

describe("judgeRepairedBatch (ATO-637)", () => {
  const registry = registryWith("os.fs.read", "os.fs.write");

  it("accepts an unrepaired batch without looking", () => {
    expect(judgeRepairedBatch({ kind: "batch", calls: [{ tool: "nope", args: {} }] }, clean, registry, [])).toEqual({ accept: true });
  });

  it("accepts a repaired call of a known tool with schema-valid args", () => {
    expect(judgeRepairedBatch(repaired([{ tool: "os.fs.read", args: { path: "a.ts" } }]), clean, registry, [])).toEqual({ accept: true });
  });

  it("refuses an unknown tool", () => {
    const verdict = judgeRepairedBatch(repaired([{ tool: "os.fs.reed", args: { path: "a.ts" } }]), clean, registry, []);
    expect(verdict).toEqual({ accept: false, reason: "unknown tool 'os.fs.reed'" });
  });

  it("refuses args that do not match the schema", () => {
    const verdict = judgeRepairedBatch(repaired([{ tool: "os.fs.read", args: { pth: "a.ts" } }]), clean, registry, []);
    expect(verdict.accept).toBe(false);
  });

  it("never uses a repair that closed a string", () => {
    const verdict = judgeRepairedBatch(
      repaired([{ tool: "os.fs.read", args: { path: "a.ts" } }], { closedString: true, closedBrackets: true }),
      clean,
      registry,
      [],
    );
    expect(verdict).toEqual({ accept: false, reason: "a string was left open" });
  });

  it("refuses closed brackets on a cut completion", () => {
    const batch = repaired([{ tool: "os.fs.read", args: { path: "a.ts" } }], { closedBrackets: true });
    expect(judgeRepairedBatch(batch, clean, registry, [])).toEqual({ accept: true });
    expect(judgeRepairedBatch(batch, { truncated: true, finishReason: null }, registry, []).accept).toBe(false);
    expect(judgeRepairedBatch(batch, { truncated: false, finishReason: "length" }, registry, []).accept).toBe(false);
  });

  it("refuses closed brackets on a tool that writes file content", () => {
    const batch = repaired([{ tool: "os.fs.write", args: { path: "a.ts", content: "x" } }], { closedBrackets: true });
    expect(judgeRepairedBatch(batch, clean, registry, []).accept).toBe(false);
  });
});

describe("parseStepBatch with a repaired completion", () => {
  function run(content: string, registry = registryWith("os.fs.read")) {
    const logs: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const log = (message: string, context?: Record<string, unknown>) => {
      logs.push({ message, ...(context ? { context } : {}) });
    };
    const ctx = { session: { id: "s-1" }, stepIndex: 3, toolDescriptors: [] } as unknown as StepContext;
    const deps = {
      profile: PLAIN_INSTRUCT_PROFILE,
      toolTransport: "grammar",
      toolCallAdapter: null,
      registry,
      logger: { info: log, warn: log, error: log, debug: log },
    } as unknown as StepDependencies;
    const prepared = { stepDescriptors: [], stepToolDescriptors: [], thinkingOff: false } as unknown as PreparedStepInference;
    const policy = {
      takeProgressNote: (batch: ToolCallBatch) => ({ batch, note: undefined }),
      setProgressNote: () => {},
      trySplitPureReadWaves: () => null,
      tryTrimApprovalGated: () => null,
    } as unknown as StepBatchPolicy;
    const completion = { content, reasoningContent: "", stop: true, truncated: false } as unknown as CompletionResult;
    const parsed = parseStepBatch({ ctx, deps, prepared, completion, policy, assumesOpenReasoning: () => false });
    return { parsed, logs };
  }

  it("runs a trailing-comma call and logs the repair", () => {
    const { parsed, logs } = run('[{"tool":"os.fs.read","args":{"path":"a.ts",}}]');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.batch.calls).toEqual([{ tool: "os.fs.read", args: { path: "a.ts" } }]);
    expect(logs).toContainEqual({
      message: "tool-call JSON repaired",
      context: { sessionId: "s-1", stepIndex: 3, fixes: "trailing comma", tools: "os.fs.read" },
    });
  });

  it("sends a repair of an unknown tool back to the one-shot repair", () => {
    const { parsed, logs } = run('[{"tool":"os.fs.reed","args":{"path":"a.ts",}}]');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain("unknown tool 'os.fs.reed'");
    expect(logs.map((entry) => entry.message)).toContain("tool-call JSON repair not used");
  });

  it("does not run a call whose string had to be closed", () => {
    const { parsed } = run('[{"tool":"os.fs.read","args":{"path":"src/a.t');
    expect(parsed.ok).toBe(false);
  });
});
