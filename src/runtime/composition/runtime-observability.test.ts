import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, resetConfigCache } from "../../config/index.js";
import * as analytics from "../../analytics/index.js";
import { SentryClient, parseSentryDsn } from "../../error-reporting/index.js";
import { createRuntimeObservability } from "./runtime-observability.js";

function clients(events: string[], label: string) {
  const dsn = parseSentryDsn("https://test@example.test/1");
  if (!dsn) throw new Error("invalid test DSN");
  const client = new analytics.AnalyticsClient({
    installId: "test-install", platform: process.platform, version: "test",
    posthog: {
      capture: () => { events.push(`${label}:capture`); },
      shutdown: async () => { events.push(`${label}:analytics-stop`); },
    },
  });
  const reporter = new SentryClient({
    dsn, installId: "test-install", release: "test", platform: process.platform,
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  vi.spyOn(reporter, "shutdown").mockImplementation(async () => { events.push(`${label}:reporter-stop`); });
  return { analytics: client, errorReporter: reporter };
}

describe("runtime observability construction phases", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "atomic-runtime-observability-"));
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", stateDir);
    resetConfigCache();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetConfigCache();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("leaves the process-handler installation between client creation and controls", () => {
    const phases: string[] = [];
    const config = getConfig();
    Object.defineProperty(config.analytics, "enabled", { get: () => { phases.push("enabled"); return false; } });
    vi.spyOn(analytics, "buildRuntimeTelemetry").mockImplementation(() => {
      phases.push("clients"); return { analytics: null, errorReporter: null };
    });
    const component = createRuntimeObservability(config, {});
    expect(phases).toEqual(["enabled", "clients"]);
    phases.push("process-handlers");
    component.createControls();
    expect(phases).toEqual(["enabled", "clients", "process-handlers", "enabled"]);
    expect(component.getAnalytics()).toBeNull();
    expect(component.getErrorReporter()).toBeNull();
  });

  it("detaches clients before stopping them and exposes rebuilt clients through late getters", async () => {
    const events: string[] = [];
    const first = clients(events, "first");
    const next = clients(events, "next");
    const builder = vi.spyOn(analytics, "buildRuntimeTelemetry").mockReturnValueOnce(first).mockReturnValue(next);
    const config = getConfig();
    config.analytics.enabled = true;
    const component = createRuntimeObservability(config, {});
    const controls = component.createControls();
    expect(component.getAnalytics()).toBe(first.analytics);
    expect(component.getErrorReporter()).toBe(first.errorReporter);
    const stop = controls.setAnalyticsEnabled(false);
    expect(component.getAnalytics()).toBeNull();
    expect(component.getErrorReporter()).toBeNull();
    await stop;
    expect(events.slice(-2)).toEqual(["first:analytics-stop", "first:reporter-stop"]);
    await controls.setAnalyticsEnabled(true);
    expect(component.getAnalytics()).toBe(next.analytics);
    expect(component.getErrorReporter()).toBe(next.errorReporter);
    expect(builder).toHaveBeenCalledTimes(2);
    await controls.setAnalyticsEnabled(true);
    expect(builder).toHaveBeenCalledTimes(2);
    await controls.setAnalyticsEnabled(false);
  });

  it("uses current analytics for reports after a toggle and retains interactive launch gating", async () => {
    const events: string[] = [];
    const first = clients(events, "first");
    const next = clients(events, "next");
    vi.spyOn(analytics, "buildRuntimeTelemetry").mockReturnValueOnce(first).mockReturnValue(next);
    const opened = vi.spyOn(analytics, "captureAppOpened");
    const report = vi.spyOn(analytics, "captureOnboardingStep");
    const config = getConfig();
    config.analytics.enabled = true;
    const component = createRuntimeObservability(config, { interactiveLaunch: true });
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(first.analytics);
    const controls = component.createControls();
    await controls.setAnalyticsEnabled(false);
    controls.reportOnboardingStep("download_started");
    expect(report).toHaveBeenLastCalledWith(null, "download_started", undefined);
    await controls.setAnalyticsEnabled(true);
    controls.reportOnboardingStep("download_started");
    expect(report).toHaveBeenLastCalledWith(next.analytics, "download_started", undefined);
    await controls.setAnalyticsEnabled(false);
  });
});
