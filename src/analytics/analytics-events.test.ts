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

  it("attaches only provider + model when no shape metrics given", () => {
    const client = fakeClient();
    const store = fakeStore({ firstMessage: true });
    captureMessageSent(client, store, ctx);
    expect(client.capture).toHaveBeenCalledWith(ANALYTICS_EVENTS.messageSent, {
      provider: "openrouter",
      model: "gpt",
    });
  });

  it("attaches latency_ms / step_count / outcome to message_sent when provided", () => {
    const client = fakeClient();
    const store = fakeStore({ firstMessage: true });
    captureMessageSent(client, store, {
      ...ctx,
      latencyMs: 1234,
      stepCount: 5,
      outcome: "reply",
    });
    expect(client.capture).toHaveBeenCalledWith(ANALYTICS_EVENTS.messageSent, {
      provider: "openrouter",
      model: "gpt",
      latency_ms: 1234,
      step_count: 5,
      outcome: "reply",
    });
  });

  it("keeps shape metrics off first_message_sent (only provider + model)", () => {
    const client = fakeClient();
    const store = fakeStore(); // first message not yet sent
    captureMessageSent(client, store, {
      ...ctx,
      latencyMs: 1234,
      stepCount: 5,
      outcome: "reply",
    });
    // first call is first_message_sent — must carry base props only
    expect(client.capture).toHaveBeenNthCalledWith(
      1,
      ANALYTICS_EVENTS.firstMessageSent,
      { provider: "openrouter", model: "gpt" },
    );
  });

  it("attaches prompt_tokens / completion_tokens to message_sent when provided", () => {
    const client = fakeClient();
    const store = fakeStore({ firstMessage: true });
    captureMessageSent(client, store, {
      ...ctx,
      promptTokens: 100,
      completionTokens: 50,
    });
    expect(client.capture).toHaveBeenCalledWith(ANALYTICS_EVENTS.messageSent, {
      provider: "openrouter",
      model: "gpt",
      prompt_tokens: 100,
      completion_tokens: 50,
    });
  });

  it("attaches cost_usd to message_sent when provided", () => {
    const client = fakeClient();
    const store = fakeStore({ firstMessage: true });
    captureMessageSent(client, store, {
      ...ctx,
      costUsd: 0.0042,
    });
    expect(client.capture).toHaveBeenCalledWith(ANALYTICS_EVENTS.messageSent, {
      provider: "openrouter",
      model: "gpt",
      cost_usd: 0.0042,
    });
  });

  it("keeps prompt_tokens / completion_tokens / cost_usd off first_message_sent (only provider + model)", () => {
    const client = fakeClient();
    const store = fakeStore(); // first message not yet sent
    captureMessageSent(client, store, {
      ...ctx,
      promptTokens: 100,
      completionTokens: 50,
      costUsd: 0.0042,
    });
    // first call is first_message_sent — must carry base props only
    expect(client.capture).toHaveBeenNthCalledWith(
      1,
      ANALYTICS_EVENTS.firstMessageSent,
      { provider: "openrouter", model: "gpt" },
    );
  });

  it("omits prompt_tokens / completion_tokens / cost_usd keys entirely when not provided", () => {
    const client = fakeClient();
    const store = fakeStore({ firstMessage: true });
    captureMessageSent(client, store, ctx);
    const payload = client.capture.mock.calls[0][1];
    expect(payload).not.toHaveProperty("prompt_tokens");
    expect(payload).not.toHaveProperty("completion_tokens");
    expect(payload).not.toHaveProperty("cost_usd");
  });

  it("emits cost_usd: 0 when explicitly provided as zero", () => {
    const client = fakeClient();
    const store = fakeStore({ firstMessage: true });
    captureMessageSent(client, store, {
      ...ctx,
      costUsd: 0,
    });
    expect(client.capture).toHaveBeenCalledWith(ANALYTICS_EVENTS.messageSent, {
      provider: "openrouter",
      model: "gpt",
      cost_usd: 0,
    });
    const payload = client.capture.mock.calls[0][1];
    expect(payload).toHaveProperty("cost_usd", 0);
  });

  it("no-ops when analytics is disabled (null client)", () => {
    const store = fakeStore();
    expect(() => captureMessageSent(null, store, ctx)).not.toThrow();
    expect(store.markFirstMessageSent).not.toHaveBeenCalled();
  });
});
