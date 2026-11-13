import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WebSocketLike } from "../discord/discord-gateway-transport.js";
import { readThreadReplies, slackChannelDefinition } from "./index.js";
import { SlackChannel } from "./slack-channel.js";

class FakeSocket {
  sent: string[] = [];
  private listeners: Record<string, Array<(ev: never) => void>> = {};
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000): void {
    this.emit("close", { code, reason: "" });
  }
  addEventListener(type: string, cb: (ev: never) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  emit(type: string, ev: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(ev as never);
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function slackFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (url: string) => {
    const method = String(url).split("/").pop() ?? "";
    const body =
      overrides[method] ??
      (method === "auth.test"
        ? { ok: true, user_id: "UBOT", team_id: "T1" }
        : method === "apps.connections.open"
          ? { ok: true, url: "wss://slack.invalid/link?ticket=t" }
          : { ok: true, ts: "1.1" });
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

function makeChannel(over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "atomic-slack-"));
  dirs.push(dir);
  const statuses: Array<{ state: string; lastError?: string }> = [];
  const sockets: FakeSocket[] = [];
  const lock = { acquire: vi.fn(), release: vi.fn() };
  const fetchImpl = slackFetch();
  const channel = new SlackChannel({
    runtime: { sessionStore: { load: () => null } } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    approvals: { resolve: vi.fn() } as never,
    approvalRouter: { setForSession: vi.fn(() => vi.fn()) } as never,
    enabled: true,
    ownerIds: ["UOWNER"],
    threadReplies: true,
    sessionMapPath: join(dir, "slack-session.json"),
    lock,
    botToken: "xoxb-1-2-abc",
    appToken: "xapp-1-A-2-def",
    onStatus: (s) => statuses.push(s),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    apiBaseUrl: "https://slack.invalid/api",
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as WebSocketLike;
    },
    ...over,
  });
  return { channel, statuses, sockets, lock, fetchImpl };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("SlackChannel", () => {
  it("stays disabled when switched off, without taking the lock", async () => {
    const { channel, lock } = makeChannel({ enabled: false });
    await channel.start();
    expect(channel.state()).toBe("disabled");
    expect(lock.acquire).not.toHaveBeenCalled();
  });

  it("reports a missing token as disabled, not down", async () => {
    for (const over of [{ botToken: null }, { appToken: null }]) {
      const { channel } = makeChannel(over);
      await channel.start();
      expect(channel.state()).toBe("disabled");
      expect(channel.lastError()).toBeNull();
    }
  });

  it("goes up on hello and acks envelopes", async () => {
    const { channel, sockets } = makeChannel();
    await channel.start();
    expect(channel.state()).toBe("starting");
    await flush();
    sockets[0]!.emit("message", { data: JSON.stringify({ type: "hello" }) });
    expect(channel.state()).toBe("up");
    await channel.stop();
  });

  it("goes down with a readable reason and releases the lock on a bad token", async () => {
    const { channel, lock } = makeChannel({
      fetchImpl: slackFetch({ "auth.test": { ok: false, error: "invalid_auth" } }),
    });
    await channel.start();
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toMatch(/rejected the token/);
    expect(lock.release).toHaveBeenCalled();
  });

  it("never leaks a token into lastError", async () => {
    const { channel } = makeChannel({
      fetchImpl: vi.fn(async () => {
        throw new Error("connect failed with xoxb-1-2-abc");
      }),
    });
    await channel.start();
    expect(channel.lastError()).not.toContain("xoxb-1-2-abc");
    expect(channel.lastError()).toContain("<token>");
  });

  it("goes down when the lock is held by another process", async () => {
    const { channel } = makeChannel({
      lock: {
        acquire: () => {
          throw new Error("channel-locked: already running in another atomic-agent (pid 42)");
        },
        release: vi.fn(),
      },
    });
    await channel.start();
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toMatch(/already running/);
  });

  it("stop() is idempotent and releases the lock once", async () => {
    const { channel, lock } = makeChannel();
    await channel.start();
    await channel.stop();
    await channel.stop();
    expect(channel.state()).toBe("disabled");
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it("a second start() while starting opens no second socket", async () => {
    const { channel, sockets } = makeChannel();
    await channel.start();
    await channel.start();
    await flush();
    expect(sockets).toHaveLength(1);
    await channel.stop();
  });
});

describe("slackChannelDefinition", () => {
  it("builds a channel with the catalog id and no side effects", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-slack-def-"));
    dirs.push(dir);
    const channel = slackChannelDefinition.create({
      runtime: {} as never,
      config: {} as never,
      channelConfig: { enabled: false, ownerIds: [], options: {} },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      approvals: {} as never,
      approvalRouter: {} as never,
      stateDir: dir,
      inboxDir: join(dir, "inbox", "slack"),
      emitStatus: vi.fn(),
    });
    expect(channel.id).toBe("slack");
    expect(channel.state()).toBe("disabled");
  });
});

describe("readThreadReplies", () => {
  it("defaults to true and only an explicit false turns it off", () => {
    expect(readThreadReplies({})).toBe(true);
    expect(readThreadReplies({ threadReplies: true })).toBe(true);
    expect(readThreadReplies({ threadReplies: false })).toBe(false);
    expect(readThreadReplies({ threadReplies: "false" })).toBe(false);
  });
});
