import { describe, expect, it } from "vitest";

import { WebhookReplayCache } from "./webhook-replay-cache.js";

describe("WebhookReplayCache", () => {
  it("remembers ids it was given", () => {
    const cache = new WebhookReplayCache(3);
    expect(cache.has("hook\nmsg_1")).toBe(false);
    cache.remember("hook\nmsg_1");
    expect(cache.has("hook\nmsg_1")).toBe(true);
    expect(cache.has("other\nmsg_1")).toBe(false);
  });

  it("drops the oldest id once full", () => {
    const cache = new WebhookReplayCache(2);
    cache.remember("a");
    cache.remember("b");
    cache.remember("c");
    expect(cache.size).toBe(2);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
  });

  it("treats a remembered-again id as the newest", () => {
    const cache = new WebhookReplayCache(2);
    cache.remember("a");
    cache.remember("b");
    cache.remember("a");
    cache.remember("c");
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  it.each([0, -1, 1.5])("refuses capacity %d", (capacity) => {
    expect(() => new WebhookReplayCache(capacity)).toThrow(/positive integer/);
  });
});
