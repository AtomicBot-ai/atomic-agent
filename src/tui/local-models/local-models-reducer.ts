import type { TuiAction } from "../tui-action.js";
import type { TuiState } from "../tui-state.js";
import { isLocalModelsAction } from "./local-models-actions.js";
import {
  createInitialLocalModelsHfState,
  totalRowCount,
  type LocalModelsPanelState,
} from "./local-models-panel-state.js";

function clampCursor(cursor: number, len: number): number {
  if (len <= 0) return 0;
  return Math.min(len - 1, Math.max(0, cursor));
}

function hfChoiceCount(panel: LocalModelsPanelState): number {
  return panel.hf.repo?.choices.length ?? 0;
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
    case "local_models_cursor_set":
      return {
        ...state,
        localModelsPanel: {
          ...p,
          cursor: clampCursor(action.row, totalRowCount(p)),
        },
      };
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
    /* --- "add a model from Hugging Face" --- */
    case "local_models_hf_opened":
      // The reference and any resolved repo survive: re-opening the
      // branch after an Escape should not cost a second HTTP round trip
      // for a repo the operator is still choosing a quant from.
      return {
        ...state,
        localModelsPanel: { ...p, mode: "hfRef", hf: { ...p.hf, error: null } },
      };
    case "local_models_hf_closed":
      return {
        ...state,
        localModelsPanel: {
          ...p,
          mode: "list",
          hf: createInitialLocalModelsHfState(),
        },
      };
    case "local_models_hf_reference_changed":
      // Editing clears the error the old reference earned — keeping it
      // over new text would blame a string that is no longer there.
      return {
        ...state,
        localModelsPanel: {
          ...p,
          hf: { ...p.hf, reference: action.value, error: null },
        },
      };
    case "local_models_hf_lookup_started":
      return {
        ...state,
        localModelsPanel: { ...p, hf: { ...p.hf, busy: true, error: null } },
      };
    case "local_models_hf_lookup_cancelled":
      return {
        ...state,
        localModelsPanel: { ...p, hf: { ...p.hf, busy: false } },
      };
    case "local_models_hf_lookup_failed":
      // Stays on the reference editor: that is the only screen where
      // retyping the thing that failed is possible.
      return {
        ...state,
        localModelsPanel: {
          ...p,
          mode: "hfRef",
          hf: { ...p.hf, busy: false, error: action.error },
        },
      };
    case "local_models_hf_repo_resolved":
      // A late response for a reference the operator has already left
      // must not yank them into a file list they did not ask for.
      if (p.mode !== "hfRef") return state;
      return {
        ...state,
        localModelsPanel: {
          ...p,
          mode: "hfPick",
          hf: {
            ...p.hf,
            busy: false,
            error: null,
            repo: action.repo,
            cursor: 0,
          },
        },
      };
    case "local_models_hf_cursor_set":
      return {
        ...state,
        localModelsPanel: {
          ...p,
          hf: { ...p.hf, cursor: clampCursor(action.cursor, hfChoiceCount(p)) },
        },
      };
    case "local_models_hf_cursor_moved":
      return {
        ...state,
        localModelsPanel: {
          ...p,
          hf: {
            ...p.hf,
            cursor: clampCursor(p.hf.cursor + action.delta, hfChoiceCount(p)),
          },
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
