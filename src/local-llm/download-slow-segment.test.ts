import { afterEach, describe, expect, it, vi } from "vitest";

import { StalledError, classifyDownloadError } from "./download-errors.js";
import {
  SLOW_SEGMENT_CEILING_BPS,
  SlowSegmentError,
  judgeWindow,
  watchSegmentPace,
} from "./download-slow-segment.js";

describe("judgeWindow", () => {
  it("calls a connection slow when it runs far below the best one", () => {
    const pace = { peakBps: 0 };
    expect(judgeWindow(120_000, 1_000, pace)).toEqual({
      slow: false,
      bps: 120_000,
    });
    // ~400 B/s against 120 KB/s: the incident's throttled tail.
    expect(judgeWindow(400, 1_000, pace).slow).toBe(true);
    expect(pace.peakBps).toBe(120_000);
  });

  it("leaves a link that is slow everywhere alone", () => {
    const pace = { peakBps: 0 };
    for (const bytes of [900, 1_000, 800, 1_100, 700]) {
      expect(judgeWindow(bytes, 1_000, pace).slow).toBe(false);
    }
  });

  it("never judges a connection above the ceiling, however fast the peak", () => {
    const pace = { peakBps: 50 * 1024 * 1024 };
    expect(judgeWindow(SLOW_SEGMENT_CEILING_BPS, 1_000, pace).slow).toBe(false);
    expect(judgeWindow(SLOW_SEGMENT_CEILING_BPS - 1, 1_000, pace).slow).toBe(
      true,
    );
  });

  it("leaves a silent window to the stall watchdog", () => {
    const pace = { peakBps: 1_000_000 };
    expect(judgeWindow(0, 30_000, pace)).toEqual({ slow: false, bps: 0 });
  });

  it("measures a window against a peak it could have set itself", () => {
    // The first window of a download has nothing to compare with.
    expect(judgeWindow(10, 1_000, { peakBps: 0 }).slow).toBe(false);
  });
});

describe("watchSegmentPace", () => {
  afterEach(() => vi.useRealTimers());

  it("reports a slow window once and stops watching", () => {
    vi.useFakeTimers();
    let written = 0;
    const pace = { peakBps: 1_000_000 };
    const onSlow = vi.fn();
    watchSegmentPace(() => written, 1_000, pace, onSlow);
    written += 900_000;
    vi.advanceTimersByTime(1_000);
    expect(onSlow).not.toHaveBeenCalled();
    written += 100;
    vi.advanceTimersByTime(1_000);
    expect(onSlow).toHaveBeenCalledTimes(1);
    const error = onSlow.mock.calls[0]![0] as SlowSegmentError;
    expect(error).toBeInstanceOf(SlowSegmentError);
    expect(error.message).toMatch(/too slow: 100 B\/s against 976\.6 KB\/s/);
    // It had a healthy window first: the reconnect that opened it helped.
    expect(error.helped).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(onSlow).toHaveBeenCalledTimes(1);
  });

  it("says a connection that was slow from its first window did not help", () => {
    vi.useFakeTimers();
    let written = 0;
    const onSlow = vi.fn();
    watchSegmentPace(() => written, 1_000, { peakBps: 1_000_000 }, onSlow);
    // Silence is not judged and not healthy either.
    vi.advanceTimersByTime(1_000);
    written += 50;
    vi.advanceTimersByTime(1_000);
    expect(onSlow).toHaveBeenCalledTimes(1);
    expect((onSlow.mock.calls[0]![0] as SlowSegmentError).helped).toBe(false);
  });

  it("records the average rate of a connection that finishes before its first window", () => {
    vi.useFakeTimers();
    let written = 0;
    const pace = { peakBps: 0 };
    const stop = watchSegmentPace(() => written, 30_000, pace, vi.fn());
    written = 12_000_000;
    vi.advanceTimersByTime(2_000);
    stop();
    expect(pace.peakBps).toBe(6_000_000);
    // A throttled peer is then judged against it at its first window.
    let trickle = 0;
    const onSlow = vi.fn();
    watchSegmentPace(() => trickle, 30_000, pace, onSlow);
    trickle = 15_000;
    vi.advanceTimersByTime(30_000);
    expect(onSlow).toHaveBeenCalledTimes(1);
  });

  it("ignores a run too short to measure", () => {
    vi.useFakeTimers();
    let written = 0;
    const pace = { peakBps: 0 };
    const stop = watchSegmentPace(() => written, 30_000, pace, vi.fn());
    written = 1_000_000;
    vi.advanceTimersByTime(10);
    stop();
    expect(pace.peakBps).toBe(0);
  });

  it("stops when told to", () => {
    vi.useFakeTimers();
    const onSlow = vi.fn();
    const stop = watchSegmentPace(() => 0, 1_000, { peakBps: 1e6 }, onSlow);
    stop();
    vi.advanceTimersByTime(10_000);
    expect(onSlow).not.toHaveBeenCalled();
  });
});

describe("SlowSegmentError", () => {
  it("is a transport failure the segment retries in place", () => {
    const error = new SlowSegmentError(400, 120_000, false);
    expect(error).toBeInstanceOf(StalledError);
    expect(error.name).toBe("SlowSegmentError");
    expect(classifyDownloadError(error)).toBe("transport");
  });
});
