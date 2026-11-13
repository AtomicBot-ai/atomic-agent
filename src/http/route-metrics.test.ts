import { afterEach, describe, expect, it } from "vitest";

import { PrometheusRegistry } from "../tracing/prometheus-registry.js";
import { PROMETHEUS_CONTENT_TYPE } from "../tracing/prometheus-format.js";
import { startTestHarness, type Harness } from "./test-harness.js";

const AUTH = { headers: { authorization: "Bearer secret" } };

describe("GET /metrics (ATO-646)", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
  });

  it("refuses a scrape without the API key when serve has one", async () => {
    harness = await startTestHarness({ apiKey: "secret", metricsRegistry: new PrometheusRegistry() });
    const missing = await fetch(`${harness.baseUrl}/metrics`);
    expect(missing.status).toBe(401);
    const wrong = await fetch(`${harness.baseUrl}/metrics`, {
      headers: { authorization: "Bearer not-it" },
    });
    expect(wrong.status).toBe(401);
    const body = await wrong.text();
    expect(body).not.toContain("atomic_agent_");
  });

  it("answers the text format to the right bearer", async () => {
    harness = await startTestHarness({ apiKey: "secret", metricsRegistry: new PrometheusRegistry() });
    const res = await fetch(`${harness.baseUrl}/metrics`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(PROMETHEUS_CONTENT_TYPE);
    const text = await res.text();
    expect(text).toContain("# TYPE atomic_agent_info gauge");
    expect(text).toContain("atomic_agent_turns_running 0");
    expect(text).toContain('atomic_agent_tasks{status="pending"} 0');
  });

  it("is never open when serve runs without a key, even on loopback", async () => {
    harness = await startTestHarness({ metricsRegistry: new PrometheusRegistry() });
    const res = await fetch(`${harness.baseUrl}/metrics`);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("metrics_need_api_key");
    expect(body).not.toContain("atomic_agent_");
  });

  it("counts a finished turn and never prints the session id", async () => {
    harness = await startTestHarness({ apiKey: "secret", metricsRegistry: new PrometheusRegistry() });
    const session = harness.runtime.createSession();
    await harness.runtime.runTurn(session, "hi", { origin: "http" });

    const text = await (await fetch(`${harness.baseUrl}/metrics`, AUTH)).text();
    expect(text).toMatch(/atomic_agent_turn_completed_total\{origin="http",outcome="reply"\} 1\n/);
    expect(text).toMatch(/atomic_agent_turn_duration_ms_count\{origin="http",outcome="reply"\} 1\n/);
    expect(text).not.toContain(session.id);
  });

  it("still answers the live readings without a registry", async () => {
    harness = await startTestHarness({ apiKey: "secret" });
    const text = await (await fetch(`${harness.baseUrl}/metrics`, AUTH)).text();
    expect(text).toContain("atomic_agent_turns_running");
    expect(text).not.toContain("atomic_agent_turn_completed_total");
  });
});
