import { describe, expect, it } from "vitest";
import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolCallBatch } from "../../llm/grammar/tool-call-grammar.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import { GrammarError } from "../../llm/reliability/llm-failures.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { extractGrammarFailureTags } from "../../error-reporting/grammar-failure-tag.js";
import { extractSafeToolTransport } from "../../error-reporting/error-scrubber.js";
import type { StepBatchPolicy } from "./step-batch-policy.js";
import { finishStepBatchRepair } from "./step-batch-parsing.js";
import type { StepContext, StepDependencies } from "./step-contract.js";
import type { PreparedStepInference } from "./step-inference.js";
import type { ParseDeps } from "./step-parsing.js";

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

/** The repair completion `content` handed to `finishStepBatchRepair`. */
function repair(content: string, extra: Partial<CompletionResult> = {}) {
  const log = () => {};
  const ctx = { session: { id: "s-1" }, stepIndex: 1, toolDescriptors: [] } as unknown as StepContext;
  const deps = {
    profile: PLAIN_INSTRUCT_PROFILE,
    toolTransport: "grammar",
    toolCallAdapter: null,
    registry: registryWith("os.fs.read", "reply"),
    logger: { info: log, warn: log, error: log, debug: log },
  } as unknown as StepDependencies;
  const prepared = { stepDescriptors: [], stepToolDescriptors: [], thinkingOff: false } as unknown as PreparedStepInference;
  const policy = {
    takeProgressNote: (batch: ToolCallBatch) => ({ batch, note: undefined }),
    setProgressNote: () => {},
    trySplitPureReadWaves: () => null,
    tryTrimApprovalGated: () => null,
  } as unknown as StepBatchPolicy;
  const completion = {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    ...extra,
  } as unknown as CompletionResult;
  const retryParseDeps = { toolTransport: "grammar", toolCallAdapter: null } as unknown as ParseDeps;
  return finishStepBatchRepair(
    { ctx, deps, prepared, completion, policy, assumesOpenReasoning: () => false },
    completion,
    retryParseDeps,
  );
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

describe("finishStepBatchRepair on a repair served without the grammar (ATO-2422)", () => {
  it("reads prose that opens with [ as the reply, like the first parse does", () => {
    // Before ATO-2422 this body ended the step: `replyFallbackBatch`
    // refuses any body that opens with `[` or `{`.
    const answer = "[1] The docs say {x} is a set.";
    const parsed = repair(answer, { grammarSkipped: true });
    expect(parsed.batch.calls).toEqual([{ tool: "reply", args: { text: answer } }]);
  });

  it("still fails a call-looking repair body, tagged as repair_failed without the grammar", () => {
    const err = thrown(() => repair('[{"tool": "os.fs.read", "args": ', { grammarSkipped: true }));
    expect(err).toBeInstanceOf(GrammarError);
    const grammar = err as GrammarError;
    expect(grammar.path).toBe("repair_failed");
    expect(grammar.transport).toBe("grammar");
    expect(grammar.grammarSkipped).toBe(true);
    expect(extractGrammarFailureTags(grammar)).toEqual({ grammar_path: "repair_failed", grammar_skipped: "yes" });
    expect(extractSafeToolTransport(grammar)).toBe("grammar");
  });

  it("keeps the grammar path as it was: a [-led body under the grammar fails, grammar_skipped no", () => {
    const err = thrown(() => repair("[1] The docs say {x} is a set."));
    expect(err).toBeInstanceOf(GrammarError);
    expect(extractGrammarFailureTags(err)).toEqual({ grammar_path: "repair_failed", grammar_skipped: "no" });
  });
});
