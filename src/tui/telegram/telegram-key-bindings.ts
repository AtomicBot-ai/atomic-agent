import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";

export interface TelegramTabKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: TuiAppCallbacks;
}

/**
 * Keyboard layer for the Telegram tab. Invoked by `TuiApp`'s global
 * `useInput` after `handleAppKey` declined the key. Returns `true`
 * when the key was consumed so the editor echo is suppressed.
 *
 * Three modes routed by `state.telegramPanel.mode`:
 *  - `list`         — letter hotkeys for live-control verbs.
 *  - `tokenPrompt`  — masked entry; every printable char is captured.
 *  - `pairingActive`— Esc cancels, otherwise no input.
 *  - `pairingResult`— any key dismisses.
 */
export function handleTelegramTabKey(
  input: string,
  key: Key,
  ctx: TelegramTabKeyContext,
): boolean {
  const { state } = ctx;
  if (state.uiMode !== "debug" || state.activeTab !== "telegram") return false;
  const panel = state.telegramPanel;
  switch (panel.mode) {
    case "tokenPrompt":
      return handleTokenPromptKey(input, key, ctx);
    case "pairingActive":
      return handlePairingActiveKey(input, key, ctx);
    case "pairingResult":
      return handlePairingResultKey(input, key, ctx);
    case "list":
    default:
      return handleListKey(input, key, ctx);
  }
}

function handleListKey(
  input: string,
  key: Key,
  ctx: TelegramTabKeyContext,
): boolean {
  const { callbacks } = ctx;
  // Primary CTA — drives the setup flow forward by exactly one step.
  if (key.return) {
    void callbacks.onTelegramAdvanceConnectRequested?.();
    return true;
  }
  if (input === "a") {
    callbacks.onTelegramAdvancedToggleRequested?.();
    return true;
  }
  if (input === "e") {
    void callbacks.onTelegramToggleEnabledRequested?.();
    return true;
  }
  if (input === "t") {
    callbacks.onTelegramTokenPromptOpenRequested?.();
    return true;
  }
  if (input === "T") {
    void callbacks.onTelegramClearTokenRequested?.();
    return true;
  }
  if (input === "o") {
    void callbacks.onTelegramStartPairingRequested?.();
    return true;
  }
  if (input === "O") {
    void callbacks.onTelegramClearOwnerRequested?.();
    return true;
  }
  if (input === "r") {
    void callbacks.onTelegramRestartRequested?.();
    return true;
  }
  if (input === "R") {
    callbacks.onTelegramRefreshRequested?.();
    return true;
  }
  return false;
}

function handleTokenPromptKey(
  input: string,
  key: Key,
  ctx: TelegramTabKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  const prompt = state.telegramPanel.tokenPrompt;
  if (!prompt) return false;
  if (key.escape) {
    dispatch({ type: "telegram_token_prompt_closed" });
    return true;
  }
  if (key.return) {
    void callbacks.onTelegramTokenSubmitted?.(prompt.buffer);
    return true;
  }
  if (key.backspace || key.delete) {
    dispatch({
      type: "telegram_token_prompt_buffer_changed",
      buffer: prompt.buffer.slice(0, -1),
    });
    return true;
  }
  if (input && input.length > 0 && !key.ctrl && !key.meta) {
    dispatch({
      type: "telegram_token_prompt_buffer_changed",
      buffer: prompt.buffer + input,
    });
    return true;
  }
  return true;
}

function handlePairingActiveKey(
  _input: string,
  key: Key,
  ctx: TelegramTabKeyContext,
): boolean {
  const { callbacks } = ctx;
  if (key.escape) {
    callbacks.onTelegramCancelPairingRequested?.();
    return true;
  }
  return true;
}

function handlePairingResultKey(
  _input: string,
  _key: Key,
  ctx: TelegramTabKeyContext,
): boolean {
  ctx.callbacks.onTelegramDismissPairingResultRequested?.();
  return true;
}
