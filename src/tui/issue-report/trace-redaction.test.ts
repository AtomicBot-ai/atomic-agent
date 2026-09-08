import { describe, expect, it } from "vitest";

import { redactTraceNdjson } from "./trace-redaction.js";

const CTX = { homeDir: "/Users/valerii", workingDir: "/Users/valerii/proj" };

const ROWS = [
  { seq: 1, type: "session_started", sessionId: "s", ts: 1, workingDir: "/Users/valerii/proj" },
  { seq: 2, type: "prompt_captured", sessionId: "s", ts: 2, tail: "secret plans", tokens: 12 },
  { seq: 3, type: "tool_invocation", sessionId: "s", ts: 3, tool: "os.fs.read", args: { path: "/Users/valerii/proj/a" }, summary: "file body", status: "ok" },
  { seq: 4, type: "llm_completion", sessionId: "s", ts: 4, content: "reply text", modelId: "m", timing: { ms: 5 } },
  { seq: 5, type: "reflection", sessionId: "s", ts: 5, notes: ["private"] },
  { seq: 6, type: "error", sessionId: "s", ts: 6, message: `boom at /Users/valerii/proj/x ghp_${"A".repeat(36)}`, category: "tool" },
  { seq: 7, type: "step_finished", sessionId: "s", ts: 7, stepIndex: 0 },
];
const NDJSON = `${ROWS.map((r) => JSON.stringify(r)).join("\n")}\n`;

function parse(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("redactTraceNdjson", () => {
  it("errors: keeps only failure-shaped rows, scrubbed", () => {
    const { text, stats } = redactTraceNdjson(NDJSON, "errors", CTX);
    const rows = parse(text);
    expect(rows.map((r) => r.type)).toEqual(["error", "step_finished"]);
    expect(rows[0]?.message).toBe("boom at <cwd>/x <token>");
    expect(stats).toEqual({ kept: 2, dropped: 5, stripped: 0 });
  });

  it("scrubbed: strips content fields, drops memory-fabric events, keeps structure", () => {
    const { text, stats } = redactTraceNdjson(NDJSON, "scrubbed", CTX);
    const rows = parse(text);
    expect(rows.map((r) => r.type)).toEqual([
      "session_started",
      "prompt_captured",
      "tool_invocation",
      "llm_completion",
      "error",
      "step_finished",
    ]);
    expect(rows[0]?.workingDir).toBe("<removed>");
    expect(rows[1]?.tail).toBe("<removed>");
    expect(rows[1]?.tokens).toBe(12);
    expect(rows[2]?.args).toBe("<removed>");
    expect(rows[2]?.summary).toBe("<removed>");
    expect(rows[2]?.tool).toBe("os.fs.read");
    expect(rows[3]?.content).toBe("<removed>");
    expect(rows[3]?.modelId).toBe("m");
    expect(text).not.toContain("secret plans");
    expect(text).not.toContain("private");
    expect(text).not.toContain("/Users/valerii");
    expect(stats.dropped).toBe(1);
    expect(stats.stripped).toBe(5);
  });

  it("full: keeps everything but masks secrets", () => {
    const { text, stats } = redactTraceNdjson(NDJSON, "full", CTX);
    const rows = parse(text);
    expect(rows).toHaveLength(7);
    expect(rows[1]?.tail).toBe("secret plans");
    expect(rows[2]?.args).toEqual({ path: "/Users/valerii/proj/a" });
    expect(text).not.toContain("ghp_");
    expect(stats).toEqual({ kept: 7, dropped: 0, stripped: 0 });
  });

  it("drops rows it cannot parse rather than passing them through", () => {
    const { text, stats } = redactTraceNdjson('not json\n{"type":"error","message":"x"}\n', "full", CTX);
    expect(parse(text)).toHaveLength(1);
    expect(stats.dropped).toBe(1);
  });

  it("returns an empty string for an empty trace", () => {
    expect(redactTraceNdjson("", "full", CTX).text).toBe("");
  });
});
