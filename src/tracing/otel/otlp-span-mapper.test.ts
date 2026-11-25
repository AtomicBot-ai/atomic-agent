import { describe, expect, it } from "vitest";

import type { TraceEvent } from "../trace/trace-event.js";
import type { OtlpKeyValue, OtlpSpan } from "./otlp-json.js";
import { STATUS_ERROR, STATUS_OK } from "./otlp-json.js";
import { createOtlpSpanMapper } from "./otlp-span-mapper.js";

const SESSION = "sess-1";
const OPENROUTER_KEY = `sk-or-v1-${"a1b2c3d4".repeat(8)}`;

function attr(span: { attributes: OtlpKeyValue[] }, key: string): unknown {
  const found = span.attributes.find((a) => a.key === key);
  if (!found) return undefined;
  const v = found.value as Record<string, unknown>;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("boolValue" in v) return v.boolValue;
  if ("arrayValue" in v) {
    return (v.arrayValue as { values: Array<{ stringValue: string }> }).values.map(
      (x) => x.stringValue,
    );
  }
  return v;
}

let seq = 0;
const base = (ts: number) => ({ seq: seq++, sessionId: SESSION, ts });

/** One turn: a model call that asks for a tool, the tool, a final reply. */
function turnEvents(opts: { userMessage?: string; toolArgs?: Record<string, unknown> } = {}): TraceEvent[] {
  return [
    { type: "session_started", ...base(1000), workingDir: "/home/me/project" },
    {
      type: "turn_started",
      ...base(1000),
      turnIndex: 0,
      userMessage: opts.userMessage ?? "list my files",
      route: {
        mode: "cloud",
        main: { providerId: "openrouter", model: "qwen/qwen3-coder" },
        worker: null,
      },
    },
    { type: "step_started", ...base(1010), turnIndex: 0, stepIndex: 0 },
    {
      type: "prompt_captured",
      ...base(1020),
      turnIndex: 0,
      stepIndex: 0,
      stablePrefixHash: "h",
      tail: "user: list my files",
      tokens: { total: 900, stablePrefix: 800, tail: 100 },
      slotId: 0,
      cacheReused: false,
    },
    {
      type: "llm_completion",
      ...base(2000),
      turnIndex: 0,
      stepIndex: 0,
      attempt: 1,
      content: '{"tool":"fs.list"}',
      timing: { promptMs: 300, predictedMs: 500, promptTokens: 900, predictedTokens: 40 },
      cacheHitTokens: 800,
      modelId: "qwen/qwen3-coder-0711",
      stop: true,
      truncated: false,
      generationId: "gen-1",
      costUsd: 0.0012,
    },
    {
      type: "tool_invocation",
      ...base(2100),
      turnIndex: 0,
      stepIndex: 0,
      tool: "fs.list",
      args: opts.toolArgs ?? { path: "." },
      status: "ok",
      summary: "3 entries",
      batchIndex: 0,
      batchSize: 1,
    },
    {
      type: "step_finished",
      ...base(2110),
      turnIndex: 0,
      stepIndex: 0,
      summary: "listed",
      durationMs: 1100,
    },
    { type: "step_started", ...base(2120), turnIndex: 0, stepIndex: 1 },
    {
      type: "llm_completion",
      ...base(2600),
      turnIndex: 0,
      stepIndex: 1,
      attempt: 1,
      content: "You have 3 files.",
      timing: { promptMs: 100, predictedMs: 300, promptTokens: 950, predictedTokens: 10 },
      cacheHitTokens: 0,
      modelId: "qwen/qwen3-coder-0711",
      stop: true,
      truncated: false,
      costUsd: 0.0003,
    },
    {
      type: "turn_finished",
      ...base(2700),
      turnIndex: 0,
      reason: "reply",
      stepCount: 2,
      durationMs: 1700,
    },
  ];
}

function run(events: TraceEvent[], captureContent = false): OtlpSpan[] {
  const spans: OtlpSpan[] = [];
  const mapper = createOtlpSpanMapper({
    onSpan: (s) => spans.push(s),
    captureContent,
    knownSecrets: () => [{ label: "openrouter-key", value: OPENROUTER_KEY }],
  });
  for (const e of events) mapper.handle(e);
  return spans;
}

describe("createOtlpSpanMapper", () => {
  it("maps a turn to invoke_agent / chat / execute_tool spans in one trace", () => {
    const spans = run(turnEvents());
    expect(spans.map((s) => s.name)).toEqual([
      "chat qwen/qwen3-coder-0711",
      "execute_tool fs.list",
      "chat qwen/qwen3-coder-0711",
      "invoke_agent atomic-agent",
    ]);
    const root = spans.at(-1)!;
    expect(root.parentSpanId).toBeUndefined();
    for (const child of spans.slice(0, -1)) {
      expect(child.traceId).toBe(root.traceId);
      expect(child.parentSpanId).toBe(root.spanId);
    }
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("uses gen_ai.* semantic-convention attributes", () => {
    const [chat, tool, , root] = run(turnEvents());
    expect(attr(root!, "gen_ai.operation.name")).toBe("invoke_agent");
    expect(attr(root!, "gen_ai.conversation.id")).toBe(SESSION);
    expect(attr(root!, "gen_ai.provider.name")).toBe("openrouter");
    expect(attr(root!, "gen_ai.request.model")).toBe("qwen/qwen3-coder");
    expect(attr(root!, "gen_ai.usage.input_tokens")).toBe(1850);
    expect(attr(root!, "gen_ai.usage.output_tokens")).toBe(50);
    expect(attr(root!, "gen_ai.usage.cost")).toBeCloseTo(0.0015);
    expect(attr(root!, "atomic.turn.reason")).toBe("reply");
    expect(root!.status.code).toBe(STATUS_OK);

    expect(attr(chat!, "gen_ai.operation.name")).toBe("chat");
    expect(attr(chat!, "gen_ai.response.model")).toBe("qwen/qwen3-coder-0711");
    expect(attr(chat!, "gen_ai.response.id")).toBe("gen-1");
    expect(attr(chat!, "gen_ai.usage.input_tokens")).toBe(900);
    expect(attr(chat!, "gen_ai.usage.output_tokens")).toBe(40);
    expect(attr(chat!, "gen_ai.usage.cache_read.input_tokens")).toBe(800);
    expect(attr(chat!, "gen_ai.response.finish_reasons")).toEqual(["stop"]);
    expect(chat!.kind).toBe(3);

    expect(attr(tool!, "gen_ai.operation.name")).toBe("execute_tool");
    expect(attr(tool!, "gen_ai.tool.name")).toBe("fs.list");
  });

  it("times a chat span from the server's timing and a tool from the call before it", () => {
    const [chat, tool, , root] = run(turnEvents());
    // ts 2000 minus promptMs + predictedMs (800 ms).
    expect(chat!.startTimeUnixNano).toBe("1200000000");
    expect(chat!.endTimeUnixNano).toBe("2000000000");
    expect(tool!.startTimeUnixNano).toBe("2000000000");
    expect(tool!.endTimeUnixNano).toBe("2100000000");
    expect(root!.startTimeUnixNano).toBe("1000000000");
    expect(root!.endTimeUnixNano).toBe("2700000000");
  });

  it("keeps all text out of spans unless captureContent is set", () => {
    const spans = run(turnEvents());
    const json = JSON.stringify(spans);
    expect(json).not.toContain("list my files");
    expect(json).not.toContain("You have 3 files");
    expect(json).not.toContain("3 entries");
    expect(json).not.toContain('"path"');
    expect(json).not.toContain("/home/me/project");
    expect(json).not.toContain("gen_ai.input.messages");
    expect(json).not.toContain("gen_ai.output.messages");
  });

  it("puts masked text in with captureContent", () => {
    const spans = run(
      turnEvents({
        userMessage: `use my key ${OPENROUTER_KEY} please`,
        toolArgs: { token: OPENROUTER_KEY, path: "." },
      }),
      true,
    );
    const json = JSON.stringify(spans);
    expect(json).not.toContain(OPENROUTER_KEY);
    expect(json).toContain("[redacted:");
    const root = spans.at(-1)!;
    const input = JSON.parse(attr(root, "gen_ai.input.messages") as string);
    expect(input[0].role).toBe("user");
    expect(input[0].parts[0].content).toContain("[redacted:");
    const chat = spans[2]!;
    expect(JSON.parse(attr(chat, "gen_ai.output.messages") as string)[0].parts[0].content).toBe(
      "You have 3 files.",
    );
    expect(attr(spans[1]!, "gen_ai.tool.call.arguments")).toContain('"path":"."');
  });

  it("masks a secret by shape even when it is not a known value", () => {
    const spans: OtlpSpan[] = [];
    const mapper = createOtlpSpanMapper({ onSpan: (s) => spans.push(s), captureContent: true });
    const events = turnEvents({ userMessage: `key: ${OPENROUTER_KEY}` });
    for (const e of events) mapper.handle(e);
    expect(JSON.stringify(spans)).not.toContain(OPENROUTER_KEY);
  });

  it("marks a failed turn and a failed model call as errors", () => {
    const spans = run([
      {
        type: "turn_started",
        ...base(0),
        turnIndex: 0,
        route: { mode: "local", main: { providerId: "local", model: null }, worker: null },
      },
      { type: "step_started", ...base(10), turnIndex: 0, stepIndex: 0 },
      {
        type: "error",
        ...base(50),
        turnIndex: 0,
        stepIndex: 0,
        message: "fetch failed at /home/me/secret-project",
        category: "transport",
        causeCode: "ECONNREFUSED",
      },
      { type: "turn_finished", ...base(60), turnIndex: 0, reason: "failed", stepCount: 1, durationMs: 60 },
    ]);
    expect(spans.map((s) => s.name)).toEqual(["chat", "invoke_agent atomic-agent"]);
    const [chat, root] = spans;
    expect(chat!.status.code).toBe(STATUS_ERROR);
    expect(attr(chat!, "error.type")).toBe("transport");
    expect(attr(chat!, "atomic.error.cause_code")).toBe("ECONNREFUSED");
    expect(root!.status.code).toBe(STATUS_ERROR);
    expect(attr(root!, "error.type")).toBe("transport");
    expect(root!.events?.[0]?.name).toBe("exception");
    // The message is text: not exported without captureContent.
    expect(JSON.stringify(spans)).not.toContain("secret-project");
  });

  it("marks a tool error on its span", () => {
    const events = turnEvents();
    const tool = events.find((e) => e.type === "tool_invocation")!;
    if (tool.type === "tool_invocation") tool.status = "error";
    const toolSpan = run(events).find((s) => s.name.startsWith("execute_tool"))!;
    expect(toolSpan.status.code).toBe(STATUS_ERROR);
    expect(attr(toolSpan, "error.type")).toBe("tool_error");
  });

  it("turns other in-turn events into span events with only safe fields", () => {
    const events = turnEvents();
    events.splice(events.length - 1, 0, {
      type: "loop_detected",
      ...base(2650),
      turnIndex: 0,
      stepIndex: 1,
      tool: "fs.list",
      count: 3,
      level: "warn",
      detector: "generic_repeat",
      read: {
        path: "/home/me/private.txt",
        startLine: 1,
        endLine: 2,
        previousFingerprint: "a",
        fingerprint: "a",
      },
    }, {
      type: "parse_retry",
      ...base(2660),
      turnIndex: 0,
      stepIndex: 1,
      attempt: 2,
      reason: "model wrote: my password is hunter2",
    });
    const root = run(events).at(-1)!;
    const names = root.events?.map((e) => e.name);
    expect(names).toEqual(["loop_detected", "parse_retry"]);
    const loop = root.events![0]!;
    expect(attr(loop, "atomic.count")).toBe(3);
    expect(attr(loop, "atomic.tool")).toBe("fs.list");
    expect(attr(loop, "atomic.detector")).toBe("generic_repeat");
    const json = JSON.stringify(root);
    expect(json).not.toContain("private.txt");
    expect(json).not.toContain("hunter2");
  });

  it("ignores events with no open turn and ends open turns as unfinished", () => {
    const spans: OtlpSpan[] = [];
    const mapper = createOtlpSpanMapper({ onSpan: (s) => spans.push(s), captureContent: false });
    mapper.handle({ type: "reflection", ...base(5), outcome: "ok" });
    expect(spans).toHaveLength(0);
    mapper.handle({ type: "turn_started", ...base(10), turnIndex: 0 });
    expect(mapper.openTurnCount()).toBe(1);
    mapper.endAll(500);
    expect(mapper.openTurnCount()).toBe(0);
    expect(spans).toHaveLength(1);
    expect(attr(spans[0]!, "atomic.turn.unfinished")).toBe(true);
    expect(spans[0]!.endTimeUnixNano).toBe("500000000");
  });

  it("caps open turns, ending the oldest", () => {
    const spans: OtlpSpan[] = [];
    const mapper = createOtlpSpanMapper({
      onSpan: (s) => spans.push(s),
      captureContent: false,
      maxOpenTurns: 2,
    });
    for (const id of ["a", "b", "c"]) {
      mapper.handle({ type: "turn_started", seq: 0, sessionId: id, ts: 1, turnIndex: 0 });
    }
    expect(mapper.openTurnCount()).toBe(2);
    expect(spans.map((s) => attr(s, "session.id"))).toEqual(["a"]);
  });

  it("never throws, even when the span consumer does", () => {
    const mapper = createOtlpSpanMapper({
      onSpan: () => {
        throw new Error("exporter down");
      },
      captureContent: false,
    });
    expect(() => {
      for (const e of turnEvents()) mapper.handle(e);
    }).not.toThrow();
  });
});
