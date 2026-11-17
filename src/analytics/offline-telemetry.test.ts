import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnalyticsClient } from "./analytics-client.js";
import { fetchFeatureFlag, resetFeatureFlagCache } from "./fetch-feature-flag.js";
import { SentryClient, type FetchLike } from "../error-reporting/sentry-client.js";
import { parseSentryDsn } from "../error-reporting/sentry-config.js";
import { AppUpdateCheckError, checkForAppUpdate } from "../update/check-app-update.js";
import {
  egressSnapshot,
  resetOfflineNetworkForTests,
  setOfflineNetwork,
} from "../llm/offline-network.js";

/**
 * ATO-1085: offline mode turned on while the telemetry clients are
 * alive (the TUI Privacy tab or the desktop switch flips it at run
 * time). Nothing is handed to PostHog, Sentry or GitHub, so the HTTP
 * pool has nothing to refuse and the offline line keeps reading
 * "0 requests blocked".
 */
describe("telemetry while offline mode is on (ATO-1085)", () => {
  const savedEnv = process.env.ATOMIC_AGENT_OFFLINE;

  beforeEach(() => {
    delete process.env.ATOMIC_AGENT_OFFLINE;
    resetOfflineNetworkForTests();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ATOMIC_AGENT_OFFLINE;
    else process.env.ATOMIC_AGENT_OFFLINE = savedEnv;
    resetOfflineNetworkForTests();
    resetFeatureFlagCache();
  });

  function posthog() {
    return {
      capture: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(() => () => undefined),
      captureImmediate: vi.fn(async () => undefined),
    };
  }

  it("PostHog: capture drops the event, and resumes when the mode goes off", () => {
    const ph = posthog();
    const client = new AnalyticsClient({ installId: "x", platform: "linux", version: "1.0.0", posthog: ph });

    setOfflineNetwork(true);
    client.capture("message_sent");
    expect(ph.capture).not.toHaveBeenCalled();

    setOfflineNetwork(false);
    client.capture("message_sent");
    expect(ph.capture).toHaveBeenCalledTimes(1);
  });

  it("PostHog: captureConfirmed reports 'not delivered' so a one-time event is retried later", async () => {
    const ph = posthog();
    const client = new AnalyticsClient({ installId: "x", platform: "linux", version: "1.0.0", posthog: ph });

    setOfflineNetwork(true);
    await expect(client.captureConfirmed("app_installed")).resolves.toBe(false);
    expect(ph.captureImmediate).not.toHaveBeenCalled();
    expect(ph.capture).not.toHaveBeenCalled();
  });

  it("PostHog: ATOMIC_AGENT_OFFLINE=1 drops events from a client built before it was read", () => {
    const ph = posthog();
    const client = new AnalyticsClient({ installId: "x", platform: "linux", version: "1.0.0", posthog: ph });
    process.env.ATOMIC_AGENT_OFFLINE = "1";
    client.capture("message_sent");
    expect(ph.capture).not.toHaveBeenCalled();
  });

  it("Sentry: capture builds no envelope and sends nothing", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const client = new SentryClient({
      dsn: parseSentryDsn("https://pub@o1.ingest.sentry.io/7")!,
      installId: "x",
      release: "0",
      platform: "linux",
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    setOfflineNetwork(true);
    client.capture({ errorType: "E", source: "s", frames: [] });
    await client.flush();
    expect(fetchImpl).not.toHaveBeenCalled();

    setOfflineNetwork(false);
    client.capture({ errorType: "E2", source: "s", frames: [] });
    await client.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("feature flags read off without asking PostHog", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ flags: { f: { enabled: true } } }) }));
    setOfflineNetwork(true);
    await expect(
      fetchFeatureFlag({ key: "f", distinctId: "x", fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("the update check never asks GitHub and says why", async () => {
    const fetchImpl = vi.fn();
    setOfflineNetwork(true);
    const failure = await checkForAppUpdate({
      force: true,
      currentVersion: "0.0.1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(AppUpdateCheckError);
    expect((failure as Error).message).toMatch(/offline mode is on/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(egressSnapshot()).toMatchObject({ requestsOut: 0, requestsBlocked: 0, bytesOut: 0 });
  });
});
