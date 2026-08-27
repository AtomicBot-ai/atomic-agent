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
 * The dial has to be safe to fiddle with: `-` and `+` only ever change
 * what the panel is showing, and only Enter writes anything.
 */
describe("pricing a different task count", () => {
  const withDraft = (draft: number | null): TuiState => ({
    ...open(),
    contextPanelPairsDraft: draft,
    contextUsage: { ...open().contextUsage, conversationPairsCap: 20 },
  });

  it("moves the draft down and up", () => {
    expect(run("-", key(), withDraft(null)).actions).toEqual([
      { type: "context_pairs_draft_moved", delta: -1 },
    ]);
    expect(run("+", key(), withDraft(null)).actions).toEqual([
      { type: "context_pairs_draft_moved", delta: 1 },
    ]);
  });

  it("writes nothing while the operator is still choosing", () => {
    let written: number | null = null;
    handleContextPanelKey("-", key(), {
      state: withDraft(null),
      dispatch: () => {},
      onSetPairs: (n) => {
        written = n;
      },
    });
    expect(written).toBeNull();
  });

  it("commits on enter and closes", () => {
    let written: number | null = null;
    const actions: TuiAction[] = [];
    handleContextPanelKey("", key({ return: true }), {
      state: withDraft(6),
      dispatch: (a) => actions.push(a),
      onSetPairs: (n) => {
        written = n;
      },
    });
    expect(written).toBe(6);
    expect(actions).toEqual([{ type: "context_panel_closed" }]);
  });

  it("throws the draft away on esc", () => {
    // What makes trying a number out free.
    let written: number | null = null;
    handleContextPanelKey("", key({ escape: true }), {
      state: withDraft(3),
      dispatch: () => {},
      onSetPairs: (n) => {
        written = n;
      },
    });
    expect(written).toBeNull();
  });

  it("commits nothing on enter when no number was tried", () => {
    let called = false;
    handleContextPanelKey("", key({ return: true }), {
      state: withDraft(null),
      dispatch: () => {},
      onSetPairs: () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });
});
