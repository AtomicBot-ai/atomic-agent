import { describe, expect, it, vi } from "vitest";

import type { TelegramApi } from "./outbound-sender.js";
import { isNotModified, TelegramProgressIndicator } from "./telegram-progress-indicator.js";

// ATO-965: a status snapshot edits ONE bubble, and posts a new one only
// when the old can no longer be edited.

function makeApi(editImpl?: (messageId: number, text: string) => Promise<unknown>) {
  const sends: { text: string; opts: Record<string, unknown> | undefined }[] = [];
  const edits: { messageId: number; text: string }[] = [];
  const deletes: number[] = [];
  let nextId = 100;
  const api: TelegramApi = {
    sendMessage: vi.fn(async (_chat, text, opts) => {
      sends.push({ text, opts });
      return { message_id: nextId++ };
    }),
    editMessageText: vi.fn(async (_chat, messageId, text) => {
      edits.push({ messageId, text });
      return editImpl ? editImpl(messageId, text) : true;
    }),
    deleteMessage: vi.fn(async (_chat, messageId) => {
      deletes.push(messageId);
      return true;
    }),
  };
  return { api, sends, edits, deletes };
}

describe("TelegramProgressIndicator.showSnapshot", () => {
  it("posts the first snapshot, then edits the same message", async () => {
    const { api, sends, edits } = makeApi();
    const bubble = new TelegramProgressIndicator(api, 7);
    await bubble.showSnapshot("snap 1");
    await bubble.showSnapshot("snap 2");
    await bubble.showSnapshot("snap 3");
    expect(sends).toEqual([{ text: "snap 1", opts: { disable_notification: true } }]);
    expect(edits).toEqual([
      { messageId: 100, text: "snap 2" },
      { messageId: 100, text: "snap 3" },
    ]);
  });

  it("is not throttled like step labels, and holds the bubble against them", async () => {
    const { api, edits } = makeApi();
    const bubble = new TelegramProgressIndicator(api, 7, undefined, 60_000);
    bubble.start("🤔 Thinking…");
    await bubble.showSnapshot("snapshot");
    bubble.update("🔧 os.fs.read");
    await bubble.remove();
    expect(edits.map((e) => e.text)).toEqual(["snapshot"]);
  });

  it("posts a new bubble when the old one cannot be edited, and keeps editing that one", async () => {
    const { api, sends, edits, deletes } = makeApi(async (messageId) => {
      if (messageId === 100) throw new Error("Bad Request: message to edit not found");
      return true;
    });
    const bubble = new TelegramProgressIndicator(api, 7);
    await bubble.showSnapshot("snap 1");
    await bubble.showSnapshot("snap 2");
    await bubble.showSnapshot("snap 3");
    expect(sends.map((s) => s.text)).toEqual(["snap 1", "snap 2"]);
    expect(edits[edits.length - 1]).toEqual({ messageId: 101, text: "snap 3" });
    expect(bubble.currentMessageId()).toBe(101);
    await vi.waitFor(() => expect(deletes).toContain(100));
  });

  it("neither reposts on 'not modified' nor on a flood-wait", async () => {
    const notModified = makeApi(async () => {
      throw new Error("Bad Request: message is not modified");
    });
    const a = new TelegramProgressIndicator(notModified.api, 7);
    await a.showSnapshot("x");
    await a.showSnapshot("y");
    expect(notModified.sends).toHaveLength(1);

    const flood = makeApi(async () => {
      throw Object.assign(new Error("Too Many Requests"), { error_code: 429, parameters: { retry_after: 60 } });
    });
    const b = new TelegramProgressIndicator(flood.api, 7);
    await b.showSnapshot("x");
    await b.showSnapshot("y");
    await b.showSnapshot("z");
    expect(flood.sends).toHaveLength(1);
    expect(flood.edits).toHaveLength(1); // muted after the 429
  });

  it("does nothing after remove", async () => {
    const { api, sends } = makeApi();
    const bubble = new TelegramProgressIndicator(api, 7);
    await bubble.remove();
    await bubble.showSnapshot("late");
    expect(sends).toHaveLength(0);
  });
});

describe("isNotModified", () => {
  it("recognises grammy's error and a raw description", () => {
    expect(isNotModified(new Error("Call to 'editMessageText' failed! (400: Bad Request: message is not modified)"))).toBe(true);
    expect(isNotModified({ description: "Bad Request: message is not modified" })).toBe(true);
    expect(isNotModified(new Error("message to edit not found"))).toBe(false);
  });
});
