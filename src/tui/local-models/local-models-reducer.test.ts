import { describe, expect, it } from "vitest";

import { reduceTuiState } from "../agent-event-reducer.js";
import { createInitialTuiState, type TuiSessionInfo } from "../tui-state.js";
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
  approvalRequired: false,
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
