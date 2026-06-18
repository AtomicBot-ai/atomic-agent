import type { TuiAction } from "../tui-action.js";
import type { TuiState } from "../tui-state.js";
import { isLocalModelsAction } from "./local-models-actions.js";
import { totalRowCount } from "./local-models-panel-state.js";

function clampCursor(cursor: number, len: number): number {
  if (len <= 0) return 0;
  return Math.min(len - 1, Math.max(0, cursor));
}

export function reduceLocalModelsAction(state: TuiState, action: TuiAction): TuiState | null {
  if (!isLocalModelsAction(action)) return null;
  const p = state.localModelsPanel;
  switch (action.type) {
    case "local_models_refresh_started":
      return { ...state, localModelsPanel: { ...p, loading: true, errorLine: null } };
    case "local_models_snapshot_loaded": {
      const nextPanel = {
        ...p,
        rows: action.rows,
        backend: action.backend,
        daemon: action.daemon,
        configMode: action.configMode,
        activeModelId: action.activeModelId,
        totalRamGb: action.totalRamGb,
        gpuBudgetGb: action.gpuBudgetGb,
        dataDir: action.dataDir,
        embeddingRows: action.embeddingRows,
        embeddingDaemon: action.embeddingDaemon,
        lastRefreshedAt: action.at,
        loading: false,
        errorLine: null,
        // Reconcile the UI-level phase with the snapshot: once the
        // daemon is healthy we are no longer "starting"; once it is
        // fully gone we are no longer "stopping".
        daemonPhase:
          p.daemonPhase === "starting" && action.daemon.healthy
            ? "idle"
            : p.daemonPhase === "stopping" && !action.daemon.running
              ? "idle"
              : p.daemonPhase,
      };
      return {
        ...state,
        localModelsPanel: {
          ...nextPanel,
          cursor: clampCursor(p.cursor, totalRowCount(nextPanel)),
        },
      };
    }
    case "local_models_cursor_up":
      return {
        ...state,
        localModelsPanel: {
          ...p,
          cursor: clampCursor(p.cursor - 1, totalRowCount(p)),
        },
      };
    case "local_models_cursor_down":
      return {
        ...state,
        localModelsPanel: {
          ...p,
          cursor: clampCursor(p.cursor + 1, totalRowCount(p)),
        },
      };
    case "local_models_embedding_remove_confirm_opened":
      return {
        ...state,
        localModelsPanel: { ...p, embeddingRemoveConfirmId: action.id },
      };
    case "local_models_embedding_remove_confirm_closed":
      return {
        ...state,
        localModelsPanel: { ...p, embeddingRemoveConfirmId: null },
      };
    case "local_models_embedding_onboarding_opened":
      return {
        ...state,
        localModelsPanel: {
          ...p,
          embeddingOnboardingPrompt: {
            modelId: action.modelId,
            name: action.name,
            sizeLabel: action.sizeLabel,
          },
        },
      };
    case "local_models_embedding_onboarding_dismissed":
      return {
        ...state,
        localModelsPanel: { ...p, embeddingOnboardingPrompt: null },
      };
    case "local_models_pull_started":
      // Keep list visible so the active row can show a live download indicator.
      if (action.pull.kind === "embedding") {
        return {
          ...state,
          localModelsPanel: {
            ...p,
            mode: "list",
            embeddingPull: action.pull,
            errorLine: null,
          },
        };
      }
      return {
        ...state,
        localModelsPanel: {
          ...p,
          mode: "list",
          pull: action.pull,
          errorLine: null,
        },
      };
    case "local_models_pull_progress":
      if (action.kind === "embedding") {
        if (!p.embeddingPull) return state;
        return {
          ...state,
          localModelsPanel: {
            ...p,
            embeddingPull: {
              ...p.embeddingPull,
              percent: action.percent,
              transferredBytes: action.transferredBytes,
              totalBytes: action.totalBytes,
            },
          },
        };
      }
      if (!p.pull) return state;
      return {
        ...state,
        localModelsPanel: {
          ...p,
          pull: {
            ...p.pull,
            percent: action.percent,
            transferredBytes: action.transferredBytes,
            totalBytes: action.totalBytes,
          },
        },
      };
    case "local_models_pull_finished":
      if (action.kind === "embedding") {
        return {
          ...state,
          localModelsPanel: {
            ...p,
            mode: "list",
            embeddingPull: null,
            loading: false,
          },
        };
      }
      return {
        ...state,
        localModelsPanel: { ...p, mode: "list", pull: null, loading: false },
      };
    case "local_models_pull_failed":
      if (action.kind === "embedding") {
        return {
          ...state,
          localModelsPanel: {
            ...p,
            mode: "list",
            embeddingPull: null,
            loading: false,
            errorLine: action.error,
          },
        };
      }
      return {
        ...state,
        localModelsPanel: {
          ...p,
          mode: "list",
          pull: null,
          loading: false,
          errorLine: action.error,
        },
      };
    case "local_models_backend_check_started":
      return { ...state, localModelsPanel: { ...p, mode: "backendUpdate", loading: true } };
    case "local_models_backend_check_loaded":
      return {
        ...state,
        localModelsPanel: {
          ...p,
          backend: action.backend,
          mode: "list",
          loading: false,
        },
      };
    case "local_models_error_set":
      return { ...state, localModelsPanel: { ...p, errorLine: action.message } };
    case "local_models_error_cleared":
      return { ...state, localModelsPanel: { ...p, errorLine: null } };
    case "local_models_mode_set":
      return { ...state, localModelsPanel: { ...p, mode: action.mode } };
    case "local_models_detail_closed":
      return { ...state, localModelsPanel: { ...p, mode: "list" } };
    case "local_models_remove_confirm_opened":
      return {
        ...state,
        localModelsPanel: { ...p, removeConfirmId: action.id },
      };
    case "local_models_remove_confirm_closed":
      return { ...state, localModelsPanel: { ...p, removeConfirmId: null } };
    case "local_models_daemon_phase_set":
      return {
        ...state,
        localModelsPanel: {
          ...p,
          daemonPhase: action.phase,
          daemonError: action.phase === "idle" ? p.daemonError : null,
        },
      };
    case "local_models_daemon_error_set":
      return {
        ...state,
        localModelsPanel: { ...p, daemonError: action.message, daemonPhase: "idle" },
      };
    case "local_llm_logs_loaded":
      return {
        ...state,
        localLlmLogs: {
          text: action.text,
          path: action.path,
          size: action.size,
          truncated: action.truncated,
          lastReadAt: action.at,
          error: null,
        },
      };
    case "local_llm_logs_error":
      return {
        ...state,
        localLlmLogs: {
          ...state.localLlmLogs,
          path: action.path ?? state.localLlmLogs.path,
          error: action.message,
          lastReadAt: Date.now(),
        },
      };
    default:
      return state;
  }
}
