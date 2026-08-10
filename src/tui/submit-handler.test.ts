import { describe, expect, it, vi } from "vitest";
import { handleEditorSubmit } from "./submit-handler.js";
import {
  createInitialTuiState,
  type TuiSessionInfo,
  type TuiState,
} from "./tui-state.js";
import type { TuiAppCallbacks } from "./tui-app.js";

function fakeSession(overrides: Partial<TuiSessionInfo> = {}): TuiSessionInfo {
  return {
    sessionId: "s1",
    workingDir: "/tmp",
    llamaUrl: "http://127.0.0.1:8080",
    browserChannel: "chrome",
    browserHeadless: false,
    approvalLevel: 5,
    maxSteps: 10,
    skillCount: 0,
    ...overrides,
  };
}

function stubCallbacks(
  overrides: Partial<TuiAppCallbacks> = {},
): TuiAppCallbacks {
  return {
    onApprovalDecision: vi.fn(),
    onAbort: vi.fn(),
    onQuit: vi.fn(),
    onMessageSubmitted: vi.fn(),
    ...overrides,
  };
}

describe("handleEditorSubmit", () => {
  it("runs a registered command from the buffer even when the palette is closed", () => {
    const state = createInitialTuiState(fakeSession());
    const systemMessages: string[] = [];
    const dispatch = (a: { type: string; text?: string }): void => {
      if (a.type === "system_message" && a.text) systemMessages.push(a.text);
    };
    handleEditorSubmit("/clear", state, dispatch as never, stubCallbacks());
    expect(systemMessages.some((t) => t.includes("chat cleared"))).toBe(true);
  });

  it("with palette open, runs the buffer when it is a full registered command (stale slashQuery)", () => {
    const base = createInitialTuiState(fakeSession());
    const state: TuiState = {
      ...base,
      slashPaletteOpen: true,
      /** Stale: would make `filterSlashCommands(\"\")` return help first. */
      slashQuery: "",
      slashPaletteCursor: 0,
    };
    const systemMessages: string[] = [];
    const dispatch = (a: { type: string; text?: string }): void => {
      if (a.type === "system_message" && a.text) systemMessages.push(a.text);
    };
    handleEditorSubmit("/clear", state, dispatch as never, stubCallbacks());
    expect(systemMessages.some((t) => t.includes("chat cleared"))).toBe(true);
    expect(systemMessages.some((t) => t.includes("slash commands:"))).toBe(
      false,
    );
  });

  it("invokes onDebugBundleExportRequested for /dump", () => {
    const state = createInitialTuiState(fakeSession());
    const onDebugBundleExportRequested = vi.fn();
    const dispatch = vi.fn();
    handleEditorSubmit(
      "/dump",
      state,
      dispatch,
      stubCallbacks({ onDebugBundleExportRequested }),
    );
    expect(onDebugBundleExportRequested).toHaveBeenCalledTimes(1);
    expect(onDebugBundleExportRequested).toHaveBeenCalledWith(state);
  });

  it("maps /privacy level and the approve aliases onto onApprovalLevelSetRequested", () => {
    const state = createInitialTuiState(fakeSession());
    const onApprovalLevelSetRequested = vi.fn();
    const dispatch = vi.fn();
    const callbacks = stubCallbacks({ onApprovalLevelSetRequested });

    handleEditorSubmit("/privacy level 3", state, dispatch, callbacks);
    expect(onApprovalLevelSetRequested).toHaveBeenCalledWith(3);

    handleEditorSubmit("/privacy approve on", state, dispatch, callbacks);
    expect(onApprovalLevelSetRequested).toHaveBeenCalledWith(5);

    handleEditorSubmit("/privacy approve off", state, dispatch, callbacks);
    expect(onApprovalLevelSetRequested).toHaveBeenCalledWith(1);
    expect(onApprovalLevelSetRequested).toHaveBeenCalledTimes(3);
  });
});
