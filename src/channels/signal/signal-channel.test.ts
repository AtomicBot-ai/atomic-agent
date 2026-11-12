import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChannelContext } from "../channel.js";
import { SIGNAL_CHANNEL } from "./index.js";
import { SignalChannel } from "./signal-channel.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeCtx(channelConfig: ChannelContext["channelConfig"]) {
  const dir = mkdtempSync(join(tmpdir(), "signal-channel-"));
  dirs.push(dir);
  const statuses: Array<{ state: string; lastError?: string }> = [];
  const ctx = {
    runtime: {} as never,
    config: {} as never,
    channelConfig,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    approvals: { resolve: vi.fn() } as never,
    approvalRouter: { setForSession: vi.fn(() => vi.fn()) } as never,
    stateDir: dir,
    inboxDir: join(dir, "inbox", "signal"),
    emitStatus: (s: { state: string; lastError?: string }) => statuses.push(s),
  } as ChannelContext;
  return { ctx, statuses };
}

const on = (options: Record<string, string | number | boolean> = { account: "+15550001111" }) => ({
  enabled: true,
  ownerIds: ["+15550002222"],
  options,
});

const refused = vi.fn(async () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
});

describe("SignalChannel", () => {
  it("is registered with id signal and builds without side effects", () => {
    const { ctx } = makeCtx(on());
    const channel = SIGNAL_CHANNEL.create(ctx);
    expect(SIGNAL_CHANNEL.id).toBe("signal");
    expect(channel.id).toBe("signal");
    expect(channel.state()).toBe("disabled");
  });

  it("stays disabled when switched off or without an account", async () => {
    const lock = { acquire: vi.fn(), release: vi.fn() };
    const off = new SignalChannel(makeCtx({ ...on(), enabled: false }).ctx, { lock, fetch: refused });
    await off.start();
    expect(off.state()).toBe("disabled");

    const noAccount = new SignalChannel(makeCtx(on({})).ctx, { lock, fetch: refused });
    await noAccount.start();
    expect(noAccount.state()).toBe("disabled");
    expect(noAccount.lastError()).toBeNull();
    expect(lock.acquire).not.toHaveBeenCalled();
    expect(refused).not.toHaveBeenCalled();
  });

  it("goes down with a clear reason while the daemon is not running", async () => {
    const lock = { acquire: vi.fn(), release: vi.fn() };
    const { ctx, statuses } = makeCtx(on({ account: "+15550001111", url: "http://127.0.0.1:8080" }));
    const channel = new SignalChannel(ctx, { lock, fetch: refused, backoff: () => 60_000 });
    await channel.start();
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toBe(
      "signal-cli daemon not reachable at http://127.0.0.1:8080 (ECONNREFUSED)",
    );
    expect(statuses.at(-1)).toMatchObject({ channel: "signal", state: "down" });
    await channel.stop();
    expect(channel.state()).toBe("disabled");
    expect(lock.release).toHaveBeenCalledTimes(1);
    await channel.stop();
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it("goes down when the lock is held by another process", async () => {
    const lock = {
      acquire: () => {
        throw new Error("channel-locked: already running in another atomic-agent (pid 42)");
      },
      release: vi.fn(),
    };
    const channel = new SignalChannel(makeCtx(on()).ctx, { lock, fetch: refused });
    await channel.start();
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toMatch(/^channel-locked:/);
  });

  it("comes up when the event stream opens", async () => {
    const lock = { acquire: vi.fn(), release: vi.fn() };
    const fetch = vi.fn(
      async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const channel = new SignalChannel(makeCtx(on()).ctx, { lock, fetch });
    await channel.start();
    expect(channel.state()).toBe("up");
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("http://127.0.0.1:8080/api/v1/events");
    await channel.stop();
    expect(channel.state()).toBe("disabled");
  });
});
