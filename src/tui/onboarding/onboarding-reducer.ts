import { reduceLocalModelsAction } from "../local-models/local-models-reducer.js";
import { reduceProvidersPanel } from "../providers/providers-reducer.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiState } from "../tui-state.js";
import { moveOnboardingCursor } from "./onboarding-state.js";

/**
 * Folds the first-run actions. Returns `null` when the action is not
 * ours so `reduceTuiState` can carry on down its chain.
 *
 * Every case except `onboarding_set` is a no-op while the flow is
 * closed: a late action from an unmounted screen must never resurrect
 * the surface on top of a live session.
 */
export function reduceOnboardingAction(
  state: TuiState,
  action: TuiAction,
): TuiState | null {
  switch (action.type) {
    case "onboarding_set":
      return { ...state, onboarding: action.onboarding };
    case "onboarding_step_set": {
      if (!state.onboarding) return state;
      return {
        ...state,
        onboarding: {
          ...state.onboarding,
          step: action.step,
          // Each list owns its own cursor; carrying the choice screen's
          // row into the model picker would land it on an arbitrary model.
          cursor: 0,
          error: null,
          busy: false,
        },
      };
    }
    case "onboarding_cursor_moved": {
      if (!state.onboarding) return state;
      return {
        ...state,
        onboarding: {
          ...state.onboarding,
          cursor: moveOnboardingCursor(
            state.onboarding.cursor,
            action.delta,
            action.length,
          ),
        },
      };
    }
    case "onboarding_cursor_set": {
      if (!state.onboarding) return state;
      return { ...state, onboarding: { ...state.onboarding, cursor: action.cursor } };
    }
    case "onboarding_url_changed": {
      if (!state.onboarding) return state;
      const patch =
        action.field === "chat"
          ? { chatUrl: action.value }
          : { embeddingUrl: action.value };
      return { ...state, onboarding: { ...state.onboarding, ...patch } };
    }
    case "onboarding_busy_set": {
      if (!state.onboarding) return state;
      return { ...state, onboarding: { ...state.onboarding, busy: action.busy } };
    }
    case "onboarding_error_set": {
      if (!state.onboarding) return state;
      return { ...state, onboarding: { ...state.onboarding, error: action.error } };
    }
    case "onboarding_local_model_picked": {
      if (!state.onboarding) return state;
      return {
        ...state,
        onboarding: {
          ...state.onboarding,
          step: "local_download",
          localModelId: action.modelId,
          error: null,
        },
      };
    }
    case "onboarding_second_backend_offered": {
      if (!state.onboarding) return state;
      return {
        ...state,
        onboarding: {
          ...state.onboarding,
          step: "propose_second",
          offer: action.offer,
          cursor: 0,
          error: null,
          busy: false,
        },
      };
    }
    case "onboarding_finished": {
      if (!state.onboarding) return state;
      return {
        ...state,
        onboarding: {
          ...state.onboarding,
          step: "finished",
          outcome: action.outcome,
          busy: false,
          error: null,
        },
      };
    }
    // The cloud step is the providers wizard, verification and hot-swap
    // included, rather than a second implementation of it. These two
    // outcomes are the wizard's way of saying "done" and "backed out",
    // and the flow has to hear them — so it delegates the panel half to
    // the owning reducer and folds its own step change on top. Without
    // the delegation the panel would never clear its wizard, because a
    // handled action never reaches the rest of the chain.
    // The pull is owned by `LocalModelsOrchestrator`, which reports
    // through the panel's slice; the flow listens for the same events
    // rather than running a second download of its own.
    case "local_models_pull_finished": {
      if (state.onboarding?.step !== "local_download") return null;
      if (action.kind !== "chat") return null;
      const next = reduceLocalModelsAction(state, action) ?? state;
      return {
        ...next,
        onboarding: { ...state.onboarding, step: "finished", outcome: "local" },
      };
    }
    // Hybrid-recall embeddings are a second download and a second
    // decision, and the first run does not ask for either. The offer
    // still exists in the LLM panel, where there is room to explain it.
    case "local_models_embedding_onboarding_opened": {
      if (state.onboarding?.step !== "local_download") return null;
      return state;
    }
    case "providers_wizard_succeeded": {
      if (state.onboarding?.step !== "cloud") return null;
      const next = reduceProvidersPanel(state, action) ?? state;
      return {
        ...next,
        onboarding: { ...state.onboarding, step: "finished", outcome: "cloud" },
      };
    }
    case "providers_wizard_closed": {
      if (state.onboarding?.step !== "cloud") return null;
      const next = reduceProvidersPanel(state, action) ?? state;
      return {
        ...next,
        onboarding: { ...state.onboarding, step: "choose", error: null, busy: false },
      };
    }
    default:
      return null;
  }
}
