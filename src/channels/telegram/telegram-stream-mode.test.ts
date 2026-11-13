import { describe, expect, it } from "vitest";

import {
  DEFAULT_TELEGRAM_STREAM_REPLIES,
  resolveTelegramStreamReplies,
  shouldStreamReplies,
  TELEGRAM_STREAM_REPLIES_ENV,
} from "./telegram-stream-mode.js";

describe("resolveTelegramStreamReplies (ATO-634)", () => {
  it("defaults to private chats only", () => {
    expect(DEFAULT_TELEGRAM_STREAM_REPLIES).toBe("private");
    expect(resolveTelegramStreamReplies(undefined, {})).toBe("private");
  });

  it("uses the config value when the env is silent", () => {
    expect(resolveTelegramStreamReplies("off", {})).toBe("off");
  });

  it("lets the env override the config, with switch words", () => {
    const env = (v: string) => ({ [TELEGRAM_STREAM_REPLIES_ENV]: v });
    expect(resolveTelegramStreamReplies("private", env("off"))).toBe("off");
    expect(resolveTelegramStreamReplies("off", env(" PRIVATE "))).toBe("private");
    expect(resolveTelegramStreamReplies("private", env("0"))).toBe("off");
    expect(resolveTelegramStreamReplies("off", env("true"))).toBe("private");
  });

  it("ignores an unknown env value", () => {
    expect(resolveTelegramStreamReplies("off", { [TELEGRAM_STREAM_REPLIES_ENV]: "all" })).toBe("off");
  });
});

describe("shouldStreamReplies", () => {
  it("streams only private chats, and nothing when off or absent", () => {
    expect(shouldStreamReplies("private", true)).toBe(true);
    expect(shouldStreamReplies("private", false)).toBe(false);
    expect(shouldStreamReplies("off", true)).toBe(false);
    expect(shouldStreamReplies(undefined, true)).toBe(false);
  });
});
