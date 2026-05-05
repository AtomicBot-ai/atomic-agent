import { describe, expect, it, vi } from "vitest";

import {
  chunkUtf16,
  sendOutbound,
  type TelegramApi,
} from "./outbound-sender.js";

interface SendCall {
  chatId: number;
  text: string;
  opts?: Record<string, unknown> | undefined;
}

function fakeApi(behaviour: ReadonlyArray<unknown | null> = []): {
  api: TelegramApi;
  calls: SendCall[];
} {
  const calls: SendCall[] = [];
  const queue = [...behaviour];
  const api: TelegramApi = {
    sendMessage: vi.fn(
      async (chatId: number, text: string, opts?: Record<string, unknown>) => {
        calls.push({ chatId, text, opts });
        const next = queue.length > 0 ? queue.shift() : null;
        if (next instanceof Error || (next && typeof next === "object")) {
          throw next;
        }
        return { message_id: calls.length };
      },
    ),
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
    expect(result).toEqual({ chunks: 1, dropped: 0, parseFallbacks: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.chatId).toBe(42);
    expect(calls[0]!.text).toBe("hello");
    expect(calls[0]!.opts).toBeUndefined();
  });

  it("sends multiple chunks for a long message", async () => {
    const { api, calls } = fakeApi();
    const text = "x".repeat(8500);
    const result = await sendOutbound({ api, chatId: 7, text });
    expect(result.chunks).toBeGreaterThanOrEqual(2);
    expect(result.dropped).toBe(0);
    expect(result.parseFallbacks).toBe(0);
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
    expect(result).toEqual({ chunks: 1, dropped: 0, parseFallbacks: 0 });
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
    expect(result).toEqual({ chunks: 1, dropped: 1, parseFallbacks: 0 });
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
    expect(result).toEqual({ chunks: 1, dropped: 1, parseFallbacks: 0 });
    expect(calls.length).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  describe("parseMode: html", () => {
    it("converts markdown to HTML and sends with parse_mode=HTML", async () => {
      const { api, calls } = fakeApi();
      const result = await sendOutbound({
        api,
        chatId: 5,
        text: "**bold** and `code`",
        parseMode: "html",
      });
      expect(result).toEqual({ chunks: 1, dropped: 0, parseFallbacks: 0 });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.text).toBe("<b>bold</b> and <code>code</code>");
      expect(calls[0]!.opts).toEqual({
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    });

    it("falls back to plain text on Telegram 400 'can't parse entities'", async () => {
      const err = {
        error_code: 400,
        description: "Bad Request: can't parse entities: bad tag",
      };
      const { api, calls } = fakeApi([err, null]);
      const warn = vi.fn();
      const result = await sendOutbound({
        api,
        chatId: 5,
        text: "**bold**",
        parseMode: "html",
        logger: { warn },
      });
      expect(result).toEqual({ chunks: 1, dropped: 0, parseFallbacks: 1 });
      expect(calls).toHaveLength(2);
      expect(calls[0]!.text).toBe("<b>bold</b>");
      expect(calls[0]!.opts).toEqual({
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      // Plain-text fallback retains the raw markdown source and omits parse_mode.
      expect(calls[1]!.text).toBe("**bold**");
      expect(calls[1]!.opts).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toBe(
        "telegram: parse_mode rejected, retrying as plain",
      );
    });

    it("counts a dropped chunk when both formatted and plain attempts fail", async () => {
      const parseErr = {
        error_code: 400,
        description: "Bad Request: can't parse entities",
      };
      const plainErr = new Error("network down");
      const { api } = fakeApi([parseErr, plainErr]);
      const warn = vi.fn();
      const result = await sendOutbound({
        api,
        chatId: 5,
        text: "**bold**",
        parseMode: "html",
        logger: { warn },
      });
      expect(result).toEqual({ chunks: 1, dropped: 1, parseFallbacks: 1 });
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it("does not fall back when the 400 is not a parse-entity error", async () => {
      const err = {
        error_code: 400,
        description: "Bad Request: chat not found",
      };
      const { api, calls } = fakeApi([err]);
      const result = await sendOutbound({
        api,
        chatId: 5,
        text: "**bold**",
        parseMode: "html",
      });
      expect(result).toEqual({ chunks: 1, dropped: 1, parseFallbacks: 0 });
      expect(calls).toHaveLength(1);
    });

    it("plain mode never adds parse_mode and never falls back on 400", async () => {
      const err = {
        error_code: 400,
        description: "Bad Request: can't parse entities",
      };
      const { api, calls } = fakeApi([err]);
      const result = await sendOutbound({
        api,
        chatId: 5,
        text: "**bold**",
        parseMode: "plain",
      });
      expect(result).toEqual({ chunks: 1, dropped: 1, parseFallbacks: 0 });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.opts).toBeUndefined();
    });

    it("converts each chunk independently for long messages", async () => {
      const { api, calls } = fakeApi();
      const part1 = `**header**\n${"a".repeat(1000)}\n`;
      const part2 = `${"b".repeat(2500)}\n**footer**`;
      const result = await sendOutbound({
        api,
        chatId: 5,
        text: part1 + part2,
        parseMode: "html",
      });
      expect(result.chunks).toBeGreaterThanOrEqual(1);
      expect(result.dropped).toBe(0);
      for (const c of calls) {
        expect(c.opts).toEqual({
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
      }
      // The combined formatted output must contain a converted bold tag.
      const combined = calls.map((c) => c.text).join("");
      expect(combined).toContain("<b>header</b>");
    });
  });
});
