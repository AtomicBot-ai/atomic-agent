import type { Key } from "ink";
import { describe, expect, it } from "vitest";

import type { TuiAppCallbacks } from "../../tui-app.js";
import type { TuiAction } from "../../tui-action.js";
import { fakeSession } from "../../test-fixtures.js";
import { createInitialTuiState } from "../../tui-state.js";
import type { TuiState } from "../../tui-state.js";
import { handleLlmPanelKey } from "../llm-panel-key-bindings.js";
import type { FallbackLinkRow } from "./fallback-panel-state.js";

function emptyKey(overrides: Partial<Key> = {}): Key {
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
  };
}

const noopCallbacks: TuiAppCallbacks = {};

function link(providerId: string, over: Partial<FallbackLinkRow> = {}): FallbackLinkRow {
  return {
    providerId,
    modelLabel: null,
    kind: "openrouter",
    isActive: false,
    isAppendedLocal: false,
    ...over,
  };
}

/** Fallback pane in debug mode with a 3-link chain and one addable. */
function fallbackState(over: Partial<TuiState> = {}): TuiState {
  const base = createInitialTuiState(fakeSession());
  return {
    ...base,
    uiMode: "debug",
    activeTab: "llm",
    llmPanel: { ...base.llmPanel, mode: "fallback", fallbackCursor: 1 },
    fallbackPanel: {
      ...base.fallbackPanel,
      links: [
        link("cloud-a", { isActive: true }),
        link("cloud-b"),
        link("local-llama", { kind: "llama-server", isAppendedLocal: true }),
      ],
      addableProviderIds: ["cloud-c"],
      appendLocal: true,
    },
    ...over,
  };
}

function press(input: string, key: Key, state: TuiState) {
  const dispatched: TuiAction[] = [];
  const handled = handleLlmPanelKey(input, key, {
    state,
    dispatch: (action) => dispatched.push(action),
    callbacks: noopCallbacks,
  });
  return { handled, dispatched };
}

describe("fallback pane key routing", () => {
  it("moves the selected link down with >", () => {
    const { handled, dispatched } = press(">", emptyKey(), fallbackState());
    expect(handled).toBe(true);
    expect(dispatched).toEqual([
      { type: "fallback_move_requested", providerId: "cloud-b", delta: 1 },
    ]);
  });

  it("moves the selected link up with <", () => {
    const { dispatched } = press("<", emptyKey(), fallbackState());
    expect(dispatched).toEqual([
      { type: "fallback_move_requested", providerId: "cloud-b", delta: -1 },
    ]);
  });

  it("removes the selected link with d", () => {
    const { dispatched } = press("d", emptyKey(), fallbackState());
    expect(dispatched).toEqual([
      { type: "fallback_remove_requested", providerId: "cloud-b" },
    ]);
  });

  it("toggles appendLocal with l", () => {
    const { dispatched } = press("l", emptyKey(), fallbackState());
    expect(dispatched).toEqual([
      { type: "fallback_append_local_toggle_requested" },
    ]);
  });

  it("opens the add-link picker with a", () => {
    const { dispatched } = press("a", emptyKey(), fallbackState());
    expect(dispatched).toEqual([{ type: "fallback_add_picker_opened" }]);
  });

  it("moves the row cursor with j (clamped to the row count)", () => {
    const { dispatched } = press("j", emptyKey(), fallbackState());
    // 3 links + 1 add row = 4 rows, indices 0..3. From cursor 1 → 2.
    expect(dispatched).toEqual([{ type: "llm_cursor_set", cursor: 2 }]);
  });

  it("adds the picked provider on Enter inside the picker", () => {
    const state = fallbackState({
      fallbackPanel: {
        ...fallbackState().fallbackPanel,
        addPicker: { cursor: 0 },
      },
    });
    const { dispatched } = press("", emptyKey({ return: true }), state);
    expect(dispatched).toEqual([
      { type: "fallback_add_requested", providerId: "cloud-c" },
      { type: "fallback_add_picker_closed" },
    ]);
  });

  it("lets the shared pane-switch key fall through (does not consume [ )", () => {
    const { dispatched } = press("[", emptyKey(), fallbackState());
    // The fallback handler does not claim '[', so the shared handler
    // switches panes (fallback -> external, one step left).
    expect(dispatched).toEqual([{ type: "llm_mode_set", mode: "external" }]);
  });
});
