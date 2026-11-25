import { useCallback } from "react";
import { getConfig } from "../../config/index.js";
import {
  describeLlamaHealthFailure,
  managedPortsOf,
} from "../../llm/describe-llama-health-failure.js";
import { checkLlamaServer } from "../../llm/llama-server-health.js";
import { probeOpenAiCompatEndpoint } from "../../llm/detect-openai-compat-endpoint.js";
import type {
  OnboardingOutcome,
  OnboardingUiState,
} from "./onboarding-state.js";
import {
  normalizeLocalLlmBaseUrl,
  persistUserRemoteLlmUrls,
} from "../persist-user-local-models-config.js";
import { saveCustomOpenAiCompatEndpoint, customEndpointKeyWizard } from "./persist-custom-endpoint.js";
import type { TuiAction } from "../tui-action.js";

/**
 * The custom-endpoint branch's two writes: probe the chat URL and move
 * on, then probe the optional embedding URL and save both. Extracted
 * from `OnboardingScreen` so endpoint probing and persistence can be
 * changed independently of layout.
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
          // A hosted OpenAI-compatible endpoint answers 404 on
          // `/health`; asking the right question saves it as a provider
          // instead of dead-ending the operator on a llama-server error.
          const probe = await probeOpenAiCompatEndpoint(base, {
            timeoutMs: 5000,
          });
          if (probe.kind === "ok") {
            const saved = await saveCustomOpenAiCompatEndpoint(base, {
              timeoutMs: 5000,
            });
            if (saved) {
              dispatch({
                type: "onboarding_url_changed",
                field: "chat",
                value: saved.detection.baseUrl,
              });
              finish("custom");
              return;
            }
          }
          if (probe.kind === "needs_auth") {
            // The route exists and speaks the OpenAI shape — it just
            // wants a key, which this screen has no field for. Hand the
            // operator to the provider wizard with the URL already
            // filled in, on its key screen, instead of telling them
            // their URL is wrong and leaving them to find the LLM tab.
            dispatch({
              type: "providers_wizard_opened",
              wizard: customEndpointKeyWizard(probe.baseUrl),
            });
            dispatch({ type: "onboarding_step_set", step: "cloud" });
            return;
          }
          dispatch({
            type: "onboarding_error_set",
            error: describeLlamaHealthFailure(health, base, managedPortsOf(getConfig().localModels)),
          });
          return;
        }
        dispatch({
          type: "onboarding_url_changed",
          field: "chat",
          value: base,
        });
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
            error: describeLlamaHealthFailure(health, embeddingUrl, managedPortsOf(getConfig().localModels)),
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
