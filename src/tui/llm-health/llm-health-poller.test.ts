import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getUserConfigPath,
  resetConfigCache,
  USER_CONFIG_DEFAULTS,
  writeUserConfigFileSync,
} from "../../config/index.js";
import type { UserConfigFile } from "../../config/index.js";

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
 * Instant no-model `/props` stub. The default `fetchImpl` is the real
 * global fetch, and a healthy first probe follows up with `/props` —
 * on the fake hostnames below that meant a real DNS lookup racing the
 * tests' 30ms sleeps, which lost often enough under a loaded test run
 * to flake the updateUrl assertions.
 */
const stubProps: typeof fetch = () =>
  Promise.resolve(new Response("{}", { status: 404 }));

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
    const poller = new LlmHealthPoller(
      capture,
      "http://first:9000",
      60_000,
      stubProps,
    );
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
    const poller = new LlmHealthPoller(
      capture,
      "http://old:9000",
      10_000,
      stubProps,
    );
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

  it("spawns no child process on the probe tick", async () => {
    // The poller used to sample the managed daemon's RSS with a `ps`
    // child every tick, purely to feed a `healthy · 4.4 GB` readout on
    // the composer bar. The readout is gone (see
    // `composer-meta-controls.tsx`) and so is the sampler: at a
    // three-second cadence that was 1 200 processes an hour for a
    // number nobody acted on.
    spy.mockResolvedValue({
      reachable: true,
      status: 200,
      error: null,
      latencyMs: 1,
    } satisfies HealthResult);
    const capture = makeCapture();
    const poller = new LlmHealthPoller(capture, "http://127.0.0.1:19091", 50, stubProps);
    poller.start();
    await sleep(140);
    poller.stop();
    expect(
      capture.actions.map((a) => a.type).filter((t) => t.includes("rss")),
    ).toEqual([]);
  });
});
/**
 * Issue #112 — the footer poller is the noisiest local prober in the
 * process: `/health` every 3 s plus a one-shot `/props`, from the moment
 * the TUI mounts, whatever the route. On a cloud session that is a
 * request every three seconds against a server nobody is running, and a
 * `down` badge plus an `n_ctx` reading about a backend that is not
 * serving the turn.
 */
describe("LlmHealthPoller — gated on the active text provider", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "atomic-poller-gate-"));
  let previousStateDir: string | undefined;
  let spy: ReturnType<typeof vi.spyOn>;

  const writeLlm = (llm: UserConfigFile["llm"]): void => {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      ...(llm ? { llm } : {}),
    });
    resetConfigCache();
  };

  beforeEach(() => {
    previousStateDir = process.env.ATOMIC_AGENT_STATE_DIR;
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    spy = vi.spyOn(healthModule, "checkLlamaServer");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousStateDir === undefined) {
      delete process.env.ATOMIC_AGENT_STATE_DIR;
    } else {
      process.env.ATOMIC_AGENT_STATE_DIR = previousStateDir;
    }
    rmSync(getUserConfigPath(stateDir), { force: true });
    resetConfigCache();
  });

  it("probes nothing at TUI startup when a cloud provider is active", async () => {
    writeLlm({
      activeTextProvider: "cloudy",
      activeEmbeddingProvider: "local-llama-embed",
      providers: [
        {
          id: "cloudy",
          kind: "openai-compatible",
          baseUrl: "https://cloud.invalid",
          defaultChatModel: "cloudy-1",
          apiKey: "sk-test",
        },
        { id: "local-llama-embed", kind: "llama-server", url: "http://127.0.0.1:19092" },
      ],
      toolTransport: "auto",
    });
    const props = vi.fn(stubProps);
    const capture = makeCapture();
    const poller = new LlmHealthPoller(capture, "http://127.0.0.1:8080", 10, props);
    poller.start();
    await sleep(40);
    poller.stop();

    // Exact counts: several tick windows elapsed, and every one of them
    // must have cost zero requests.
    expect(spy).toHaveBeenCalledTimes(0);
    expect(props).toHaveBeenCalledTimes(0);
    expect(capture.actions).toEqual([]);
  });

  it("probes on the same schedule as before when the route is local", async () => {
    // The control: same poller, same timings, default (llama-server)
    // config — one `/health` per tick and the one-shot `/props`.
    writeLlm(undefined);
    spy.mockResolvedValue({
      reachable: true,
      status: 200,
      error: null,
      latencyMs: 1,
    } satisfies HealthResult);
    const props = vi.fn(stubProps);
    const capture = makeCapture();
    const poller = new LlmHealthPoller(capture, "http://127.0.0.1:8080", 10_000, props);
    poller.start();
    await sleep(30);
    poller.stop();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(props).toHaveBeenCalledTimes(1);
  });

  it("resumes within one tick after a hot switch back to a local provider", async () => {
    writeLlm({
      activeTextProvider: "cloudy",
      activeEmbeddingProvider: "local-llama-embed",
      providers: [
        {
          id: "cloudy",
          kind: "openai-compatible",
          baseUrl: "https://cloud.invalid",
          defaultChatModel: "cloudy-1",
          apiKey: "sk-test",
        },
        { id: "local-llama-embed", kind: "llama-server", url: "http://127.0.0.1:19092" },
      ],
      toolTransport: "auto",
    });
    spy.mockResolvedValue({
      reachable: true,
      status: 200,
      error: null,
      latencyMs: 1,
    } satisfies HealthResult);
    const capture = makeCapture();
    const poller = new LlmHealthPoller(capture, "http://127.0.0.1:8080", 10, stubProps);
    poller.start();
    await sleep(40);
    expect(spy).toHaveBeenCalledTimes(0);

    // The operator picks the local backend again. No start/stop call
    // reaches the poller — it re-reads config on its own tick.
    writeLlm(undefined);
    await sleep(40);
    poller.stop();
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });
});
