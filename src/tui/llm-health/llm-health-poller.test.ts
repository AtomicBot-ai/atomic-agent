import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as healthModule from "../../llm/llama-server-health.js";
import type { HealthResult } from "../../llm/llama-server-health.js";
import type { TuiAction } from "../tui-action.js";
import { LlmHealthPoller } from "./llm-health-poller.js";

interface Capture {
  emit(action: TuiAction): void;
  actions: TuiAction[];
}

function makeCapture(): Capture {
  const actions: TuiAction[] = [];
  return {
    actions,
    emit(action) {
      actions.push(action);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `LlmHealthPoller` drives the always-on footer health indicator. These
 * tests lock in observable behaviours the reducer depends on: first-probe
 * probing state, steady-healthy polls without probing flicker, in-flight
 * debounce, URL hot-swap via `updateUrl`, and clean shutdown via `stop`.
 */
describe("LlmHealthPoller", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(healthModule, "checkLlamaServer");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should emit probing then healthy on a reachable URL", async () => {
    spy.mockResolvedValueOnce({
      reachable: true,
      status: 200,
      error: null,
      latencyMs: 42,
    } satisfies HealthResult);
    const capture = makeCapture();
    const poller = new LlmHealthPoller(capture, "http://127.0.0.1:19091", 10_000);
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    poller.stop();

    const health = capture.actions.filter((a) => a.type === "llm_health_updated");
    expect(health).toHaveLength(2);
    expect(health[0]).toMatchObject({ status: "probing" });
    expect(health[1]).toMatchObject({
      status: "healthy",
      latencyMs: 42,
      error: null,
    });
  });

  it("should not emit probing on later ticks while the server stays healthy", async () => {
    spy.mockResolvedValue({
      reachable: true,
      status: 200,
      error: null,
      latencyMs: 1,
    } satisfies HealthResult);
    const capture = makeCapture();
    // Interval must exceed a single probe so the timer does not fire while
    // `probing` is still true (that tick is skipped and we would never get a
    // second healthy emission).
    const poller = new LlmHealthPoller(capture, "http://127.0.0.1:19091", 250);
    poller.start();
    // First tick (immediate) + one interval tick → two healthy emissions.
    await sleep(450);
    poller.stop();

    const health = capture.actions.filter((a) => a.type === "llm_health_updated");
    const probings = health.filter((a) => a.status === "probing");
    const healthies = health.filter((a) => a.status === "healthy");
    expect(probings).toHaveLength(1);
    expect(healthies.length).toBeGreaterThanOrEqual(2);
  });

  it("should not emit probing on later ticks while the server stays down", async () => {
    spy.mockResolvedValue({
      reachable: false,
      status: null,
      error: "connect ECONNREFUSED",
      latencyMs: 3,
    } satisfies HealthResult);
    const capture = makeCapture();
    const poller = new LlmHealthPoller(capture, "http://127.0.0.1:19091", 250);
    poller.start();
    // First tick (immediate) + one interval tick → two unreachable emissions,
    // but only the very first tick may show the transient `probing` glyph.
    await sleep(450);
    poller.stop();

    const health = capture.actions.filter((a) => a.type === "llm_health_updated");
    const probings = health.filter((a) => a.status === "probing");
    const downs = health.filter((a) => a.status === "unreachable");
    expect(probings).toHaveLength(1);
    expect(downs.length).toBeGreaterThanOrEqual(2);
  });

  it("should emit probing again after updateUrl even when previously steady-healthy", async () => {
    spy
      .mockResolvedValueOnce({
        reachable: true,
        status: 200,
        error: null,
        latencyMs: 1,
      } satisfies HealthResult)
      .mockResolvedValueOnce({
        reachable: true,
        status: 200,
        error: null,
        latencyMs: 2,
      } satisfies HealthResult);
    const capture = makeCapture();
    const poller = new LlmHealthPoller(capture, "http://first:9000", 60_000);
    poller.start();
    await sleep(30);
    poller.updateUrl("http://second:9000");
    await sleep(30);
    poller.stop();

    const health = capture.actions.filter((a) => a.type === "llm_health_updated");
    expect(health.filter((a) => a.status === "probing")).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("should emit unreachable on probe failure", async () => {
    spy.mockResolvedValueOnce({
      reachable: false,
      status: null,
      error: "connect ECONNREFUSED",
      latencyMs: 3,
    } satisfies HealthResult);
    const capture = makeCapture();
    const poller = new LlmHealthPoller(capture, "http://127.0.0.1:19091", 10_000);
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    poller.stop();

    const final = capture.actions.at(-1);
    expect(final).toMatchObject({
      type: "llm_health_updated",
      status: "unreachable",
      error: "connect ECONNREFUSED",
    });
  });

  it("should skip a re-probe while one is still in flight", async () => {
    let resolveFirst: ((r: HealthResult) => void) | null = null;
    spy.mockImplementationOnce(
      () =>
        new Promise<HealthResult>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const capture = makeCapture();
    const poller = new LlmHealthPoller(capture, "http://127.0.0.1:19091", 10_000);
    poller.start();
    poller.updateUrl("http://127.0.0.1:19091");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(spy).toHaveBeenCalledTimes(1);
    resolveFirst?.({ reachable: true, status: 200, error: null, latencyMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    poller.stop();
  });

  it("should re-probe after updateUrl with a new URL", async () => {
    spy
      .mockResolvedValueOnce({
        reachable: true,
        status: 200,
        error: null,
        latencyMs: 5,
      } satisfies HealthResult)
      .mockResolvedValueOnce({
        reachable: true,
        status: 200,
        error: null,
        latencyMs: 7,
      } satisfies HealthResult);
    const capture = makeCapture();
    const poller = new LlmHealthPoller(capture, "http://old:9000", 10_000);
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    poller.updateUrl("http://new:9000");
    await new Promise((resolve) => setTimeout(resolve, 10));
    poller.stop();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ url: "http://old:9000" });
    expect(spy.mock.calls[1]?.[0]).toMatchObject({ url: "http://new:9000" });
  });

  it("should fetch /props once and emit the model label after first healthy probe", async () => {
    spy.mockResolvedValue({
      reachable: true,
      status: 200,
      error: null,
      latencyMs: 1,
    } satisfies HealthResult);
    const fetchCalls: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push(url);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model_alias: "Qwen3-30B-A3B-Instruct.gguf",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };
    const capture = makeCapture();
    const poller = new LlmHealthPoller(
      capture,
      "http://127.0.0.1:19091",
      300,
      fetchImpl,
    );
    poller.start();
    await sleep(450);
    poller.stop();

    const modelEvents = capture.actions.filter(
      (a) => a.type === "llm_model_updated",
    );
    expect(modelEvents).toHaveLength(1);
    expect(modelEvents[0]).toMatchObject({
      type: "llm_model_updated",
      model: "Qwen3-30B-A3B-Instruct.gguf",
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain("/props");
  });

  it("should emit notifyCatalogModel without waiting for /props", () => {
    const capture = makeCapture();
    const poller = new LlmHealthPoller(capture, "http://127.0.0.1:19091");
    poller.notifyCatalogModel("gemma-4-e4b");
    poller.stop();
    expect(capture.actions).toContainEqual({
      type: "llm_model_updated",
      model: "gemma-4-e4b",
    });
  });

  it("should re-fetch /props after refreshModelLabel", async () => {
    spy.mockResolvedValue({
      reachable: true,
      status: 200,
      error: null,
      latencyMs: 1,
    } satisfies HealthResult);
    let propsCount = 0;
    const fetchImpl: typeof fetch = () => {
      propsCount += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({ model_alias: "restarted-model" }),
          { status: 200 },
        ),
      );
    };
    const capture = makeCapture();
    const poller = new LlmHealthPoller(
      capture,
      "http://127.0.0.1:19091",
      60_000,
      fetchImpl,
    );
    poller.notifyCatalogModel("gemma-4-e4b");
    await poller.refreshModelLabel();
    poller.stop();
    const labels = capture.actions
      .filter((a) => a.type === "llm_model_updated")
      .map((a) => (a as { model: string | null }).model);
    expect(labels).toContain("gemma-4-e4b");
    expect(labels).toContain("restarted-model");
    expect(propsCount).toBe(1);
  });

  it("should re-fetch the model label after updateUrl", async () => {
    spy.mockResolvedValue({
      reachable: true,
      status: 200,
      error: null,
      latencyMs: 1,
    } satisfies HealthResult);
    let propsCount = 0;
    const fetchImpl: typeof fetch = () => {
      propsCount += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model_alias: propsCount === 1 ? "first" : "second",
          }),
          { status: 200 },
        ),
      );
    };
    const capture = makeCapture();
    const poller = new LlmHealthPoller(
      capture,
      "http://a:9000",
      60_000,
      fetchImpl,
    );
    poller.start();
    await sleep(40);
    poller.updateUrl("http://b:9000");
    await sleep(40);
    poller.stop();

    const modelEvents = capture.actions.filter(
      (a) => a.type === "llm_model_updated",
    );
    // Three: first label, reset to null on URL change, second label.
    expect(modelEvents).toHaveLength(3);
    expect(modelEvents.map((a) => (a as { model: string | null }).model)).toEqual([
      "first",
      null,
      "second",
    ]);
  });

  it("should not emit after stop", async () => {
    let resolveProbe: ((r: HealthResult) => void) | null = null;
    spy.mockImplementationOnce(
      () =>
        new Promise<HealthResult>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const capture = makeCapture();
    const poller = new LlmHealthPoller(capture, "http://127.0.0.1:19091", 10_000);
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    poller.stop();
    resolveProbe?.({ reachable: true, status: 200, error: null, latencyMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const healthy = capture.actions.filter(
      (a) => a.type === "llm_health_updated" && a.status === "healthy",
    );
    expect(healthy).toHaveLength(0);
  });

  it("fetches the model label from /props under a reverse-proxy prefix", async () => {
    // Same defect as every other llama endpoint: "/props" used to
    // resolve against the origin, so a prefixed server never showed a
    // model name — half of the "does not recognize my models" report.
    spy.mockResolvedValue({
      reachable: true,
      status: 200,
      error: null,
      latencyMs: 1,
      kind: "llama-server",
    } satisfies HealthResult);
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ model_alias: "my-model" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const capture = makeCapture();
    const poller = new LlmHealthPoller(
      capture,
      "https://box.example/llama",
      10_000,
      fetchImpl,
    );
    poller.start();
    await sleep(30);
    poller.stop();
    expect(urls).toEqual(["https://box.example/llama/props"]);
    const modelEvents = capture.actions.filter((a) => a.type === "llm_model_updated");
    expect(modelEvents.at(-1)).toMatchObject({ model: "my-model" });
  });

  it("samples the managed daemon's RSS on the probe tick, no second timer", async () => {
    spy.mockResolvedValue({
      reachable: true,
      status: 200,
      error: null,
      latencyMs: 1,
    } satisfies HealthResult);
    const samples: Array<number | null> = [4_400_000_000, 4_500_000_000];
    const capture = makeCapture();
    const poller = new LlmHealthPoller(
      capture,
      "http://127.0.0.1:19091",
      100,
      fetch,
      async () => samples.shift() ?? null,
    );
    poller.start();
    await sleep(180);
    poller.stop();
    const rss = capture.actions.filter((a) => a.type === "llm_daemon_rss_updated");
    // One emission per changed sample — the poll cadence is the only clock.
    expect(rss[0]).toEqual({
      type: "llm_daemon_rss_updated",
      rssBytes: 4_400_000_000,
    });
    expect(rss[1]).toEqual({
      type: "llm_daemon_rss_updated",
      rssBytes: 4_500_000_000,
    });
  });

  it("stays silent about RSS when there is nothing to measure", async () => {
    spy.mockResolvedValue({
      reachable: false,
      status: null,
      error: "down",
      latencyMs: 1,
    } satisfies HealthResult);
    const capture = makeCapture();
    const poller = new LlmHealthPoller(
      capture,
      "http://127.0.0.1:19091",
      50,
      fetch,
      async () => null,
    );
    poller.start();
    await sleep(140);
    poller.stop();
    // The slice starts at `null`; re-emitting `null` every interval
    // would re-render the composer for no visible change.
    expect(
      capture.actions.filter((a) => a.type === "llm_daemon_rss_updated"),
    ).toEqual([]);
  });
});
