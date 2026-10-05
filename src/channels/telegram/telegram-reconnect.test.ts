import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONFLICT_JITTER_MS,
  CONFLICT_RETRY_MS,
  RECONNECT_STABLE_UP_MS,
  TelegramReconnect,
  classifyTelegramFailure,
  formatGivingUpError,
  formatLockWaitError,
  formatReconnectingError,
} from "./telegram-reconnect.js";

/** grammy's `GrammyError` as the channel sees it: Telegram answered no. */
function botApiError(code: number, description: string): Error {
  return Object.assign(
    new Error(`Call to 'getUpdates' failed! (${code}: ${description})`),
    { name: "GrammyError", error_code: code, description },
  );
}

describe("classifyTelegramFailure", () => {
  it.each([
    [401, "Unauthorized"],
    [404, "Not Found"],
  ])("gives up on a %i: the token itself was rejected", (code, description) => {
    expect(classifyTelegramFailure(botApiError(code, description))).toBe(
      "fatal",
    );
  });

  it("waits out a 409 instead of giving up: another poller may go away", () => {
    expect(
      classifyTelegramFailure(
        botApiError(409, "Conflict: terminated by other getUpdates request"),
      ),
    ).toBe("conflict");
  });

  it.each([
    [429, "Too Many Requests: retry after 5"],
    [500, "Internal Server Error"],
    [502, "Bad Gateway"],
  ])("retries a %i", (code, description) => {
    expect(classifyTelegramFailure(botApiError(code, description))).toBe(
      "transient",
    );
  });

  it.each(["ECONNRESET", "ETIMEDOUT", "ENOTFOUND"])(
    "retries a network failure (%s), which carries no Bot API code",
    (code) => {
      const httpError = Object.assign(
        new Error("Network request for 'getUpdates' failed!"),
        { name: "HttpError", error: Object.assign(new Error(code), { code }) },
      );
      expect(classifyTelegramFailure(httpError)).toBe("transient");
    },
  );

  it("classifies by shape, not by prose that merely mentions a code", () => {
    expect(classifyTelegramFailure(new Error("409: Conflict"))).toBe(
      "transient",
    );
    expect(classifyTelegramFailure({ error_code: "401" })).toBe("transient");
    expect(classifyTelegramFailure("401")).toBe("transient");
    expect(classifyTelegramFailure(undefined)).toBe("transient");
  });
});

describe("lastError wording", () => {
  it("keeps the lock wait constant, so its retries emit no fresh status", () => {
    expect(formatLockWaitError("channel-locked: already running (pid 7)")).toBe(
      "channel-locked: already running (pid 7) — will start here once it stops",
    );
  });

  it("says why it gave up and what ends it", () => {
    expect(formatGivingUpError("(401: Unauthorized)")).toBe(
      "(401: Unauthorized) — Telegram rejected the bot token; not retrying until it is replaced",
    );
  });
});

describe("formatReconnectingError", () => {
  it("names the cause, the wait in whole seconds rounded up, and the attempt", () => {
    expect(
      formatReconnectingError("polling stopped: boom", {
        attempt: 2,
        delayMs: 2_001,
        kind: "transient",
        firstOfKind: false,
      }),
    ).toBe("polling stopped: boom — reconnecting in 3s (attempt 2)");
    expect(
      formatReconnectingError("x", {
        attempt: 1,
        delayMs: 500,
        kind: "transient",
        firstOfKind: true,
      }),
    ).toBe("x — reconnecting in 1s (attempt 1)");
  });
});

describe("TelegramReconnect", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("walks the shared backoff schedule while the outage lasts", () => {
    vi.useFakeTimers();
    const reconnect = new TelegramReconnect({ random: () => 1 });
    const armed = [1, 2, 3, 4].map(() => reconnect.schedule(() => undefined));
    expect(armed).toEqual([
      { attempt: 1, delayMs: 2_500, kind: "transient", firstOfKind: true },
      { attempt: 2, delayMs: 4_500, kind: "transient", firstOfKind: false },
      { attempt: 3, delayMs: 8_500, kind: "transient", firstOfKind: false },
      { attempt: 4, delayMs: 16_500, kind: "transient", firstOfKind: false },
    ]);
    reconnect.cancel();
  });

  it("keeps retrying for ever, capped at a minute between attempts", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const reconnect = new TelegramReconnect({ random: () => 1 });
    for (let i = 0; i < 200; i += 1) reconnect.schedule(run);
    expect(reconnect.currentAttempt()).toBe(200);
    expect(reconnect.schedule(run).delayMs).toBe(60_500);
    reconnect.cancel();
  });

  it("steps back for the conflict wait whatever the rung, with jitter", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const low = new TelegramReconnect({ random: () => 0 });
    expect(low.schedule(run, "conflict")).toEqual({
      attempt: 1,
      delayMs: CONFLICT_RETRY_MS,
      kind: "conflict",
      firstOfKind: true,
    });
    low.cancel();

    const high = new TelegramReconnect({ random: () => 0.999 });
    high.schedule(run);
    high.schedule(run);
    const conflict = high.schedule(run, "conflict");
    expect(conflict.attempt).toBe(3);
    expect(conflict.delayMs).toBeGreaterThanOrEqual(CONFLICT_RETRY_MS);
    expect(conflict.delayMs).toBeLessThan(
      CONFLICT_RETRY_MS + CONFLICT_JITTER_MS,
    );
    vi.advanceTimersByTime(conflict.delayMs - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    high.cancel();
  });

  it("flags only the first retry of each cause, so a long wait is reported once", () => {
    vi.useFakeTimers();
    const reconnect = new TelegramReconnect({ random: () => 0 });
    const kinds = [
      "locked",
      "locked",
      "transient",
      "transient",
      "conflict",
      "conflict",
    ] as const;
    const flags = kinds.map(
      (kind) => reconnect.schedule(() => undefined, kind).firstOfKind,
    );
    expect(flags).toEqual([true, false, true, false, true, false]);
    // A new outage reports again.
    reconnect.cancel();
    expect(reconnect.schedule(() => undefined, "conflict").firstOfKind).toBe(
      true,
    );
    reconnect.cancel();
  });

  it("runs once after the delay, with never more than one timer armed", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const reconnect = new TelegramReconnect({ random: () => 0 });
    reconnect.schedule(run);
    reconnect.schedule(run);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(499);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(reconnect.pending()).toBe(false);
    expect(reconnect.inOutage()).toBe(true);
    vi.advanceTimersByTime(10 * 60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancel() disarms the timer and ends the outage", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const reconnect = new TelegramReconnect({ random: () => 1 });
    reconnect.schedule(run);
    reconnect.schedule(run);
    reconnect.cancel();
    vi.advanceTimersByTime(10 * 60_000);
    expect(run).not.toHaveBeenCalled();
    expect(reconnect.pending()).toBe(false);
    expect(reconnect.inOutage()).toBe(false);
    expect(reconnect.schedule(run).attempt).toBe(1);
    reconnect.cancel();
  });

  it("clearTimer() disarms the timer but keeps climbing the same outage", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const reconnect = new TelegramReconnect({ random: () => 1 });
    reconnect.schedule(run);
    reconnect.clearTimer();
    vi.advanceTimersByTime(10 * 60_000);
    expect(run).not.toHaveBeenCalled();
    expect(reconnect.inOutage()).toBe(true);
    expect(reconnect.schedule(run).attempt).toBe(2);
    reconnect.cancel();
  });

  it("starts over only once the channel stayed up for a full long-poll round", () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    const reconnect = new TelegramReconnect({
      random: () => 1,
      now: () => now,
    });
    reconnect.schedule(() => undefined);
    reconnect.markUp();
    now += RECONNECT_STABLE_UP_MS - 1;
    // Died just short of the window: still the same outage.
    expect(reconnect.schedule(() => undefined).attempt).toBe(2);
    reconnect.markUp();
    now += RECONNECT_STABLE_UP_MS;
    expect(reconnect.schedule(() => undefined)).toMatchObject({
      attempt: 1,
      delayMs: 2_500,
      firstOfKind: true,
    });
    // A retry that never reached `up` does not open the window.
    now += 10 * RECONNECT_STABLE_UP_MS;
    expect(reconnect.schedule(() => undefined).attempt).toBe(2);
    reconnect.cancel();
  });

  it("never holds the process open while a retry waits", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const reconnect = new TelegramReconnect();
    reconnect.schedule(() => undefined);
    const timer = setTimeoutSpy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    reconnect.cancel();
  });
});
