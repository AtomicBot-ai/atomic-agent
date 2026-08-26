import { describe, expect, it } from "vitest";
import {
  backdropRevertsThemePreview,
  resolveBackdropDismissal,
} from "./backdrop-dismissal.js";
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

function stateWith(overrides: Partial<TuiState>): TuiState {
  return { ...createInitialTuiState(session()), ...overrides };
}

describe("what a click outside closes", () => {
  it("declines the event when nothing is open", () => {
    // Returning an action here would make every stray click in the chat
    // dispatch a close for a surface that is not there.
    expect(resolveBackdropDismissal(stateWith({}))).toBeNull();
  });

  /**
   * The reported bug. `modalOwnsInput` raises the mouse floor for all
   * three pickers, so while one was open every control on screen stopped
   * answering — and no target took the click that would have closed it
   * either. The picker was not modal, it was a hole in the app that only
   * the keyboard could climb out of.
   */
  it("closes the theme picker", () => {
    expect(resolveBackdropDismissal(stateWith({ themePickerOpen: true }))).toEqual(
      { type: "theme_picker_closed" },
    );
  });

  it("closes the session picker", () => {
    expect(
      resolveBackdropDismissal(stateWith({ sessionPickerOpen: true })),
    ).toEqual({ type: "session_picker_closed" });
  });

  it("closes the slash palette", () => {
    expect(
      resolveBackdropDismissal(stateWith({ slashPaletteOpen: true })),
    ).toEqual({ type: "slash_palette_closed" });
  });

  it("still closes everything it closed before", () => {
    expect(resolveBackdropDismissal(stateWith({ menuOpen: true }))).toEqual({
      type: "menu_closed",
    });
    expect(
      resolveBackdropDismissal(stateWith({ contextPanelOpen: true })),
    ).toEqual({ type: "context_panel_closed" });
  });

  it("resolves a stack to one action, in the documented order", () => {
    // The chain is defensive rather than descriptive: the menu closes
    // itself before activating a node (`handleMenuKey` dispatches
    // `menu_closed` and *then* calls `activate`), so a menu and a picker
    // do not actually coexist. What the order guarantees is that a click
    // never dispatches two closes, and never picks a surface that is not
    // the frontmost one when they do overlap — the confirm ladder, which
    // genuinely does open over the menu.
    expect(
      resolveBackdropDismissal(
        stateWith({ menuOpen: true, contextPanelOpen: true }),
      ),
    ).toEqual({ type: "context_panel_closed" });
    expect(
      resolveBackdropDismissal(
        stateWith({ menuOpen: true, themePickerOpen: true }),
      ),
    ).toEqual({ type: "menu_closed" });
  });
});

describe("cancelling the theme picker puts the palette back", () => {
  it("asks for a revert only for the theme picker", () => {
    // The picker previews live, so a dismissal that skipped the revert
    // would silently *apply* whatever the cursor was resting on — the
    // opposite of a cancel.
    expect(backdropRevertsThemePreview(stateWith({ themePickerOpen: true }))).toBe(
      true,
    );
    expect(backdropRevertsThemePreview(stateWith({ menuOpen: true }))).toBe(false);
    expect(backdropRevertsThemePreview(stateWith({}))).toBe(false);
  });

  it("does not revert when another surface wins the click", () => {
    // The revert is keyed off the resolved action, not off
    // `themePickerOpen`, so it can never fire for a click that closed
    // something else and left the picker up.
    expect(
      backdropRevertsThemePreview(
        stateWith({ themePickerOpen: true, contextPanelOpen: true }),
      ),
    ).toBe(false);
  });
});
