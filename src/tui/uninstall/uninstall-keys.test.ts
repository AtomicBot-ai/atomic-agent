import type { Key } from "ink";
import { describe, expect, it, vi } from "vitest";

import { handleAppKey } from "../app-key-bindings.js";
import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { reduceUninstallAction } from "./uninstall-reducer.js";
import type { UninstallAction } from "./uninstall-actions.js";
import type { UninstallPreview } from "./uninstall-state.js";

const PREVIEW: UninstallPreview = {
  rows: [
    {
      path: "/Users/op/.atomic-agent",
      label: "state",
      size: "1.7 GB",
      group: "data",
    },
  ],
  total: "1.7 GB",
  devCheckout: false,
};

function emptyKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...overrides,
  } as Key;
}

/** State with the ladder open at the given step. */
function openAt(step: "loading" | "review" | "confirm" | "closing"): TuiState {
  const actions: UninstallAction[] = [{ type: "uninstall_opened" }];
  if (step !== "loading") {
    actions.push({ type: "uninstall_plan_loaded", preview: PREVIEW });
  }
  if (step === "confirm" || step === "closing") {
    actions.push({ type: "uninstall_review_accepted" });
  }
  if (step === "closing") {
    actions.push(
      { type: "uninstall_typed_set", typed: "uninstall" },
      { type: "uninstall_started" },
    );
  }
  let state = createInitialTuiState(fakeSession());
  for (const action of actions) {
    state = reduceUninstallAction(state, action) ?? state;
  }
  return state;
}

function press(state: TuiState, input: string, key: Key = emptyKey()) {
  const dispatch = vi.fn();
  const onUninstallConfirmed = vi.fn();
  const handled = handleAppKey(input, key, {
    state,
    dispatch,
    callbacks: {
      onApprovalDecision: vi.fn(),
      onAbort: vi.fn(),
      onQuit: vi.fn(),
      onUninstallConfirmed,
    },
    ctrlCArmed: false,
    setCtrlCArmed: vi.fn(),
    sidebarVisible: false,
  });
  return { handled, dispatch, onUninstallConfirmed };
}

describe("uninstall ladder keys", () => {
  it("swallows keys meant for the app behind it", () => {
    const { handled } = press(openAt("review"), "z");
    expect(handled).toBe(true);
  });

  it("esc cancels from every answerable step", () => {
    for (const step of ["loading", "review", "confirm"] as const) {
      const { dispatch } = press(openAt(step), "", emptyKey({ escape: true }));
      expect(dispatch).toHaveBeenCalledWith({ type: "uninstall_closed" });
    }
  });

  it("does not treat y as an answer on the review step", () => {
    const { dispatch, onUninstallConfirmed } = press(openAt("review"), "y");
    expect(onUninstallConfirmed).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("enter on the review step closes while the cursor sits on cancel", () => {
    const { dispatch } = press(
      openAt("review"),
      "",
      emptyKey({ return: true }),
    );
    expect(dispatch).toHaveBeenCalledWith({ type: "uninstall_closed" });
  });

  it("takes a deliberate move to reach Continue", () => {
    const { dispatch } = press(
      openAt("review"),
      "",
      emptyKey({ rightArrow: true }),
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "uninstall_cursor_set",
      cursor: "continue",
    });
  });

  it("types into the confirm field instead of acting on it", () => {
    const { dispatch, onUninstallConfirmed } = press(openAt("confirm"), "u");
    expect(dispatch).toHaveBeenCalledWith({
      type: "uninstall_typed_set",
      typed: "u",
    });
    expect(onUninstallConfirmed).not.toHaveBeenCalled();
  });

  it("enter does nothing until the word is complete", () => {
    let state = openAt("confirm");
    state =
      reduceUninstallAction(state, {
        type: "uninstall_typed_set",
        typed: "uninstal",
      }) ?? state;
    const { dispatch, onUninstallConfirmed } = press(
      state,
      "",
      emptyKey({ return: true }),
    );
    expect(onUninstallConfirmed).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("enter fires once the word is complete", () => {
    let state = openAt("confirm");
    state =
      reduceUninstallAction(state, {
        type: "uninstall_typed_set",
        typed: "uninstall",
      }) ?? state;
    const { dispatch, onUninstallConfirmed } = press(
      state,
      "",
      emptyKey({ return: true }),
    );
    expect(dispatch).toHaveBeenCalledWith({ type: "uninstall_started" });
    expect(onUninstallConfirmed).toHaveBeenCalledOnce();
    // Without this the app never unmounts and the post-exit removal
    // in tui-command never runs — the ladder froze on "closing".
    expect(dispatch).toHaveBeenCalledWith({ type: "quit_requested" });
  });

  it("backspace clears what was typed", () => {
    let state = openAt("confirm");
    state =
      reduceUninstallAction(state, {
        type: "uninstall_typed_set",
        typed: "uni",
      }) ?? state;
    const { dispatch } = press(state, "", emptyKey({ backspace: true }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "uninstall_typed_set",
      typed: "un",
    });
  });

  it("caps a paste so the field stays clearable", () => {
    const { dispatch } = press(openAt("confirm"), "x".repeat(500));
    const typed = dispatch.mock.calls[0]?.[0]?.typed as string;
    expect(typed.length).toBeLessThanOrEqual(32);
  });

  it("ctrl+c closes the dialog and hands the key on", () => {
    const { handled, dispatch } = press(
      openAt("review"),
      "c",
      emptyKey({ ctrl: true }),
    );
    expect(dispatch).toHaveBeenCalledWith({ type: "uninstall_closed" });
    expect(handled).toBe(false);
  });

  it("answers nothing once the app is on its way down", () => {
    for (const [input, key] of [
      ["", emptyKey({ escape: true })],
      ["", emptyKey({ return: true })],
      ["c", emptyKey({ ctrl: true })],
    ] as const) {
      const { handled, dispatch } = press(openAt("closing"), input, key);
      expect(handled).toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
    }
  });

  describe("desktop question", () => {
    const SHARED_PREVIEW: UninstallPreview = {
      ...PREVIEW,
      desktopSharedDir: "/Users/op/.atomic-agent",
    };
    function typedOut(): TuiState {
      let state = createInitialTuiState(fakeSession());
      for (const action of [
        { type: "uninstall_opened" },
        { type: "uninstall_plan_loaded", preview: SHARED_PREVIEW },
        { type: "uninstall_review_accepted" },
        { type: "uninstall_typed_set", typed: "uninstall" },
      ] as UninstallAction[]) {
        state = reduceUninstallAction(state, action) ?? state;
      }
      return state;
    }
    function atDesktop(): TuiState {
      return (
        reduceUninstallAction(typedOut(), { type: "uninstall_desktop_asked" }) ??
        typedOut()
      );
    }

    it("enter on the complete word asks the desktop question instead of starting", () => {
      const { dispatch, onUninstallConfirmed } = press(
        typedOut(),
        "",
        emptyKey({ return: true }),
      );
      expect(dispatch).toHaveBeenCalledWith({ type: "uninstall_desktop_asked" });
      expect(dispatch).not.toHaveBeenCalledWith({ type: "uninstall_started" });
      expect(onUninstallConfirmed).not.toHaveBeenCalled();
    });

    it("enter right away keeps the desktop data", () => {
      const { dispatch, onUninstallConfirmed } = press(
        atDesktop(),
        "",
        emptyKey({ return: true }),
      );
      expect(dispatch).toHaveBeenCalledWith({ type: "uninstall_started" });
      expect(onUninstallConfirmed).toHaveBeenCalledWith({ keepDesktopData: true });
      expect(dispatch).toHaveBeenCalledWith({ type: "quit_requested" });
    });

    it("takes a deliberate move to reach Delete too", () => {
      const { dispatch } = press(atDesktop(), "", emptyKey({ rightArrow: true }));
      expect(dispatch).toHaveBeenCalledWith({
        type: "uninstall_desktop_cursor_set",
        cursor: "delete",
      });
      let state = atDesktop();
      state =
        reduceUninstallAction(state, {
          type: "uninstall_desktop_cursor_set",
          cursor: "delete",
        }) ?? state;
      const pressed = press(state, "", emptyKey({ return: true }));
      expect(pressed.onUninstallConfirmed).toHaveBeenCalledWith({
        keepDesktopData: false,
      });
    });

    it("does not treat y or n as answers", () => {
      for (const input of ["y", "n"]) {
        const { dispatch, onUninstallConfirmed } = press(atDesktop(), input);
        expect(dispatch).not.toHaveBeenCalled();
        expect(onUninstallConfirmed).not.toHaveBeenCalled();
      }
    });

    it("esc cancels the whole uninstall from the desktop question", () => {
      const { dispatch, onUninstallConfirmed } = press(
        atDesktop(),
        "",
        emptyKey({ escape: true }),
      );
      expect(dispatch).toHaveBeenCalledWith({ type: "uninstall_closed" });
      expect(onUninstallConfirmed).not.toHaveBeenCalled();
    });

    it("keeps desktop data by default when the question was never asked", () => {
      let state = openAt("confirm");
      state =
        reduceUninstallAction(state, {
          type: "uninstall_typed_set",
          typed: "uninstall",
        }) ?? state;
      const { onUninstallConfirmed } = press(state, "", emptyKey({ return: true }));
      // Not asked means not agreed: if the post-exit plan finds the
      // desktop app after all, its folder must survive.
      expect(onUninstallConfirmed).toHaveBeenCalledWith({ keepDesktopData: true });
    });
  });
});
