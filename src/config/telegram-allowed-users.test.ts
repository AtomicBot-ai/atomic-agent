import { describe, expect, it } from "vitest";

import { createTelegramDefaults, parseTelegramConfig } from "./channel-config.js";
import { parseTelegramAllowedUsers } from "./telegram-allowed-users.js";

describe("telegram.allowedUsers (ATO-2221)", () => {
  it("is absent when the key is absent: older files need no migration", () => {
    const parsed = parseTelegramConfig({ enabled: true, ownerUserId: 42 }, createTelegramDefaults);
    expect(parsed.allowedUsers).toBeUndefined();
  });

  it("parses guests, numeric strings included, and drops duplicates", () => {
    const parsed = parseTelegramConfig(
      {
        ownerUserId: 42,
        allowedUsers: [
          { userId: 77, role: "guest" },
          { userId: "78" },
          { userId: 77, role: "guest" },
        ],
      },
      createTelegramDefaults,
    );
    expect(parsed.allowedUsers).toEqual([
      { userId: 77, role: "guest" },
      { userId: 78, role: "guest" },
    ]);
  });

  it("rejects a bad id, an unknown role and a non-array", () => {
    expect(() => parseTelegramAllowedUsers([{ userId: -5 }], "f")).toThrow(/f\[0\]\.userId/);
    expect(() => parseTelegramAllowedUsers([{ userId: 5, role: "owner" }], "f")).toThrow(
      /f\[0\]\.role/,
    );
    expect(() => parseTelegramAllowedUsers({ userId: 5 }, "f")).toThrow(/expected an array/);
    expect(() => parseTelegramAllowedUsers(["77"], "f")).toThrow(/f\[0\]/);
  });
});
