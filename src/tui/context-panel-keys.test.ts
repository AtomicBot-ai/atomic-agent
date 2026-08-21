import type { Key } from "ink";
import { describe, expect, it } from "vitest";
import { handleContextPanelKey } from "./context-panel-keys.js";
import type { TuiAction } from "./tui-action.js";
import { createInitialTuiState, type TuiState } from "./tui-state.js";
import { fakeSession } from "./test-fixtures.js";

function key(overrides: Partial<Key> = {}): Key {
  return {
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
    ...overrides,
  } as Key;
}

function open(): TuiState {
  return { ...createInitialTuiState(fakeSession()), contextPanelOpen: true };
}

function run(
  input: string,
  k: Key,
  state: TuiState = open(),
): { handled: boolean; actions: TuiAction[] } {
  const actions: TuiAction[] = [];
  const handled = handleContextPanelKey(input, k, {
    state,
    dispatch: (action) => actions.push(action),
  });
  return { handled, actions };
}

describe("handleContextPanelKey", () => {
  it("does nothing while the panel is closed", () => {
    const state = createInitialTuiState(fakeSession());
    expect(run("", key({ escape: true }), state)).toEqual({
      handled: false,
      actions: [],
    });
  });

  it("closes on esc, enter and q", () => {
    for (const [input, k] of [
      ["", key({ escape: true })],
      ["", key({ return: true })],
      ["q", key()],
    ] as const) {
      expect(run(input, k)).toEqual({
        handled: true,
        actions: [{ type: "context_panel_closed" }],
      });
    }
  });

  /**
   * The editor is unfocused while the panel owns input, so a swallowed
   * letter goes nowhere. Passing it on would park it in the buffer, to
   * surface later as a character the operator never meant to type.
   */
  it("swallows any other bare key", () => {
    expect(run("x", key())).toEqual({ handled: true, actions: [] });
  });

  /** `ctrl+c` still aborts a running turn from here. */
  it("lets modified keys through", () => {
    expect(run("c", key({ ctrl: true })).handled).toBe(false);
    expect(run("x", key({ meta: true })).handled).toBe(false);
  });
});
