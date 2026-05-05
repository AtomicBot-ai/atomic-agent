import { describe, expect, it, vi } from "vitest";

import {
  WELCOME_MESSAGE_TEXT,
  sendWelcomeMessage,
} from "./welcome-message.js";
import type { TelegramApi } from "./outbound-sender.js";

function makeApi(impl?: TelegramApi["sendMessage"]): TelegramApi {
  return {
    sendMessage: vi.fn(impl ?? (async () => ({ message_id: 1 }))),
  };
}

describe("sendWelcomeMessage", () => {
  it("posts the fixed welcome text exactly once with previews disabled and reports delivered=true", async () => {
    const api = makeApi();
    await expect(
      sendWelcomeMessage({ api, chatId: 42 }),
    ).resolves.toBe(true);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith(
      42,
      WELCOME_MESSAGE_TEXT,
      expect.objectContaining({ disable_web_page_preview: true }),
    );
  });

  it("never includes the bot token, error text, or arbitrary user input", () => {
    expect(WELCOME_MESSAGE_TEXT).not.toMatch(/[0-9]{6,}:[A-Za-z0-9_-]{20,}/);
    expect(WELCOME_MESSAGE_TEXT).not.toMatch(/error|fail|exception/i);
    expect(WELCOME_MESSAGE_TEXT).not.toMatch(/\$|\{|\}/);
  });

  it("swallows API errors, returns delivered=false, and scrubs the token from the warn log", async () => {
    // The error message intentionally embeds a token-shaped fragment;
    // `scrubErrorMessage` must redact it before the warn line lands
    // anywhere a user / log shipper could read.
    const api = makeApi(async () => {
      throw new Error(
        "network down via api.telegram.org/bot1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123/sendMessage",
      );
    });
    const warn = vi.fn();
    await expect(
      sendWelcomeMessage({
        api,
        chatId: 42,
        logger: { warn },
      }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, context] = warn.mock.calls[0];
    expect(message).toMatch(/welcome sendMessage failed/);
    expect(context).toBeDefined();
    const ctx = context as { error: string };
    expect(ctx.error).not.toMatch(/1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123/);
  });

  it("does not throw when no logger is provided and still reports delivered=false on failure", async () => {
    const api = makeApi(async () => {
      throw new Error("boom");
    });
    await expect(sendWelcomeMessage({ api, chatId: 1 })).resolves.toBe(false);
  });
});
