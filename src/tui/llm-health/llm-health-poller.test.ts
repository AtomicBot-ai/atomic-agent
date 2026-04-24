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
    await vi.waitFor(
      () =>
        capture.actions.filter((a) => a.type === "llm_health_updated" && a.status === "healthy")
          .length >= 2,
      { timeout: 5000, interval: 20 },
    );
    poller.stop();

    const health = capture.actions.filter((a) => a.type === "llm_health_updated");
    const probings = health.filter((a) => a.status === "probing");
    const healthies = health.filter((a) => a.status === "healthy");
    expect(probings).toHaveLength(1);
    expect(healthies.length).toBeGreaterThanOrEqual(2);
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
    await vi.waitFor(
      () =>
        capture.actions.filter((a) => a.type === "llm_health_updated" && a.status === "healthy")
          .length >= 1,
      { timeout: 3000, interval: 10 },
    );
    poller.updateUrl("http://second:9000");
    await vi.waitFor(
      () =>
        capture.actions.filter((a) => a.type === "llm_health_updated" && a.status === "probing")
          .length >= 2,
      { timeout: 3000, interval: 10 },
    );
    poller.stop();
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
});
