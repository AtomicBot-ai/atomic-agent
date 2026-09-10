import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TelegramSessionPointer,
  telegramChatKey,
} from "./telegram-session-pointer.js";

// The per-chat mechanics are pinned in `../chat-session-map.test.ts`;
// this file pins only what is Telegram-specific.
describe("TelegramSessionPointer", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-pointer-"));
    path = join(dir, "telegram-session.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a private chat and a group on separate sessions", () => {
    const ptr = new TelegramSessionPointer(path);
    ptr.setCurrent(telegramChatKey(42), "s-dm", "DM");
    ptr.setCurrent(telegramChatKey(-1001), "s-group", "Ops");
    expect(ptr.get("42").current).toBe("s-dm");
    expect(ptr.get("-1001").current).toBe("s-group");
    expect(new TelegramSessionPointer(path).entries()).toHaveLength(2);
  });

  it("migrates the pre-per-chat file into the owner's DM", () => {
    writeFileSync(path, JSON.stringify({ current: "s-old", history: ["s-1"] }));
    const ptr = new TelegramSessionPointer(path);
    expect(ptr.adoptLegacy(telegramChatKey(42), "DM")).toBe("s-old");
    expect(ptr.get("42")).toMatchObject({ current: "s-old", history: ["s-1"] });
  });
});

describe("telegramChatKey", () => {
  it("is the chat id outside forum topics", () => {
    expect(telegramChatKey(42)).toBe("42");
    expect(telegramChatKey(-1001234)).toBe("-1001234");
  });

  it("folds the topic id in so each topic is its own conversation", () => {
    expect(telegramChatKey(-1001234, 77)).toBe("-1001234:77");
    expect(telegramChatKey(-1001234, 77)).not.toBe(telegramChatKey(-1001234));
  });
});
