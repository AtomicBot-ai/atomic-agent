import { afterEach, describe, expect, it, vi } from "vitest";

import { createOtlpExporter, type FetchLike } from "./otlp-exporter.js";
import type { OtlpExportRequest, OtlpSpan } from "./otlp-json.js";
import { msToUnixNano, toAttributes } from "./otlp-json.js";

function span(i: number): OtlpSpan {
  return {
    traceId: "0".repeat(31) + "1",
    spanId: i.toString(16).padStart(16, "0"),
    name: `span-${i}`,
    kind: 1,
    startTimeUnixNano: msToUnixNano(i),
    endTimeUnixNano: msToUnixNano(i + 1),
    attributes: [],
    status: { code: 0 },
  };
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: OtlpExportRequest;
}

function recordingFetch(status = 200): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as OtlpExportRequest });
    return { ok: status >= 200 && status < 300, status };
  };
  return { fetch, calls };
}

const names = (call: Call): string[] =>
  call.body.resourceSpans[0]!.scopeSpans[0]!.spans.map((s) => s.name);

afterEach(() => {
  vi.useRealTimers();
});

describe("createOtlpExporter", () => {
  it("posts an ExportTraceServiceRequest as JSON with the configured headers", async () => {
    const { fetch, calls } = recordingFetch();
    const exporter = createOtlpExporter({
      tracesUrl: "http://collector:4318/v1/traces",
      headers: { Authorization: "Basic abc" },
      resource: toAttributes({ "service.name": "atomic-agent" }),
      scope: { name: "atomic-agent", version: "1.2.3" },
      fetch,
    });
    exporter.enqueue(span(1));
    await exporter.flush();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("http://collector:4318/v1/traces");
    expect(call.headers).toEqual({
      Authorization: "Basic abc",
      "Content-Type": "application/json",
    });
    const rs = call.body.resourceSpans[0]!;
    expect(rs.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "atomic-agent" } },
    ]);
    expect(rs.scopeSpans[0]!.scope).toEqual({ name: "atomic-agent", version: "1.2.3" });
    expect(rs.scopeSpans[0]!.spans[0]!.startTimeUnixNano).toBe("1000000");
    expect(exporter.stats()).toMatchObject({ exported: 1, dropped: 0, queued: 0 });
  });

  it("sends as soon as a batch fills, in batches of maxBatchSize", async () => {
    const { fetch, calls } = recordingFetch();
    const exporter = createOtlpExporter({
      tracesUrl: "http://c/v1/traces",
      headers: {},
      resource: [],
      scope: { name: "t" },
      fetch,
      maxBatchSize: 2,
      scheduledDelayMs: 60_000,
    });
    for (let i = 0; i < 5; i++) exporter.enqueue(span(i));
    await exporter.flush();
    expect(calls.map(names)).toEqual([
      ["span-0", "span-1"],
      ["span-2", "span-3"],
      ["span-4"],
    ]);
  });

  it("sends a partial batch after the scheduled delay", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = recordingFetch();
    const exporter = createOtlpExporter({
      tracesUrl: "http://c/v1/traces",
      headers: {},
      resource: [],
      scope: { name: "t" },
      fetch,
      scheduledDelayMs: 1000,
    });
    exporter.enqueue(span(1));
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    await exporter.flush();
    expect(calls).toHaveLength(1);
    expect(exporter.stats().exported).toBe(1);
  });

  it("bounds the queue, dropping the oldest spans", async () => {
    const { fetch, calls } = recordingFetch();
    const warn = vi.fn();
    // Hold the first request so spans pile up behind it.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowFetch: FetchLike = async (url, init) => {
      await gate;
      return fetch(url, init);
    };
    const exporter = createOtlpExporter({
      tracesUrl: "http://c/v1/traces",
      headers: {},
      resource: [],
      scope: { name: "t" },
      fetch: slowFetch,
      maxQueueSize: 2,
      maxBatchSize: 2,
      scheduledDelayMs: 60_000,
      logger: { warn },
    });
    exporter.enqueue(span(0));
    exporter.enqueue(span(1)); // batch full: taken off the queue, request held
    await new Promise((r) => setImmediate(r));
    exporter.enqueue(span(2));
    exporter.enqueue(span(3));
    exporter.enqueue(span(4)); // queue (max 2) full: span-2 dropped
    expect(exporter.stats().dropped).toBe(1);
    release();
    await exporter.flush();
    expect(calls.map(names)).toEqual([["span-0", "span-1"], ["span-3", "span-4"]]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("contains failures: a 5xx or a thrown fetch never rejects, and warns once per streak", async () => {
    const warn = vi.fn();
    let mode: "throw" | "500" | "ok" = "throw";
    const fetch: FetchLike = async () => {
      if (mode === "throw") throw new Error("connect ECONNREFUSED");
      return { ok: mode === "ok", status: mode === "ok" ? 200 : 500 };
    };
    const exporter = createOtlpExporter({
      tracesUrl: "http://c/v1/traces",
      headers: { Authorization: "Bearer very-secret-token" },
      resource: [],
      scope: { name: "t" },
      fetch,
      logger: { warn },
    });
    exporter.enqueue(span(1));
    await expect(exporter.flush()).resolves.toBeUndefined();
    mode = "500";
    exporter.enqueue(span(2));
    await expect(exporter.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("very-secret-token");
    expect(exporter.stats()).toMatchObject({ failedBatches: 2, dropped: 2 });
    mode = "ok";
    exporter.enqueue(span(3));
    await exporter.flush();
    mode = "throw";
    exporter.enqueue(span(4));
    await exporter.flush();
    // A new streak after a success warns again.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(exporter.stats().exported).toBe(1);
  });

  it("flushes on shutdown and then ignores new spans", async () => {
    const { fetch, calls } = recordingFetch();
    const exporter = createOtlpExporter({
      tracesUrl: "http://c/v1/traces",
      headers: {},
      resource: [],
      scope: { name: "t" },
      fetch,
      scheduledDelayMs: 60_000,
    });
    exporter.enqueue(span(1));
    exporter.enqueue(span(2));
    await exporter.shutdown();
    expect(calls.map(names)).toEqual([["span-1", "span-2"]]);
    exporter.enqueue(span(3));
    await exporter.flush();
    expect(calls).toHaveLength(1);
  });

  it("does not let a hung endpoint hold shutdown past its limit", async () => {
    vi.useFakeTimers();
    const fetch: FetchLike = () => new Promise(() => {});
    const exporter = createOtlpExporter({
      tracesUrl: "http://c/v1/traces",
      headers: {},
      resource: [],
      scope: { name: "t" },
      fetch,
    });
    exporter.enqueue(span(1));
    let done = false;
    void exporter.shutdown(500).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(done).toBe(true);
  });
});
