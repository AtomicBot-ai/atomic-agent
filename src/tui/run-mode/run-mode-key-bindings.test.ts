import { describe, expect, it, vi } from "vitest";
import type { Key } from "ink";

import { apply, fakeSession } from "../test-fixtures.js";
import { createInitialTuiState } from "../tui-state.js";
import type { TuiState } from "../tui-state.js";
import { handleRunModePickerKey } from "./run-mode-key-bindings.js";

const KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

function withPicker(): TuiState {
  return apply(createInitialTuiState(fakeSession()), [
    { type: "run_mode_picker_opened" },
  ]);
}

function press(state: TuiState, input: string, key: Partial<Key> = {}) {
  const dispatch = vi.fn();
  const handled = handleRunModePickerKey(input, { ...KEY, ...key }, {
    state,
    dispatch,
  });
  return { handled, dispatch };
}

describe("handleRunModePickerKey", () => {
  it("declines every key while the picker is closed", () => {
    const state = createInitialTuiState(fakeSession());
    const { handled, dispatch } = press(state, "j");
    expect(handled).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("closes on Esc without requesting a change", () => {
    const { handled, dispatch } = press(withPicker(), "", { escape: true });
    expect(handled).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "run_mode_picker_closed" });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "run_mode_change_requested" }),
    );
  });

  it("applies the draft on Enter and closes", () => {
    const { dispatch } = press(withPicker(), "", { return: true });
    expect(dispatch).toHaveBeenNthCalledWith(1, {
      type: "run_mode_change_requested",
      mode: "local",
      cloudShare: 40,
    });
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: "run_mode_picker_closed",
    });
  });

  it("moves with arrows and with j/k", () => {
    for (const [input, key] of [
      ["j", {}],
      ["", { downArrow: true }],
    ] as const) {
      const { dispatch } = press(withPicker(), input, key);
      expect(dispatch).toHaveBeenCalledWith({
        type: "run_mode_picker_cursor_set",
        cursor: 1,
      });
    }
  });

  it("wraps the cursor in both directions", () => {
    const { dispatch } = press(withPicker(), "k");
    expect(dispatch).toHaveBeenCalledWith({
      type: "run_mode_picker_cursor_set",
      cursor: 2,
    });
  });

  it("steps the dial by 5, or 25 with shift", () => {
    const fine = press(withPicker(), "", { rightArrow: true });
    expect(fine.dispatch).toHaveBeenCalledWith({
      type: "run_mode_picker_share_set",
      cloudShare: 45,
    });
    const coarse = press(withPicker(), "", { rightArrow: true, shift: true });
    expect(coarse.dispatch).toHaveBeenCalledWith({
      type: "run_mode_picker_share_set",
      cloudShare: 65,
    });
    const down = press(withPicker(), "", { leftArrow: true });
    expect(down.dispatch).toHaveBeenCalledWith({
      type: "run_mode_picker_share_set",
      cloudShare: 35,
    });
  });

  it("forwards typed digits", () => {
    const { dispatch } = press(withPicker(), "7");
    expect(dispatch).toHaveBeenCalledWith({
      type: "run_mode_picker_digit_typed",
      digit: "7",
    });
  });

  it("swallows every unclaimed key so nothing leaks to the editor", () => {
    // The picker floats over the chat surface, where the editor holds
    // focus — an unswallowed letter would be typed into the prompt.
    for (const input of ["x", "Z", " ", "/"]) {
      const { handled } = press(withPicker(), input);
      expect(handled).toBe(true);
    }
    expect(press(withPicker(), "", { tab: true }).handled).toBe(true);
    expect(press(withPicker(), "b", { ctrl: true }).handled).toBe(true);
  });
});
