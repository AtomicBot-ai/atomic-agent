import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { LinearChannel, type LinearChannelDeps } from "./linear-channel.js";
import { LINEAR_KEY_REFUSED } from "./linear-poller.js";

function viewerFetch(): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ data: { viewer: { id: "u-bot", name: "Agent" } } }), { status: 200 })) as never;
}

function make(over: Partial<LinearChannelDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "linear-channel-"));
  const endpoint = { listen: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const poller = { listen: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const createEndpoint = vi.fn(() => endpoint);
  const createPoller = vi.fn(() => poller);
  const channel = new LinearChannel({
    runtime: {} as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    approvals: {} as never,
    approvalRouter: { setForSession: vi.fn(() => () => {}) } as never,
    enabled: true,
    ownerIds: ["u-owner"],
    port: 3979,
    handles: ["agent"],
    onAssign: null,
    sessionMapPath: join(dir, "linear-session.json"),
    lock: { acquire: vi.fn(), release: vi.fn() },
    apiKey: "lin_api_test",
    webhookSecret: null,
    fetchImpl: viewerFetch(),
    createEndpoint,
    createPoller,
    ...over,
  });
  return { channel, createEndpoint, createPoller, poller };
}

describe("LinearChannel: webhook or polling (ATO-2464)", () => {
  it("polls when no webhook secret is saved: no public address needed", async () => {
    const { channel, createEndpoint, createPoller } = make();
    await channel.start();
    expect(createPoller).toHaveBeenCalledTimes(1);
    expect(createEndpoint).not.toHaveBeenCalled();
    expect(channel.state()).toBe("up");
    await channel.stop();
  });

  it("uses the webhook when its secret is saved", async () => {
    const { channel, createEndpoint, createPoller } = make({ webhookSecret: "lin_wh_x" });
    await channel.start();
    expect(createEndpoint).toHaveBeenCalledTimes(1);
    expect(createPoller).not.toHaveBeenCalled();
    await channel.stop();
  });

  it("mode poll wins over a saved secret; mode webhook without a secret stays off", async () => {
    const forced = make({ webhookSecret: "lin_wh_x", mode: "poll" });
    await forced.channel.start();
    expect(forced.createPoller).toHaveBeenCalledTimes(1);
    await forced.channel.stop();
    const webhook = make({ mode: "webhook" });
    await webhook.channel.start();
    expect(webhook.channel.state()).toBe("disabled");
  });

  it("goes down without retrying when the first poll finds the key refused", async () => {
    const { channel, poller } = make();
    poller.listen.mockRejectedValueOnce(new Error(LINEAR_KEY_REFUSED));
    await channel.start();
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toBe(LINEAR_KEY_REFUSED);
    expect(poller.listen).toHaveBeenCalledTimes(1);
    await channel.stop();
  });
});
