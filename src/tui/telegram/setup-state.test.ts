import { describe, expect, it } from "vitest";

import {
  createInitialTelegramPanelState,
  type TelegramPanelState,
} from "./telegram-panel-state.js";
import { deriveSetupState } from "./setup-state.js";

function panel(overrides: Partial<TelegramPanelState>): TelegramPanelState {
  return { ...createInitialTelegramPanelState(), ...overrides };
}

describe("deriveSetupState", () => {
  it("step=not_connected when no token is present", () => {
    const view = deriveSetupState(panel({ hasToken: false }));
    expect(view.step).toBe("not_connected");
    expect(view.title).toMatch(/Connect Telegram/i);
    expect(view.cta).toMatch(/Enter/);
    expect(view.isTerminal).toBe(false);
  });

  it("step=connecting while the channel is starting", () => {
    const view = deriveSetupState(
      panel({ hasToken: true, channelState: "starting" }),
    );
    expect(view.step).toBe("connecting");
    expect(view.cta).toBeNull();
  });

  it("step=connecting while a setEnabled / setToken call is in flight", () => {
    const view = deriveSetupState(
      panel({ hasToken: true, channelState: "disabled", busy: true }),
    );
    expect(view.step).toBe("connecting");
  });

  it("step=connecting during the setOwnerUserId restart cycle (channel transiently disabled with enabled=true)", () => {
    // Locks the post-review fix: the panel must not flicker through
    // "ready" while the channel is stop→start cycling. The marker is
    // `enabled=true` (config still says we want it on) + `disabled`
    // channel state + a token.
    const view = deriveSetupState(
      panel({
        hasToken: true,
        enabled: true,
        channelState: "disabled",
        ownerUserId: 42,
      }),
    );
    expect(view.step).toBe("connecting");
  });

  it("step=connecting while channelState=stopping (mid-restart transient)", () => {
    const view = deriveSetupState(
      panel({
        hasToken: true,
        enabled: true,
        channelState: "stopping",
        ownerUserId: 42,
      }),
    );
    expect(view.step).toBe("connecting");
  });

  it("step=not_connected with the channel error when the channel is down", () => {
    const view = deriveSetupState(
      panel({
        hasToken: true,
        channelState: "down",
        lastError: "401: Unauthorized",
      }),
    );
    expect(view.step).toBe("not_connected");
    expect(view.body).toMatch(/Unauthorized/);
    expect(view.cta).toMatch(/try again/i);
  });

  it("step=needs_pairing when the channel is up but no owner is persisted", () => {
    const view = deriveSetupState(
      panel({
        hasToken: true,
        enabled: true,
        channelState: "up",
        ownerUserId: null,
      }),
    );
    expect(view.step).toBe("needs_pairing");
    expect(view.cta).toMatch(/pairing/i);
    expect(view.body).toMatch(/DM your bot/i);
  });

  it("step=pairing_failed after a timed-out pairing window with no owner", () => {
    const view = deriveSetupState(
      panel({
        hasToken: true,
        enabled: true,
        channelState: "up",
        ownerUserId: null,
        lastDismissedPairingTimedOut: true,
      }),
    );
    expect(view.step).toBe("pairing_failed");
    expect(view.title).toMatch(/didn't complete/i);
  });

  it("step=pairing_active strictly tracks mode === pairingActive", () => {
    const view = deriveSetupState(
      panel({
        hasToken: true,
        channelState: "up",
        mode: "pairingActive",
        pairing: { expiresAt: 0, nowMs: 0 },
      }),
    );
    expect(view.step).toBe("pairing_active");
    expect(view.cta).toMatch(/Esc/);
  });

  it("step=ready when token + up + owner are all present", () => {
    const view = deriveSetupState(
      panel({
        hasToken: true,
        enabled: true,
        channelState: "up",
        ownerUserId: 42,
        botUsername: "my_bot",
      }),
    );
    expect(view.step).toBe("ready");
    expect(view.title).toMatch(/@my_bot/);
    expect(view.isTerminal).toBe(true);
  });

  it("step=ready does NOT require botUsername (the optional bot probe is just polish)", () => {
    const view = deriveSetupState(
      panel({
        hasToken: true,
        enabled: true,
        channelState: "up",
        ownerUserId: 42,
      }),
    );
    expect(view.step).toBe("ready");
  });

  it("never reads the token buffer (paranoia: the setup taxonomy is bool-only)", () => {
    const view = deriveSetupState(
      panel({
        hasToken: true,
        channelState: "up",
        ownerUserId: 1,
        tokenPrompt: { buffer: "1234567890:ABCDEF", error: null, submitting: false },
      }),
    );
    expect(JSON.stringify(view)).not.toContain("1234567890");
  });
});
