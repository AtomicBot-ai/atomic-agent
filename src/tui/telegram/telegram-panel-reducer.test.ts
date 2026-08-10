import { describe, expect, it } from "vitest";
import { createInitialTuiState, type TuiSessionInfo } from "../tui-state.js";
import { reduceTelegramAction } from "./telegram-panel-reducer.js";

const SESSION: TuiSessionInfo = {
  sessionId: null,
  workingDir: "/tmp",
  llamaUrl: "http://localhost",
  browserChannel: "chromium",
  browserHeadless: true,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

describe("reduceTelegramAction", () => {
  it("returns null for non-telegram actions", () => {
    const state = createInitialTuiState(SESSION);
    const result = reduceTelegramAction(state, { type: "chat_cleared" });
    expect(result).toBeNull();
  });

  it("folds telegram_status_changed into channelState + lastError", () => {
    const state = createInitialTuiState(SESSION);
    const next = reduceTelegramAction(state, {
      type: "telegram_status_changed",
      channelState: "down",
      lastError: "missing TELEGRAM_BOT_TOKEN",
    });
    expect(next).not.toBeNull();
    expect(next!.telegramPanel.channelState).toBe("down");
    expect(next!.telegramPanel.lastError).toBe("missing TELEGRAM_BOT_TOKEN");
  });

  it("folds telegram_settings_synced; only the boolean presence flag, never the value", () => {
    const state = createInitialTuiState(SESSION);
    const next = reduceTelegramAction(state, {
      type: "telegram_settings_synced",
      enabled: true,
      ownerUserId: 42,
      hasToken: true,
    });
    expect(next!.telegramPanel.enabled).toBe(true);
    expect(next!.telegramPanel.ownerUserId).toBe(42);
    expect(next!.telegramPanel.hasToken).toBe(true);
    // The reducer never accepts the raw token; only the boolean
    // presence flag survives. This guards against accidentally
    // widening the action type to carry the token itself.
    const keys = Object.keys(next!.telegramPanel);
    for (const key of keys) {
      expect(key).not.toBe("token");
      expect(key).not.toBe("botToken");
    }
  });

  it("toggles busy through started/settled and merges optional message + error", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTelegramAction(state, { type: "telegram_action_started" })!;
    expect(state.telegramPanel.busy).toBe(true);
    state = reduceTelegramAction(state, {
      type: "telegram_action_settled",
      message: "telegram enabled",
    })!;
    expect(state.telegramPanel.busy).toBe(false);
    expect(state.telegramPanel.message).toBe("telegram enabled");
    state = reduceTelegramAction(state, {
      type: "telegram_action_settled",
      error: "kaboom",
    })!;
    expect(state.telegramPanel.lastError).toBe("kaboom");
    // sticky message survives the second settle (no override given)
    expect(state.telegramPanel.message).toBe("telegram enabled");
  });

  describe("token prompt modal", () => {
    it("opens with empty buffer + no error", () => {
      const state = createInitialTuiState(SESSION);
      const next = reduceTelegramAction(state, {
        type: "telegram_token_prompt_opened",
      })!;
      expect(next.telegramPanel.mode).toBe("tokenPrompt");
      expect(next.telegramPanel.tokenPrompt).toEqual({
        buffer: "",
        error: null,
        submitting: false,
      });
    });

    it("buffer_changed clears any previous error", () => {
      let state = createInitialTuiState(SESSION);
      state = reduceTelegramAction(state, {
        type: "telegram_token_prompt_opened",
      })!;
      state = reduceTelegramAction(state, {
        type: "telegram_token_prompt_error_set",
        error: "token is empty",
      })!;
      expect(state.telegramPanel.tokenPrompt!.error).toBe("token is empty");
      state = reduceTelegramAction(state, {
        type: "telegram_token_prompt_buffer_changed",
        buffer: "1",
      })!;
      expect(state.telegramPanel.tokenPrompt!.error).toBeNull();
      expect(state.telegramPanel.tokenPrompt!.buffer).toBe("1");
    });

    it("buffer_changed is a no-op outside the modal", () => {
      const state = createInitialTuiState(SESSION);
      const next = reduceTelegramAction(state, {
        type: "telegram_token_prompt_buffer_changed",
        buffer: "abc",
      })!;
      expect(next.telegramPanel.tokenPrompt).toBeNull();
    });

    it("closes the modal and clears the buffer", () => {
      let state = createInitialTuiState(SESSION);
      state = reduceTelegramAction(state, {
        type: "telegram_token_prompt_opened",
      })!;
      state = reduceTelegramAction(state, {
        type: "telegram_token_prompt_buffer_changed",
        buffer: "secret",
      })!;
      state = reduceTelegramAction(state, {
        type: "telegram_token_prompt_closed",
      })!;
      expect(state.telegramPanel.mode).toBe("list");
      expect(state.telegramPanel.tokenPrompt).toBeNull();
    });
  });

  describe("pairing flow", () => {
    it("opens the active modal with countdown anchors", () => {
      const state = createInitialTuiState(SESSION);
      const next = reduceTelegramAction(state, {
        type: "telegram_pairing_started",
        expiresAt: 60_000,
        nowMs: 0,
      })!;
      expect(next.telegramPanel.mode).toBe("pairingActive");
      expect(next.telegramPanel.pairing).toEqual({
        expiresAt: 60_000,
        nowMs: 0,
      });
    });

    it("tick updates nowMs without changing the deadline", () => {
      let state = createInitialTuiState(SESSION);
      state = reduceTelegramAction(state, {
        type: "telegram_pairing_started",
        expiresAt: 60_000,
        nowMs: 0,
      })!;
      state = reduceTelegramAction(state, {
        type: "telegram_pairing_tick",
        nowMs: 1_000,
      })!;
      expect(state.telegramPanel.pairing).toEqual({
        expiresAt: 60_000,
        nowMs: 1_000,
      });
    });

    it("resolved with a claim moves to pairingResult and pre-fills owner", () => {
      let state = createInitialTuiState(SESSION);
      state = reduceTelegramAction(state, {
        type: "telegram_pairing_started",
        expiresAt: 60_000,
        nowMs: 0,
      })!;
      state = reduceTelegramAction(state, {
        type: "telegram_pairing_resolved",
        result: { userId: 7, chatId: 42, welcomeDelivered: true },
      })!;
      expect(state.telegramPanel.mode).toBe("pairingResult");
      expect(state.telegramPanel.pairing).toBeNull();
      expect(state.telegramPanel.pairingResult).toEqual({
        userId: 7,
        chatId: 42,
        welcomeDelivered: true,
      });
      expect(state.telegramPanel.ownerUserId).toBe(7);
    });

    it("resolved with welcomeDelivered=false plumbs the flag into pairingResult", () => {
      let state = createInitialTuiState(SESSION);
      state = reduceTelegramAction(state, {
        type: "telegram_pairing_started",
        expiresAt: 60_000,
        nowMs: 0,
      })!;
      state = reduceTelegramAction(state, {
        type: "telegram_pairing_resolved",
        result: { userId: 7, chatId: 42, welcomeDelivered: false },
      })!;
      expect(state.telegramPanel.pairingResult).toEqual({
        userId: 7,
        chatId: 42,
        welcomeDelivered: false,
      });
    });

    it("resolved with null falls back to list and stickies the timeout flag for the setup view", () => {
      let state = createInitialTuiState(SESSION);
      state = reduceTelegramAction(state, {
        type: "telegram_pairing_started",
        expiresAt: 60_000,
        nowMs: 0,
      })!;
      state = reduceTelegramAction(state, {
        type: "telegram_pairing_resolved",
        result: null,
      })!;
      expect(state.telegramPanel.mode).toBe("list");
      expect(state.telegramPanel.lastDismissedPairingTimedOut).toBe(true);
      // Old behaviour duplicated the failure into `message`; the
      // setup view now owns the user-facing copy via deriveSetupState.
      expect(state.telegramPanel.message).toBeNull();
    });

    it("modal_dismissed always returns to list and clears modal slots", () => {
      let state = createInitialTuiState(SESSION);
      state = reduceTelegramAction(state, {
        type: "telegram_pairing_resolved",
        result: { userId: 9, chatId: 99, welcomeDelivered: true },
      })!;
      state = reduceTelegramAction(state, {
        type: "telegram_pairing_modal_dismissed",
      })!;
      expect(state.telegramPanel.mode).toBe("list");
      expect(state.telegramPanel.pairingResult).toBeNull();
      expect(state.telegramPanel.pairing).toBeNull();
    });
  });

  it("telegram_message_cleared zeroes the sticky message", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTelegramAction(state, {
      type: "telegram_action_settled",
      message: "ok",
    })!;
    expect(state.telegramPanel.message).toBe("ok");
    state = reduceTelegramAction(state, { type: "telegram_message_cleared" })!;
    expect(state.telegramPanel.message).toBeNull();
  });

  it("telegram_advanced_toggled flips the showAdvanced flag", () => {
    let state = createInitialTuiState(SESSION);
    expect(state.telegramPanel.showAdvanced).toBe(false);
    state = reduceTelegramAction(state, { type: "telegram_advanced_toggled" })!;
    expect(state.telegramPanel.showAdvanced).toBe(true);
    state = reduceTelegramAction(state, { type: "telegram_advanced_toggled" })!;
    expect(state.telegramPanel.showAdvanced).toBe(false);
  });

  it("pairing_resolved with null sets the lastDismissedPairingTimedOut sticky", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTelegramAction(state, {
      type: "telegram_pairing_started",
      expiresAt: 60_000,
      nowMs: 0,
    })!;
    state = reduceTelegramAction(state, {
      type: "telegram_pairing_resolved",
      result: null,
    })!;
    expect(state.telegramPanel.lastDismissedPairingTimedOut).toBe(true);
    // A fresh pairing window clears the sticky.
    state = reduceTelegramAction(state, {
      type: "telegram_pairing_started",
      expiresAt: 60_000,
      nowMs: 0,
    })!;
    expect(state.telegramPanel.lastDismissedPairingTimedOut).toBe(false);
  });

  it("settings sync with a non-null owner clears the timeout sticky", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTelegramAction(state, {
      type: "telegram_pairing_resolved",
      result: null,
    })!;
    expect(state.telegramPanel.lastDismissedPairingTimedOut).toBe(true);
    state = reduceTelegramAction(state, {
      type: "telegram_settings_synced",
      enabled: true,
      ownerUserId: 42,
      hasToken: true,
    })!;
    expect(state.telegramPanel.lastDismissedPairingTimedOut).toBe(false);
  });
});
