import { describe, expect, it } from "vitest";

import { reduceTuiState } from "../agent-event-reducer.js";
import type { TuiAction } from "../tui-action.js";
import {
  createInitialTuiState,
  type TuiSessionInfo,
  type TuiState,
} from "../tui-state.js";
import type {
  EmbeddingDaemonInfo,
  EmbeddingModelRow,
} from "./local-models-panel-state.js";

const EMPTY_EMBEDDING_ROWS: readonly EmbeddingModelRow[] = [];
const DEFAULT_EMBEDDING_DAEMON: EmbeddingDaemonInfo = {
  enabled: false,
  running: false,
  healthy: false,
  loading: false,
  pid: null,
  port: 19092,
  activeModelId: null,
};

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

describe("reduceLocalModelsAction", () => {
  it("loads snapshot rows and clamps cursor", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTuiState(state, {
      type: "local_models_snapshot_loaded",
      rows: [
        {
          id: "qwen-3.5-4b",
          def: {
            id: "qwen-3.5-4b",
            name: "Q",
            filename: "x.gguf",
            huggingFaceUrl: "u",
            fileSizeGb: 1,
            sizeLabel: "1",
            description: "",
            maxContextLength: 1,
            contextLabel: "1",
            minRamGb: 1,
            recommendedRamGb: 1,
            family: "qwen",
            supportsVision: false,
          },
          downloaded: false,
          mmprojStatus: "n/a",
          active: false,
        },
      ],
      backend: { currentTag: "v1", latestTag: "v1", updateAvailable: false },
      daemon: {
        running: false,
        healthy: false,
        loading: false,
        pid: null,
        port: 19091,
      },
      configMode: "managed",
      activeModelId: null,
      totalRamGb: 32,
      gpuBudgetGb: null,
      dataDir: "/tmp/data",
      at: 42,
      embeddingRows: EMPTY_EMBEDDING_ROWS,
      embeddingDaemon: DEFAULT_EMBEDDING_DAEMON,
    });
    expect(state.localModelsPanel.rows).toHaveLength(1);
    expect(state.localModelsPanel.lastRefreshedAt).toBe(42);
    expect(state.localModelsPanel.dataDir).toBe("/tmp/data");
    expect(state.localModelsPanel.embeddingDaemon).toEqual(DEFAULT_EMBEDDING_DAEMON);
    expect(state.localModelsPanel.embeddingRows).toEqual([]);
  });

  it("persists the GPU memory budget from the snapshot", () => {
    let state = createInitialTuiState(SESSION);
    expect(state.localModelsPanel.gpuBudgetGb).toBeNull();
    state = reduceTuiState(state, {
      type: "local_models_snapshot_loaded",
      rows: [],
      backend: { currentTag: null, latestTag: null, updateAvailable: null },
      daemon: {
        running: false,
        healthy: false,
        loading: false,
        pid: null,
        port: 19091,
      },
      configMode: "managed",
      activeModelId: null,
      totalRamGb: 32,
      gpuBudgetGb: 8,
      dataDir: "/tmp/data",
      at: 5,
      embeddingRows: EMPTY_EMBEDDING_ROWS,
      embeddingDaemon: DEFAULT_EMBEDDING_DAEMON,
    });
    expect(state.localModelsPanel.gpuBudgetGb).toBe(8);
  });

  it("moves cursor up and down with clamp", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTuiState(state, {
      type: "local_models_snapshot_loaded",
      rows: [
        {
          id: "qwen-3.5-4b",
          def: {
            id: "qwen-3.5-4b",
            name: "A",
            filename: "a.gguf",
            huggingFaceUrl: "u",
            fileSizeGb: 1,
            sizeLabel: "1",
            description: "",
            maxContextLength: 1,
            contextLabel: "1",
            minRamGb: 1,
            recommendedRamGb: 1,
            family: "qwen",
            supportsVision: false,
          },
          downloaded: true,
          mmprojStatus: "n/a",
          active: true,
        },
        {
          id: "qwen-3.5-9b",
          def: {
            id: "qwen-3.5-9b",
            name: "B",
            filename: "b.gguf",
            huggingFaceUrl: "u",
            fileSizeGb: 1,
            sizeLabel: "1",
            description: "",
            maxContextLength: 1,
            contextLabel: "1",
            minRamGb: 1,
            recommendedRamGb: 1,
            family: "qwen",
            supportsVision: false,
          },
          downloaded: false,
          mmprojStatus: "n/a",
          active: false,
        },
      ],
      backend: { currentTag: null, latestTag: null, updateAvailable: null },
      daemon: {
        running: false,
        healthy: false,
        loading: false,
        pid: null,
        port: 19091,
      },
      configMode: "managed",
      activeModelId: "qwen-3.5-4b",
      totalRamGb: 32,
      gpuBudgetGb: null,
      dataDir: "/tmp/data",
      at: 1,
      embeddingRows: EMPTY_EMBEDDING_ROWS,
      embeddingDaemon: DEFAULT_EMBEDDING_DAEMON,
    });
    state = reduceTuiState(state, { type: "local_models_cursor_down" });
    expect(state.localModelsPanel.cursor).toBe(1);
    state = reduceTuiState(state, { type: "local_models_cursor_down" });
    expect(state.localModelsPanel.cursor).toBe(1);
    state = reduceTuiState(state, { type: "local_models_cursor_up" });
    expect(state.localModelsPanel.cursor).toBe(0);
    state = reduceTuiState(state, { type: "local_models_cursor_up" });
    expect(state.localModelsPanel.cursor).toBe(0);
  });

  it("updates pull progress then fails back to list", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTuiState(state, {
      type: "local_models_pull_started",
      pull: {
        kind: "chat",
        modelId: "qwen-3.5-4b",
        label: "x",
        percent: 0,
        transferredBytes: 0,
        totalBytes: 100,
        error: null,
      },
    });
    expect(state.localModelsPanel.mode).toBe("list");
    state = reduceTuiState(state, {
      type: "local_models_pull_progress",
      percent: 50,
      transferredBytes: 50,
      totalBytes: 100,
    });
    expect(state.localModelsPanel.pull?.percent).toBe(50);
    state = reduceTuiState(state, { type: "local_models_pull_failed", error: "boom" });
    expect(state.localModelsPanel.mode).toBe("list");
    expect(state.localModelsPanel.errorLine).toBe("boom");
  });

  it("tracks chat and embedding pulls independently", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTuiState(state, {
      type: "local_models_pull_started",
      pull: {
        kind: "chat",
        modelId: "qwen-3.5-4b",
        label: "chat",
        percent: 0,
        transferredBytes: 0,
        totalBytes: 100,
        error: null,
      },
    });
    state = reduceTuiState(state, {
      type: "local_models_pull_started",
      pull: {
        kind: "embedding",
        modelId: "nomic-embed-text-v1.5",
        label: "embed",
        percent: 0,
        transferredBytes: 0,
        totalBytes: 200,
        error: null,
      },
    });

    state = reduceTuiState(state, {
      type: "local_models_pull_progress",
      kind: "embedding",
      percent: 25,
      transferredBytes: 50,
      totalBytes: 200,
    });

    expect(state.localModelsPanel.pull?.percent).toBe(0);
    expect(state.localModelsPanel.embeddingPull?.percent).toBe(25);

    state = reduceTuiState(state, {
      type: "local_models_pull_finished",
      kind: "embedding",
    });

    expect(state.localModelsPanel.pull?.modelId).toBe("qwen-3.5-4b");
    expect(state.localModelsPanel.embeddingPull).toBeNull();
  });

  it("tracks daemon start/stop phases", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTuiState(state, {
      type: "local_models_daemon_phase_set",
      phase: "starting",
    });
    expect(state.localModelsPanel.daemonPhase).toBe("starting");
    state = reduceTuiState(state, {
      type: "local_models_daemon_error_set",
      message: "spawn failed",
    });
    expect(state.localModelsPanel.daemonError).toBe("spawn failed");
    expect(state.localModelsPanel.daemonPhase).toBe("idle");
  });

  it("snapshot clears starting phase once daemon becomes healthy", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTuiState(state, {
      type: "local_models_daemon_phase_set",
      phase: "starting",
    });
    state = reduceTuiState(state, {
      type: "local_models_snapshot_loaded",
      rows: [],
      backend: { currentTag: null, latestTag: null, updateAvailable: null },
      daemon: {
        running: true,
        healthy: true,
        loading: false,
        pid: 99,
        port: 19091,
      },
      configMode: "managed",
      activeModelId: "qwen-3.5-4b",
      totalRamGb: 32,
      gpuBudgetGb: null,
      dataDir: "/tmp/data",
      at: 100,
      embeddingRows: EMPTY_EMBEDDING_ROWS,
      embeddingDaemon: DEFAULT_EMBEDDING_DAEMON,
    });
    expect(state.localModelsPanel.daemonPhase).toBe("idle");
  });

  it("navigates a single cursor across the combined chat+embedding row list", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTuiState(state, {
      type: "local_models_snapshot_loaded",
      rows: [
        {
          id: "qwen-3.5-4b",
          def: {
            id: "qwen-3.5-4b",
            name: "A",
            filename: "a.gguf",
            huggingFaceUrl: "u",
            fileSizeGb: 1,
            sizeLabel: "1",
            description: "",
            maxContextLength: 1,
            contextLabel: "1",
            minRamGb: 1,
            recommendedRamGb: 1,
            family: "qwen",
            supportsVision: false,
          },
          downloaded: true,
          mmprojStatus: "n/a",
          active: true,
        },
      ],
      backend: { currentTag: null, latestTag: null, updateAvailable: null },
      daemon: {
        running: false,
        healthy: false,
        loading: false,
        pid: null,
        port: 19091,
      },
      configMode: "managed",
      activeModelId: "qwen-3.5-4b",
      totalRamGb: 32,
      gpuBudgetGb: null,
      dataDir: "/tmp/data",
      at: 1,
      embeddingRows: [
        {
          id: "nomic-embed-text-v1.5",
          def: {
            id: "nomic-embed-text-v1.5",
            name: "Nomic",
            filename: "n.gguf",
            huggingFaceUrl: "u",
            fileSizeGb: 0.1,
            sizeLabel: "100 MB",
            description: "",
            dim: 768,
            pooling: "mean",
            minRamGb: 1,
            recommendedRamGb: 1,
          },
          downloaded: true,
          active: true,
        },
      ],
      embeddingDaemon: { ...DEFAULT_EMBEDDING_DAEMON, enabled: true },
    });
    expect(state.localModelsPanel.cursor).toBe(0);
    // Cursor walks from the chat row into the embedding row in one
    // continuous range; clamping uses the combined length (2).
    state = reduceTuiState(state, { type: "local_models_cursor_down" });
    expect(state.localModelsPanel.cursor).toBe(1);
    state = reduceTuiState(state, { type: "local_models_cursor_down" });
    expect(state.localModelsPanel.cursor).toBe(1);
    state = reduceTuiState(state, { type: "local_models_cursor_up" });
    expect(state.localModelsPanel.cursor).toBe(0);
  });

  it("opens and dismisses the embedding onboarding modal", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTuiState(state, {
      type: "local_models_embedding_onboarding_opened",
      modelId: "nomic-embed-text-v1.5",
      name: "Nomic Embed Text v1.5",
      sizeLabel: "~84 MB",
    });
    expect(state.localModelsPanel.embeddingOnboardingPrompt).toEqual({
      modelId: "nomic-embed-text-v1.5",
      name: "Nomic Embed Text v1.5",
      sizeLabel: "~84 MB",
    });
    state = reduceTuiState(state, {
      type: "local_models_embedding_onboarding_dismissed",
    });
    expect(state.localModelsPanel.embeddingOnboardingPrompt).toBeNull();
  });

  it("opens and closes the embedding remove-confirm modal independently", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTuiState(state, {
      type: "local_models_embedding_remove_confirm_opened",
      id: "nomic-embed-text-v1.5",
    });
    expect(state.localModelsPanel.embeddingRemoveConfirmId).toBe(
      "nomic-embed-text-v1.5",
    );
    // Chat-side modal stays untouched.
    expect(state.localModelsPanel.removeConfirmId).toBeNull();
    state = reduceTuiState(state, {
      type: "local_models_embedding_remove_confirm_closed",
    });
    expect(state.localModelsPanel.embeddingRemoveConfirmId).toBeNull();
  });

  it("stores llama-server log tail on load", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTuiState(state, {
      type: "local_llm_logs_loaded",
      text: "line 1\nline 2\n",
      path: "/tmp/data/llama-server.log",
      size: 14,
      truncated: false,
      at: 7,
    });
    expect(state.localLlmLogs.text).toContain("line 2");
    expect(state.localLlmLogs.path).toBe("/tmp/data/llama-server.log");
    expect(state.localLlmLogs.size).toBe(14);
    expect(state.localLlmLogs.lastReadAt).toBe(7);
  });

  it("records log tail error without clearing previous text", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceTuiState(state, {
      type: "local_llm_logs_loaded",
      text: "previous content",
      path: "/tmp/data/llama-server.log",
      size: 16,
      truncated: false,
      at: 1,
    });
    state = reduceTuiState(state, {
      type: "local_llm_logs_error",
      message: "ENOENT",
      path: "/tmp/data/llama-server.log",
    });
    expect(state.localLlmLogs.text).toBe("previous content");
    expect(state.localLlmLogs.error).toBe("ENOENT");
  });
});

describe("the Hugging Face branch's slice", () => {
  const REPO = {
    repoId: "unsloth/Qwen3.5-4B-GGUF",
    revision: "main",
    choices: [
      { path: "a.gguf", filename: "a.gguf", sizeBytes: 1, fileSizeGb: 1, sizeLabel: "1 GB" },
      { path: "b.gguf", filename: "b.gguf", sizeBytes: 2, fileSizeGb: 2, sizeLabel: "2 GB" },
    ],
    mmproj: null,
    hidden: null,
  };

  function reduceAll(
    actions: readonly TuiAction[],
    from: TuiState = createInitialTuiState(SESSION),
  ): TuiState {
    return actions.reduce((state, action) => reduceTuiState(state, action), from);
  }

  it("keeps a resolved repo across an escape back to the reference", () => {
    // Re-entering the file list must not cost a second HTTP round trip
    // for a repo the operator is still choosing a quantisation from.
    const state = reduceAll([
      { type: "local_models_hf_opened" },
      { type: "local_models_hf_reference_changed", value: "unsloth/x" },
      { type: "local_models_hf_lookup_started" },
      { type: "local_models_hf_repo_resolved", repo: REPO },
      { type: "local_models_mode_set", mode: "hfRef" },
      { type: "local_models_hf_opened" },
    ]);
    expect(state.localModelsPanel.hf.repo).toEqual(REPO);
    expect(state.localModelsPanel.hf.reference).toBe("unsloth/x");
  });

  it("drops a lookup that lands after the operator left the editor", () => {
    // Escape aborts the request, but a response already on the wire can
    // still arrive. Yanking the operator into a file list they walked
    // away from is the bug this guards.
    const state = reduceAll([
      { type: "local_models_hf_opened" },
      { type: "local_models_hf_lookup_started" },
      { type: "local_models_hf_closed" },
      { type: "local_models_hf_repo_resolved", repo: REPO },
    ]);
    expect(state.localModelsPanel.mode).toBe("list");
    expect(state.localModelsPanel.hf.repo).toBeNull();
  });

  it("clears the error as soon as the reference is edited", () => {
    const state = reduceAll([
      { type: "local_models_hf_opened" },
      { type: "local_models_hf_lookup_failed", error: "no .gguf in that repo" },
      { type: "local_models_hf_reference_changed", value: "unsloth/y" },
    ]);
    expect(state.localModelsPanel.hf.error).toBeNull();
    // A failure stays on the editor — the only screen where retyping is
    // possible.
    expect(state.localModelsPanel.mode).toBe("hfRef");
  });

  it("clamps the file cursor to the list it is walking", () => {
    const state = reduceAll([
      { type: "local_models_hf_opened" },
      { type: "local_models_hf_lookup_started" },
      { type: "local_models_hf_repo_resolved", repo: REPO },
      { type: "local_models_hf_cursor_moved", delta: 9 },
    ]);
    expect(state.localModelsPanel.hf.cursor).toBe(1);
    const back = reduceAll(
      [{ type: "local_models_hf_cursor_moved", delta: -9 }],
      state,
    );
    expect(back.localModelsPanel.hf.cursor).toBe(0);
  });

  it("resets the slice when the branch is closed", () => {
    const state = reduceAll([
      { type: "local_models_hf_opened" },
      { type: "local_models_hf_reference_changed", value: "unsloth/x" },
      { type: "local_models_hf_lookup_started" },
      { type: "local_models_hf_repo_resolved", repo: REPO },
      { type: "local_models_hf_closed" },
    ]);
    expect(state.localModelsPanel.mode).toBe("list");
    expect(state.localModelsPanel.hf).toEqual({
      reference: "",
      busy: false,
      error: null,
      repo: null,
      cursor: 0,
    });
  });
});
