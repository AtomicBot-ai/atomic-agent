import { useCallback } from "react";
import { describeLlamaHealthFailure } from "../../llm/describe-llama-health-failure.js";
import { checkLlamaServer } from "../../llm/llama-server-health.js";
import type {
  OnboardingOutcome,
  OnboardingUiState,
} from "../onboarding/onboarding-state.js";
import {
  normalizeLocalLlmBaseUrl,
  persistUserRemoteLlmUrls,
} from "../persist-user-local-models-config.js";
import type { TuiAction } from "../tui-action.js";

/**
 * The custom-endpoint branch's two writes: probe the chat URL and move
 * on, then probe the optional embedding URL and save both. Extracted
 * from `OnboardingScreen` so the screen stays a layout shell — these are
 * the only async effects the flow runs, and they change for llama-server
 * reasons, not for layout ones.
 *
 * Each probe runs `GET /health` before anything is written, so a typo
 * is caught here instead of surfacing as a dead agent on the first
 * message.
 */
export function useOnboardingUrlActions(args: {
  onboarding: OnboardingUiState;
  dispatch(action: TuiAction): void;
  finish(outcome: OnboardingOutcome): void;
}): {
  probeAndAdvance(raw: string): Promise<void>;
  saveEmbeddingUrl(raw: string): Promise<void>;
} {
  const { onboarding, dispatch, finish } = args;

  const probeAndAdvance = useCallback(
    async (raw: string) => {
      if (onboarding.busy) return;
      dispatch({ type: "onboarding_busy_set", busy: true });
      dispatch({ type: "onboarding_error_set", error: null });
      try {
        const base = normalizeLocalLlmBaseUrl(raw);
        const health = await checkLlamaServer({
          url: base,
          retries: 0,
          backoffMs: 0,
          timeoutMs: 5000,
          // A --api-key server passes /health (key-exempt) and then
          // rejects every completion; catch it while the operator is
          // still on this screen.
          verifyAuth: true,
        });
        if (!health.reachable) {
          dispatch({
            type: "onboarding_error_set",
            error: describeLlamaHealthFailure(health, base),
          });
          return;
        }
        dispatch({ type: "onboarding_url_changed", field: "chat", value: base });
        dispatch({ type: "onboarding_step_set", step: "custom_embedding_url" });
      } catch (err) {
        dispatch({
          type: "onboarding_error_set",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        dispatch({ type: "onboarding_busy_set", busy: false });
      }
    },
    [dispatch, onboarding.busy],
  );

  const saveEmbeddingUrl = useCallback(
    async (raw: string) => {
      if (onboarding.busy) return;
      const chatUrl = normalizeLocalLlmBaseUrl(onboarding.chatUrl);
      if (raw.trim().length === 0) {
        persistUserRemoteLlmUrls({ chatUrl });
        finish("custom");
        return;
      }
      dispatch({ type: "onboarding_busy_set", busy: true });
      dispatch({ type: "onboarding_error_set", error: null });
      try {
        const embeddingUrl = normalizeLocalLlmBaseUrl(raw);
        const health = await checkLlamaServer({
          url: embeddingUrl,
          retries: 0,
          backoffMs: 0,
          timeoutMs: 5000,
          verifyAuth: true,
        });
        if (!health.reachable) {
          dispatch({
            type: "onboarding_error_set",
            error: describeLlamaHealthFailure(health, embeddingUrl),
          });
          return;
        }
        persistUserRemoteLlmUrls({ chatUrl, embeddingUrl });
        finish("custom");
      } catch (err) {
        dispatch({
          type: "onboarding_error_set",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        dispatch({ type: "onboarding_busy_set", busy: false });
      }
    },
    [dispatch, finish, onboarding.busy, onboarding.chatUrl],
  );

  return { probeAndAdvance, saveEmbeddingUrl };
}
