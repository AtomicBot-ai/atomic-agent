import { describe, expect, it } from "vitest";

import { createTraceBus } from "../trace/trace-bus.js";
import type { TraceEvent } from "../trace/trace-event.js";
import type { FetchLike } from "./otlp-exporter.js";
import type { OtlpExportRequest } from "./otlp-json.js";
import { createOtlpTraceSink } from "./otlp-trace-sink.js";

const settings = {
  tracesUrl: "http://localhost:4318/v1/traces",
  headers: { "x-api-key": "k" },
  captureContent: false,
  serviceName: "atomic-agent",
  resourceAttributes: { "deployment.environment": "test" },
};

function turn(sessionId: string): TraceEvent[] {
  return [
    { type: "turn_started", seq: 0, sessionId, ts: 100, turnIndex: 0, userMessage: "hi" },
    {
      type: "llm_completion",
      seq: 1,
      sessionId,
      ts: 200,
      turnIndex: 0,
      stepIndex: 0,
      attempt: 1,
      content: "hello",
      cacheHitTokens: 0,
      modelId: "m",
      stop: true,
      truncated: false,
    },
    { type: "turn_finished", seq: 2, sessionId, ts: 300, turnIndex: 0, reason: "reply", stepCount: 1, durationMs: 200 },
  ];
}

describe("createOtlpTraceSink", () => {
  it("exports a turn received on the trace bus as OTLP JSON", async () => {
    const bodies: OtlpExportRequest[] = [];
    const fetch: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init.body) as OtlpExportRequest);
      return { ok: true, status: 200 };
    };
    const otlp = createOtlpTraceSink({ settings, version: "9.9.9", fetch });
    const bus = createTraceBus([otlp.sink]);
    for (const e of turn("s1")) bus.emit(e);
    await otlp.flush();
    expect(bodies).toHaveLength(1);
    const rs = bodies[0]!.resourceSpans[0]!;
    const resource = Object.fromEntries(
      rs.resource.attributes.map((a) => [a.key, (a.value as { stringValue: string }).stringValue]),
    );
    expect(resource).toMatchObject({
      "service.name": "atomic-agent",
      "service.version": "9.9.9",
      "deployment.environment": "test",
    });
    expect(rs.scopeSpans[0]!.spans.map((s) => s.name)).toEqual([
      "chat m",
      "invoke_agent atomic-agent",
    ]);
    expect(JSON.stringify(bodies)).not.toContain("hello");
  });

  it("ends open turns on shutdown and sends them", async () => {
    const bodies: OtlpExportRequest[] = [];
    const fetch: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init.body) as OtlpExportRequest);
      return { ok: true, status: 200 };
    };
    const otlp = createOtlpTraceSink({ settings, fetch });
    otlp.sink(turn("s2")[0]!);
    await otlp.shutdown();
    const spans = bodies.flatMap((b) => b.resourceSpans[0]!.scopeSpans[0]!.spans);
    expect(spans.map((s) => s.name)).toEqual(["invoke_agent atomic-agent"]);
    // After shutdown the sink ignores events.
    for (const e of turn("s3")) otlp.sink(e);
    await otlp.flush();
    expect(bodies).toHaveLength(1);
  });

  it("keeps the agent going when the endpoint is down", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4318");
    };
    const otlp = createOtlpTraceSink({ settings, fetch, logger: { warn: () => {} } });
    const bus = createTraceBus([otlp.sink]);
    expect(() => {
      for (const e of turn("s4")) bus.emit(e);
    }).not.toThrow();
    await expect(otlp.shutdown()).resolves.toBeUndefined();
    expect(otlp.exporter.stats().failedBatches).toBe(1);
  });
});
