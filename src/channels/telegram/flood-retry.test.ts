import { describe, expect, it } from "vitest";

import { callWithFloodRetry, floodWaitSeconds } from "./flood-retry.js";

const flood = (retryAfter?: unknown) => ({
  error_code: 429,
  ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }),
  message: "Too Many Requests",
});

describe("floodWaitSeconds", () => {
  it("reads retry_after from a 429 and ignores other errors", () => {
    expect(floodWaitSeconds(flood(3))).toBe(3);
    expect(floodWaitSeconds({ error_code: 400 })).toBeNull();
    expect(floodWaitSeconds(new Error("boom"))).toBeNull();
    expect(floodWaitSeconds(null)).toBeNull();
  });

  it("backs off one second when the 429 has no usable retry_after", () => {
    expect(floodWaitSeconds(flood())).toBe(1);
    expect(floodWaitSeconds(flood(-2))).toBe(1);
    expect(floodWaitSeconds(flood("soon"))).toBe(1);
  });
});

describe("callWithFloodRetry", () => {
  it("waits retry_after on every 429 and retries until the call succeeds", async () => {
    const answers: unknown[] = [flood(2), flood(5), flood(1)];
    const slept: number[] = [];
    let calls = 0;
    const result = await callWithFloodRetry(
      async () => {
        calls += 1;
        const next = answers.shift();
        if (next) throw next;
        return "ok";
      },
      { sleep: async (ms) => void slept.push(ms) },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(4);
    expect(slept).toEqual([2000, 5000, 1000]);
  });

  it("throws a non-429 error at once, without waiting", async () => {
    const slept: number[] = [];
    await expect(
      callWithFloodRetry(
        async () => {
          throw new Error("bad request");
        },
        { sleep: async (ms) => void slept.push(ms) },
      ),
    ).rejects.toThrow("bad request");
    expect(slept).toEqual([]);
  });

  it("gives up with the 429 once the waits would pass the budget", async () => {
    const slept: number[] = [];
    await expect(
      callWithFloodRetry(
        async () => {
          throw flood(4);
        },
        { sleep: async (ms) => void slept.push(ms), budgetMs: 10_000 },
      ),
    ).rejects.toMatchObject({ error_code: 429 });
    expect(slept).toEqual([4000, 4000]);
  });
});
