import { describe, expect, it } from "vitest";

import { apply, fakeSession } from "../test-fixtures.js";
import { createInitialTuiState } from "../tui-state.js";
import type { TuiState } from "../tui-state.js";

const base = (): TuiState => createInitialTuiState(fakeSession());

const synced = {
  type: "run_mode_synced" as const,
  effective: "fusion" as const,
  stored: "fusion" as const,
  cloudShare: 40,
  localLabel: "qwen3.6-9b",
  cloudLabel: "openai/gpt-4o-mini",
  cloudProviderMissing: false,
  localProviderMissing: false,
  degradedMessage: null,
};

describe("reduceRunModeAction", () => {
  it("starts on local with no picker open", () => {
    const state = base();
    expect(state.runModePanel.effective).toBe("local");
    expect(state.runModePanel.picker).toBeNull();
  });

  it("mirrors a synced snapshot", () => {
    const state = apply(base(), [synced]);
    expect(state.runModePanel).toMatchObject({
      effective: "fusion",
      stored: "fusion",
      cloudShare: 40,
      localLabel: "qwen3.6-9b",
      cloudLabel: "openai/gpt-4o-mini",
    });
  });

  it("opens the picker on the mode currently in force", () => {
    const state = apply(base(), [synced, { type: "run_mode_picker_opened" }]);
    expect(state.runModePanel.picker).toMatchObject({
      cursor: 2,
      draftMode: "fusion",
      draftCloudShare: 40,
    });
  });

  it("moves the cursor and the draft mode together", () => {
    const state = apply(base(), [
      synced,
      { type: "run_mode_picker_opened" },
      { type: "run_mode_picker_cursor_set", cursor: 0 },
    ]);
    expect(state.runModePanel.picker?.draftMode).toBe("local");
  });

  it("clamps the cursor to the available modes", () => {
    const state = apply(base(), [
      { type: "run_mode_picker_opened" },
      { type: "run_mode_picker_cursor_set", cursor: 99 },
    ]);
    expect(state.runModePanel.picker?.cursor).toBe(2);
  });

  it("clamps the dial to 0-100", () => {
    const high = apply(base(), [
      { type: "run_mode_picker_opened" },
      { type: "run_mode_picker_share_set", cloudShare: 250 },
    ]);
    expect(high.runModePanel.picker?.draftCloudShare).toBe(100);
    const low = apply(base(), [
      { type: "run_mode_picker_opened" },
      { type: "run_mode_picker_share_set", cloudShare: -40 },
    ]);
    expect(low.runModePanel.picker?.draftCloudShare).toBe(0);
  });

  it("builds a dial value from typed digits", () => {
    const state = apply(base(), [
      { type: "run_mode_picker_opened" },
      { type: "run_mode_picker_digit_typed", digit: "7" },
      { type: "run_mode_picker_digit_typed", digit: "5" },
    ]);
    expect(state.runModePanel.picker?.draftCloudShare).toBe(75);
  });

  it("keeps 100 reachable but nothing longer", () => {
    const state = apply(base(), [
      { type: "run_mode_picker_opened" },
      { type: "run_mode_picker_digit_typed", digit: "1" },
      { type: "run_mode_picker_digit_typed", digit: "0" },
      { type: "run_mode_picker_digit_typed", digit: "0" },
    ]);
    expect(state.runModePanel.picker?.draftCloudShare).toBe(100);
  });

  it("reverts on close — the committed mirror was never touched", () => {
    const state = apply(base(), [
      synced,
      { type: "run_mode_picker_opened" },
      { type: "run_mode_picker_share_set", cloudShare: 90 },
      { type: "run_mode_picker_closed" },
    ]);
    expect(state.runModePanel.picker).toBeNull();
    expect(state.runModePanel.cloudShare).toBe(40);
  });

  it("does not move the mirror on a change REQUEST", () => {
    // Only the orchestrator may change the mode; the mirror follows the
    // `run_mode_synced` it emits afterwards.
    const state = apply(base(), [
      synced,
      { type: "run_mode_change_requested", mode: "local" },
    ]);
    expect(state.runModePanel.effective).toBe("fusion");
  });

  it("tracks busy and surfaces a settle error", () => {
    const busy = apply(base(), [{ type: "run_mode_change_started" }]);
    expect(busy.runModePanel.busy).toBe(true);
    const settled = apply(busy, [
      { type: "run_mode_change_settled", error: "no cloud provider" },
    ]);
    expect(settled.runModePanel).toMatchObject({
      busy: false,
      lastError: "no cloud provider",
    });
  });

  it("clears a previous error when a new change starts", () => {
    const state = apply(base(), [
      { type: "run_mode_change_settled", error: "boom" },
      { type: "run_mode_change_started" },
    ]);
    expect(state.runModePanel.lastError).toBeNull();
  });

  it("ignores picker actions while the picker is closed", () => {
    const state = apply(base(), [
      { type: "run_mode_picker_share_set", cloudShare: 90 },
    ]);
    expect(state.runModePanel.picker).toBeNull();
  });
});
