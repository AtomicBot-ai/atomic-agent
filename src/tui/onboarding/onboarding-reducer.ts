import { reduceLocalModelsAction } from "../local-models/local-models-reducer.js";
import { reduceProvidersPanel } from "../providers/providers-reducer.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiState } from "../tui-state.js";
import { moveOnboardingCursor, type OnboardingCloudReturn } from "./onboarding-state.js";

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
    case "onboarding_cloud_meanwhile_opened": {
      if (!state.onboarding) return state;
      // Both mid-download screens open the wizard with this action, and
      // whichever asked is the one to come back to.
      const from: OnboardingCloudReturn =
        state.onboarding.step === "wait_or_jump" ? "wait_or_jump" : "local_download";
      return {
        ...state,
        onboarding: {
          ...state.onboarding,
          step: "cloud",
          resumeAfterCloud: from,
          cursor: 0,
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
      const step = state.onboarding?.step;
      if (step !== "local_download" && step !== "wait_or_jump") return null;
      if (action.kind !== "chat") return null;
      const next = reduceLocalModelsAction(state, action) ?? state;
      return {
        ...next,
        onboarding: {
          ...state.onboarding!,
          step: "finished",
          // A cloud model configured mid-download is the outcome that
          // matters for what happens next; the local one has landed
          // either way.
          outcome: state.onboarding!.outcome ?? "local",
        },
      };
    }
    // Hybrid-recall embeddings are a second download and a second
    // decision, and the first run does not ask for either. The offer
    // still exists in the LLM panel, where there is room to explain it.
    case "local_models_embedding_onboarding_opened": {
      const active = state.onboarding?.step;
      if (active !== "local_download" && active !== "wait_or_jump" && active !== "cloud") {
        return null;
      }
      return state;
    }
    case "providers_wizard_succeeded": {
      if (state.onboarding?.step !== "cloud") return null;
      const next = reduceProvidersPanel(state, action) ?? state;
      // Came from a running download: the operator now has a working
      // cloud model *and* an unfinished local one, which is a question
      // — wait, or start using the agent — not a conclusion.
      const stillPulling = next.localModelsPanel.pull !== null;
      const step =
        state.onboarding.resumeAfterCloud !== null && stillPulling
          ? "wait_or_jump"
          : "finished";
      return {
        ...next,
        onboarding: {
          ...state.onboarding,
          step,
          outcome: "cloud",
          resumeAfterCloud: null,
          // A second provider added from that screen lands on it again,
          // so the row it left from must not still be selected.
          cursor: 0,
        },
      };
    }
    case "providers_wizard_closed": {
      if (state.onboarding?.step !== "cloud") return null;
      const next = reduceProvidersPanel(state, action) ?? state;
      // Backing out of a wizard opened mid-download returns to the
      // screen that opened it, not to a backend choice already made.
      const step = state.onboarding.resumeAfterCloud ?? "choose";
      return {
        ...next,
        onboarding: {
          ...state.onboarding,
          step,
          resumeAfterCloud: null,
          cursor: 0,
          error: null,
          busy: false,
        },
      };
    }
    default:
      return null;
  }
}
