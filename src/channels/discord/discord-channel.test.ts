import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiscordChannel } from "./discord-channel.js";
import { OP } from "./discord-channel-types.js";
import type { WebSocketLike } from "./discord-gateway-transport.js";

function makeChannel(over: Record<string, unknown> = {}) {
  const statuses: Array<{ state: string; lastError?: string }> = [];
  const lock = { acquire: vi.fn(), release: vi.fn(), held: () => false };
  const channel = new DiscordChannel({
    runtime: { sessionStore: { load: () => null } } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    approvals: { resolve: vi.fn() } as never,
    approvalRouter: { setForSession: vi.fn(() => vi.fn()) } as never,
    enabled: true,
    ownerUserId: "111",
    sessionPointerPath: "/tmp/does-not-matter.json",
    inboxDir: "/tmp/does-not-matter-inbox",
    lock: lock as never,
    token: "a".repeat(24) + ".bbbbbb." + "c".repeat(30),
    onStatus: (s) => statuses.push(s),
    createSocket: (() => ({
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
    })) as unknown as (url: string) => WebSocketLike,
    ...over,
  });
  return { channel, statuses, lock };
}

describe("DiscordChannel", () => {
  it("stays disabled when the kill switch is off", async () => {
    const { channel, lock } = makeChannel({ enabled: false });
    await channel.start();
    expect(channel.state()).toBe("disabled");
    // No lock is taken for a channel that never runs.
    expect(lock.acquire).not.toHaveBeenCalled();
  });

  it("reports a missing token as disabled, not down", async () => {
    // An unconfigured integration is a resting state; badging it as a
    // failure trains the operator to ignore a red badge.
    const { channel } = makeChannel({ token: null });
    await channel.start();
    expect(channel.state()).toBe("disabled");
    expect(channel.lastError()).toBeNull();
  });

  it("goes down with a scrubbed reason when the lock is held", async () => {
    const { channel, statuses } = makeChannel({
      lock: {
        acquire: () => {
          throw new Error("another atomic-agent process (pid 42) is already running the Discord channel");
        },
        release: vi.fn(),
      },
    });
    await channel.start();
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toMatch(/already running/);
    expect(statuses.at(-1)?.state).toBe("down");
  });

  it("goes down and releases the lock when the token is rejected", async () => {
    const lock = { acquire: vi.fn(), release: vi.fn() };
    const { channel } = makeChannel({
      lock,
      apiBaseUrl: "https://discord.invalid/api/v10",
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await channel.start();
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toMatch(/bot token/);
    // A held lock would block every later start attempt in this process.
    expect(lock.release).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("never leaks the token into lastError", async () => {
    const token = "d".repeat(24) + ".eeeeee." + "f".repeat(30);
    const { channel } = makeChannel({ token, apiBaseUrl: "https://x.invalid" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`connect failed using ${token}`);
      }),
    );
    await channel.start();
    expect(channel.lastError()).not.toContain(token);
    expect(channel.lastError()).toContain("<token>");
    vi.unstubAllGlobals();
  });

  it("setEnabled(true) starts a channel that booted switched off", async () => {
    // The bug this pins: `enabled` was read from the construction-time
    // deps on every start(), so an operator who switched the channel on
    // from the Integrations hub got a silent `disabled` until the next
    // launch -- the config write was real, the running channel never
    // heard about it.
    const { channel, lock } = makeChannel({ enabled: false });
    await channel.start();
    expect(channel.state()).toBe("disabled");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "9", username: "b" }), { status: 200 })),
    );
    await channel.setEnabled(true);

    expect(channel.state()).not.toBe("disabled");
    expect(lock.acquire).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("setEnabled(false) stops a running channel and releases the lock", async () => {
    const { channel, lock } = makeChannel();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "9", username: "b" }), { status: 200 })),
    );
    await channel.start();
    await channel.setEnabled(false);

    expect(channel.state()).toBe("disabled");
    expect(lock.release).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("setEnabled(true) on an already-running channel does not build a second gateway", async () => {
    // Two gateways on one token receive every event twice, so every
    // turn would run twice, side effects included.
    const { channel, lock } = makeChannel();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "9", username: "b" }), { status: 200 })),
    );
    await channel.start();
    const acquiredOnce = lock.acquire.mock.calls.length;
    await channel.setEnabled(true);

    expect(lock.acquire.mock.calls.length).toBe(acquiredOnce);
    vi.unstubAllGlobals();
  });

  it("stopping a disabled channel is a no-op", async () => {
    const { channel, lock } = makeChannel({ enabled: false });
    await channel.start();
    await channel.stop();
    expect(lock.release).not.toHaveBeenCalled();
  });
});

describe("DiscordChannel per-channel approval bindings", () => {
  /** Scriptable socket: records frames sent, lets a test inject frames. */
  class FakeSocket implements WebSocketLike {
    private handlers: Record<string, Array<(ev: never) => void>> = {};
    send(): void {}
    close(code?: number, reason?: string): void {
      // A real socket answers close() with a close event; the gateway's
      // stop() waits for it.
      for (const cb of this.handlers.close ?? []) {
        (cb as (e: unknown) => void)({ code: code ?? 1000, reason: reason ?? "" });
      }
    }
    addEventListener(type: string, cb: (ev: never) => void): void {
      (this.handlers[type] ??= []).push(cb);
    }
    frame(op: number, d: unknown, t?: string): void {
      for (const cb of this.handlers.message ?? []) {
        (cb as (e: unknown) => void)({ data: JSON.stringify({ op, d, t, s: 1 }) });
      }
    }
  }

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  };

  it("keeps one binding per channel, drops it on /new, and drops all on stop()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-discord-bindings-"));
    const unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
    const setForSession = vi.fn(() => {
      const u = vi.fn();
      unsubscribes.push(u);
      return u;
    });
    let n = 0;
    const sessions = new Map<string, { id: string; metadata: Record<string, unknown> }>();
    const runtime = {
      createSession: (input?: { metadata?: Record<string, unknown> }) => {
        const s = { id: `s${++n}`, metadata: input?.metadata ?? {} };
        sessions.set(s.id, s);
        return s;
      },
      sessionStore: { load: (id: string) => sessions.get(id) ?? null },
      turnController: { isBusy: () => false },
      runTurn: vi.fn(async (_s: unknown, _t: string, opts: { eventHook?: (e: unknown) => void }) => {
        opts.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: "done" } });
        return {};
      }),
    };
    const posted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        if (url.endsWith("/users/@me")) {
          return new Response(JSON.stringify({ id: "9", username: "b" }), { status: 200 });
        }
        if (url.endsWith("/gateway/bot")) {
          return new Response(JSON.stringify({ url: "wss://gw.test" }), { status: 200 });
        }
        if (init?.method === "POST" && /\/channels\/[^/]+\/messages$/.test(url)) {
          posted.push(url.split("/channels/")[1]!.split("/")[0]!);
          return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
      }),
    );
    let socket: FakeSocket | null = null;
    const { channel } = makeChannel({
      runtime: runtime as never,
      approvalRouter: { setForSession } as never,
      sessionPointerPath: join(dir, "discord-session.json"),
      createSocket: () => {
        socket = new FakeSocket();
        return socket;
      },
    });
    await channel.start();
    await settle();
    expect(socket).not.toBeNull();
    const owner = { id: "111" };
    const inGuild = (channel_id: string, content: string) => ({
      id: `m-${channel_id}`,
      channel_id,
      guild_id: "g1",
      content: `<@9> ${content}`,
      author: owner,
      mentions: [{ id: "9" }],
    });

    socket!.frame(OP.DISPATCH, inGuild("a", "project A"), "MESSAGE_CREATE");
    await settle();
    socket!.frame(OP.DISPATCH, inGuild("b", "project B"), "MESSAGE_CREATE");
    await settle();
    // Two channels, two sessions, two live bindings — neither evicted the other.
    expect(setForSession).toHaveBeenCalledTimes(2);
    expect(setForSession.mock.calls.map((c) => c[0])).toEqual(["s1", "s2"]);
    expect(unsubscribes.every((u) => u.mock.calls.length === 0)).toBe(true);
    // A second turn in #a re-uses its session and binding.
    socket!.frame(OP.DISPATCH, inGuild("a", "more A"), "MESSAGE_CREATE");
    await settle();
    expect(setForSession).toHaveBeenCalledTimes(2);
    expect(runtime.runTurn.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual([
      "s1",
      "s2",
      "s1",
    ]);
    // /new in #a releases only #a's binding.
    socket!.frame(OP.DISPATCH, inGuild("a", "/new"), "MESSAGE_CREATE");
    await settle();
    expect(unsubscribes[0]!).toHaveBeenCalledTimes(1);
    expect(unsubscribes[1]!).not.toHaveBeenCalled();
    // stop() drops whatever is left.
    await channel.stop();
    expect(unsubscribes[1]!).toHaveBeenCalledTimes(1);
    // Replies went to the channels that asked.
    expect(posted).toEqual(["a", "b", "a", "a"]);
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });
});
