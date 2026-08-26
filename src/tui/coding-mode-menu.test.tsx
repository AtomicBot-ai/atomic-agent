import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { CODING_MODES, codingModeLook } from "./coding-mode.js";
import { CodingModePopup } from "./components/coding-mode-popup.js";
import { reduceUiAction } from "./reduce-ui-actions.js";
import { createInitialTuiState, type TuiSessionInfo, type TuiState } from "./tui-state.js";

function session(): TuiSessionInfo {
  return {
    sessionId: "s1",
    workingDir: "/tmp/w",
    llamaUrl: "http://127.0.0.1:8080",
    browserChannel: "chromium",
    browserHeadless: true,
    approvalLevel: 1,
    maxSteps: 8,
    skillCount: 0,
  };
}

function stateWith(overrides: Partial<TuiState> = {}): TuiState {
  return { ...createInitialTuiState(session()), ...overrides };
}

function apply(state: TuiState, action: Parameters<typeof reduceUiAction>[1]): TuiState {
  return reduceUiAction(state, action) ?? state;
}

/**
 * The popup is absolutely positioned, so it needs a `position="relative"`
 * pane with a real height to sit inside — exactly the geometry
 * `tui-app.tsx` gives it, and the same wrapper
 * `composer-switch-popup.test.tsx` uses. Rendered bare in a plain Box it
 * measures to nothing and every assertion below would read an empty
 * string.
 */
function frame(cursor: number, columns = 76, rows = 12): string {
  const { lastFrame, unmount } = render(
    <Box flexDirection="column" position="relative" width={columns} height={rows}>
      {Array.from({ length: rows }, (_unused, row) => (
        <Text key={`bg-${row}`}>{"·".repeat(columns)}</Text>
      ))}
      <CodingModePopup
        cursor={cursor}
        active="default"
        availableRows={rows}
        availableColumns={columns}
        onActivate={() => {}}
      />
    </Box>,
  );
  const out = (lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
  unmount();
  return out;
}

/**
 * The chip used to advance the ring on click. That made the one control
 * that changes what the agent is *allowed to do* the only one with no
 * confirmation and no explanation — two stray clicks took you from
 * `plan` to `auto` with nothing on screen saying what either
 * meant.
 */
describe("the coding-mode menu", () => {
  it("shows every description in full, never truncated", () => {
    // The whole reason the menu exists. A description with its end
    // shaved off reads as a rendering bug and still does not answer the
    // question — so the menu is sized from its content rather than the
    // content being cut to fit the menu.
    const body = frame(0);
    for (const mode of CODING_MODES) {
      const look = codingModeLook(mode);
      expect(body, `${mode} label`).toContain(look.label);
      expect(body, `${mode} detail`).toContain(look.detail);
    }
    expect(body).not.toContain("…");
  });

  it("stacks the description rather than cutting it when the pane is narrow", () => {
    // Too narrow for two columns is not a licence to truncate: the
    // detail moves to its own indented line and stays whole.
    const body = frame(0, 40, 14);
    for (const mode of CODING_MODES) {
      expect(body, `${mode} detail`).toContain(codingModeLook(mode).detail);
    }
    expect(body).not.toContain("…");
  });

  it("hangs off the right edge, where the chip is", () => {
    // The chip sits at the far end of the composer's bar. A menu that
    // dropped from the opposite corner would read as belonging to
    // something else.
    const columns = 90;
    const lines = frame(0, columns, 12).split("\n");
    const top = lines.find((l) => l.includes("╭"));
    expect(top).toBeDefined();
    const right = (top as string).indexOf("╮");
    expect(right).toBeGreaterThanOrEqual(columns - 2);
  });

  it("marks the mode in force", () => {
    expect(frame(0)).toMatch(/✓\s*default/);
  });

  it("keeps the four rows even when the pane is too short for chrome", () => {
    // Title and footer are ornament; the rows are the content.
    const short = frame(0, 76, 6);
    for (const mode of CODING_MODES) {
      expect(short, `${mode} survived`).toContain(codingModeLook(mode).label);
    }
  });

  it("never draws wider or taller than the pane it was given", () => {
    for (const [columns, rows] of [[70, 12], [40, 8], [30, 6]] as const) {
      const lines = frame(0, columns, rows).split("\n");
      const widest = lines.reduce((a, l) => Math.max(a, l.length), 0);
      expect(widest, `${columns}x${rows} width`).toBeLessThanOrEqual(columns);
    }
  });
});

describe("driving the menu", () => {
  it("opens seeded on the mode in force", () => {
    // The menu opens as a statement of where you are before it is a list
    // of where you could go.
    const state = apply(
      stateWith({ codingMode: "auto" }),
      { type: "coding_mode_menu_opened" },
    );
    expect(state.codingModeMenu?.cursor).toBe(
      CODING_MODES.indexOf("auto"),
    );
  });

  it("wraps the cursor in both directions", () => {
    let state = apply(stateWith(), { type: "coding_mode_menu_opened" });
    expect(state.codingModeMenu?.cursor).toBe(0);
    state = apply(state, { type: "coding_mode_menu_cursor_moved", delta: -1 });
    expect(state.codingModeMenu?.cursor).toBe(CODING_MODES.length - 1);
    state = apply(state, { type: "coding_mode_menu_cursor_moved", delta: 1 });
    expect(state.codingModeMenu?.cursor).toBe(0);
  });

  it("applies a mode and closes", () => {
    let state = apply(stateWith(), { type: "coding_mode_menu_opened" });
    state = apply(state, { type: "coding_mode_cycled", mode: "plan" });
    expect(state.codingMode).toBe("plan");
    expect(state.codingModeMenu).toBeNull();
  });

  it("closes even when the row picked is the one already in force", () => {
    // Picking the row you are on is a decision too; leaving the popup up
    // would read as the click not landing.
    let state = apply(
      stateWith({ codingMode: "plan" }),
      { type: "coding_mode_menu_opened" },
    );
    state = apply(state, { type: "coding_mode_cycled", mode: "plan" });
    expect(state.codingMode).toBe("plan");
    expect(state.codingModeMenu).toBeNull();
  });

  it("cancels without changing the mode", () => {
    let state = apply(
      stateWith({ codingMode: "default" }),
      { type: "coding_mode_menu_opened" },
    );
    state = apply(state, { type: "coding_mode_menu_cursor_moved", delta: 1 });
    state = apply(state, { type: "coding_mode_menu_closed" });
    expect(state.codingModeMenu).toBeNull();
    // Moving the cursor previews nothing — unlike the theme picker, the
    // mode only changes when a row is actually chosen.
    expect(state.codingMode).toBe("default");
  });

  it("ignores a cursor move when the menu is shut", () => {
    const state = apply(stateWith(), {
      type: "coding_mode_menu_cursor_moved",
      delta: 1,
    });
    expect(state.codingModeMenu).toBeNull();
  });
});
