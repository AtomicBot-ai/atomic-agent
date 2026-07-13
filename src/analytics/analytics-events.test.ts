import { describe, expect, it, vi } from "vitest";

import type { AnalyticsClient } from "./analytics-client.js";
import {
  ANALYTICS_EVENTS,
  captureAppInstalled,
  captureMessageSent,
} from "./analytics-events.js";
import type { AnalyticsStateStore } from "./analytics-state-store.js";

function fakeClient() {
  return { capture: vi.fn() } as unknown as AnalyticsClient & {
    capture: ReturnType<typeof vi.fn>;
  };
}

function fakeStore(overrides: Partial<Record<string, boolean>> = {}) {
  const state = {
    appInstalled: overrides.appInstalled ?? false,
    firstMessage: overrides.firstMessage ?? false,
  };
  return {
    isAppInstalledSent: () => state.appInstalled,
    isFirstMessageSent: () => state.firstMessage,
    markAppInstalledSent: vi.fn(() => {
      state.appInstalled = true;
    }),
    markFirstMessageSent: vi.fn(() => {
      state.firstMessage = true;
    }),
  } as unknown as AnalyticsStateStore & {
    markAppInstalledSent: ReturnType<typeof vi.fn>;
    markFirstMessageSent: ReturnType<typeof vi.fn>;
  };
}

describe("captureAppInstalled", () => {
  it("fires once and marks the flag", () => {
    const client = fakeClient();
    const store = fakeStore();
    captureAppInstalled(client, store);
    expect(client.capture).toHaveBeenCalledWith(ANALYTICS_EVENTS.appInstalled);
    expect(store.markAppInstalledSent).toHaveBeenCalledTimes(1);
  });

  it("no-ops when already sent", () => {
    const client = fakeClient();
    const store = fakeStore({ appInstalled: true });
    captureAppInstalled(client, store);
    expect(client.capture).not.toHaveBeenCalled();
  });

  it("no-ops when analytics is disabled (null client)", () => {
    const store = fakeStore();
    expect(() => captureAppInstalled(null, store)).not.toThrow();
    expect(store.markAppInstalledSent).not.toHaveBeenCalled();
  });
});

describe("captureMessageSent", () => {
  const ctx = { provider: "openrouter", model: "gpt" };

  it("fires first_message_sent once, message_sent every time", () => {
    const client = fakeClient();
    const store = fakeStore();

    captureMessageSent(client, store, ctx);
    captureMessageSent(client, store, ctx);

    const events = client.capture.mock.calls.map((c) => c[0]);
    expect(events).toEqual([
      ANALYTICS_EVENTS.firstMessageSent,
      ANALYTICS_EVENTS.messageSent,
      ANALYTICS_EVENTS.messageSent,
    ]);
    expect(store.markFirstMessageSent).toHaveBeenCalledTimes(1);
  });

  it("attaches only provider + model", () => {
    const client = fakeClient();
    const store = fakeStore({ firstMessage: true });
    captureMessageSent(client, store, ctx);
    expect(client.capture).toHaveBeenCalledWith(ANALYTICS_EVENTS.messageSent, {
      provider: "openrouter",
      model: "gpt",
    });
  });

  it("no-ops when analytics is disabled (null client)", () => {
    const store = fakeStore();
    expect(() => captureMessageSent(null, store, ctx)).not.toThrow();
    expect(store.markFirstMessageSent).not.toHaveBeenCalled();
  });
});
