import type { Key } from "ink";
import { describe, expect, it, vi } from "vitest";

import type { LocalModelDef } from "../../local-llm/index.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type TuiSessionInfo } from "../tui-state.js";
import { handleLocalModelsTabKey } from "./local-models-key-bindings.js";
import type { LocalModelRow, MmprojStatus } from "./local-models-panel-state.js";

const SESSION: TuiSessionInfo = {
  sessionId: null,
  workingDir: "/tmp",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: true,
  approvalRequired: false,
  maxSteps: 10,
  skillCount: 0,
};

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

function makeRow(
  id: LocalModelRow["id"],
  opts: {
    supportsVision: boolean;
    downloaded: boolean;
    mmprojStatus: MmprojStatus;
    active?: boolean;
  },
): LocalModelRow {
  const def: LocalModelDef = {
    id,
    name: id,
    filename: `${id}.gguf`,
    huggingFaceUrl: "u",
    fileSizeGb: 1,
    sizeLabel: "1",
    description: "",
    maxContextLength: 1,
    contextLabel: "1",
    minRamGb: 1,
    recommendedRamGb: 1,
    family: "qwen",
    supportsVision: opts.supportsVision,
  };
  return {
    id,
    def,
    downloaded: opts.downloaded,
    mmprojStatus: opts.mmprojStatus,
    active: opts.active ?? false,
  };
}

function stateWithRow(row: LocalModelRow) {
  const initial = createInitialTuiState(SESSION);
  return {
    ...initial,
    uiMode: "debug" as const,
    activeTab: "models" as const,
    localModelsPanel: {
      ...initial.localModelsPanel,
      rows: [row],
      cursor: 0,
    },
  };
}

describe("handleLocalModelsTabKey — vision-aware Enter / g hotkey", () => {
  it("Enter on a missing GGUF + vision row triggers with-mmproj pull", () => {
    const onPull = vi.fn();
    const callbacks: TuiAppCallbacks = {
      onApprovalDecision: vi.fn(),
      onAbort: vi.fn(),
      onQuit: vi.fn(),
      onMessageSubmitted: vi.fn(),
      onLocalModelsPullRequested: onPull,
    };
    const state = stateWithRow(
      makeRow("gemma-4-e4b", {
        supportsVision: true,
        downloaded: false,
        mmprojStatus: "missing",
      }),
    );
    const handled = handleLocalModelsTabKey("", emptyKey({ return: true }), {
      state,
      dispatch: vi.fn(),
      callbacks,
    });
    expect(handled).toBe(true);
    expect(onPull).toHaveBeenCalledWith("gemma-4-e4b", "with-mmproj");
  });

  it("Enter on a downloaded GGUF + missing mmproj row triggers mmproj-only pull", () => {
    const onPull = vi.fn();
    const callbacks: TuiAppCallbacks = {
      onApprovalDecision: vi.fn(),
      onAbort: vi.fn(),
      onQuit: vi.fn(),
      onMessageSubmitted: vi.fn(),
      onLocalModelsPullRequested: onPull,
    };
    const state = stateWithRow(
      makeRow("gemma-4-e4b", {
        supportsVision: true,
        downloaded: true,
        mmprojStatus: "missing",
      }),
    );
    const handled = handleLocalModelsTabKey("", emptyKey({ return: true }), {
      state,
      dispatch: vi.fn(),
      callbacks,
    });
    expect(handled).toBe(true);
    expect(onPull).toHaveBeenCalledWith("gemma-4-e4b", "mmproj-only");
  });

  it("Enter on a fully-downloaded vision row sets active without re-pulling", () => {
    const onPull = vi.fn();
    const onSetActive = vi.fn();
    const callbacks: TuiAppCallbacks = {
      onApprovalDecision: vi.fn(),
      onAbort: vi.fn(),
      onQuit: vi.fn(),
      onMessageSubmitted: vi.fn(),
      onLocalModelsPullRequested: onPull,
      onLocalModelsSetActiveRequested: onSetActive,
    };
    const state = stateWithRow(
      makeRow("gemma-4-e4b", {
        supportsVision: true,
        downloaded: true,
        mmprojStatus: "downloaded",
        active: false,
      }),
    );
    handleLocalModelsTabKey("", emptyKey({ return: true }), {
      state,
      dispatch: vi.fn(),
      callbacks,
    });
    expect(onPull).not.toHaveBeenCalled();
    expect(onSetActive).toHaveBeenCalledWith("gemma-4-e4b");
  });

  it("`g` on a missing-GGUF row triggers a gguf-only pull", () => {
    const onPull = vi.fn();
    const callbacks: TuiAppCallbacks = {
      onApprovalDecision: vi.fn(),
      onAbort: vi.fn(),
      onQuit: vi.fn(),
      onMessageSubmitted: vi.fn(),
      onLocalModelsPullRequested: onPull,
    };
    const state = stateWithRow(
      makeRow("gemma-4-e4b", {
        supportsVision: true,
        downloaded: false,
        mmprojStatus: "missing",
      }),
    );
    const handled = handleLocalModelsTabKey("g", emptyKey(), {
      state,
      dispatch: vi.fn() as (a: TuiAction) => void,
      callbacks,
    });
    expect(handled).toBe(true);
    expect(onPull).toHaveBeenCalledWith("gemma-4-e4b", "gguf-only");
  });

  it("`g` on a row with GGUF already on disk is a no-op", () => {
    const onPull = vi.fn();
    const callbacks: TuiAppCallbacks = {
      onApprovalDecision: vi.fn(),
      onAbort: vi.fn(),
      onQuit: vi.fn(),
      onMessageSubmitted: vi.fn(),
      onLocalModelsPullRequested: onPull,
    };
    const state = stateWithRow(
      makeRow("gemma-4-e4b", {
        supportsVision: true,
        downloaded: true,
        mmprojStatus: "missing",
      }),
    );
    handleLocalModelsTabKey("g", emptyKey(), {
      state,
      dispatch: vi.fn(),
      callbacks,
    });
    expect(onPull).not.toHaveBeenCalled();
  });

  it("Enter on a text-only Qwen row pulls GGUF (with-mmproj is harmless because mmprojStatus=n/a)", () => {
    const onPull = vi.fn();
    const callbacks: TuiAppCallbacks = {
      onApprovalDecision: vi.fn(),
      onAbort: vi.fn(),
      onQuit: vi.fn(),
      onMessageSubmitted: vi.fn(),
      onLocalModelsPullRequested: onPull,
    };
    const state = stateWithRow(
      makeRow("qwen-3.5-4b", {
        supportsVision: false,
        downloaded: false,
        mmprojStatus: "n/a",
      }),
    );
    handleLocalModelsTabKey("", emptyKey({ return: true }), {
      state,
      dispatch: vi.fn(),
      callbacks,
    });
    expect(onPull).toHaveBeenCalledWith("qwen-3.5-4b", "with-mmproj");
  });
});
