import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RECONNECT_STABLE_UP_MS,
  TelegramReconnect,
  formatReconnectingError,
  isFatalTelegramError,
} from "./telegram-reconnect.js";

/** grammy's `GrammyError` as the channel sees it: Telegram answered no. */
function botApiError(code: number, description: string): Error {
  return Object.assign(
    new Error(`Call to 'getUpdates' failed! (${code}: ${description})`),
    { name: "GrammyError", error_code: code, description },
  );
}

describe("isFatalTelegramError", () => {
  it.each([
    [401, "Unauthorized"],
    [404, "Not Found"],
    [409, "Conflict: terminated by other getUpdates request"],
  ])("gives up on a %i", (code, description) => {
    expect(isFatalTelegramError(botApiError(code, description))).toBe(true);
  });

  it.each([
    [429, "Too Many Requests: retry after 5"],
    [500, "Internal Server Error"],
    [502, "Bad Gateway"],
  ])("retries a %i", (code, description) => {
    expect(isFatalTelegramError(botApiError(code, description))).toBe(false);
  });

  it("retries a network failure, which carries no Bot API code", () => {
    const httpError = Object.assign(
      new Error("Network request for 'getUpdates' failed!"),
      { name: "HttpError", error: new Error("ECONNRESET") },
    );
    expect(isFatalTelegramError(httpError)).toBe(false);
  });

  it("classifies by shape, not by prose that merely mentions a code", () => {
    expect(isFatalTelegramError(new Error("409: Conflict"))).toBe(false);
    expect(isFatalTelegramError({ error_code: "401" })).toBe(false);
    expect(isFatalTelegramError("401")).toBe(false);
    expect(isFatalTelegramError(undefined)).toBe(false);
  });
});

describe("formatReconnectingError", () => {
  it("names the cause, the wait in whole seconds rounded up, and the attempt", () => {
    expect(
      formatReconnectingError("polling stopped: boom", {
        attempt: 2,
        delayMs: 2_001,
      }),
    ).toBe("polling stopped: boom — reconnecting in 3s (attempt 2)");
    expect(formatReconnectingError("x", { attempt: 1, delayMs: 500 })).toBe(
      "x — reconnecting in 1s (attempt 1)",
    );
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
      { attempt: 1, delayMs: 2_500 },
      { attempt: 2, delayMs: 4_500 },
      { attempt: 3, delayMs: 8_500 },
      { attempt: 4, delayMs: 16_500 },
    ]);
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
    expect(reconnect.schedule(() => undefined)).toEqual({
      attempt: 1,
      delayMs: 2_500,
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
