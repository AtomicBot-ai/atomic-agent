import { describe, expect, it } from "vitest";
import { resolveBackdropDismissal } from "../backdrop-dismissal.js";
import { apply, fakeSession } from "../test-fixtures.js";
import { createInitialTuiState } from "../tui-state.js";
import type { RewindPoint } from "../../session/session-rewind.js";

const points: RewindPoint[] = [
  { turnIndex: 6, text: "third", at: 3, ordinal: 3 },
  { turnIndex: 2, text: "second", at: 2, ordinal: 2 },
  { turnIndex: 0, text: "first", at: 1, ordinal: 1 },
];

describe("rewind picker reducer (ATO-1057)", () => {
  it("opens on the newest question", () => {
    const next = apply(createInitialTuiState(fakeSession()), [
      { type: "rewind_picker_opened", points },
    ]);
    expect(next.rewindPicker).toEqual({ points, cursor: 0 });
  });

  it("stays closed when there is nothing to list", () => {
    const next = apply(createInitialTuiState(fakeSession()), [
      { type: "rewind_picker_opened", points: [] },
    ]);
    expect(next.rewindPicker).toBeNull();
  });

  it("moves and clamps the cursor, keyboard and mouse alike", () => {
    const open = apply(createInitialTuiState(fakeSession()), [
      { type: "rewind_picker_opened", points },
    ]);
    const down = apply(open, [
      { type: "rewind_picker_cursor_moved", delta: 1 },
      { type: "rewind_picker_cursor_moved", delta: 1 },
      { type: "rewind_picker_cursor_moved", delta: 1 },
    ]);
    expect(down.rewindPicker?.cursor).toBe(2);
    const up = apply(down, [{ type: "rewind_picker_cursor_moved", delta: -1 }]);
    expect(up.rewindPicker?.cursor).toBe(1);
    expect(apply(open, [{ type: "rewind_picker_cursor_set", row: 9 }]).rewindPicker?.cursor).toBe(2);
    expect(apply(open, [{ type: "rewind_picker_cursor_set", row: -3 }]).rewindPicker?.cursor).toBe(0);
  });

  it("ignores cursor moves while closed", () => {
    const next = apply(createInitialTuiState(fakeSession()), [
      { type: "rewind_picker_cursor_moved", delta: 1 },
    ]);
    expect(next.rewindPicker).toBeNull();
  });

  it("closes on Esc's action and on a click outside", () => {
    const open = apply(createInitialTuiState(fakeSession()), [
      { type: "rewind_picker_opened", points },
    ]);
    expect(resolveBackdropDismissal(open)).toEqual({ type: "rewind_picker_closed" });
    expect(apply(open, [{ type: "rewind_picker_closed" }]).rewindPicker).toBeNull();
  });

  it("closes when the chat on screen is replaced", () => {
    const open = apply(createInitialTuiState(fakeSession()), [
      { type: "rewind_picker_opened", points },
    ]);
    const switched = apply(open, [
      { type: "session_switched", sessionId: "other", workingDir: "/tmp", messages: [] },
    ]);
    expect(switched.rewindPicker).toBeNull();
  });
});
