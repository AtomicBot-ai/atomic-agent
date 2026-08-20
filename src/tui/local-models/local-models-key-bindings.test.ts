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
  approvalLevel: 5,
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

  it("'G' cycles the managed GPU device regardless of the cursor row type", () => {
    const onCycle = vi.fn();
    const callbacks: TuiAppCallbacks = {
      onApprovalDecision: vi.fn(),
      onAbort: vi.fn(),
      onQuit: vi.fn(),
      onMessageSubmitted: vi.fn(),
      onLocalModelsDeviceCycleRequested: onCycle,
    };
    const state = stateWithRow(
      makeRow("gemma-4-e4b", {
        supportsVision: true,
        downloaded: true,
        mmprojStatus: "downloaded",
      }),
    );
    const handled = handleLocalModelsTabKey("G", emptyKey({ shift: true }), {
      state,
      dispatch: vi.fn(),
      callbacks,
    });
    expect(handled).toBe(true);
    expect(onCycle).toHaveBeenCalledTimes(1);
  });

  // The flag is on by default and drives a background download, so it
  // needs an in-TUI way out: the CLI equivalent rewrites the whole
  // config file. Like `G`, it ignores the cursor row.
  it("'U' toggles backend auto-update regardless of the cursor row type", () => {
    const onToggle = vi.fn();
    const callbacks: TuiAppCallbacks = {
      onApprovalDecision: vi.fn(),
      onAbort: vi.fn(),
      onQuit: vi.fn(),
      onMessageSubmitted: vi.fn(),
      onLocalModelsAutoUpdateToggleRequested: onToggle,
    };
    const state = stateWithRow(
      makeRow("gemma-4-e4b", { downloaded: true, mmprojStatus: "downloaded" }),
    );
    const handled = handleLocalModelsTabKey("U", emptyKey({ shift: true }), {
      state,
      dispatch: vi.fn(),
      callbacks,
    });
    expect(handled).toBe(true);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  // Lowercase must not trigger it — `u` is unbound here, and silently
  // flipping a background-download setting on a stray keypress is the
  // kind of surprise the uppercase convention exists to prevent.
  it("lowercase 'u' does not toggle backend auto-update", () => {
    const onToggle = vi.fn();
    const callbacks: TuiAppCallbacks = {
      onApprovalDecision: vi.fn(),
      onAbort: vi.fn(),
      onQuit: vi.fn(),
      onMessageSubmitted: vi.fn(),
      onLocalModelsAutoUpdateToggleRequested: onToggle,
    };
    const state = stateWithRow(
      makeRow("gemma-4-e4b", { downloaded: true, mmprojStatus: "downloaded" }),
    );
    handleLocalModelsTabKey("u", emptyKey(), {
      state,
      dispatch: vi.fn(),
      callbacks,
    });
    expect(onToggle).not.toHaveBeenCalled();
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

  it("y on the embedding-onboarding modal resolves with accept=true", () => {
    const onResolved = vi.fn();
    const callbacks: TuiAppCallbacks = {
      onApprovalDecision: vi.fn(),
      onAbort: vi.fn(),
      onQuit: vi.fn(),
      onMessageSubmitted: vi.fn(),
      onLocalModelsEmbeddingOnboardingResolved: onResolved,
    };
    const initial = createInitialTuiState(SESSION);
    const state = {
      ...initial,
      uiMode: "debug" as const,
      activeTab: "models" as const,
      localModelsPanel: {
        ...initial.localModelsPanel,
        embeddingOnboardingPrompt: {
          modelId: "nomic-embed-text-v1.5" as const,
          name: "Nomic Embed Text v1.5",
          sizeLabel: "~84 MB",
        },
      },
    };
    const handled = handleLocalModelsTabKey("y", emptyKey(), {
      state,
      dispatch: vi.fn(),
      callbacks,
    });
    expect(handled).toBe(true);
    expect(onResolved).toHaveBeenCalledWith(true);
  });

  it("n on the embedding-onboarding modal resolves with accept=false", () => {
    const onResolved = vi.fn();
    const callbacks: TuiAppCallbacks = {
      onApprovalDecision: vi.fn(),
      onAbort: vi.fn(),
      onQuit: vi.fn(),
      onMessageSubmitted: vi.fn(),
      onLocalModelsEmbeddingOnboardingResolved: onResolved,
    };
    const initial = createInitialTuiState(SESSION);
    const state = {
      ...initial,
      uiMode: "debug" as const,
      activeTab: "models" as const,
      localModelsPanel: {
        ...initial.localModelsPanel,
        embeddingOnboardingPrompt: {
          modelId: "nomic-embed-text-v1.5" as const,
          name: "Nomic Embed Text v1.5",
          sizeLabel: "~84 MB",
        },
      },
    };
    handleLocalModelsTabKey("n", emptyKey(), {
      state,
      dispatch: vi.fn(),
      callbacks,
    });
    expect(onResolved).toHaveBeenCalledWith(false);
  });

  it("Enter on an embedding row with downloaded=false triggers an embedding pull", () => {
    const onEmbPull = vi.fn();
    const callbacks: TuiAppCallbacks = {
      onApprovalDecision: vi.fn(),
      onAbort: vi.fn(),
      onQuit: vi.fn(),
      onMessageSubmitted: vi.fn(),
      onLocalModelsEmbeddingPullRequested: onEmbPull,
    };
    const initial = createInitialTuiState(SESSION);
    const state = {
      ...initial,
      uiMode: "debug" as const,
      activeTab: "models" as const,
      localModelsPanel: {
        ...initial.localModelsPanel,
        rows: [],
        cursor: 0,
        embeddingRows: [
          {
            id: "nomic-embed-text-v1.5" as const,
            def: {
              id: "nomic-embed-text-v1.5" as const,
              name: "Nomic",
              filename: "n.gguf",
              huggingFaceUrl: "u",
              fileSizeGb: 0.1,
              sizeLabel: "100 MB",
              description: "",
              dim: 768,
              pooling: "mean" as const,
              minRamGb: 1,
              recommendedRamGb: 1,
            },
            downloaded: false,
            active: false,
          },
        ],
      },
    };
    handleLocalModelsTabKey("", emptyKey({ return: true }), {
      state,
      dispatch: vi.fn(),
      callbacks,
    });
    expect(onEmbPull).toHaveBeenCalledWith("nomic-embed-text-v1.5");
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
