import type { Key } from "ink";
import { describe, expect, it, vi } from "vitest";

import type { LocalModelDef } from "../../local-llm/index.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type TuiSessionInfo } from "../tui-state.js";
import { handleLocalModelsHfKey } from "./local-models-hf-keys.js";
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

describe("the Hugging Face branch's keys", () => {
  const REPO = {
    repoId: "unsloth/Qwen3.5-4B-GGUF",
    revision: "main",
    choices: [
      {
        path: "Q4_K_M.gguf",
        filename: "Q4_K_M.gguf",
        sizeBytes: 1,
        fileSizeGb: 1,
        sizeLabel: "1 GB",
      },
      {
        path: "Q8_0.gguf",
        filename: "Q8_0.gguf",
        sizeBytes: 2,
        fileSizeGb: 2,
        sizeLabel: "2 GB",
      },
    ],
    mmproj: null,
    hidden: null,
  };

  function hfState(
    mode: "list" | "hfRef" | "hfPick",
    hf: Partial<{ reference: string; busy: boolean; cursor: number; repo: typeof REPO }> = {},
  ) {
    const base = stateWithRow(
      makeRow("a" as LocalModelRow["id"], {
        supportsVision: false,
        downloaded: true,
        mmprojStatus: "n/a",
      }),
    );
    return {
      ...base,
      localModelsPanel: {
        ...base.localModelsPanel,
        mode,
        hf: {
          reference: hf.reference ?? "",
          busy: hf.busy ?? false,
          error: null,
          repo: hf.repo ?? null,
          cursor: hf.cursor ?? 0,
        },
      },
    };
  }

  it("`a` opens the reference editor from the list", () => {
    const dispatch = vi.fn();
    handleLocalModelsTabKey("a", emptyKey(), {
      state: hfState("list"),
      dispatch,
      callbacks: {} as TuiAppCallbacks,
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "local_models_hf_opened" });
  });

  it("swallows the list's own hotkeys while the editor is open", () => {
    // `s` starts the daemon and `d` opens a delete confirm on the list.
    // Typing a repo name must not do either.
    for (const input of ["s", "d", "g", "B", "r"]) {
      const dispatch = vi.fn();
      const callbacks = {
        onLocalModelsDaemonStartRequested: vi.fn(),
        onLocalModelsBackendPullRequested: vi.fn(),
        onLocalModelsRefreshRequested: vi.fn(),
      } as unknown as TuiAppCallbacks;
      const handled = handleLocalModelsTabKey(input, emptyKey(), {
        state: hfState("hfRef", { reference: "unsloth/x" }),
        dispatch,
        callbacks,
      });
      expect(handled).toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
      expect(callbacks.onLocalModelsDaemonStartRequested).not.toHaveBeenCalled();
      expect(callbacks.onLocalModelsBackendPullRequested).not.toHaveBeenCalled();
      expect(callbacks.onLocalModelsRefreshRequested).not.toHaveBeenCalled();
    }
  });

  it("esc cancels the lookup while one is in flight, and leaves once it is not", () => {
    const busyCallbacks = {
      onLocalModelsHfLookupCancelRequested: vi.fn(),
    } as unknown as TuiAppCallbacks;
    const busyDispatch = vi.fn();
    handleLocalModelsTabKey("", emptyKey({ escape: true }), {
      state: hfState("hfRef", { busy: true }),
      dispatch: busyDispatch,
      callbacks: busyCallbacks,
    });
    expect(busyCallbacks.onLocalModelsHfLookupCancelRequested).toHaveBeenCalled();
    expect(busyDispatch).not.toHaveBeenCalled();

    const idleDispatch = vi.fn();
    handleLocalModelsTabKey("", emptyKey({ escape: true }), {
      state: hfState("hfRef"),
      dispatch: idleDispatch,
      callbacks: {} as TuiAppCallbacks,
    });
    expect(idleDispatch).toHaveBeenCalledWith({ type: "local_models_hf_closed" });
  });

  it("ctrl+l clears the reference, but not mid-lookup", () => {
    const dispatch = vi.fn();
    handleLocalModelsTabKey("l", emptyKey({ ctrl: true }), {
      state: hfState("hfRef", { reference: "typo" }),
      dispatch,
      callbacks: {} as TuiAppCallbacks,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "local_models_hf_reference_changed",
      value: "",
    });
    const busy = vi.fn();
    handleLocalModelsTabKey("l", emptyKey({ ctrl: true }), {
      state: hfState("hfRef", { reference: "typo", busy: true }),
      dispatch: busy,
      callbacks: {} as TuiAppCallbacks,
    });
    expect(busy).not.toHaveBeenCalled();
  });

  it("j/k walk the file list and Enter adds the one under the cursor", () => {
    const dispatch = vi.fn();
    handleLocalModelsTabKey("j", emptyKey(), {
      state: hfState("hfPick", { repo: REPO }),
      dispatch,
      callbacks: {} as TuiAppCallbacks,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "local_models_hf_cursor_moved",
      delta: 1,
    });

    const callbacks = {
      onLocalModelsHfAddRequested: vi.fn(),
    } as unknown as TuiAppCallbacks;
    handleLocalModelsTabKey("", emptyKey({ return: true }), {
      state: hfState("hfPick", { repo: REPO, cursor: 1 }),
      dispatch: vi.fn(),
      callbacks,
    });
    expect(callbacks.onLocalModelsHfAddRequested).toHaveBeenCalledWith(REPO, 1);
  });

  it("esc on the file list goes back to the reference, not out of the branch", () => {
    // The repo survives on the slice, so re-entering the list costs no
    // second request.
    const dispatch = vi.fn();
    handleLocalModelsTabKey("", emptyKey({ escape: true }), {
      state: hfState("hfPick", { repo: REPO }),
      dispatch,
      callbacks: {} as TuiAppCallbacks,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "local_models_mode_set",
      mode: "hfRef",
    });
  });
});

describe("the Hugging Face branch is shared with the LLM pane", () => {
  it("declines every key while the branch is closed", () => {
    // `Manage › LLM › Local` is the surface an operator actually reaches
    // — `tab_changed: "models"` redirects there — so the branch's keys
    // live in their own handler both tables call. Returning `null` when
    // it is closed is what lets each caller keep its own hotkeys.
    const base = createInitialTuiState(SESSION);
    expect(
      handleLocalModelsHfKey("a", emptyKey(), {
        state: base,
        dispatch: vi.fn(),
        callbacks: {} as TuiAppCallbacks,
      }),
    ).toBeNull();
  });

  it("claims every key once it is open", () => {
    const base = createInitialTuiState(SESSION);
    const state = {
      ...base,
      localModelsPanel: { ...base.localModelsPanel, mode: "hfRef" as const },
    };
    for (const input of ["s", "d", "n", "c", "f", "L"]) {
      expect(
        handleLocalModelsHfKey(input, emptyKey(), {
          state,
          dispatch: vi.fn(),
          callbacks: {} as TuiAppCallbacks,
        }),
      ).toBe(true);
    }
  });
});
