import { describe, expect, it } from "vitest";
import { StructuredLogger, type LogRecord } from "../tracing/structured-logger.js";
import type { Channel } from "./channel.js";
import { channelStatusOf } from "./channel.js";
import { ChannelRegistry } from "./channel-registry.js";

function logger(records: LogRecord[]): StructuredLogger {
  return new StructuredLogger({ level: "debug", sinks: [(r) => records.push(r)] });
}

function channel(id: string, calls: string[], opts: { failStart?: boolean; failStop?: boolean } = {}): Channel {
  return {
    id,
    state: () => "up",
    lastError: () => null,
    start: async () => {
      calls.push(`${id}:start`);
      if (opts.failStart) throw new Error(`${id} start boom`);
    },
    stop: async () => {
      calls.push(`${id}:stop`);
      if (opts.failStop) throw new Error(`${id} stop boom`);
    },
  };
}

describe("ChannelRegistry", () => {
  it("lists channels in registration order and finds them by id", () => {
    const registry = new ChannelRegistry(logger([]));
    const a = channel("a", []);
    const b = channel("b", []);
    registry.register(a);
    registry.register(b);
    expect(registry.list()).toEqual([a, b]);
    expect(registry.get("b")).toBe(b);
    expect(registry.get("missing")).toBeNull();
  });

  it("refuses a second channel with the same id", () => {
    const registry = new ChannelRegistry(logger([]));
    registry.register(channel("a", []));
    expect(() => registry.register(channel("a", []))).toThrow(/already registered/);
  });

  it("starts only the requested ids and logs a rejected start instead of throwing", async () => {
    const calls: string[] = [];
    const records: LogRecord[] = [];
    const registry = new ChannelRegistry(logger(records));
    registry.register(channel("a", calls, { failStart: true }));
    registry.register(channel("b", calls));
    registry.register(channel("c", calls));
    expect(() => registry.startInBackground(["a", "c", "unknown"])).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual(["a:start", "c:start"]);
    expect(records).toMatchObject([
      { level: "error", message: "a: start() rejected unexpectedly", context: { error: "a start boom" } },
    ]);
  });

  it("stops every channel except the skipped ones, even when one fails", async () => {
    const calls: string[] = [];
    const records: LogRecord[] = [];
    const registry = new ChannelRegistry(logger(records));
    registry.register(channel("telegram", calls));
    registry.register(channel("a", calls, { failStop: true }));
    registry.register(channel("b", calls));
    await registry.stopAll(new Set(["telegram"]));
    expect(calls.sort()).toEqual(["a:stop", "b:stop"]);
    expect(records).toMatchObject([
      { level: "warn", message: "a: shutdown failed", context: { error: "a stop boom" } },
    ]);
  });
});

describe("channelStatusOf", () => {
  it("carries lastError only while down", () => {
    const base = { id: "x", start: async () => {}, stop: async () => {} };
    expect(channelStatusOf({ ...base, state: () => "down", lastError: () => "no route" })).toEqual({
      channel: "x",
      state: "down",
      lastError: "no route",
    });
    expect(channelStatusOf({ ...base, state: () => "up", lastError: () => "stale" })).toEqual({
      channel: "x",
      state: "up",
    });
  });
});
