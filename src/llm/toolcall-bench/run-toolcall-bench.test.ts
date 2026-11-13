import { describe, expect, it } from "vitest";

import { BENCH_CASES, BENCH_TOOLS, type BenchCase } from "./bench-cases.js";
import { runToolCallBench, type BenchComplete } from "./run-toolcall-bench.js";

const ONE: BenchCase[] = [
  { id: "read", prompt: "read notes.md", expectedTool: "read_file", requiredArgs: ["path"] },
];

function scripted(replies: Array<string | Error | null>): BenchComplete {
  let i = 0;
  return async () => {
    const next = replies[i++ % replies.length];
    if (next instanceof Error) throw next;
    if (next === null) return { content: "plain text" };
    return { content: "", toolCalls: [{ function: { name: "read_file", arguments: next } }] };
  };
}

describe("runToolCallBench (ATO-1092)", () => {
  it("counts each outcome per model across tries", async () => {
    const complete = scripted(['{"path":"notes.md"}', "{broken", null, "{}", new Error("rate limited")]);
    const [result] = await runToolCallBench({ models: ["m"], tries: 5, cases: ONE, complete, now: () => 0 });
    expect(result).toMatchObject({
      model: "m",
      tries: 5,
      validJson: 2,
      rightTool: 2,
      argsOk: 1,
      parseFailures: 1,
      noCall: 1,
      errors: 1,
      okByCase: { read: 1 },
      firstError: "rate limited",
    });
  });

  it("runs models in order, one request at a time, with the fixed toolbox", async () => {
    const seen: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const complete: BenchComplete = async (model, request) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      seen.push(model);
      expect(request.tools).toBe(BENCH_TOOLS);
      expect(request.prompt).toContain("read notes.md");
      await Promise.resolve();
      inFlight -= 1;
      return { content: "" };
    };
    const results = await runToolCallBench({ models: ["a", "b"], tries: 2, cases: ONE, complete });
    expect(seen).toEqual(["a", "a", "b", "b"]);
    expect(maxInFlight).toBe(1);
    expect(results.map((r) => r.model)).toEqual(["a", "b"]);
  });

  it("uses the built-in cases by default and reports the mean try time", async () => {
    let t = 0;
    const results = await runToolCallBench({
      models: ["m"],
      tries: 1,
      complete: async () => ({ content: "" }),
      now: () => (t += 10),
    });
    expect(results[0]!.tries).toBe(BENCH_CASES.length);
    expect(results[0]!.avgMs).toBe(10);
  });

  it("runs at least one try even when asked for zero", async () => {
    const [result] = await runToolCallBench({ models: ["m"], tries: 0, cases: ONE, complete: scripted([null]) });
    expect(result!.tries).toBe(1);
  });

  it("reports every try to onTry", async () => {
    const events: string[] = [];
    await runToolCallBench({
      models: ["m"],
      tries: 2,
      cases: ONE,
      complete: scripted(['{"path":"x"}']),
      onTry: (e) => events.push(`${e.model}/${e.caseId}/${e.attempt}/${e.outcome}`),
    });
    expect(events).toEqual(["m/read/1/ok", "m/read/2/ok"]);
  });
});

describe("bench cases", () => {
  it("expect only tools the toolbox offers, with arguments those tools declare", () => {
    const byName = new Map(BENCH_TOOLS.map((t) => [t.function.name, t]));
    const ids = new Set<string>();
    for (const c of BENCH_CASES) {
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
      const tool = byName.get(c.expectedTool);
      expect(tool).toBeDefined();
      const props = (tool!.function.parameters as { properties: Record<string, unknown> }).properties;
      for (const arg of c.requiredArgs) expect(props).toHaveProperty(arg);
    }
  });
});
