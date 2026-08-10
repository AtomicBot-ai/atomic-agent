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
    approvalRequired: false,
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

  it("routes the /model picker request through the callback, not dispatch", () => {
    // The orchestrator that owns the /v1/models fetch listens on the
    // event bus; a dispatched request action is a reducer no-op it
    // never sees, which is why /model looked dead in the app.
    const state = createInitialTuiState(fakeSession());
    const dispatched: Array<{ type: string }> = [];
    const onPickerRequested = vi.fn();
    handleEditorSubmit(
      "/model",
      state,
      ((a: { type: string }) => dispatched.push(a)) as never,
      stubCallbacks({ onProvidersChatModelPickerRequested: onPickerRequested }),
    );
    expect(onPickerRequested).toHaveBeenCalledWith(null);
    expect(
      dispatched.some(
        (a) => a.type === "providers_chat_model_picker_requested",
      ),
    ).toBe(false);
    // The jump to the LLM tab still travels through the reducer.
    expect(dispatched.some((a) => a.type === "tab_changed")).toBe(true);
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

  it("maps /privacy approve on|off onto onApproveEverythingSetRequested", () => {
    const state = createInitialTuiState(fakeSession());
    const onApproveEverythingSetRequested = vi.fn();
    const dispatch = vi.fn();
    const callbacks = stubCallbacks({ onApproveEverythingSetRequested });

    handleEditorSubmit("/privacy approve on", state, dispatch, callbacks);
    expect(onApproveEverythingSetRequested).toHaveBeenCalledWith(true);

    handleEditorSubmit("/privacy approve off", state, dispatch, callbacks);
    expect(onApproveEverythingSetRequested).toHaveBeenCalledWith(false);
    expect(onApproveEverythingSetRequested).toHaveBeenCalledTimes(2);
  });
});
