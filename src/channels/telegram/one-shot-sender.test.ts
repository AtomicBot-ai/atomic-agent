import { describe, expect, it, vi } from "vitest";

import { fetchTelegramApi, sendTelegramOneShot } from "./one-shot-sender.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("one-shot Telegram sender", () => {
  it("posts one sendMessage to the Bot API with the chat id and text", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return jsonResponse({ ok: true, result: { message_id: 7 } });
    }) as unknown as typeof fetch;

    const result = await sendTelegramOneShot({
      token: "123456:ABCDEF",
      chatId: 42,
      text: "✅ Model ready",
      fetchImpl,
    });

    expect(result).toEqual({ chunks: 1, dropped: 0, parseFallbacks: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.telegram.org/bot123456:ABCDEF/sendMessage");
    expect(calls[0].body).toMatchObject({ chat_id: 42, text: "✅ Model ready" });
    // Infrastructure speaks plain text: no parse_mode.
    expect(calls[0].body.parse_mode).toBeUndefined();
  });

  it("surfaces a Bot API error in the shape sendOutbound already understands", async () => {
    const api = fetchTelegramApi({
      token: "t",
      fetchImpl: (async () =>
        jsonResponse(
          { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } },
          429,
        )) as unknown as typeof fetch,
    });
    await expect(api.sendMessage(1, "x")).rejects.toMatchObject({
      error_code: 429,
      parameters: { retry_after: 3 },
    });
  });

  it("drops the chunk (never throws) when the API keeps refusing", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error_code: 403, description: "bot was blocked by the user" }, 403),
    ) as unknown as typeof fetch;
    const warn = vi.fn();
    const result = await sendTelegramOneShot({
      token: "t",
      chatId: 1,
      text: "hi",
      fetchImpl,
      logger: { warn },
    });
    expect(result.dropped).toBe(1);
    expect(warn).toHaveBeenCalled();
  });

  it("honours a custom API base for tests and proxies", async () => {
    const seen: string[] = [];
    const api = fetchTelegramApi({
      token: "t",
      apiBase: "http://127.0.0.1:9/",
      fetchImpl: (async (url: string | URL | Request) => {
        seen.push(String(url));
        return jsonResponse({ ok: true, result: {} });
      }) as unknown as typeof fetch,
    });
    await api.sendMessage(1, "x");
    expect(seen).toEqual(["http://127.0.0.1:9/bott/sendMessage"]);
  });
});
