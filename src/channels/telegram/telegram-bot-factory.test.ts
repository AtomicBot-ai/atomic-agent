import { describe, expect, it, vi } from "vitest";

import type { InboundTextUpdate } from "./inbound-handler.js";

/**
 * grammy is loaded lazily inside the factory, so the mock has to be
 * hoisted ahead of the module graph. The fake `Bot` records the
 * `message:text` handler so a test can feed it a synthetic context.
 */
const { instances, MockBot } = vi.hoisted(() => {
  const instances: Array<{ handlers: Map<string, (ctx: unknown) => unknown> }> = [];
  class MockBot {
    api = {};
    handlers = new Map<string, (ctx: unknown) => unknown>();
    constructor(public token: string) {
      instances.push(this);
    }
    on(event: string, cb: (ctx: unknown) => unknown): void {
      this.handlers.set(event, cb);
    }
    start(): Promise<never> {
      return new Promise(() => undefined);
    }
    async stop(): Promise<void> {}
  }
  return { instances, MockBot };
});

vi.mock("grammy", () => ({ Bot: MockBot }));

import { defaultGrammyBotFactory } from "./telegram-bot-factory.js";

async function projectedUpdate(message: Record<string, unknown>): Promise<InboundTextUpdate> {
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
