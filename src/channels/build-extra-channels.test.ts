import { describe, expect, it } from "vitest";
import { StructuredLogger, type LogRecord } from "../tracing/structured-logger.js";
import type { Channel, ChannelDefinition } from "./channel.js";
import { ChannelRegistry } from "./channel-registry.js";
import { buildExtraChannels, type ExtraChannelBuildContext } from "./build-extra-channels.js";

function fake(id: string): Channel {
  return { id, state: () => "disabled", lastError: () => null, start: async () => {}, stop: async () => {} };
}

function ctx(records: LogRecord[], channels: Record<string, unknown>): ExtraChannelBuildContext {
  return {
    runtime: {} as never,
    config: { channels } as never,
    logger: new StructuredLogger({ level: "debug", sinks: [(r) => records.push(r)] }),
    approvals: {} as never,
    approvalRouter: {} as never,
    stateDir: "/state",
    emitStatus: () => {},
  };
}

describe("buildExtraChannels", () => {
  it("builds every definition with its own config and inbox, and returns the enabled ids", () => {
    const registry = new ChannelRegistry(new StructuredLogger({ level: "error", sinks: [] }));
    const seen: Array<{ id: string; enabled: boolean; inbox: string }> = [];
    const def = (id: string): ChannelDefinition => ({
      id,
      label: id,
      create: (c) => {
        seen.push({ id, enabled: c.channelConfig.enabled, inbox: c.inboxDir });
        return fake(id);
      },
    });
    const toStart = buildExtraChannels({
      definitions: [def("on"), def("off"), def("absent")],
      registry,
      ctx: ctx([], {
        on: { enabled: true, ownerIds: [], options: {} },
        off: { enabled: false, ownerIds: [], options: {} },
      }),
    });
    expect(toStart).toEqual(["on"]);
    expect(registry.list().map((c) => c.id)).toEqual(["on", "off", "absent"]);
    expect(seen).toEqual([
      { id: "on", enabled: true, inbox: "/state/inbox/on" },
      { id: "off", enabled: false, inbox: "/state/inbox/off" },
      { id: "absent", enabled: false, inbox: "/state/inbox/absent" },
    ]);
  });

  it("skips adapters for other platforms", () => {
    const registry = new ChannelRegistry(new StructuredLogger({ level: "error", sinks: [] }));
    const toStart = buildExtraChannels({
      definitions: [{ id: "imessage", label: "iMessage", platforms: ["darwin"], create: () => fake("imessage") }],
      registry,
      ctx: ctx([], { imessage: { enabled: true, ownerIds: [], options: {} } }),
      platform: "linux",
    });
    expect(toStart).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it("logs and skips an adapter that throws or builds the wrong id, keeping the rest", () => {
    const records: LogRecord[] = [];
    const registry = new ChannelRegistry(new StructuredLogger({ level: "error", sinks: [] }));
    const toStart = buildExtraChannels({
      definitions: [
        { id: "broken", label: "Broken", create: () => { throw new Error("bad options"); } },
        { id: "liar", label: "Liar", create: () => fake("other") },
        { id: "fine", label: "Fine", create: () => fake("fine") },
      ],
      registry,
      ctx: ctx(records, {
        broken: { enabled: true, ownerIds: [], options: {} },
        liar: { enabled: true, ownerIds: [], options: {} },
        fine: { enabled: true, ownerIds: [], options: {} },
      }),
    });
    expect(toStart).toEqual(["fine"]);
    expect(registry.list().map((c) => c.id)).toEqual(["fine"]);
    expect(records.map((r) => r.message)).toEqual([
      "broken: could not build the channel",
      "liar: could not build the channel",
    ]);
  });
});
