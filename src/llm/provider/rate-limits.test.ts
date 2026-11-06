import { describe, expect, it } from "vitest";
import {
  parseClaudeRateLimitInfo,
  parseCodexRateLimitsPayload,
  parseDurationMs,
  parseRateLimitHeaders,
} from "./rate-limits.js";

const NOW = 1_800_000_000_000;

function headers(map: Record<string, string>) {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

describe("parseRateLimitHeaders", () => {
  it("reads the ChatGPT plan windows Codex sees (x-codex-*)", () => {
    expect(
      parseRateLimitHeaders(
        headers({
          "x-codex-primary-used-percent": "83",
          "x-codex-primary-window-minutes": "300",
          "x-codex-primary-reset-after-seconds": "600",
          "x-codex-secondary-used-percent": "12.5",
          "x-codex-secondary-window-minutes": "10080",
          "x-codex-secondary-reset-at": "1800100000",
        }),
        NOW,
      ),
    ).toEqual([
      { scope: "subscription", name: "5h", usedPercent: 83, resetsAt: NOW + 600_000 },
      { scope: "subscription", name: "weekly", usedPercent: 12.5, resetsAt: 1_800_100_000_000 },
    ]);
  });

  it("reads a Claude subscription's unified headers as percent of the window", () => {
    expect(
      parseRateLimitHeaders(
        headers({
          "anthropic-ratelimit-unified-status": "allowed_warning",
          "anthropic-ratelimit-unified-5h-utilization": "0.91",
          "anthropic-ratelimit-unified-5h-reset": "1800003600",
        }),
        NOW,
      ),
    ).toEqual([
      {
        scope: "subscription",
        name: "5h",
        usedPercent: 91,
        resetsAt: 1_800_003_600_000,
        status: "allowed_warning",
      },
    ]);
  });

  it("reads OpenAI-style per-kind API budgets with duration resets", () => {
    expect(
      parseRateLimitHeaders(
        headers({
          "x-ratelimit-limit-requests": "500",
          "x-ratelimit-remaining-requests": "499",
          "x-ratelimit-reset-requests": "120ms",
          "x-ratelimit-limit-tokens": "30000",
          "x-ratelimit-remaining-tokens": "3000",
          "x-ratelimit-reset-tokens": "6m0s",
        }),
        NOW,
      ),
    ).toEqual([
      { scope: "api", name: "requests", limit: 500, remaining: 499, usedPercent: 0.2, resetsAt: NOW + 120 },
      { scope: "api", name: "tokens", limit: 30000, remaining: 3000, usedPercent: 90, resetsAt: NOW + 360_000 },
    ]);
  });

  it("reads OpenRouter's unsuffixed headers with an epoch-ms reset", () => {
    expect(
      parseRateLimitHeaders(
        headers({
          "X-RateLimit-Limit": "20",
          "X-RateLimit-Remaining": "5",
          "X-RateLimit-Reset": String(NOW + 30_000),
        }),
        NOW,
      ),
    ).toEqual([
      { scope: "api", name: "requests", limit: 20, remaining: 5, usedPercent: 75, resetsAt: NOW + 30_000 },
    ]);
  });

  it("reads Anthropic's own API headers with RFC 3339 resets", () => {
    const reset = new Date(NOW + 60_000).toISOString();
    expect(
      parseRateLimitHeaders(
        headers({
          "anthropic-ratelimit-requests-limit": "50",
          "anthropic-ratelimit-requests-remaining": "49",
          "anthropic-ratelimit-requests-reset": reset,
        }),
        NOW,
      ),
    ).toEqual([
      { scope: "api", name: "requests", limit: 50, remaining: 49, usedPercent: 2, resetsAt: NOW + 60_000 },
    ]);
  });

  it("yields nothing for a response without limit headers or with junk in them", () => {
    expect(parseRateLimitHeaders(headers({}), NOW)).toEqual([]);
    expect(
      parseRateLimitHeaders(
        headers({ "x-codex-primary-used-percent": "lots", "x-ratelimit-remaining-requests": "" }),
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("parseCodexRateLimitsPayload", () => {
  it("accepts resets_in_seconds and names windows by length", () => {
    expect(
      parseCodexRateLimitsPayload(
        { primary: { used_percent: 40, window_minutes: 60, resets_in_seconds: 30 } },
        NOW,
      ),
    ).toEqual([{ scope: "subscription", name: "1h", usedPercent: 40, resetsAt: NOW + 30_000 }]);
  });

  it("ignores payloads that are not objects", () => {
    expect(parseCodexRateLimitsPayload(null, NOW)).toEqual([]);
    expect(parseCodexRateLimitsPayload("x", NOW)).toEqual([]);
    expect(parseCodexRateLimitsPayload({ primary: 3 }, NOW)).toEqual([]);
  });
});

describe("parseClaudeRateLimitInfo", () => {
  it("keeps a rejection with its reset even without a utilization figure", () => {
    expect(
      parseClaudeRateLimitInfo({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1_800_001_000 }),
    ).toEqual([{ scope: "subscription", name: "5h", status: "rejected", resetsAt: 1_800_001_000_000 }]);
  });

  it("drops a bare allowed: there is nothing to show", () => {
    expect(parseClaudeRateLimitInfo({ status: "allowed", rateLimitType: "five_hour", resetsAt: 1 })).toEqual([]);
  });
});

describe("parseDurationMs", () => {
  it("reads OpenAI's reset durations", () => {
    expect(parseDurationMs("1s")).toBe(1000);
    expect(parseDurationMs("6m0s")).toBe(360_000);
    expect(parseDurationMs("1h2m3s")).toBe(3_723_000);
    expect(parseDurationMs("20ms")).toBe(20);
    expect(parseDurationMs("0.5s")).toBe(500);
    expect(parseDurationMs("7")).toBe(7000);
    expect(parseDurationMs("soon")).toBeUndefined();
    expect(parseDurationMs(null)).toBeUndefined();
  });
});
