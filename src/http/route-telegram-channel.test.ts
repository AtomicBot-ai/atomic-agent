import { describe, expect, it } from "vitest";

import { formatChannelLockHeld } from "../channels/channel-lock-error.js";

import { otherPollerOf } from "./route-telegram-channel.js";

describe("otherPollerOf (ATO-758)", () => {
  it("names the other atomic-agent on this computer from the lock", () => {
    expect(otherPollerOf(formatChannelLockHeld(4242))).toEqual({ where: "this_computer", pid: 4242 });
  });

  it("reads Telegram's 409 as a poller somewhere else", () => {
    expect(otherPollerOf("getUpdates failed (409: Conflict: terminated by other getUpdates request)")).toEqual({
      where: "elsewhere",
    });
  });

  it("says nothing for other failures or none", () => {
    expect(otherPollerOf(null)).toBeNull();
    expect(otherPollerOf("getUpdates failed (401: Unauthorized)")).toBeNull();
  });
});
