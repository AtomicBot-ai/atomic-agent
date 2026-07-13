import { describe, expect, it, vi } from "vitest";

import { AnalyticsClient, createAnalyticsClient } from "./analytics-client.js";

function fakePosthog() {
  return {
    capture: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

describe("AnalyticsClient", () => {
  it("attributes events to the anonymous install id and hardens privacy", () => {
    const posthog = fakePosthog();
    const client = new AnalyticsClient({
      installId: "install-123",
      platform: "darwin",
      posthog,
    });

    client.capture("message_sent", { provider: "llama-server", model: "qwen" });

    expect(posthog.capture).toHaveBeenCalledTimes(1);
    const arg = posthog.capture.mock.calls[0][0];
    expect(arg.distinctId).toBe("install-123");
    expect(arg.event).toBe("message_sent");
    expect(arg.disableGeoip).toBe(true);
    // IP is overridden to null so PostHog never stores the machine's IP.
    expect(arg.properties.$ip).toBeNull();
    expect(arg.properties.platform).toBe("darwin");
    expect(arg.properties.provider).toBe("llama-server");
    expect(arg.properties.model).toBe("qwen");
  });

  it("stamps the platform tag on every event, including bare ones", () => {
    const posthog = fakePosthog();
    const client = new AnalyticsClient({
      installId: "x",
      platform: "linux",
      posthog,
    });
    client.capture("app_installed");
    expect(posthog.capture.mock.calls[0][0].properties.platform).toBe("linux");
  });

  it("is fire-safe: swallows capture errors", () => {
    const posthog = {
      capture: vi.fn(() => {
        throw new Error("network down");
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const client = new AnalyticsClient({
      installId: "x",
      platform: "darwin",
      posthog,
    });
    expect(() => client.capture("app_installed")).not.toThrow();
  });

  it("createAnalyticsClient returns null when disabled", () => {
    const client = createAnalyticsClient({
      enabled: false,
      installId: "x",
      platform: "darwin",
      posthog: fakePosthog(),
    });
    expect(client).toBeNull();
  });

  it("createAnalyticsClient builds a client when enabled", () => {
    const client = createAnalyticsClient({
      enabled: true,
      installId: "x",
      platform: "darwin",
      posthog: fakePosthog(),
    });
    expect(client).toBeInstanceOf(AnalyticsClient);
  });

  it("createAnalyticsClient returns null under the test runner without an injected posthog", () => {
    // Vitest sets `process.env.VITEST`, so a real connection is never
    // opened during the suite — protects production analytics.
    const client = createAnalyticsClient({
      enabled: true,
      installId: "x",
      platform: "darwin",
    });
    expect(client).toBeNull();
  });
});
