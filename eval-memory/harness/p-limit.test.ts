import { describe, expect, it } from "vitest";

import { pLimit } from "./p-limit.js";

describe("pLimit", () => {
  it("rejects non-positive or non-integer concurrency", () => {
    expect(() => pLimit(0)).toThrow();
    expect(() => pLimit(-1)).toThrow();
    expect(() => pLimit(1.5)).toThrow();
  });

  it("respects the concurrency cap", async () => {
    const limit = pLimit(2);
    let activePeak = 0;
    let active = 0;

    const make = (ms: number) => async () => {
      active += 1;
      activePeak = Math.max(activePeak, active);
      await new Promise((r) => setTimeout(r, ms));
      active -= 1;
      return ms;
    };

    const results = await Promise.all([
      limit(make(20)),
      limit(make(20)),
      limit(make(20)),
      limit(make(20)),
      limit(make(20)),
    ]);

    expect(results).toEqual([20, 20, 20, 20, 20]);
    expect(activePeak).toBeLessThanOrEqual(2);
    expect(activePeak).toBeGreaterThan(0);
  });

  it("preserves FIFO scheduling order", async () => {
    const limit = pLimit(1);
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3].map((i) =>
        limit(async () => {
          order.push(i);
          await new Promise((r) => setTimeout(r, 5));
        }),
      ),
    );
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("a rejection on one task does not abort siblings", async () => {
    const limit = pLimit(2);
    const settled = await Promise.allSettled([
      limit(async () => {
        throw new Error("boom");
      }),
      limit(async () => "ok-1"),
      limit(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return "ok-2";
      }),
    ]);
    expect(settled[0]?.status).toBe("rejected");
    expect(settled[1]?.status).toBe("fulfilled");
    expect(settled[2]?.status).toBe("fulfilled");
  });

  it("exposes activeCount / pendingCount that bracket 0 over a run", async () => {
    const limit = pLimit(2);
    expect(limit.activeCount).toBe(0);
    expect(limit.pendingCount).toBe(0);

    // Sample from inside each task body — the limiter is guaranteed
    // to see ourselves as active here. Sampling via setInterval is
    // unreliable because tasks may finish between two interval fires.
    let peakActive = 0;
    let peakPending = 0;
    const make = () => async () => {
      peakActive = Math.max(peakActive, limit.activeCount);
      peakPending = Math.max(peakPending, limit.pendingCount);
      await new Promise((r) => setTimeout(r, 10));
    };
    await Promise.all([limit(make()), limit(make()), limit(make()), limit(make())]);

    expect(peakActive).toBeGreaterThan(0);
    expect(peakActive).toBeLessThanOrEqual(2);
    // With 4 tasks and concurrency=2, at least 2 are queued at start.
    expect(peakPending).toBeGreaterThanOrEqual(1);
    expect(limit.activeCount).toBe(0);
    expect(limit.pendingCount).toBe(0);
  });
});
