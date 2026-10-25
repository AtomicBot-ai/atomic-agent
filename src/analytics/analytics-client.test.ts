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
      version: "1.2.3",
      posthog,
    });

    client.capture("message_sent", { provider: "llama-server", model: "qwen" });

    expect(posthog.capture).toHaveBeenCalledTimes(1);
    const arg = posthog.capture.mock.calls[0][0];
    expect(arg.distinctId).toBe("install-123");
    expect(arg.event).toBe("message_sent");
    expect(arg.disableGeoip).toBe(true);
    // IP is overridden with a placeholder so PostHog never stores the real IP.
    expect(arg.properties.$ip).toBe("0.0.0.0");
    expect(arg.properties.platform).toBe("darwin");
    expect(arg.properties.app_version).toBe("1.2.3");
    expect(arg.properties.provider).toBe("llama-server");
    expect(arg.properties.model).toBe("qwen");
  });

  it("stamps the platform and app_version tags on every event, including bare ones", () => {
    const posthog = fakePosthog();
    const client = new AnalyticsClient({
      installId: "x",
      platform: "linux",
      version: "9.9.9",
      posthog,
    });
    client.capture("app_installed");
    expect(posthog.capture.mock.calls[0][0].properties.platform).toBe("linux");
    expect(posthog.capture.mock.calls[0][0].properties.app_version).toBe(
      "9.9.9",
    );
  });

  it("stamps arch, surface, install_channel and desktop_version after caller props", () => {
    const posthog = fakePosthog();
    const client = new AnalyticsClient({
      installId: "x",
      platform: "darwin",
      version: "1.0.0",
      dimensions: {
        surface: "desktop",
        arch: "arm64",
        installChannel: "dmg",
        desktopVersion: "0.6.7",
      },
      posthog,
    });
    // A caller cannot override the global dimensions.
    client.capture("app_opened", { surface: "tui", arch: "x64" });
    const props = posthog.capture.mock.calls[0][0].properties;
    expect(props.surface).toBe("desktop");
    expect(props.arch).toBe("arm64");
    expect(props.install_channel).toBe("dmg");
    expect(props.desktop_version).toBe("0.6.7");
    expect(props.$ip).toBe("0.0.0.0");
  });

  it("stamps arch but no surface fields when no dimensions are given", () => {
    const posthog = fakePosthog();
    const client = new AnalyticsClient({
      installId: "x",
      platform: "linux",
      version: "1.0.0",
      posthog,
    });
    client.capture("app_opened");
    const props = posthog.capture.mock.calls[0][0].properties;
    expect(props.arch).toBe(process.arch);
    expect(props).not.toHaveProperty("surface");
    expect(props).not.toHaveProperty("desktop_version");
  });

  it("omits desktop_version for terminal surfaces", () => {
    const posthog = fakePosthog();
    const client = new AnalyticsClient({
      installId: "x",
      platform: "linux",
      version: "1.0.0",
      dimensions: { surface: "tui", arch: "x64", installChannel: "curl_sh" },
      posthog,
    });
    client.capture("app_opened");
    const props = posthog.capture.mock.calls[0][0].properties;
    expect(props.surface).toBe("tui");
    expect(props.install_channel).toBe("curl_sh");
    expect(props).not.toHaveProperty("desktop_version");
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
      version: "1.0.0",
      posthog,
    });
    expect(() => client.capture("app_installed")).not.toThrow();
  });

  it("createAnalyticsClient returns null when disabled", () => {
    const client = createAnalyticsClient({
      enabled: false,
      installId: "x",
      platform: "darwin",
      version: "1.0.0",
      posthog: fakePosthog(),
    });
    expect(client).toBeNull();
  });

  it("createAnalyticsClient returns null under ATOMIC_AGENT_ANALYTICS=off", () => {
    const client = createAnalyticsClient({
      enabled: true,
      installId: "x",
      platform: "darwin",
      version: "1.0.0",
      posthog: fakePosthog(),
      env: { ATOMIC_AGENT_ANALYTICS: "off" },
    });
    expect(client).toBeNull();
  });

  it("createAnalyticsClient builds a client when enabled", () => {
    const client = createAnalyticsClient({
      enabled: true,
      installId: "x",
      platform: "darwin",
      version: "1.0.0",
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
      version: "1.0.0",
    });
    expect(client).toBeNull();
  });
});

// ATO-717: one-time events must know whether they were delivered.
describe("AnalyticsClient.captureConfirmed", () => {
  function immediatePosthog(send: () => Promise<void> | void) {
    const listeners: Array<(err: unknown) => void> = [];
    const posthog = {
      capture: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: string, cb: (err: unknown) => void) => {
        if (event === "error") listeners.push(cb);
        return () => {
          listeners.splice(listeners.indexOf(cb), 1);
        };
      }),
      captureImmediate: vi.fn(async (_message: unknown) => {
        await send();
      }),
    };
    const emitError = (err: unknown) => {
      for (const cb of [...listeners]) cb(err);
    };
    return { posthog, emitError, listeners };
  }

  const make = (posthog: ConstructorParameters<typeof AnalyticsClient>[0]["posthog"]) =>
    new AnalyticsClient({ installId: "x", platform: "linux", version: "1.0.0", posthog });

  it("resolves true when the send completes without an error", async () => {
    const { posthog, listeners } = immediatePosthog(() => {});
    const client = make(posthog);
    await expect(client.captureConfirmed("app_installed", { a: 1 })).resolves.toBe(true);
    const arg = posthog.captureImmediate.mock.calls[0]![0] as {
      distinctId: string;
      event: string;
      properties: Record<string, unknown>;
      disableGeoip: boolean;
    };
    expect(arg.distinctId).toBe("x");
    expect(arg.event).toBe("app_installed");
    expect(arg.properties.a).toBe(1);
    expect(arg.properties.$ip).toBe("0.0.0.0");
    expect(arg.disableGeoip).toBe(true);
    expect(posthog.capture).not.toHaveBeenCalled();
    // The error listener is removed again.
    expect(listeners).toHaveLength(0);
  });

  it("resolves false when PostHog reports a delivery error (offline)", async () => {
    const harness = immediatePosthog(() => {
      // posthog-node swallows the fetch failure and emits it instead.
      harness.emitError(new Error("fetch failed"));
    });
    const client = make(harness.posthog);
    await expect(client.captureConfirmed("app_installed")).resolves.toBe(false);
    expect(harness.listeners).toHaveLength(0);
  });

  it("resolves false and never rejects when the send itself throws", async () => {
    const { posthog } = immediatePosthog(() => {
      throw new Error("boom");
    });
    const warn = vi.fn();
    const client = new AnalyticsClient({
      installId: "x",
      platform: "linux",
      version: "1.0.0",
      posthog,
      logger: { warn },
    });
    await expect(client.captureConfirmed("app_installed")).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("falls back to a queued capture when the implementation has no immediate send", async () => {
    const posthog = fakePosthog();
    const client = make(posthog);
    await expect(client.captureConfirmed("app_installed")).resolves.toBe(true);
    expect(posthog.capture).toHaveBeenCalledTimes(1);
  });
});
