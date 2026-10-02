import { describe, expect, it, vi } from "vitest";

import type { SentryClient } from "../error-reporting/index.js";
import type { AnalyticsClient } from "./analytics-client.js";
import type { AnalyticsStateStore } from "./analytics-state-store.js";
import type { AnalyticsDimensions } from "./resolve-analytics-dimensions.js";
import {
  buildRuntimeTelemetry,
  createTelemetryToggle,
  type RuntimeTelemetry,
  type RuntimeTelemetryFactories,
} from "./toggle-runtime-telemetry.js";

const DIMENSIONS: AnalyticsDimensions = {
  surface: "desktop",
  arch: "arm64",
  installChannel: "dmg",
};

function fakeStore() {
  return {
    getSharedInstallId: vi.fn(() => "install-1"),
    getDaysSinceInstall: () => 3,
  } as unknown as AnalyticsStateStore & {
    getSharedInstallId: ReturnType<typeof vi.fn>;
  };
}

function fakeClients(order: string[]): RuntimeTelemetry {
  const analytics = {
    capture: vi.fn((event: string) => order.push(`capture:${event}`)),
    shutdown: vi.fn(async () => {
      order.push("analytics.shutdown");
    }),
  } as unknown as AnalyticsClient;
  const errorReporter = {
    shutdown: vi.fn(async () => {
      order.push("sentry.shutdown");
    }),
  } as unknown as SentryClient;
  return { analytics, errorReporter };
}

function harness(initialEnabled: boolean) {
  const order: string[] = [];
  let live: RuntimeTelemetry = initialEnabled
    ? fakeClients(order)
    : { analytics: null, errorReporter: null };
  const rebuild = vi.fn(() => fakeClients(order));
  const onEnabled = vi.fn();
  const toggle = createTelemetryToggle({
    initialEnabled,
    store: fakeStore(),
    get: () => live,
    set: (next) => {
      live = next;
    },
    rebuild,
    onEnabled,
  });
  return { order, toggle, rebuild, onEnabled, current: () => live };
}

describe("createTelemetryToggle (runtime opt-out)", () => {
  it("sends analytics_disabled exactly once, before teardown", async () => {
    const h = harness(true);
    expect(await h.toggle(false, "slash")).toBe(true);
    expect(await h.toggle(false, "slash")).toBe(false);
    expect(h.order).toEqual([
      "capture:analytics_disabled",
      "analytics.shutdown",
      "sentry.shutdown",
    ]);
    expect(h.current()).toEqual({ analytics: null, errorReporter: null });
  });

  it("passes via through and defaults it to settings", async () => {
    const h = harness(true);
    const analytics = h.current().analytics as unknown as {
      capture: ReturnType<typeof vi.fn>;
    };
    await h.toggle(false);
    expect(analytics.capture).toHaveBeenCalledWith("analytics_disabled", {
      via: "settings",
      days_since_install: 3,
    });
  });

  it("is a no-op when the value already matches", async () => {
    const h = harness(true);
    expect(await h.toggle(true)).toBe(false);
    expect(h.order).toEqual([]);
    expect(h.rebuild).not.toHaveBeenCalled();
  });

  it("rebuilds the clients and calls onEnabled when turned back on", async () => {
    const h = harness(false);
    await h.toggle(true);
    expect(h.rebuild).toHaveBeenCalledTimes(1);
    expect(h.onEnabled).toHaveBeenCalledTimes(1);
    expect(h.current().analytics).not.toBeNull();
    expect(h.order).not.toContain("capture:analytics_disabled");
  });
});

describe("buildRuntimeTelemetry", () => {
  function factories() {
    return {
      createAnalyticsClient: vi.fn(() => null),
      createSentryClient: vi.fn(() => null),
    } satisfies RuntimeTelemetryFactories;
  }

  it("builds both clients enabled with the shared id and surface", () => {
    const f = factories();
    const store = fakeStore();
    buildRuntimeTelemetry({
      enabled: true,
      store,
      dimensions: DIMENSIONS,
      version: "1.0.0",
      env: {},
      factories: f,
    });
    expect(store.getSharedInstallId).toHaveBeenCalledWith(true, "desktop");
    expect(f.createAnalyticsClient.mock.calls[0]).toMatchObject([
      { enabled: true, installId: "install-1", dimensions: DIMENSIONS },
    ]);
    expect(f.createSentryClient.mock.calls[0]).toMatchObject([
      { enabled: true, installId: "install-1", dimensions: DIMENSIONS },
    ]);
  });

  it("ATOMIC_AGENT_ANALYTICS=off disables both and leaves the shared id alone", () => {
    const f = factories();
    const store = fakeStore();
    buildRuntimeTelemetry({
      enabled: true,
      store,
      dimensions: DIMENSIONS,
      version: "1.0.0",
      env: { ATOMIC_AGENT_ANALYTICS: "off" },
      factories: f,
    });
    expect(store.getSharedInstallId).toHaveBeenCalledWith(false, "desktop");
    expect(f.createAnalyticsClient.mock.calls[0]).toMatchObject([
      { enabled: false },
    ]);
    expect(f.createSentryClient.mock.calls[0]).toMatchObject([
      { enabled: false },
    ]);
  });
});
