import { describe, expect, it } from "vitest";

import { redactTraceNdjson } from "./trace-redaction.js";

const CTX = { homeDir: "/Users/valerii", workingDir: "/Users/valerii/proj" };

const ROWS = [
  { seq: 0, type: "turn_started", sessionId: "s", ts: 0, turnIndex: 0, userMessage: "my private ask" },
  { seq: 1, type: "session_started", sessionId: "s", ts: 1, workingDir: "/Users/valerii/proj" },
  { seq: 2, type: "prompt_captured", sessionId: "s", ts: 2, tail: "secret plans", tokens: 12 },
  { seq: 3, type: "tool_invocation", sessionId: "s", ts: 3, tool: "os.fs.read", args: { path: "/Users/valerii/proj/a" }, summary: "file body", status: "ok" },
  { seq: 4, type: "llm_completion", sessionId: "s", ts: 4, content: "reply text", modelId: "m", timing: { ms: 5 } },
  { seq: 5, type: "reflection", sessionId: "s", ts: 5, notes: ["private"] },
  { seq: 6, type: "error", sessionId: "s", ts: 6, message: `boom at /Users/valerii/proj/x ghp_${"A".repeat(36)}`, stack: "at /opt/agent/dist/x.js:1", category: "tool" },
  { seq: 7, type: "step_finished", sessionId: "s", ts: 7, stepIndex: 0, summary: "file contents preview", durationMs: 3 },
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
    // Paths outside home / cwd go too, and the stack keeps only its shape.
    expect(rows[0]?.stack).toBe("at <path>:1");
    expect(rows[1]?.summary).toBe("<removed>");
    expect(rows[1]?.durationMs).toBe(3);
    for (const r of rows) expect(r.sessionId).toBeUndefined();
    expect(text).not.toContain("file contents");
    expect(stats).toEqual({ kept: 2, dropped: 6, stripped: 1 });
  });

  it("scrubbed: strips content fields, drops memory-fabric events, keeps structure", () => {
    const { text, stats } = redactTraceNdjson(NDJSON, "scrubbed", CTX);
    const rows = parse(text);
    expect(rows.map((r) => r.type)).toEqual([
      "turn_started",
      "session_started",
      "prompt_captured",
      "tool_invocation",
      "llm_completion",
      "error",
      "step_finished",
    ]);
    expect(rows[0]?.userMessage).toBe("<removed>");
    expect(rows[1]?.workingDir).toBe("<removed>");
    expect(rows[2]?.tail).toBe("<removed>");
    expect(rows[2]?.tokens).toBe(12);
    expect(rows[3]?.args).toBe("<removed>");
    expect(rows[3]?.summary).toBe("<removed>");
    expect(rows[3]?.tool).toBe("os.fs.read");
    expect(rows[4]?.content).toBe("<removed>");
    expect(rows[4]?.modelId).toBe("m");
    expect(rows[6]?.summary).toBe("<removed>");
    for (const r of rows) expect(r.sessionId).toBeUndefined();
    expect(text).not.toContain("secret plans");
    expect(text).not.toContain("private");
    expect(text).not.toContain("file contents");
    expect(text).not.toContain("/Users/valerii");
    expect(stats.dropped).toBe(1);
    expect(stats.stripped).toBe(7);
  });

  it("full: keeps everything but masks secrets", () => {
    const { text, stats } = redactTraceNdjson(NDJSON, "full", CTX);
    const rows = parse(text);
    expect(rows).toHaveLength(8);
    expect(rows[0]?.userMessage).toBe("my private ask");
    expect(rows[2]?.tail).toBe("secret plans");
    expect(rows[3]?.args).toEqual({ path: "/Users/valerii/proj/a" });
    expect(rows[0]?.sessionId).toBe("s");
    expect(text).not.toContain("ghp_");
    expect(stats).toEqual({ kept: 8, dropped: 0, stripped: 0 });
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
