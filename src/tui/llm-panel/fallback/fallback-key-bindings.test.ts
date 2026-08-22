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

/**
 * Runs a key through the panel handler recording BOTH channels: the pure
 * UI actions it dispatches and the edit callbacks it fires. The edits
 * must be callbacks — a dispatched edit intent would dead-end in the
 * reducer and never reach `FallbackOrchestrator` (the original defect).
 */
function press(input: string, key: Key, state: TuiState) {
  const dispatched: TuiAction[] = [];
  const calls: unknown[][] = [];
  const callbacks: TuiAppCallbacks = {
    onFallbackMoveRequested: (providerId, delta) =>
      calls.push(["move", providerId, delta]),
    onFallbackAddRequested: (providerId) => calls.push(["add", providerId]),
    onFallbackRemoveRequested: (providerId) =>
      calls.push(["remove", providerId]),
    onFallbackAppendLocalToggleRequested: () => calls.push(["toggleLocal"]),
  };
  const handled = handleLlmPanelKey(input, key, {
    state,
    dispatch: (action) => dispatched.push(action),
    callbacks,
  });
  return { handled, dispatched, calls };
}

describe("fallback pane key routing", () => {
  it("moves the selected link down with > via the callback, not dispatch", () => {
    const { handled, dispatched, calls } = press(">", emptyKey(), fallbackState());
    expect(handled).toBe(true);
    expect(calls).toEqual([["move", "cloud-b", 1]]);
    expect(dispatched).toEqual([]);
  });

  it("moves the selected link up with <", () => {
    const { calls } = press("<", emptyKey(), fallbackState());
    expect(calls).toEqual([["move", "cloud-b", -1]]);
  });

  it("removes the selected link with d", () => {
    const { dispatched, calls } = press("d", emptyKey(), fallbackState());
    expect(calls).toEqual([["remove", "cloud-b"]]);
    expect(dispatched).toEqual([]);
  });

  it("toggles appendLocal with l", () => {
    const { calls } = press("l", emptyKey(), fallbackState());
    expect(calls).toEqual([["toggleLocal"]]);
  });

  it("opens the add-link picker with a (pure UI, dispatched)", () => {
    const { dispatched, calls } = press("a", emptyKey(), fallbackState());
    expect(dispatched).toEqual([{ type: "fallback_add_picker_opened" }]);
    expect(calls).toEqual([]);
  });

  it("moves the row cursor with j (clamped to the row count)", () => {
    const { dispatched } = press("j", emptyKey(), fallbackState());
    // 3 links + 1 add row = 4 rows, indices 0..3. From cursor 1 → 2.
    expect(dispatched).toEqual([{ type: "llm_cursor_set", cursor: 2 }]);
  });

  it("adds the picked provider on Enter inside the picker via the callback", () => {
    const state = fallbackState({
      fallbackPanel: {
        ...fallbackState().fallbackPanel,
        addPicker: { cursor: 0 },
      },
    });
    const { dispatched, calls } = press("", emptyKey({ return: true }), state);
    expect(calls).toEqual([["add", "cloud-c"]]);
    expect(dispatched).toEqual([{ type: "fallback_add_picker_closed" }]);
  });

  it("lets the shared pane-switch key fall through (does not consume [ )", () => {
    const { dispatched } = press("[", emptyKey(), fallbackState());
    // The fallback handler does not claim '[', so the shared handler
    // switches panes (fallback -> external, one step left).
    expect(dispatched).toEqual([{ type: "llm_mode_set", mode: "external" }]);
  });
});
