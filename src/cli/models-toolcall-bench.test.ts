import { describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../config/index.js";
import type { CompletionRequest, CompletionResult } from "../llm/provider/completion-types.js";
import { fakeProvider } from "../llm/provider/fake-provider.fixture.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import { BENCH_CASES } from "../llm/toolcall-bench/index.js";

import type { BuiltSpecs } from "./models-bench-providers.js";
import { promptOf, runModelsAsk, runModelsToolcallBench } from "./models-toolcall-bench.js";

const CONFIG = {
  llm: {
    activeTextProvider: "or",
    activeEmbeddingProvider: "or",
    providers: [{ id: "or", kind: "openrouter" }],
    toolTransport: "auto",
  },
} as unknown as AtomicAgentConfig;

function result(partial: Partial<CompletionResult>): CompletionResult {
  return {
    content: "",
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 0, predictedTokens: 0 },
    cacheHitTokens: 0,
    slotId: -1,
    modelId: null,
    ...partial,
  };
}

function harness(providers: Record<string, LlmProvider>, refused: BuiltSpecs["refused"] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[][] = [];
  return {
    out,
    err,
    asked,
    deps: {
      config: CONFIG,
      build: async (_config: AtomicAgentConfig, specs: ReadonlyArray<{ spec: string }>) => {
        asked.push(specs.map((s) => s.spec));
        return { providers: new Map(Object.entries(providers)), refused };
      },
      write: (t: string) => out.push(t),
      writeErr: (t: string) => err.push(t),
    },
  };
}

describe("models toolcall-bench (ATO-1092)", () => {
  it("sends the fixed toolbox with tool_choice auto and prints a JSON summary", async () => {
    const requests: CompletionRequest[] = [];
    const provider = fakeProvider("or", "native_tools", async (request) => {
      requests.push(request);
      return result({ toolCalls: [{ function: { name: "read_file", arguments: '{"path":"x"}' } }] });
    });
    const h = harness({ "or:m1": provider });
    const code = await runModelsToolcallBench(["--models", "or:m1", "--tries", "2", "--json"], h.deps);
    expect(code).toBe(0);
    expect(h.asked).toEqual([["or:m1"]]);
    expect(requests).toHaveLength(BENCH_CASES.length * 2);
    expect(requests[0]).toMatchObject({ toolChoice: "auto", parallelToolCalls: false });
    expect(requests[0]!.tools).toHaveLength(5);
    const [summary] = JSON.parse(h.out.join(""));
    expect(summary).toMatchObject({ model: "or:m1", tries: BENCH_CASES.length * 2, rightTool: 2, argsOk: 2 });
  });

  it("skips a grammar link and exits 1 when nothing is left", async () => {
    const h = harness({ cli: fakeProvider("cli", "grammar", async () => result({})) });
    expect(await runModelsToolcallBench(["--models", "cli"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("skipped cli: this link does not take native tools");
  });

  it("rejects a bad --tries before building anything", async () => {
    const h = harness({});
    expect(await runModelsToolcallBench(["--tries", "zero"], h.deps)).toBe(2);
    expect(h.asked).toEqual([]);
  });

  it("reports refused specs and exits 1 when none could be built", async () => {
    const h = harness({}, [{ spec: "nope", reason: "no provider" }]);
    expect(await runModelsToolcallBench(["--models", "nope"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("skipped nope: no provider");
  });
});

describe("models ask (ATO-1092)", () => {
  it("asks every model the same question without tools", async () => {
    const seen: CompletionRequest[] = [];
    const make = (answer: string) =>
      fakeProvider("p", "native_tools", async (request) => {
        seen.push(request);
        return result({ content: answer });
      });
    const h = harness({ "or:a": make("four"), "or:b": make("4") });
    const code = await runModelsAsk(["what", "is", "2+2", "--models", "or:a,or:b"], h.deps);
    expect(code).toBe(0);
    expect(seen.map((r) => r.prompt)).toEqual(["what is 2+2", "what is 2+2"]);
    expect(seen.every((r) => r.tools === undefined)).toBe(true);
    expect(h.out.join("")).toMatch(/== or:a \(\d+ ms\) ==\nfour\n\n== or:b \(\d+ ms\) ==\n4\n/);
  });

  it("needs a question", async () => {
    const h = harness({});
    expect(await runModelsAsk(["--models", "or"], h.deps)).toBe(2);
  });

  it("exits 1 when every model failed", async () => {
    const down = fakeProvider("p", "native_tools", async () => {
      throw new Error("401");
    });
    const h = harness({ or: down });
    expect(await runModelsAsk(["hi", "--json"], h.deps)).toBe(1);
    expect(JSON.parse(h.out.join(""))[0]).toMatchObject({ model: "or", error: "401" });
  });
});

describe("promptOf", () => {
  it("drops --models and its value and --json", () => {
    expect(promptOf(["--json", "hello", "--models", "a,b", "world"])).toBe("hello world");
  });
});
