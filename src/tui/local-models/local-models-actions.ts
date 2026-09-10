import type {
  EmbeddingModelId,
  HuggingFaceRepoChoices,
  LocalModelId,
} from "../../local-llm/index.js";
import type {
  DaemonPhase,
  EmbeddingDaemonInfo,
  EmbeddingModelRow,
  LocalModelsBackendInfo,
  LocalModelsDaemonInfo,
  LocalModelRow,
  LocalModelsPanelMode,
  LocalModelsPullState,
  LocalModelsNotifyPrompt,
} from "./local-models-panel-state.js";

export type LocalModelsAction =
  | {
      type: "local_models_snapshot_loaded";
      rows: readonly LocalModelRow[];
      backend: LocalModelsBackendInfo;
      daemon: LocalModelsDaemonInfo;
      configMode: "external" | "managed";
      activeModelId: LocalModelId | null;
      totalRamGb: number;
      /** GPU memory budget (decimal GB) or `null` when not applicable. */
      gpuBudgetGb: number | null;
      dataDir: string;
      at: number;
      /** Memory-v2 phase 1B. Embedding catalog rows. */
      embeddingRows: readonly EmbeddingModelRow[];
      /** Memory-v2 phase 1B. Embedding daemon snapshot + active model. */
      embeddingDaemon: EmbeddingDaemonInfo;
    }
  | { type: "local_models_cursor_up" }
  /** Put the model-list cursor on an absolute row (mouse click). */
  | { type: "local_models_cursor_set"; row: number }
  | { type: "local_models_cursor_down" }
  | {
      type: "local_models_embedding_remove_confirm_opened";
      id: EmbeddingModelId;
    }
  | { type: "local_models_embedding_remove_confirm_closed" }
  | {
      type: "local_models_embedding_onboarding_opened";
      modelId: EmbeddingModelId;
      name: string;
      sizeLabel: string;
    }
  | { type: "local_models_embedding_onboarding_dismissed" }
  | {
      /**
       * "Tell me when it lands?" — asked once, the first time a pull
       * starts with no remembered answer, or on demand with `N`.
       */
      type: "local_models_notify_prompt_opened";
      prompt: LocalModelsNotifyPrompt;
    }
  | { type: "local_models_notify_prompt_closed" }
  | { type: "local_models_pull_started"; pull: LocalModelsPullState }
  | {
      type: "local_models_pull_progress";
      kind?: LocalModelsPullState["kind"];
      percent: number;
      transferredBytes: number;
      totalBytes: number;
      /** Omitted = unchanged; `null` = bytes are flowing again. */
      waiting?: LocalModelsPullState["waiting"];
    }
  | { type: "local_models_pull_finished"; kind?: LocalModelsPullState["kind"] }
  | {
      type: "local_models_pull_failed";
      kind?: LocalModelsPullState["kind"];
      error: string;
    }
  | { type: "local_models_backend_check_started" }
  | {
      type: "local_models_backend_check_loaded";
      backend: LocalModelsBackendInfo;
    }
  | { type: "local_models_error_set"; message: string }
  | { type: "local_models_error_cleared" }
  | { type: "local_models_mode_set"; mode: LocalModelsPanelMode }
  | { type: "local_models_detail_closed" }
  | { type: "local_models_remove_confirm_opened"; id: LocalModelId }
  | { type: "local_models_remove_confirm_closed" }
  | { type: "local_models_refresh_started" }
  /* --- "add a model from Hugging Face", the Models pane's own branch --- */
  /** Open the reference editor. Keeps whatever was typed last time. */
  | { type: "local_models_hf_opened" }
  /** Back to the model list, lookup cancelled and slice reset. */
  | { type: "local_models_hf_closed" }
  | { type: "local_models_hf_reference_changed"; value: string }
  | { type: "local_models_hf_lookup_started" }
  | { type: "local_models_hf_lookup_failed"; error: string }
  | { type: "local_models_hf_lookup_cancelled" }
  | { type: "local_models_hf_repo_resolved"; repo: HuggingFaceRepoChoices }
  | { type: "local_models_hf_cursor_set"; cursor: number }
  | { type: "local_models_hf_cursor_moved"; delta: number }
  /**
   * `/llm restart` — bounce the managed chat daemon. A state no-op as a
   * reducer action: the restart lives on
   * `LocalModelsOrchestrator.restartDaemon`, which only the callback
   * layer can reach, so `submit-handler` intercepts this before dispatch
   * (same rule as `providers_contract_probe_requested` for `/llm check`).
   */
  | { type: "local_models_daemon_restart_requested" }
  | { type: "local_models_daemon_phase_set"; phase: DaemonPhase }
  | { type: "local_models_daemon_error_set"; message: string | null }
  | {
      type: "local_llm_logs_loaded";
      text: string;
      path: string;
      size: number;
      truncated: boolean;
      at: number;
    }
  | { type: "local_llm_logs_error"; message: string; path: string | null };

export function isLocalModelsAction(action: {
  type: string;
}): action is LocalModelsAction {
  return (
    action.type.startsWith("local_models_") ||
    action.type.startsWith("local_llm_logs_")
  );
}
