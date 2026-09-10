import { describe, expect, it } from "vitest";

import {
  CHANNEL_LOCKED_PREFIX,
  describeChannelLockConflict,
  formatChannelLockHeld,
  isChannelLockConflict,
} from "./channel-lock-error.js";

describe("channel lock conflict", () => {
  it("tags the reason so it can be told from a real failure", () => {
    const reason = formatChannelLockHeld(4242);
    expect(reason.startsWith(CHANNEL_LOCKED_PREFIX)).toBe(true);
    expect(isChannelLockConflict(reason)).toBe(true);
    expect(reason).toContain("4242");
  });

  it("does not mistake a real failure for a lock conflict", () => {
    // A rejected token or disallowed intents must stay an error --
    // that is the case where red is the right answer.
    expect(
      isChannelLockConflict("Discord rejected the bot token (HTTP 401)"),
    ).toBe(false);
    expect(
      isChannelLockConflict("409: Conflict: terminated by other getUpdates"),
    ).toBe(false);
    expect(isChannelLockConflict(null)).toBe(false);
    expect(isChannelLockConflict(undefined)).toBe(false);
  });

  it("strips the machine prefix for display", () => {
    const shown = describeChannelLockConflict(formatChannelLockHeld(7));
    expect(shown).toBe("already running in another atomic-agent (pid 7)");
    expect(shown).not.toContain(CHANNEL_LOCKED_PREFIX);
  });
});
