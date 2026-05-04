import { describe, expect, it, vi } from "vitest";

import {
  chunkUtf16,
  sendOutbound,
  type TelegramApi,
} from "./outbound-sender.js";

interface SendCall {
  chatId: number;
  text: string;
}

function fakeApi(behaviour: ReadonlyArray<unknown | null> = []): {
  api: TelegramApi;
  calls: SendCall[];
} {
  const calls: SendCall[] = [];
  const queue = [...behaviour];
  const api: TelegramApi = {
    sendMessage: vi.fn(async (chatId: number, text: string) => {
      calls.push({ chatId, text });
      const next = queue.length > 0 ? queue.shift() : null;
      if (next instanceof Error || (next && typeof next === "object")) {
        throw next;
      }
      return { message_id: calls.length };
    }),
  };
  return { api, calls };
}

describe("chunkUtf16", () => {
  it("returns [] for empty input", () => {
    expect(chunkUtf16("", 4000)).toEqual([]);
  });

  it("returns [text] when under the limit", () => {
    expect(chunkUtf16("hello", 4000)).toEqual(["hello"]);
  });

  it("splits on the most recent newline in the second half", () => {
    const part1 = `${"a".repeat(2000)}\n`;
    const part2 = "b".repeat(2500);
    const chunks = chunkUtf16(part1 + part2, 4000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(part1);
    expect(chunks[1]).toBe(part2);
  });

  it("never splits a UTF-16 surrogate pair across chunk boundaries", () => {
    const emoji = "😀";
    expect(emoji.length).toBe(2);
    const text = "x".repeat(3999) + emoji + "y".repeat(3999) + emoji;
    const chunks = chunkUtf16(text, 4000);
    for (const c of chunks) {
      const lastCode = c.charCodeAt(c.length - 1);
      const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
      expect(isHighSurrogate).toBe(false);
      const firstCode = c.charCodeAt(0);
      const isLowSurrogate = firstCode >= 0xdc00 && firstCode <= 0xdfff;
      expect(isLowSurrogate).toBe(false);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("hard-splits when there is no newline available", () => {
    const text = "x".repeat(8001);
    const chunks = chunkUtf16(text, 4000);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000);
    expect(chunks.join("")).toBe(text);
  });
});

describe("sendOutbound", () => {
  it("sends one chunk for a short message", async () => {
    const { api, calls } = fakeApi();
    const result = await sendOutbound({ api, chatId: 42, text: "hello" });
    expect(result).toEqual({ chunks: 1, dropped: 0 });
    expect(calls).toEqual([{ chatId: 42, text: "hello" }]);
  });

  it("sends multiple chunks for a long message", async () => {
    const { api, calls } = fakeApi();
    const text = "x".repeat(8500);
    const result = await sendOutbound({ api, chatId: 7, text });
    expect(result.chunks).toBeGreaterThanOrEqual(2);
    expect(result.dropped).toBe(0);
    expect(calls.map((c) => c.text).join("")).toBe(text);
  });

  it("retries once after a 429 with retry_after", async () => {
    const err = {
      error_code: 429,
      parameters: { retry_after: 1 },
      message: "Too Many Requests",
    };
    const { api, calls } = fakeApi([err, null]);
    const slept: number[] = [];
    const result = await sendOutbound({
      api,
      chatId: 1,
      text: "hi",
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(slept).toEqual([1000]);
    expect(result).toEqual({ chunks: 1, dropped: 0 });
    expect(calls.length).toBe(2);
  });

  it("drops a chunk on a second 429 and warns", async () => {
    const err = {
      error_code: 429,
      parameters: { retry_after: 1 },
      message: "Too Many Requests",
    };
    const { api } = fakeApi([err, err]);
    const warn = vi.fn();
    const result = await sendOutbound({
      api,
      chatId: 1,
      text: "hi",
      sleep: async () => undefined,
      logger: { warn },
    });
    expect(result).toEqual({ chunks: 1, dropped: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe(
      "telegram: dropping chunk after second 429",
    );
  });

  it("logs and drops non-429 errors without retry", async () => {
    const err = new Error("boom");
    const { api, calls } = fakeApi([err]);
    const warn = vi.fn();
    const result = await sendOutbound({
      api,
      chatId: 1,
      text: "hi",
      logger: { warn },
    });
    expect(result).toEqual({ chunks: 1, dropped: 1 });
    expect(calls.length).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
  });
});
