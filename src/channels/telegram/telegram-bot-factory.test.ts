import { afterEach, describe, expect, it, vi } from "vitest";

import type { InboundTextUpdate } from "./inbound-handler.js";
import type { BotFactoryHooks } from "./telegram-channel-types.js";

/** A grammy API transformer, as the mock records it. */
type RecordedTransformer = (
  prev: Prev,
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

type Prev = (
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

/**
 * grammy is loaded lazily inside the factory, so the mock has to be
 * hoisted ahead of the module graph. The fake `Bot` records the
 * `message:text` handler so a test can feed it a synthetic context.
 */
const { instances, MockBot } = vi.hoisted(() => {
  const instances: Array<{
    handlers: Map<string, (ctx: unknown) => unknown>;
    errorHandler?: (err: unknown) => void;
    transformers: unknown[];
    stopCalls: number;
  }> = [];
  class MockBot {
    transformers: unknown[] = [];
    stopCalls = 0;
    api = {
      config: {
        use: (...transformers: unknown[]) => {
          this.transformers.push(...transformers);
        },
      },
    };
    handlers = new Map<string, (ctx: unknown) => unknown>();
    errorHandler: ((err: unknown) => void) | undefined;
    constructor(public token: string) {
      instances.push(this);
    }
    on(event: string, cb: (ctx: unknown) => unknown): void {
      this.handlers.set(event, cb);
    }
    catch(cb: (err: unknown) => void): void {
      this.errorHandler = cb;
    }
    start(): Promise<never> {
      return new Promise(() => undefined);
    }
    async stop(): Promise<void> {
      this.stopCalls += 1;
    }
  }
  return { instances, MockBot };
});

vi.mock("grammy", () => ({ Bot: MockBot }));

import {
  GET_UPDATES_GRACE_MS,
  defaultGrammyBotFactory,
} from "./telegram-bot-factory.js";

async function projectedUpdate(
  message: Record<string, unknown>,
): Promise<InboundTextUpdate> {
  const bot = await defaultGrammyBotFactory("123:token");
  const received: InboundTextUpdate[] = [];
  bot.setTextHandler((u) => {
    received.push(u);
  });
  const onText = instances.at(-1)!.handlers.get("message:text")!;
  onText({ from: { id: 42 }, message });
  // The adapter dispatches fire-and-forget; let the microtask settle.
  await new Promise((r) => setTimeout(r, 0));
  expect(received).toHaveLength(1);
  return received[0]!;
}

describe("defaultGrammyBotFactory error routing", () => {
  it("routes grammy's own failures to the caller instead of console.error", async () => {
    // Ink owns the console in the TUI, so a poll loop that keeps failing
    // looks like a healthy channel that never receives anything.
    const errors: Error[] = [];
    await defaultGrammyBotFactory("123:token", {
      onError: (e) => errors.push(e),
    });
    const bot = instances.at(-1)!;
    expect(bot.errorHandler).toBeDefined();
    bot.errorHandler!(new Error("Call to 'getUpdates' failed!"));
    expect(errors.map((e) => e.message)).toEqual([
      "Call to 'getUpdates' failed!",
    ]);
    // A non-Error rejection still arrives as one.
    bot.errorHandler!("socket hang up");
    expect(errors.at(-1)).toBeInstanceOf(Error);
    expect(errors.at(-1)?.message).toBe("socket hang up");
  });
});

describe("defaultGrammyBotFactory update projection", () => {
  it("projects a private DM exactly as before", async () => {
    const update = await projectedUpdate({
      chat: { id: 42, type: "private", first_name: "V" },
      text: "hi",
      message_id: 7,
    });
    expect(update).toEqual({
      from: { id: 42 },
      chat: { id: 42, type: "private" },
      text: "hi",
      message_id: 7,
    });
  });

  it("carries title, topic id, topic flag and the replied-to author for a group message", async () => {
    const update = await projectedUpdate({
      chat: { id: -1001, type: "supergroup", title: "Ops" },
      text: "@bot hi",
      message_id: 8,
      message_thread_id: 77,
      is_topic_message: true,
      reply_to_message: { from: { id: 7, is_bot: true }, message_id: 3 },
    });
    expect(update).toEqual({
      from: { id: 42 },
      chat: { id: -1001, type: "supergroup", title: "Ops" },
      text: "@bot hi",
      message_id: 8,
      message_thread_id: 77,
      is_topic_message: true,
      reply_to_message: { from: { id: 7, is_bot: true } },
    });
  });

  it("does not invent a topic flag for a plain reply in a non-forum group", async () => {
    const update = await projectedUpdate({
      chat: { id: -1001, type: "group", title: "Ops" },
      text: "hi",
      message_id: 9,
      message_thread_id: 12,
      reply_to_message: { from: { id: 555 }, message_id: 12 },
    });
    expect(update.message_thread_id).toBe(12);
    expect(update.is_topic_message).toBeUndefined();
    expect(update.reply_to_message).toEqual({ from: { id: 555 } });
  });
});

describe("defaultGrammyBotFactory poll health", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Build a bot and hand back the transformer it installed on its API. */
  async function pollTransformer(hooks: BotFactoryHooks = {}): Promise<{
    call: (
      prev: Prev,
      method: string,
      payload: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<unknown>;
    abandon: () => void;
    stopCalls: () => number;
  }> {
    const bot = await defaultGrammyBotFactory("123:token", hooks);
    const mock = instances.at(-1)!;
    expect(mock.transformers).toHaveLength(1);
    const transformer = mock.transformers[0] as RecordedTransformer;
    return {
      call: (prev, method, payload, signal) =>
        transformer(prev, method, payload, signal),
      abandon: () => bot.abandon?.(),
      stopCalls: () => mock.stopCalls,
    };
  }

  /** A `getUpdates` that never answers until its signal aborts. */
  const hangs: Prev = (_method, _payload, signal) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () =>
        reject(new Error("Network request for 'getUpdates' failed!")),
      );
    });

  it("passes every other method through untouched", async () => {
    const onPollFailed = vi.fn();
    const { call } = await pollTransformer({
      onPollFailed,
      resumeAfterUpdateId: () => 99,
    });
    const prev = vi.fn<Prev>(async () => ({
      ok: true,
      result: { message_id: 1 },
    }));
    const payload = { chat_id: 1, text: "hi" };
    const signal = new AbortController().signal;

    await call(prev, "sendMessage", payload, signal);

    expect(prev).toHaveBeenCalledWith("sendMessage", payload, signal);
  });

  it("reports an answered poll with the highest update id in the batch", async () => {
    const onPollAnswered = vi.fn();
    const { call } = await pollTransformer({ onPollAnswered });

    await call(
      async () => ({
        ok: true,
        result: [{ update_id: 5 }, { update_id: 9 }, { update_id: 7 }],
      }),
      "getUpdates",
      { offset: 1, timeout: 30 },
    );
    await call(async () => ({ ok: true, result: [] }), "getUpdates", {
      timeout: 30,
    });

    expect(onPollAnswered.mock.calls).toEqual([[9], [null]]);
  });

  it("counts a 5xx as a failed poll, and a 429 as Telegram answering", async () => {
    const onPollAnswered = vi.fn();
    const onPollFailed = vi.fn();
    const { call } = await pollTransformer({ onPollAnswered, onPollFailed });

    await call(
      async () => ({ ok: false, error_code: 502, description: "Bad Gateway" }),
      "getUpdates",
      { timeout: 30 },
    );
    await call(
      async () => ({
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 5",
        parameters: { retry_after: 5 },
      }),
      "getUpdates",
      { timeout: 30 },
    );

    expect(onPollFailed).toHaveBeenCalledTimes(1);
    expect(onPollFailed.mock.calls[0]![0].message).toBe(
      "getUpdates failed (502: Bad Gateway)",
    );
    expect(onPollAnswered.mock.calls).toEqual([[null]]);
  });

  it("gives a poll on a dead connection a deadline instead of grammy's 500 s", async () => {
    // setImmediate stays real so the rejection can be drained below.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const drain = (): Promise<void> =>
      new Promise((resolve) => setImmediate(resolve));
    const onPollFailed = vi.fn();
    const { call } = await pollTransformer({ onPollFailed });
    let settled: unknown = "pending";
    void call(hangs, "getUpdates", { offset: 1, timeout: 30 }).catch(
      (err: unknown) => {
        settled = err;
      },
    );

    vi.advanceTimersByTime(30_000 + GET_UPDATES_GRACE_MS - 1);
    await drain();
    expect(settled).toBe("pending");
    vi.advanceTimersByTime(1);
    await drain();

    // grammy sees its usual network failure and retries on its own.
    expect((settled as Error).message).toBe(
      "Network request for 'getUpdates' failed!",
    );
    expect(onPollFailed).toHaveBeenCalledTimes(1);
    expect(onPollFailed.mock.calls[0]![0].message).toBe(
      "getUpdates got no answer within 45s",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a failed request, but not the abort of a deliberate stop", async () => {
    const onPollFailed = vi.fn();
    const { call } = await pollTransformer({ onPollFailed });

    await expect(
      call(
        async () => {
          throw new Error("Network request for 'getUpdates' failed!");
        },
        "getUpdates",
        { timeout: 30 },
      ),
    ).rejects.toThrow("failed");
    expect(onPollFailed).toHaveBeenCalledTimes(1);

    const stopping = new AbortController();
    const pending = call(hangs, "getUpdates", { timeout: 30 }, stopping.signal);
    stopping.abort();
    await expect(pending).rejects.toThrow("failed");
    expect(onPollFailed).toHaveBeenCalledTimes(1);
  });

  it("resumes after the last update the channel already fetched", async () => {
    let resumeAfter: number | null = 41;
    const { call } = await pollTransformer({
      resumeAfterUpdateId: () => resumeAfter,
    });
    const prev = vi.fn<Prev>(async () => ({ ok: true, result: [] }));

    // A fresh bot starts from offset 1: Telegram would replay the batch
    // the replaced bot fetched but never confirmed.
    await call(prev, "getUpdates", { offset: 1, timeout: 30 });
    // Past the floor already: left alone.
    await call(prev, "getUpdates", { offset: 50, timeout: 30 });
    resumeAfter = null;
    await call(prev, "getUpdates", { offset: 1, timeout: 30 });

    expect(prev.mock.calls.map((c) => c[1].offset)).toEqual([42, 50, 1]);
  });

  it("abandon() aborts the poll in flight, refuses the next, and ends grammy's loop", async () => {
    const onPollFailed = vi.fn();
    const { call, abandon, stopCalls } = await pollTransformer({
      onPollFailed,
    });
    const inFlight = call(hangs, "getUpdates", { timeout: 30 });

    abandon();

    await expect(inFlight).rejects.toThrow("failed");
    const prev = vi.fn<Prev>(async () => ({ ok: true, result: [] }));
    // `stop()`'s closing confirmation included: it must not reach Telegram.
    await expect(
      call(prev, "getUpdates", { offset: 8, limit: 1 }),
    ).rejects.toThrow("abandoned");
    expect(prev).not.toHaveBeenCalled();
    expect(onPollFailed).not.toHaveBeenCalled();
    expect(stopCalls()).toBe(1);
  });
});
