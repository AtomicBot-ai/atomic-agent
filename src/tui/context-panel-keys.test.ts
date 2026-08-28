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

/**
 * The selector is the setting, so a step applies on the spot. There is
 * no draft to commit and nothing a second keystroke would confirm — the
 * panel is already showing what the value costs while it is chosen.
 */
describe("stepping the task selector", () => {
  function stepped(input: string): number[] {
    const steps: number[] = [];
    handleContextPanelKey(input, key(), {
      state: open(),
      dispatch: () => {},
      onStepPairs: (delta) => steps.push(delta),
    });
    return steps;
  }

  it("steps down and up", () => {
    expect(stepped("-")).toEqual([-1]);
    expect(stepped("_")).toEqual([-1]);
    expect(stepped("+")).toEqual([1]);
    expect(stepped("=")).toEqual([1]);
  });

  it("claims those keys even with nowhere to send them", () => {
    // The editor is unfocused while the panel owns input, so a `-` that
    // fell through would land in the buffer and surprise the operator
    // later.
    expect(handleContextPanelKey("-", key(), { state: open(), dispatch: () => {} })).toBe(
      true,
    );
  });

  it("leaves closing to the keys that close", () => {
    const actions: TuiAction[] = [];
    handleContextPanelKey("-", key(), {
      state: open(),
      dispatch: (a) => actions.push(a),
      onStepPairs: () => {},
    });
    expect(actions).toEqual([]);
  });

  it("still closes on enter, esc and q without touching the value", () => {
    for (const [input, k] of [
      ["", key({ return: true })],
      ["", key({ escape: true })],
      ["q", key()],
    ] as const) {
      let stepped = false;
      const actions: TuiAction[] = [];
      handleContextPanelKey(input, k, {
        state: open(),
        dispatch: (a) => actions.push(a),
        onStepPairs: () => {
          stepped = true;
        },
      });
      expect(actions).toEqual([{ type: "context_panel_closed" }]);
      expect(stepped).toBe(false);
    }
  });
});
