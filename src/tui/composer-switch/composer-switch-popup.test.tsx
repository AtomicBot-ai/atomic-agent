import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { MouseProvider } from "../mouse/mouse-context.js";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { MouseTargetRegistry } from "../mouse/mouse-registry.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { cloudState } from "./composer-switch-fixtures.js";
import { ComposerSwitchPopup } from "./composer-switch-popup.js";
import type { ComposerSwitchRow } from "./composer-switch-rows.js";

const PANE_ROWS = 18;
const PANE_COLUMNS = 72;

function strip(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function locate(frame: string, needle: string): { x: number; y: number } {
  const lines = frame.split("\n");
  for (const [y, line] of lines.entries()) {
    const x = line.indexOf(needle);
    if (x !== -1) return { x, y };
  }
  throw new Error(`"${needle}" is not on screen:\n${frame}`);
}

function click(x: number, y: number): TuiMouseEvent {
  return {
    kind: "press",
    button: "left",
    wheel: null,
    x,
    y,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

/**
 * The popup inside a pane the size of the real content column, with
 * chat text under it, so the occlusion assertion has something to cover.
 * The registry is the real one: a click goes through genuine Yoga
 * hit-testing rather than a hand-fed rectangle.
 */
async function mount(state: TuiState) {
  const registry = new MouseTargetRegistry();
  const picked: ComposerSwitchRow[] = [];
  const actions: TuiAction[] = [];
  const { lastFrame, unmount } = render(
    <MouseProvider
      registry={registry}
      dispatch={(action: TuiAction) => actions.push(action)}
      callbacks={{} as TuiAppCallbacks}
      getState={() => state}
    >
      <Box
        flexDirection="column"
        position="relative"
        width={PANE_COLUMNS}
        height={PANE_ROWS}
      >
        {Array.from({ length: PANE_ROWS }, (_unused, row) => (
          <Text key={`bg-${row}`}>{"chat-log-line".repeat(4)}</Text>
        ))}
        <ComposerSwitchPopup
          state={state}
          availableRows={PANE_ROWS}
          availableColumns={PANE_COLUMNS}
          onActivate={(row) => picked.push(row)}
        />
      </Box>
    </MouseProvider>,
  );
  // Ink commits on its own throttle and React registers the click
  // targets in the effect after that commit, so a freshly mounted row is
  // not hit-testable on the very first tick.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return {
    registry,
    picked,
    actions,
    frame: () => strip(lastFrame() ?? ""),
    unmount,
  };
}

function open(
  kind: "backend" | "provider" | "model",
  cursor = 0,
): TuiState {
  return { ...cloudState(), composerSwitch: { kind, cursor } };
}

describe("the switch popup", () => {
  it("lists the three backends and marks the live one", async () => {
    const app = await mount(open("backend"));
    const frame = app.frame();
    expect(frame).toContain("WHERE IT RUNS");
    expect(frame).toContain("cloud");
    expect(frame).toContain("local");
    expect(frame).toContain("custom");
    expect(frame).toContain("↑↓ move");
    expect(frame).toContain("←→ switch");
    app.unmount();
  });

  it("paints over the chat rather than pushing it aside", async () => {
    const app = await mount(open("provider"));
    const lines = app.frame().split("\n");
    // The pane is exactly PANE_ROWS tall with the popup floating in it:
    // an overlay that reflowed the column would make it taller.
    expect(lines.length).toBe(PANE_ROWS);
    const title = locate(app.frame(), "PROVIDER");
    // Every cell of the popup's own row is the popup's, so none of the
    // chat text underneath survives on it.
    expect(lines[title.y]).not.toContain("chat-log-line");
    app.unmount();
  });

  it("hands a clicked row to the activator", async () => {
    const app = await mount(open("provider"));
    const { x, y } = locate(app.frame(), "Add a new provider");
    expect(app.registry.dispatch(click(x, y))).toBe(true);
    expect(app.picked.map((row) => row.label)).toEqual(["Add a new provider"]);
    expect(app.actions).toContainEqual({
      type: "composer_switch_cursor_set",
      cursor: 2,
    });
    app.unmount();
  });

  it("swallows a press on its own chrome so the backdrop cannot close it", async () => {
    const app = await mount(open("backend"));
    const { x, y } = locate(app.frame(), "WHERE IT RUNS");
    expect(app.registry.dispatch(click(x, y))).toBe(true);
    expect(app.picked).toEqual([]);
    app.unmount();
  });

  it("ignores a right-button press on a row", async () => {
    const app = await mount(open("backend"));
    const { x, y } = locate(app.frame(), "cloud");
    expect(app.registry.dispatch({ ...click(x, y), button: "right" })).toBe(
      false,
    );
    expect(app.picked).toEqual([]);
    app.unmount();
  });

  it("fits its own budget on a pane with almost no rows", async () => {
    const state = open("model");
    const registry = new MouseTargetRegistry();
    const { lastFrame, unmount } = render(
      <MouseProvider
        registry={registry}
        dispatch={() => {}}
        callbacks={{} as TuiAppCallbacks}
        getState={() => state}
      >
        <Box flexDirection="column" position="relative" width={30} height={7}>
          <ComposerSwitchPopup
            state={state}
            availableRows={7}
            availableColumns={30}
            onActivate={() => {}}
          />
        </Box>
      </MouseProvider>,
    );
    const lines = strip(lastFrame() ?? "").split("\n");
    expect(lines.length).toBeLessThanOrEqual(7);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(
      30,
    );
    unmount();
  });
});
