/**
 * End to end through the gateway: a READY makes the channel read the
 * history it missed and run it through the live inbound path (ATO-2248).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiscordChannel } from "./discord-channel.js";
import { OP } from "./discord-channel-types.js";
import type { WebSocketLike } from "./discord-gateway-transport.js";
import {
  DiscordMessageCursor,
  snowflakeAtMs,
} from "./discord-message-cursor.js";

class FakeSocket implements WebSocketLike {
  private handlers: Record<string, Array<(ev: never) => void>> = {};
  send(): void {}
  close(code?: number, reason?: string): void {
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

const BOT = "9";
const OWNER = { id: "111" };
const sf = (minutesAgo: number, k = 0): string =>
  (BigInt(snowflakeAtMs(Date.now() - minutesAgo * 60_000)) + BigInt(k)).toString();

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(history: unknown[], holdFirstRead?: Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "atomic-discord-catchup-ch-"));
  dirs.push(dir);
  const historyReads: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.endsWith("/users/@me")) {
        return new Response(JSON.stringify({ id: BOT, username: "b" }));
      }
      if (url.endsWith("/gateway/bot")) {
        return new Response(JSON.stringify({ url: "wss://gw.test" }));
      }
      if ((init?.method ?? "GET") === "GET" && url.includes("/messages?after=")) {
        historyReads.push(url);
        if (historyReads.length === 1 && holdFirstRead) await holdFirstRead;
        return new Response(JSON.stringify(history));
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ id: "1" }));
      }
      throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
    }),
  );
  let n = 0;
  const sessions = new Map<string, { id: string; metadata: unknown }>();
  const runTurn = vi.fn(
    async (_s: unknown, _t: string, opts: { eventHook?: (e: unknown) => void }) => {
      opts.eventHook?.({
        type: "llm_event",
        event: { type: "assistant_reply", text: "ok" },
      });
      return {};
    },
  );
  const runtime = {
    createSession: (input?: { metadata?: unknown }) => {
      const s = { id: `s${++n}`, metadata: input?.metadata ?? {} };
      sessions.set(s.id, s);
      return s;
    },
    sessionStore: { load: (id: string) => sessions.get(id) ?? null },
    turnController: { isBusy: () => false },
    runTurn,
  };
  let socket: FakeSocket | null = null;
  const pointerPath = join(dir, "discord-session.json");
  const channel = new DiscordChannel({
    runtime: runtime as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    approvals: { resolve: vi.fn() } as never,
    approvalRouter: { setForSession: vi.fn(() => vi.fn()) } as never,
    enabled: true,
    ownerUserIds: [OWNER.id],
    sessionPointerPath: pointerPath,
    inboxDir: join(dir, "inbox"),
    lock: { acquire: vi.fn(), release: vi.fn() } as never,
    token: "a".repeat(24) + ".bbbbbb." + "c".repeat(30),
    createSocket: () => {
      socket = new FakeSocket();
      return socket;
    },
  });
  const cursorPath = join(dir, "discord-session-cursor.json");
  return {
    channel,
    runTurn,
    historyReads,
    cursorPath,
    socket: () => socket!,
  };
}

const prompts = (runTurn: ReturnType<typeof vi.fn>): string[] =>
  runTurn.mock.calls.map((c) => c[1] as string);

describe("DiscordChannel catch-up on READY", () => {
  it("runs missed owner messages in order, skips bot/self/unaddressed, and never twice", async () => {
    const cursorId = sf(30);
    const first = sf(20, 1);
    const second = sf(10, 2);
    const selfReply = sf(5, 3);
    // Newest first, as Discord answers. REST carries no guild_id.
    const history = [
      { id: selfReply, content: "my reply", author: { id: BOT, bot: true } },
      { id: sf(6, 4), content: `<@${BOT}> hi`, author: { id: "77", bot: true }, mentions: [{ id: BOT }] },
      { id: sf(7, 5), content: "chatter, not for the bot", author: OWNER },
      { id: second, content: `<@${BOT}> second`, author: OWNER, mentions: [{ id: BOT }] },
      { id: first, content: `<@${BOT}> first`, author: OWNER, mentions: [{ id: BOT }] },
    ];
    const t = setup(history);
    new DiscordMessageCursor(t.cursorPath).advance("c1", cursorId, "g1");

    await t.channel.start();
    await vi.waitFor(() => expect(t.socket()).not.toBeNull());
    t.socket().frame(OP.DISPATCH, { session_id: "gs1" }, "READY");

    await vi.waitFor(() => expect(t.runTurn).toHaveBeenCalledTimes(2));
    const [p1, p2] = prompts(t.runTurn);
    expect(p1).toContain("first");
    expect(p2).toContain("second");
    expect(t.historyReads[0]).toContain(`/channels/c1/messages?after=${cursorId}`);
    // The cursor moved past everything read, bot replies included.
    await vi.waitFor(() =>
      expect(new DiscordMessageCursor(t.cursorPath).get("c1")?.lastMessageId).toBe(
        selfReply,
      ),
    );

    // The same message arriving live (gateway replay) is not run again.
    t.socket().frame(
      OP.DISPATCH,
      {
        id: second,
        channel_id: "c1",
        guild_id: "g1",
        content: `<@${BOT}> second`,
        author: OWNER,
        mentions: [{ id: BOT }],
      },
      "MESSAGE_CREATE",
    );
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(t.runTurn).toHaveBeenCalledTimes(2);
    await t.channel.stop();
  });

  it("does not read any history on a first run with no cursor", async () => {
    const t = setup([
      { id: sf(1), content: "hello", author: OWNER },
    ]);

    await t.channel.start();
    await vi.waitFor(() => expect(t.socket()).not.toBeNull());
    t.socket().frame(OP.DISPATCH, { session_id: "gs1" }, "READY");
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));

    expect(t.historyReads).toEqual([]);
    expect(t.runTurn).not.toHaveBeenCalled();
    await t.channel.stop();
  });

  it("gives a channel a cursor once an owner message from it is handled", async () => {
    const t = setup([]);
    await t.channel.start();
    await vi.waitFor(() => expect(t.socket()).not.toBeNull());
    const id = sf(1);
    t.socket().frame(
      OP.DISPATCH,
      { id, channel_id: "d1", content: "hello", author: OWNER },
      "MESSAGE_CREATE",
    );

    await vi.waitFor(() => expect(t.runTurn).toHaveBeenCalledTimes(1));
    const entry = new DiscordMessageCursor(t.cursorPath).get("d1");
    expect(entry?.lastMessageId).toBe(id);
    // A DM has no guild.
    expect(entry?.guildId).toBeUndefined();
    await t.channel.stop();
  });

  it("a READY that lands during a catch-up run starts one more run after it", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const t = setup([], held);
    new DiscordMessageCursor(t.cursorPath).advance("c1", sf(30), "g1");

    await t.channel.start();
    await vi.waitFor(() => expect(t.socket()).not.toBeNull());
    t.socket().frame(OP.DISPATCH, { session_id: "gs1" }, "READY");
    await vi.waitFor(() => expect(t.historyReads).toHaveLength(1));
    // A second fresh gateway session while the first run still waits on
    // its history read: the gap before it must be read too, not dropped.
    t.socket().frame(OP.DISPATCH, { session_id: "gs2" }, "READY");
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(t.historyReads).toHaveLength(1);

    release();
    await vi.waitFor(() => expect(t.historyReads).toHaveLength(2));
    // Exactly one extra run, not one per READY forever.
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(t.historyReads).toHaveLength(2);
    await t.channel.stop();
  });

  it("the rerun reads from the cursor as it was at the second READY, not past live messages", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const t = setup([], held);
    const atSecondReady = sf(30);
    new DiscordMessageCursor(t.cursorPath).advance("c1", atSecondReady, "g1");

    await t.channel.start();
    await vi.waitFor(() => expect(t.socket()).not.toBeNull());
    t.socket().frame(OP.DISPATCH, { session_id: "gs1" }, "READY");
    await vi.waitFor(() => expect(t.historyReads).toHaveLength(1));
    t.socket().frame(OP.DISPATCH, { session_id: "gs2" }, "READY");
    // A live message on the new gateway session moves the cursor while
    // the first run is still busy. The gap before gs2 is older than it.
    const live = sf(1);
    t.socket().frame(
      OP.DISPATCH,
      {
        id: live,
        channel_id: "c1",
        guild_id: "g1",
        content: `<@${BOT}> live`,
        author: OWNER,
        mentions: [{ id: BOT }],
      },
      "MESSAGE_CREATE",
    );
    await vi.waitFor(() => expect(t.runTurn).toHaveBeenCalledTimes(1));
    expect(new DiscordMessageCursor(t.cursorPath).get("c1")?.lastMessageId).toBe(
      live,
    );

    release();
    await vi.waitFor(() => expect(t.historyReads).toHaveLength(2));
    expect(t.historyReads[1]).toContain(
      `/channels/c1/messages?after=${atSecondReady}`,
    );
    expect(t.historyReads[1]).not.toContain(`after=${live}`);
    await t.channel.stop();
  });
});
