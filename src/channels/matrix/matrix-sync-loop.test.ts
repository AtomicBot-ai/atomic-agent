import { describe, expect, it, vi } from "vitest";

import { MatrixApiError, type MatrixSyncResponse } from "./matrix-api.js";
import { MatrixSyncLoop } from "./matrix-sync-loop.js";

type Step = MatrixSyncResponse | Error;

/** A fake `sync` that replays `steps`, then parks until aborted. */
function fakeApi(steps: Step[]) {
  const calls: Array<{ since: string | null; timeoutMs: number }> = [];
  const sync = vi.fn(async (since: string | null, timeoutMs: number, signal?: AbortSignal) => {
    calls.push({ since, timeoutMs });
    const next = steps.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    return new Promise<MatrixSyncResponse>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new MatrixApiError("aborted", 0)));
    });
  });
  return { api: { sync }, calls };
}

function memoryStore(initial: string | null = null) {
  let value = initial;
  return {
    load: vi.fn(() => value),
    save: vi.fn((_user: string, next: string) => {
      value = next;
    }),
    get: () => value,
  };
}

const logger = { info: vi.fn(), warn: vi.fn() };

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("MatrixSyncLoop", () => {
  it("does an initial sync with timeout 0 and flags it, then long-polls from next_batch", async () => {
    const { api, calls } = fakeApi([{ next_batch: "s1" }, { next_batch: "s2" }]);
    const store = memoryStore();
    const batches: Array<{ next: string; initial: boolean }> = [];
    const onUp = vi.fn();
    const loop = new MatrixSyncLoop({
      api,
      store,
      userId: "@bot:x",
      logger,
      onUp,
      onBatch: (b, info) => {
        batches.push({ next: b.next_batch, initial: info.initial });
      },
      onFatal: vi.fn(),
      timeoutMs: 30_000,
    });
    loop.start();
    await settle();
    expect(calls[0]).toEqual({ since: null, timeoutMs: 0 });
    expect(calls[1]).toEqual({ since: "s1", timeoutMs: 30_000 });
    expect(batches).toEqual([
      { next: "s1", initial: true },
      { next: "s2", initial: false },
    ]);
    expect(onUp).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe("s2");
    await loop.stop();
  });

  it("resumes from the stored position without an initial sync", async () => {
    const { api, calls } = fakeApi([{ next_batch: "s9" }]);
    const store = memoryStore("s8");
    const onBatch = vi.fn();
    const loop = new MatrixSyncLoop({
      api,
      store,
      userId: "@bot:x",
      logger,
      onUp: vi.fn(),
      onBatch,
      onFatal: vi.fn(),
    });
    loop.start();
    await settle();
    expect(calls[0]?.since).toBe("s8");
    expect(onBatch).toHaveBeenCalledWith({ next_batch: "s9" }, { initial: false });
    await loop.stop();
  });

  it("backs off and retries a transient failure", async () => {
    const { api, calls } = fakeApi([new MatrixApiError("HTTP 502", 502), { next_batch: "s1" }]);
    const wait = vi.fn(async () => undefined);
    const loop = new MatrixSyncLoop({
      api,
      store: memoryStore("s0"),
      userId: "@bot:x",
      logger,
      onUp: vi.fn(),
      onBatch: vi.fn(),
      onFatal: vi.fn(),
      backoff: () => 1234,
      wait,
    });
    loop.start();
    await settle();
    expect(wait).toHaveBeenCalledWith(1234, expect.any(AbortSignal));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    await loop.stop();
  });

  it("stops for good on a rejected token", async () => {
    const { api, calls } = fakeApi([new MatrixApiError("401", 401, "M_UNKNOWN_TOKEN")]);
    const onFatal = vi.fn();
    const loop = new MatrixSyncLoop({
      api,
      store: memoryStore("s0"),
      userId: "@bot:x",
      logger,
      onUp: vi.fn(),
      onBatch: vi.fn(),
      onFatal,
    });
    loop.start();
    await settle();
    expect(onFatal).toHaveBeenCalledWith(expect.stringMatching(/access token/));
    expect(calls).toHaveLength(1);
    await loop.stop();
  });

  it("starts fresh when the stored position is unknown to the server", async () => {
    const { api, calls } = fakeApi([
      new MatrixApiError("unknown pos", 400, "M_UNKNOWN_POS"),
      { next_batch: "s1" },
    ]);
    const onBatch = vi.fn();
    const loop = new MatrixSyncLoop({
      api,
      store: memoryStore("old"),
      userId: "@bot:x",
      logger,
      onUp: vi.fn(),
      onBatch,
      onFatal: vi.fn(),
    });
    loop.start();
    await settle();
    expect(calls[1]?.since).toBeNull();
    expect(onBatch).toHaveBeenCalledWith({ next_batch: "s1" }, { initial: true });
    await loop.stop();
  });

  it("stop() aborts the parked poll and is idempotent", async () => {
    const { api } = fakeApi([]);
    const loop = new MatrixSyncLoop({
      api,
      store: memoryStore("s0"),
      userId: "@bot:x",
      logger,
      onUp: vi.fn(),
      onBatch: vi.fn(),
      onFatal: vi.fn(),
    });
    loop.start();
    await settle();
    await loop.stop();
    await loop.stop();
    expect(api.sync).toHaveBeenCalledTimes(1);
  });
});
