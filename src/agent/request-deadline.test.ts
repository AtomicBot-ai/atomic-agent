import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FINALIZATION_REQUEST_DEADLINE_MS,
  createRequestDeadline,
} from "./request-deadline.js";

describe("createRequestDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires when the budget elapses and says so", () => {
    const user = new AbortController();
    const deadline = createRequestDeadline(user.signal, 1_000);
    expect(deadline.signal.aborted).toBe(false);
    vi.advanceTimersByTime(999);
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.fired()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.fired()).toBe(true);
    deadline.dispose();
  });

  it("follows the user's abort without claiming the ceiling fired", () => {
    const user = new AbortController();
    const deadline = createRequestDeadline(user.signal, 60_000);
    user.abort();
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.fired()).toBe(false);
    // The timer must not rewrite the verdict afterwards.
    vi.advanceTimersByTime(60_000);
    expect(deadline.fired()).toBe(false);
    deadline.dispose();
  });

  it("is already aborted for an already-aborted user signal", () => {
    const user = new AbortController();
    user.abort();
    const deadline = createRequestDeadline(user.signal, 60_000);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.fired()).toBe(false);
    deadline.dispose();
  });

  it("dispose() clears the timer and detaches from the user's signal", () => {
    const user = new AbortController();
    const deadline = createRequestDeadline(user.signal, 1_000);
    deadline.dispose();
    vi.advanceTimersByTime(5_000);
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.fired()).toBe(false);
    user.abort();
    expect(deadline.signal.aborted).toBe(false);
  });

  it("treats a spent or non-finite budget as due now, never as forever", () => {
    for (const budget of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const deadline = createRequestDeadline(
        new AbortController().signal,
        budget,
      );
      vi.advanceTimersByTime(0);
      expect(deadline.fired(), `budget ${budget}`).toBe(true);
      deadline.dispose();
    }
  });

  it("gives the summary step five minutes", () => {
    expect(FINALIZATION_REQUEST_DEADLINE_MS).toBe(5 * 60_000);
  });
});
