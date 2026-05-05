import { describe, expect, it } from "vitest";
import { decideConnectAction } from "./setup-flow.js";

describe("decideConnectAction", () => {
  it("opens the token prompt when the token is missing", () => {
    expect(
      decideConnectAction({
        tokenPresent: false,
        channelState: "disabled",
        ownerUserId: null,
      }),
    ).toEqual({ kind: "open_token_prompt" });
  });

  it("missing token wins over state / owner", () => {
    expect(
      decideConnectAction({
        tokenPresent: false,
        channelState: "up",
        ownerUserId: 42,
      }),
    ).toEqual({ kind: "open_token_prompt" });
  });

  it("turns the channel on when token present but disabled", () => {
    expect(
      decideConnectAction({
        tokenPresent: true,
        channelState: "disabled",
        ownerUserId: null,
      }),
    ).toEqual({ kind: "set_enabled", enabled: true });
  });

  it("retries via set_enabled(true) when token present but channel landed in down", () => {
    // `down` and `disabled` collapse onto the same recovery verb so a
    // single Enter press from the "Telegram is not connected" CTA
    // actually restarts the channel. `restart()` on the channel by
    // itself is a no-op from `down` (it only re-runs `start` when
    // wasUp), so the flow must not dispatch it.
    expect(
      decideConnectAction({
        tokenPresent: true,
        channelState: "down",
        ownerUserId: null,
      }),
    ).toEqual({ kind: "set_enabled", enabled: true });
  });

  it("opens pairing when up + no owner", () => {
    expect(
      decideConnectAction({
        tokenPresent: true,
        channelState: "up",
        ownerUserId: null,
      }),
    ).toEqual({ kind: "start_pairing" });
  });

  it("returns none when up + paired (already connected)", () => {
    expect(
      decideConnectAction({
        tokenPresent: true,
        channelState: "up",
        ownerUserId: 42,
      }),
    ).toEqual({ kind: "none" });
  });

  it("returns none for transient starting / stopping windows", () => {
    expect(
      decideConnectAction({
        tokenPresent: true,
        channelState: "starting",
        ownerUserId: null,
      }),
    ).toEqual({ kind: "none" });
    expect(
      decideConnectAction({
        tokenPresent: true,
        channelState: "stopping",
        ownerUserId: 42,
      }),
    ).toEqual({ kind: "none" });
  });
});
