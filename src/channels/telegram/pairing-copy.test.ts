import { describe, expect, it } from "vitest";

import {
  pairedOwnerLine,
  pairingInstruction,
  replaceOwnerPrompt,
} from "./pairing-copy.js";

describe("pairing copy (ATO-718)", () => {
  it("tells the operator exactly what to send, to which bot, and for how long", () => {
    expect(
      pairingInstruction({ code: "012345", botUsername: "my_bot", timeoutMs: 5 * 60_000 }),
    ).toBe(
      "Send /start 012345 to @my_bot in Telegram within 5 minutes. The code works once; other messages are ignored.",
    );
    expect(
      pairingInstruction({ code: "012345", botUsername: null, timeoutMs: 60_000 }),
    ).toContain("to your bot in Telegram within 1 minute.");
  });

  it("names the new owner by @username, or by id when there is none", () => {
    expect(pairedOwnerLine({ userId: 7, username: "alice" })).toBe(
      "Paired: @alice is now the owner.",
    );
    expect(pairedOwnerLine({ userId: 7, username: null })).toBe(
      "Paired: Telegram user 7 (no @username) is now the owner.",
    );
  });

  it("says who would be replaced and how to confirm", () => {
    expect(
      replaceOwnerPrompt({ ownerUserId: 42, confirmSeconds: 15, again: "Press p again" }),
    ).toBe(
      "This bot already has an owner (Telegram user 42). Press p again within 15 seconds to replace them.",
    );
  });

  it("never uses an em dash", () => {
    const lines = [
      pairingInstruction({ code: "1", botUsername: "b", timeoutMs: 1 }),
      pairedOwnerLine({ userId: 1, username: null }),
      replaceOwnerPrompt({ ownerUserId: 1, confirmSeconds: 1, again: "x" }),
    ];
    for (const line of lines) expect(line).not.toContain("—");
  });
});
