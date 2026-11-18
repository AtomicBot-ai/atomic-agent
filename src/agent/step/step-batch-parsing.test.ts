import { describe, expect, it } from "vitest";
import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolCallBatch } from "../../llm/grammar/tool-call-grammar.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import type { StepBatchPolicy } from "./step-batch-policy.js";
import { callLike, parseStepBatch } from "./step-batch-parsing.js";
import type { StepContext, StepDependencies } from "./step-contract.js";
import type { PreparedStepInference } from "./step-inference.js";

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

function run(content: string, extra: Partial<CompletionResult> = {}) {
  const messages: string[] = [];
  const log = (message: string) => {
    messages.push(message);
  };
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
  const parsed = parseStepBatch({ ctx, deps, prepared, completion, policy, assumesOpenReasoning: () => false });
  return { parsed, messages };
}

describe("parseStepBatch on a completion served without the grammar (ATO-1675)", () => {
  it("reads prose as the model's reply at once", () => {
    const { parsed, messages } = run("The file has three lines.", { grammarSkipped: true });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.batch.calls).toEqual([{ tool: "reply", args: { text: "The file has three lines." } }]);
    }
    expect(messages).toContain("reading a reply served without the grammar");
  });

  it("still parses a call the model wrote", () => {
    const { parsed } = run('Reading it.\n[{"tool":"os.fs.read","args":{"path":"a.ts"}}]', { grammarSkipped: true });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.batch.calls).toEqual([{ tool: "os.fs.read", args: { path: "a.ts" } }]);
  });

  it("sends a botched JSON body to repair, never echoing it as a reply", () => {
    const { parsed } = run('[{"tool": "os.fs.read", "args": ', { grammarSkipped: true, truncated: true });
    expect(parsed.ok).toBe(false);
  });

  it("keeps the grammar path as it was: prose under a grammar is a parse failure for repair", () => {
    const { parsed } = run("The file has three lines.");
    expect(parsed.ok).toBe(false);
  });

  it("sends prose followed by a botched call to repair, never delivering it as a reply", () => {
    const { parsed } = run('Let me read it.\n[{"tool": "os.fs.read", "args": {"path": ', {
      grammarSkipped: true,
      truncated: true,
    });
    expect(parsed.ok).toBe(false);
  });

  it("sends prose with a fenced call the step refused to repair, not to the user", () => {
    const { parsed } = run('Reading.\n```json\n[{"tool":"os.fs.reed","args":{"path":"a.ts",}}]\n```', {
      grammarSkipped: true,
    });
    expect(parsed.ok).toBe(false);
  });

  it("reads llama.cpp's generic tool_calls envelope only on a completion served without the grammar", () => {
    const body = '{"tool_calls":[{"name":"os.fs.read","arguments":{"path":"a.ts"}}]}';
    const skipped = run(body, { grammarSkipped: true });
    expect(skipped.parsed.ok).toBe(true);
    if (skipped.parsed.ok) {
      expect(skipped.parsed.batch.calls).toEqual([{ tool: "os.fs.read", args: { path: "a.ts" } }]);
    }
    expect(run(body).parsed.ok).toBe(false);
  });

  it("admits a fenced code answer that is not a call as a reply", () => {
    const answer = "Use this:\n```python\nitems = {\"a\": 1}\nprint(items[\"a\"])\n```";
    const { parsed } = run(answer, { grammarSkipped: true });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.batch.calls).toEqual([{ tool: "reply", args: { text: answer } }]);
  });

  it("admits citations and braces in prose, even at the start of the answer", () => {
    for (const answer of ["The limit is 4096 tokens [1].", "[1] The docs say {x} is a set."]) {
      const { parsed } = run(answer, { grammarSkipped: true });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.batch.calls).toEqual([{ tool: "reply", args: { text: answer } }]);
    }
  });

  it("sends prose followed by a broken {\"tool\": ...} call to repair", () => {
    const { parsed } = run('Done reading.\n{"tool": "os.fs.read", "args": {"path": "a.ts"', {
      grammarSkipped: true,
      truncated: true,
    });
    expect(parsed.ok).toBe(false);
  });

  it("sends prose with a fenced {name, arguments} call that did not validate to repair", () => {
    const { parsed } = run(
      'Reading.\n```json\n{"name":"os.fs.reed","arguments":{"path":"a.ts"}}\n```',
      { grammarSkipped: true },
    );
    expect(parsed.ok).toBe(false);
  });
});

describe("callLike stays linear on hostile text (ATO-1675)", () => {
  it("answers quickly on repeated name objects and on a wall of openers", () => {
    const started = Date.now();
    expect(callLike('{"name": 1} '.repeat(20_000))).toBe(false);
    expect(callLike("{".repeat(100_000))).toBe(false);
    expect(callLike('{"name": 1, "args" '.repeat(20_000))).toBe(true);
    expect(callLike('{"'.repeat(100_000))).toBe(false);
    expect(callLike(`{${'"a":"b",'.repeat(20_000)}`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("keeps finding a call and ignoring a package.json example", () => {
    expect(callLike('Reading.\n```json\n{"name":"x","arguments":{"path":"a.ts"}}\n```')).toBe(true);
    expect(callLike('{"name": "x", "argu')).toBe(true);
    expect(callLike('Done.\n{"tool": "os.fs.read", "args": {')).toBe(true);
    expect(callLike('{"name":"pkg","version":"1.0.0"}')).toBe(false);
  });

  it("finds a call key after a long field or a nested object, in any key order", () => {
    expect(callLike(`{"thought":"${"x".repeat(250)}","tool":"os.fs.read","args":{}}`)).toBe(true);
    expect(callLike(`Looking.\n{"thought":"${"x".repeat(250)}","tool":"os.fs.read","args":{"path":`)).toBe(true);
    expect(callLike('{"id":1,"meta":{"x":1},"tool":"os.fs.read","args":{}}')).toBe(true);
    expect(callLike('{"args":{"path":"a.ts"},"tool":"os.fs.read"')).toBe(true);
    expect(callLike('{"args":{"p":1},"name":"x"}')).toBe(true);
    expect(callLike("{'tool': 'os.fs.read', 'args': {}}")).toBe(true);
  });

  it("ignores call words outside an object and a long package.json example", () => {
    expect(callLike('Use {braces} and the "tool": key later.')).toBe(false);
    expect(callLike("I don't {think} it's [really] \"tool\": here.")).toBe(false);
    expect(callLike('{"message": "use the \\"tool\\": key"}')).toBe(false);
    expect(callLike('```json\n{"name":"pkg","version":"1.0.0","scripts":{"build":"tsc"}}\n```')).toBe(false);
    expect(callLike(`{"name":"pkg","description":"${"x".repeat(40_000)}"}`)).toBe(false);
  });
});
