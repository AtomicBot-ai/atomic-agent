import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SentryClient, type FetchLike } from "./sentry-client.js";
import { parseSentryDsn } from "./sentry-config.js";
import {
  SENTRY_RATE_LIMIT_MAX_EVENTS,
  SENTRY_RATE_LIMIT_WINDOW_MS,
  SentryRateLimiter,
  normalizeMessage,
  sentryGroupingKey,
} from "./sentry-rate-limit.js";

const HOUR = SENTRY_RATE_LIMIT_WINDOW_MS;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SentryRateLimiter", () => {
  it("allows 10 identical events per hour and drops the 11th", () => {
    expect(SENTRY_RATE_LIMIT_MAX_EVENTS).toBe(10);
    expect(HOUR).toBe(60 * 60 * 1000);
    const limiter = new SentryRateLimiter();
    for (let i = 0; i < 10; i += 1) {
      expect(limiter.shouldSend("same")).toBe(true);
      vi.advanceTimersByTime(1000);
    }
    expect(limiter.shouldSend("same")).toBe(false);
    expect(limiter.shouldSend("same")).toBe(false);
  });

  it("counts different events independently", () => {
    const limiter = new SentryRateLimiter();
    for (let i = 0; i < 10; i += 1) limiter.shouldSend("a");
    expect(limiter.shouldSend("a")).toBe(false);
    for (let i = 0; i < 10; i += 1) expect(limiter.shouldSend("b")).toBe(true);
    expect(limiter.shouldSend("b")).toBe(false);
  });

  it("passes the event again once an hour has gone by", () => {
    const limiter = new SentryRateLimiter();
    for (let i = 0; i < 10; i += 1) limiter.shouldSend("same");
    expect(limiter.shouldSend("same")).toBe(false);
    vi.advanceTimersByTime(HOUR - 1);
    expect(limiter.shouldSend("same")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(limiter.shouldSend("same")).toBe(true);
  });

  it("is a rolling window, not a fixed bucket", () => {
    const limiter = new SentryRateLimiter();
    for (let i = 0; i < 5; i += 1) limiter.shouldSend("k");
    vi.advanceTimersByTime(30 * 60 * 1000);
    for (let i = 0; i < 5; i += 1) limiter.shouldSend("k");
    expect(limiter.shouldSend("k")).toBe(false);
    // The first five fall out of the window; the later five still count.
    vi.advanceTimersByTime(30 * 60 * 1000);
    for (let i = 0; i < 5; i += 1) expect(limiter.shouldSend("k")).toBe(true);
    expect(limiter.shouldSend("k")).toBe(false);
  });

  it("does not count dropped events toward the window", () => {
    const limiter = new SentryRateLimiter();
    for (let i = 0; i < 10; i += 1) limiter.shouldSend("k");
    vi.advanceTimersByTime(HOUR / 2);
    for (let i = 0; i < 100; i += 1) limiter.shouldSend("k");
    vi.advanceTimersByTime(HOUR / 2);
    expect(limiter.shouldSend("k")).toBe(true);
  });
});

describe("SentryRateLimiter persistence", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sentry-rl-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("carries the budget across a restart", () => {
    const storePath = join(dir, "sentry-rate-limit.json");
    const first = new SentryRateLimiter({ storePath });
    for (let i = 0; i < 10; i += 1) first.shouldSend("crash-loop");
    const second = new SentryRateLimiter({ storePath });
    expect(second.shouldSend("crash-loop")).toBe(false);
    expect(second.shouldSend("other")).toBe(true);
    vi.advanceTimersByTime(HOUR);
    const third = new SentryRateLimiter({ storePath });
    expect(third.shouldSend("crash-loop")).toBe(true);
  });

  it("stores only hashes and timestamps, never the key text", () => {
    const storePath = join(dir, "sentry-rate-limit.json");
    new SentryRateLimiter({ storePath }).shouldSend("TransportError secret-ish");
    const raw = readFileSync(storePath, "utf8");
    expect(raw).not.toContain("TransportError");
    const parsed = JSON.parse(raw) as { v: number; keys: Record<string, number[]> };
    expect(parsed.v).toBe(1);
    expect(Object.values(parsed.keys)).toEqual([[Date.now()]]);
  });

  it("sees the sends another process wrote to the file", () => {
    const storePath = join(dir, "sentry-rate-limit.json");
    const a = new SentryRateLimiter({ storePath });
    const b = new SentryRateLimiter({ storePath });
    for (let i = 0; i < 5; i += 1) a.shouldSend("k");
    for (let i = 0; i < 5; i += 1) b.shouldSend("k");
    expect(new SentryRateLimiter({ storePath }).shouldSend("k")).toBe(false);
  });

  it("treats a corrupt or unwritable file as empty and keeps working", () => {
    const storePath = join(dir, "sentry-rate-limit.json");
    writeFileSync(storePath, "{not json", "utf8");
    const limiter = new SentryRateLimiter({ storePath });
    for (let i = 0; i < 10; i += 1) expect(limiter.shouldSend("k")).toBe(true);
    expect(limiter.shouldSend("k")).toBe(false);

    const blocked = new SentryRateLimiter({
      storePath: join(storePath, "cannot", "be", "a", "dir.json"),
    });
    for (let i = 0; i < 10; i += 1) expect(blocked.shouldSend("k")).toBe(true);
    expect(blocked.shouldSend("k")).toBe(false);
  });
});

describe("sentryGroupingKey", () => {
  it("uses the fingerprint when the event sets one", () => {
    const a = sentryGroupingKey({ fingerprint: ["{{ default }}", "TransportError", "x"] });
    const b = sentryGroupingKey({
      fingerprint: ["{{ default }}", "TransportError", "x"],
      exception: { values: [{ type: "Other", value: "different" }] },
    });
    expect(a).toBe(b);
    expect(sentryGroupingKey({ fingerprint: ["{{ default }}", "TransportError", "y"] })).not.toBe(a);
  });

  it("falls back to type + normalized message + top in-app frame", () => {
    const ev = (value: string, fn = "connect") => ({
      exception: {
        values: [
          {
            type: "Error",
            value,
            stacktrace: {
              frames: [
                { filename: "main.js", function: "run", in_app: true },
                { filename: "client.js", function: fn, in_app: true },
                { filename: "node:net", function: "afterConnect", in_app: false },
              ],
            },
          },
        ],
      },
    });
    expect(sentryGroupingKey(ev("connect ECONNREFUSED 127.0.0.1:8093"))).toBe(
      sentryGroupingKey(ev("connect ECONNREFUSED 127.0.0.1:19091")),
    );
    expect(sentryGroupingKey(ev("connect ECONNREFUSED 127.0.0.1:8093"))).not.toBe(
      sentryGroupingKey(ev("connect ECONNREFUSED 127.0.0.1:8093", "other")),
    );
    expect(sentryGroupingKey(ev("a"))).not.toBe(sentryGroupingKey(ev("b")));
  });

  it("falls back to the message last", () => {
    expect(sentryGroupingKey({ message: "llama-server 500 after 12 ms" })).toBe(
      sentryGroupingKey({ message: { formatted: "llama-server 503 after 7 ms" } }),
    );
  });
});

describe("normalizeMessage", () => {
  it("strips numbers, ports, paths, urls and ids", () => {
    expect(normalizeMessage("connect ECONNREFUSED 127.0.0.1:8093")).toBe(
      "connect ECONNREFUSED <n>:<n>",
    );
    expect(normalizeMessage("ENOENT: open '/Users/ann/.atomic-agent/state/x.json'")).toBe(
      "ENOENT: open '<path>'",
    );
    expect(normalizeMessage("GET http://localhost:19091/v1/chat failed: 500")).toBe(
      "GET <url> failed: <n>",
    );
    expect(normalizeMessage("session 3f2a9c1e-1b2c-4d5e-8f90-123456789abc gone")).toBe(
      "session <id> gone",
    );
    expect(normalizeMessage("C:\\Users\\ann\\AppData\\x.log locked")).toBe("<path> locked");
  });
});

describe("SentryClient rate limiting", () => {
  const DSN = parseSentryDsn("https://pub@o1.ingest.sentry.io/7")!;

  it("sends 10 identical captures in an hour, drops the 11th, keeps others", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const client = new SentryClient({
      dsn: DSN,
      installId: "install-1",
      release: "0.6.0",
      platform: "darwin",
      fetchImpl: fetchImpl as unknown as FetchLike,
    });
    const flood = {
      errorType: "TransportError",
      category: "transport",
      source: "llm_failure",
      httpStatus: 500,
      frames: [{ filename: "cli.mjs", lineno: 1, colno: 2 }],
    };
    for (let i = 0; i < 11; i += 1) client.capture(flood);
    client.capture({ ...flood, errorType: "ModelError" });
    await client.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(11);

    vi.advanceTimersByTime(HOUR);
    client.capture(flood);
    await client.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(12);
  });
});
