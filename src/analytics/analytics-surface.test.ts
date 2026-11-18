/**
 * ATO-1603: every event this runtime sends carries the same `surface`
 * property (`desktop` / `tui` / `cli`), so a PostHog query split by
 * surface never sees a null. The desktop app stamps the same name on its
 * own events (desktop/main/analytics/core.ts globalProps).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalyticsClient } from "./analytics-client.js";
import {
  ANALYTICS_EVENTS,
  captureAppInstalled,
  captureMessageSent,
} from "./analytics-events.js";
import type { AnalyticsStateStore } from "./analytics-state-store.js";
import type { AnalyticsSurface } from "./resolve-surface.js";

const SURFACES: AnalyticsSurface[] = ["desktop", "tui", "cli"];
const EVENT_NAMES = Object.values(ANALYTICS_EVENTS);

function fakePosthog() {
  return {
    capture: vi.fn(),
    captureImmediate: vi.fn(async (_message: unknown) => undefined),
    on: vi.fn(() => () => undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

function clientFor(
  posthog: ReturnType<typeof fakePosthog>,
  surface?: AnalyticsSurface,
): AnalyticsClient {
  return new AnalyticsClient({
    installId: "install-1",
    platform: "linux",
    version: "1.0.0",
    ...(surface
      ? { dimensions: { surface, arch: "x64", installChannel: "curl_sh" } }
      : {}),
    posthog,
  });
}

/** Properties of every message the fake PostHog received, in order. */
function sentProps(posthog: ReturnType<typeof fakePosthog>) {
  return [
    ...posthog.capture.mock.calls,
    ...posthog.captureImmediate.mock.calls,
  ].map((call) => (call[0] as { event: string; properties: Record<string, unknown> }));
}

function freshStore() {
  const flags = { installed: false, first: false };
  return {
    isAppInstalledSent: () => flags.installed,
    isOtherSurfaceAppInstalledSent: () => false,
    markAppInstalledSent: () => {
      flags.installed = true;
    },
    isFirstMessageSent: () => flags.first,
    markFirstMessageSent: () => {
      flags.first = true;
    },
  } as unknown as AnalyticsStateStore;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("surface on every event (ATO-1603)", () => {
  it.each(SURFACES)("every catalog event carries surface=%s, queued or confirmed", async (surface) => {
    const posthog = fakePosthog();
    const client = clientFor(posthog, surface);
    for (const event of EVENT_NAMES) {
      // A caller's own value can neither drop nor change it.
      client.capture(event, { surface: null });
      await client.captureConfirmed(event, { surface: "other" });
    }
    const sent = sentProps(posthog);
    expect(sent).toHaveLength(EVENT_NAMES.length * 2);
    for (const message of sent) {
      expect(message.properties.surface, message.event).toBe(surface);
    }
  });

  it("every catalog event carries a surface even from a client built without dimensions", () => {
    vi.stubEnv("ATOMIC_AGENT_SURFACE", "");
    const posthog = fakePosthog();
    const client = clientFor(posthog);
    for (const event of EVENT_NAMES) client.capture(event);
    for (const message of sentProps(posthog)) {
      expect(message.properties.surface, message.event).toBe("cli");
    }
  });

  it.each(SURFACES)(
    "app_installed, first_message_sent and message_sent carry surface=%s",
    async (surface) => {
      const posthog = fakePosthog();
      const client = clientFor(posthog, surface);
      const store = freshStore();
      await captureAppInstalled(client, store, { installChannel: "curl_sh", surface });
      captureMessageSent(client, store, { provider: "openai", model: "gpt" });
      const sent = sentProps(posthog);
      expect(sent.map((m) => m.event).sort()).toEqual(
        [
          ANALYTICS_EVENTS.appInstalled,
          ANALYTICS_EVENTS.firstMessageSent,
          ANALYTICS_EVENTS.messageSent,
        ].sort(),
      );
      for (const message of sent) {
        expect(message.properties.surface, message.event).toBe(surface);
      }
    },
  );
});
