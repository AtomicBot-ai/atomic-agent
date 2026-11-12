import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MatrixChannel, type MatrixChannelDeps } from "./matrix-channel.js";
import { MATRIX_CHANNEL } from "./index.js";

const OWNER = "@ada:hs";
const BOT = "@bot:hs";
let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "atomic-matrix-channel-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A scripted homeserver: whoami, then `syncs` in order, then a sync that
 * parks until aborted. Other calls answer `{ event_id }` and are recorded.
 */
function fakeServer(syncs: unknown[], whoami: Response = json({ user_id: BOT })) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: url.pathname,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url.pathname.endsWith("/account/whoami")) return whoami.clone();
    if (url.pathname.endsWith("/sync")) {
      const next = syncs.shift();
      if (next) return json(next);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    return json({ event_id: "$sent" });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function makeChannel(over: Partial<MatrixChannelDeps> = {}, options: Record<string, string> = {}) {
  const statuses: Array<{ state: string; lastError?: string }> = [];
  const lock = { acquire: vi.fn(), release: vi.fn() };
  const runTurn = vi.fn(
    async (_s: unknown, _t: string, opts: { eventHook?: (e: unknown) => void }) => {
      opts.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: "done" } });
      return {};
    },
  );
  const channel = new MatrixChannel({
    runtime: {
      runTurn,
      createSession: () => ({ id: "s1" }),
      sessionStore: { load: () => null },
      turnController: { isBusy: () => false },
    } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    approvals: { resolve: vi.fn() } as never,
    approvalRouter: { setForSession: vi.fn(() => vi.fn()) } as never,
    channelConfig: {
      enabled: true,
      ownerIds: [OWNER],
      options: { homeserver: "https://hs.example", ...options },
    },
    stateDir,
    emitStatus: (s) => statuses.push(s),
    lock,
    token: "syt_Ym90_abcdefghijklmnop_xyz",
    backoff: () => 1,
    ...over,
  });
  return { channel, statuses, lock, runTurn };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("MatrixChannel", () => {
  it("is registered in the catalog as 'matrix' on every platform", () => {
    expect(MATRIX_CHANNEL.id).toBe("matrix");
    expect(MATRIX_CHANNEL.platforms).toBeUndefined();
  });

  it("stays disabled when switched off, without a token or without a usable homeserver", async () => {
    const cases: Array<Partial<MatrixChannelDeps>> = [
      {
        channelConfig: {
          enabled: false,
          ownerIds: [OWNER],
          options: { homeserver: "https://hs.example" },
        },
      },
      { token: null },
      { channelConfig: { enabled: true, ownerIds: [OWNER], options: {} } },
      {
        channelConfig: {
          enabled: true,
          ownerIds: [OWNER],
          options: { homeserver: "http://hs.example" },
        },
      },
    ];
    for (const over of cases) {
      const { channel, lock } = makeChannel(over);
      await channel.start();
      expect(channel.state()).toBe("disabled");
      expect(channel.lastError()).toBeNull();
      expect(lock.acquire).not.toHaveBeenCalled();
    }
  });

  it("goes down with a scrubbed reason and releases the lock when the token is rejected", async () => {
    const server = fakeServer([], json({ errcode: "M_UNKNOWN_TOKEN", error: "Invalid token" }, 401));
    const { channel, lock } = makeChannel({ fetchImpl: server.fetchImpl });
    await channel.start();
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toMatch(/401/);
    expect(channel.lastError()).not.toContain("syt_Ym90");
    expect(lock.release).toHaveBeenCalled();
  });

  it("goes down when the token belongs to another account than options.userId", async () => {
    const server = fakeServer([]);
    const { channel } = makeChannel({ fetchImpl: server.fetchImpl }, { userId: "@other:hs" });
    await channel.start();
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toMatch(/belongs to @bot:hs/);
  });

  it("goes down when another process holds the lock", async () => {
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
    expect(channel.lastError()).toMatch(/^channel-locked:/);
  });

  it("skips history on the first sync, persists next_batch, then runs new owner messages", async () => {
    const message = (body: string) => ({
      type: "m.room.message",
      sender: OWNER,
      event_id: `$${body}`,
      content: { msgtype: "m.text", body },
    });
    const server = fakeServer([
      { next_batch: "s1", rooms: { join: { "!r:hs": { timeline: { events: [message("old")] } } } } },
      { next_batch: "s2", rooms: { join: { "!r:hs": { timeline: { events: [message("new")] } } } } },
    ]);
    const { channel, runTurn, statuses } = makeChannel({ fetchImpl: server.fetchImpl });
    await channel.start();
    await settle();
    expect(channel.state()).toBe("up");
    expect(statuses.map((s) => s.state)).toEqual(["starting", "up"]);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn.mock.calls[0]?.[1]).toContain("new");
    const stored = JSON.parse(readFileSync(join(stateDir, "matrix-sync.json"), "utf8"));
    expect(stored).toEqual({ userId: BOT, nextBatch: "s2" });
    expect(
      server.calls.some((c) => c.method === "PUT" && c.path.includes("/send/m.room.message/")),
    ).toBe(true);
    await channel.stop();
  });

  it("joins rooms an owner invited it to and rejects anyone else's invite", async () => {
    const invite = (sender: string) => ({
      invite_state: {
        events: [
          { type: "m.room.member", sender, state_key: BOT, content: { membership: "invite" } },
        ],
      },
    });
    const server = fakeServer([
      {
        next_batch: "s1",
        rooms: { invite: { "!mine:hs": invite(OWNER), "!spam:hs": invite("@mallory:hs") } },
      },
    ]);
    const { channel } = makeChannel({ fetchImpl: server.fetchImpl });
    await channel.start();
    await settle();
    const posts = server.calls.filter((c) => c.method === "POST").map((c) => c.path);
    expect(posts).toContain("/_matrix/client/v3/join/!mine%3Ahs");
    expect(posts).toContain("/_matrix/client/v3/rooms/!spam%3Ahs/leave");
    expect(posts).not.toContain("/_matrix/client/v3/join/!spam%3Ahs");
    await channel.stop();
  });

  it("stop() is idempotent and releases the lock once", async () => {
    const server = fakeServer([{ next_batch: "s1" }]);
    const { channel, lock } = makeChannel({ fetchImpl: server.fetchImpl });
    await channel.start();
    await settle();
    expect(channel.state()).toBe("up");
    await channel.stop();
    expect(channel.state()).toBe("disabled");
    expect(lock.release).toHaveBeenCalledTimes(1);
    await channel.stop();
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it("uses the real pid lockfile under the state dir by default", async () => {
    const server = fakeServer([{ next_batch: "s1" }]);
    const { channel } = makeChannel({ fetchImpl: server.fetchImpl, lock: undefined });
    await channel.start();
    expect(existsSync(join(stateDir, "matrix.lock"))).toBe(true);
    await channel.stop();
    expect(existsSync(join(stateDir, "matrix.lock"))).toBe(false);
  });
});
