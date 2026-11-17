import { describe, expect, it, vi } from "vitest";

import { GoogleChatApiError, type PubsubReceivedMessage } from "./googlechat-api.js";
import { GoogleChatPullLoop } from "./googlechat-pull-loop.js";

const SUB = "projects/p1/subscriptions/chat-sub";

/** Scripted pulls; once they run out, a pull parks until the loop is stopped. */
function fakeApi(pulls: Array<PubsubReceivedMessage[] | Error>) {
  const acks: string[][] = [];
  const api = {
    pull: vi.fn(async (_sub: string, _max: number, signal: AbortSignal) => {
      const next = pulls.shift();
      if (next instanceof Error) throw next;
      if (next) return next;
      return new Promise<PubsubReceivedMessage[]>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }),
    acknowledge: vi.fn(async (_sub: string, ids: readonly string[]) => {
      acks.push([...ids]);
    }),
  };
  return { api, acks };
}

const logger = { info: vi.fn(), warn: vi.fn() };

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("GoogleChatPullLoop", () => {
  it("hands each batch over and then acks every message in it, even ignored ones", async () => {
    const { api, acks } = fakeApi([
      [
        { ackId: "a1", message: { data: "e30=" } },
        { ackId: "a2", message: { data: "not base64 json" } },
      ],
    ]);
    const order: string[] = [];
    const onBatch = vi.fn(() => {
      order.push("batch");
    });
    api.acknowledge.mockImplementation(async (_s: string, ids: readonly string[]) => {
      order.push("ack");
      acks.push([...ids]);
    });
    const onUp = vi.fn();
    const loop = new GoogleChatPullLoop({ api, subscription: SUB, logger, onUp, onBatch, onFatal: vi.fn() });
    loop.start();
    await settle();
    await loop.stop();
    expect(onUp).toHaveBeenCalledTimes(1);
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(acks).toEqual([["a1", "a2"]]);
    expect(order).toEqual(["batch", "ack"]);
  });

  it("still acks when the batch handler throws", async () => {
    const { api, acks } = fakeApi([[{ ackId: "a1" }]]);
    const loop = new GoogleChatPullLoop({
      api,
      subscription: SUB,
      logger,
      onUp: vi.fn(),
      onBatch: () => {
        throw new Error("boom");
      },
      onFatal: vi.fn(),
    });
    loop.start();
    await settle();
    await loop.stop();
    expect(acks).toEqual([["a1"]]);
  });

  it("does not ack or dispatch an empty pull", async () => {
    const { api, acks } = fakeApi([[]]);
    const onBatch = vi.fn();
    const loop = new GoogleChatPullLoop({ api, subscription: SUB, logger, onUp: vi.fn(), onBatch, onFatal: vi.fn() });
    loop.start();
    await settle();
    await loop.stop();
    expect(onBatch).not.toHaveBeenCalled();
    expect(acks).toEqual([]);
  });

  it("backs off and retries a transient failure", async () => {
    const { api, acks } = fakeApi([new GoogleChatApiError("HTTP 503", 503), [{ ackId: "a1" }]]);
    const wait = vi.fn(async () => undefined);
    const onFatal = vi.fn();
    const loop = new GoogleChatPullLoop({
      api,
      subscription: SUB,
      logger,
      onUp: vi.fn(),
      onBatch: vi.fn(),
      onFatal,
      backoff: () => 7,
      wait,
    });
    loop.start();
    await settle();
    await loop.stop();
    expect(wait).toHaveBeenCalledWith(7, expect.any(AbortSignal));
    expect(onFatal).not.toHaveBeenCalled();
    expect(acks).toEqual([["a1"]]);
  });

  it("ends on a fatal error with a reason that names the fix", async () => {
    const { api } = fakeApi([new GoogleChatApiError("HTTP 404", 404)]);
    const onFatal = vi.fn();
    const loop = new GoogleChatPullLoop({ api, subscription: SUB, logger, onUp: vi.fn(), onBatch: vi.fn(), onFatal });
    loop.start();
    await settle();
    expect(onFatal).toHaveBeenCalledWith(expect.stringContaining("subscription"));
    expect(api.pull).toHaveBeenCalledTimes(1);
    await loop.stop();
  });
});
