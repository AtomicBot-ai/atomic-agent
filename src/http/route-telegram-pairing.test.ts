import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OwnerAlreadyPairedError,
  type PairingOutcome,
  type StartPairingOptions,
} from "../channels/telegram/index.js";
import type { LogRecord } from "../tracing/structured-logger.js";

import { startTestHarness, type Harness } from "./test-harness.js";

const CODE = "482913";

interface StubControl {
  calls: StartPairingOptions[];
  resolve(outcome: PairingOutcome | null): void;
  reject(err: unknown): void;
  setOwner(owner: number | null): void;
}

/**
 * Put the harness's real channel object into a paired-or-not, `up`
 * state with a controllable `startPairing`. The route only talks to the
 * channel's public surface, so this is the seam: no bot, no network.
 */
function stubChannel(
  harness: Harness,
  opts: { owner?: number | null; state?: "up" | "down" } = {},
): StubControl {
  const channel = harness.runtime.telegramChannel!;
  let owner = opts.owner ?? null;
  let active = false;
  let expiresAt: number | null = null;
  let settle: ((v: PairingOutcome | null) => void) | null = null;
  let fail: ((err: unknown) => void) | null = null;
  const calls: StartPairingOptions[] = [];
  vi.spyOn(channel, "state").mockImplementation(() => opts.state ?? "up");
  vi.spyOn(channel, "lastError").mockReturnValue(null);
  vi.spyOn(channel, "getOwnerUserId").mockImplementation(() => owner);
  vi.spyOn(channel, "getBotIdentity").mockReturnValue({
    id: 1,
    username: "atomic_test_bot",
  });
  vi.spyOn(channel, "pairingState").mockImplementation(() => ({
    active,
    expiresAt,
  }));
  vi.spyOn(channel, "cancelPairing").mockImplementation(() => {
    if (!active) return;
    active = false;
    expiresAt = null;
    settle?.(null);
  });
  vi.spyOn(channel, "startPairing").mockImplementation(
    (_timeout?: number, options: StartPairingOptions = {}) => {
      calls.push(options);
      if (owner !== null && options.replaceOwner !== true) {
        return Promise.reject(new OwnerAlreadyPairedError());
      }
      if (active) settle?.(null);
      active = true;
      expiresAt = Date.now() + 300_000;
      options.onOpened?.({ code: CODE, expiresAt });
      return new Promise<PairingOutcome | null>((resolve, reject) => {
        settle = (v) => {
          active = false;
          expiresAt = null;
          resolve(v);
        };
        fail = (err) => {
          active = false;
          reject(err);
        };
      });
    },
  );
  return {
    calls,
    resolve: (outcome) => settle?.(outcome),
    reject: (err) => fail?.(err),
    setOwner: (next) => {
      owner = next;
    },
  };
}

function req(
  harness: Harness,
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
  token?: string,
) {
  return fetch(`${harness.baseUrl}/api/telegram/pairing`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function status(harness: Harness): Promise<Record<string, unknown>> {
  const res = await req(harness, "GET");
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** Let the route's `.then` on the pairing outcome run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("/api/telegram/pairing", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness?.cleanup();
    harness = null;
  });

  it("POST opens a window and answers with the code; GET never shows it and reports the claim", async () => {
    const logs: LogRecord[] = [];
    harness = await startTestHarness({ logSinks: [(r) => logs.push(r)] });
    const stub = stubChannel(harness);

    const res = await req(harness, "POST");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const opened = (await res.json()) as Record<string, unknown>;
    expect(opened.status).toBe("waiting");
    expect(opened.code).toBe(CODE);
    expect(opened.botUsername).toBe("atomic_test_bot");
    expect(opened.timeoutMs).toBe(5 * 60_000);
    expect(opened.instruction).toBe(
      `Send /start ${CODE} to @atomic_test_bot in Telegram within 5 minutes. The code works once; other messages are ignored.`,
    );
    expect(stub.calls[0]?.replaceOwner).toBe(false);

    const waiting = await status(harness);
    expect(waiting.status).toBe("waiting");
    expect(typeof waiting.expiresAt).toBe("number");
    expect(JSON.stringify(waiting)).not.toContain(CODE);

    stub.resolve({
      claim: { userId: 777, chatId: 777, username: "new_owner" },
      welcomeDelivered: true,
    });
    await flush();
    const claimed = await status(harness);
    expect(claimed.status).toBe("claimed");
    expect(claimed.owner).toEqual({ userId: 777, username: "new_owner" });
    expect(claimed.pairedLine).toBe("Paired: @new_owner is now the owner.");
    expect(claimed.welcomeDelivered).toBe(true);
    expect(claimed.expiresAt).toBeNull();

    // The code never reached a log line.
    expect(JSON.stringify(logs)).not.toContain(CODE);
  });

  it("refuses to replace a paired owner until the caller confirms with replaceOwner", async () => {
    harness = await startTestHarness();
    const stub = stubChannel(harness, { owner: 42 });

    const refused = await req(harness, "POST");
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: { code: string } };
    expect(body.error.code).toBe("owner_already_paired");
    expect(JSON.stringify(body)).not.toContain(CODE);
    expect(stub.calls).toHaveLength(0);

    const confirmed = await req(harness, "POST", { replaceOwner: true });
    expect(confirmed.status).toBe(200);
    expect(((await confirmed.json()) as { code: string }).code).toBe(CODE);
    expect(stub.calls[0]?.replaceOwner).toBe(true);
  });

  it("maps an owner that appears between the check and the call to 409", async () => {
    harness = await startTestHarness();
    const stub = stubChannel(harness);
    const channel = harness.runtime.telegramChannel!;
    // A window is already open when the refused POST arrives.
    expect((await req(harness, "POST")).status).toBe(200);
    // getOwnerUserId answers null for the route's own check, then the
    // channel itself refuses: the race the channel's error covers.
    vi.spyOn(channel, "getOwnerUserId").mockReturnValueOnce(null);
    stub.setOwner(42);
    const res = await req(harness, "POST");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "owner_already_paired",
    );
    // The refusal did not orphan the open window: its claim still lands.
    stub.resolve({
      claim: { userId: 9, chatId: 9, username: null },
      welcomeDelivered: false,
    });
    await flush();
    const after = await status(harness);
    expect(after.status).toBe("claimed");
    expect(after.pairedLine).toBe(
      "Paired: Telegram user 9 (no @username) is now the owner.",
    );
  });

  it("answers 409 telegram_not_running while the channel is not up", async () => {
    harness = await startTestHarness();
    const stub = stubChannel(harness, { state: "down" });
    const res = await req(harness, "POST");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("telegram_not_running");
    expect(body.error.message).toContain("state: down");
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects a non-boolean replaceOwner", async () => {
    harness = await startTestHarness();
    stubChannel(harness, { owner: 42 });
    const res = await req(harness, "POST", { replaceOwner: "yes" });
    expect(res.status).toBe(400);
  });

  it("DELETE cancels the window and the GET says cancelled, not expired", async () => {
    harness = await startTestHarness();
    stubChannel(harness);
    expect((await req(harness, "POST")).status).toBe(200);
    const res = await req(harness, "DELETE");
    expect(res.status).toBe(200);
    await flush();
    expect((await status(harness)).status).toBe("cancelled");
  });

  it("a window that runs out reads as expired", async () => {
    harness = await startTestHarness();
    const stub = stubChannel(harness);
    expect((await req(harness, "POST")).status).toBe(200);
    stub.resolve(null);
    await flush();
    const after = await status(harness);
    expect(after.status).toBe("expired");
    expect(after.owner).toBeNull();
  });

  it("a superseded window's late outcome does not overwrite the new one", async () => {
    harness = await startTestHarness();
    stubChannel(harness);
    expect((await req(harness, "POST")).status).toBe(200);
    // The second POST cancels the first window inside the channel; its
    // null outcome must not turn the new window into `expired`.
    expect((await req(harness, "POST")).status).toBe(200);
    await flush();
    expect((await status(harness)).status).toBe("waiting");
  });

  it("a claim that fails to persist reads as failed with the reason", async () => {
    harness = await startTestHarness();
    const stub = stubChannel(harness);
    expect((await req(harness, "POST")).status).toBe(200);
    stub.reject(new Error("could not write config"));
    await flush();
    const after = await status(harness);
    expect(after.status).toBe("failed");
    expect(after.error).toBe("could not write config");
  });

  it("GET is idle before any window", async () => {
    harness = await startTestHarness();
    stubChannel(harness);
    const idle = await status(harness);
    expect(idle).toMatchObject({
      status: "idle",
      channelState: "up",
      botUsername: "atomic_test_bot",
      ownerUserId: null,
      owner: null,
      pairedLine: null,
    });
  });

  it("requires the bearer token like the other /api routes", async () => {
    harness = await startTestHarness({ apiKey: "secret" });
    stubChannel(harness);
    expect((await req(harness, "POST")).status).toBe(401);
    expect((await req(harness, "GET")).status).toBe(401);
    expect((await req(harness, "DELETE")).status).toBe(401);
    expect((await req(harness, "GET", undefined, "secret")).status).toBe(200);
  });
});
