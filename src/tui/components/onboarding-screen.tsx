import { Box, Text, useInput } from "ink";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { checkLlamaServer } from "../../llm/llama-server-health.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import {
  buildLocalModelPicks,
  hostRamGb,
  orderLocalModelPicks,
} from "../onboarding/local-model-picks.js";
import {
  computeOnboardingFit,
  ONBOARDING_SIZE_ADVICE,
} from "../onboarding/onboarding-fit.js";
import { handleOnboardingKey } from "../onboarding/onboarding-key-bindings.js";
import type { OnboardingOutcome, OnboardingUiState } from "../onboarding/onboarding-state.js";
import {
  normalizeLocalLlmBaseUrl,
  persistUserLocalModelsConfig,
  persistUserRemoteLlmUrls,
} from "../persist-user-local-models-config.js";
import { persistOnboardingState } from "../persist-onboarding-state.js";
import { routeProvidersWizardKey } from "../providers/route-wizard-key.js";
import { createProvidersWizardState } from "../providers/providers-wizard-state.js";
import { theme } from "../theme/theme.js";
import type { TuiAction } from "../tui-action.js";
import type { LocalModelId } from "../../local-llm/index.js";
import type { TuiState } from "../tui-state.js";
import { OnboardingChooseStep } from "./onboarding-choose-step.js";
import { OnboardingHeader } from "./onboarding-header.js";
import { OnboardingDownloadStep } from "./onboarding-download-step.js";
import { OnboardingIntroStep } from "./onboarding-intro-step.js";
import { OnboardingLocalPickStep } from "./onboarding-local-pick-step.js";
import { OnboardingUrlStep } from "./onboarding-url-step.js";
import { ProvidersWizard } from "./providers-wizard.js";

export interface OnboardingScreenCallbacks {
  /** Verify + save + hot-swap the cloud provider (the panel's own path). */
  onProvidersWizardSubmit?(
    wizard: import("../providers/providers-wizard-state.js").ProvidersWizardState,
  ): void;
  onProvidersWizardSubmitCancel?(): void;
  /** Reload the runtime's providers once the flow has written config. */
  onOnboardingFinished?(outcome: OnboardingOutcome): void;
  /** Start a model pull. Owned by `LocalModelsOrchestrator`. */
  onLocalModelsPullRequested?(modelId: LocalModelId): void;
}

const SUBTITLES: Record<OnboardingUiState["step"], string> = {
  intro: "",
  choose: "setup · step 1 of 2",
  local_pick: "local models · step 2 of 2",
  local_download: "local models · downloading",
  cloud: "cloud model · step 2 of 2",
  custom_chat_url: "custom endpoint · step 2 of 2",
  custom_embedding_url: "custom endpoint · embeddings",
  finished: "setting up…",
};

/**
 * The whole first-run surface. It owns the terminal while it is mounted:
 * no status bar, no rail, no composer, no hint strip but its own, and
 * that strip is pinned to the real last row rather than trailing the
 * content.
 *
 * Effects live here rather than in the reducer — persisting config and
 * probing a URL are writes, and the reducer stays pure so the step
 * machine can be tested as a table.
 */
export function OnboardingScreen(props: {
  state: TuiState;
  onboarding: OnboardingUiState;
  dispatch(action: TuiAction): void;
  callbacks: OnboardingScreenCallbacks;
}): ReactElement {
  const { onboarding, dispatch, callbacks } = props;
  const size = useTerminalSize();
  const fit = computeOnboardingFit(size);
  const ramGb = useMemo(() => hostRamGb(), []);
  const settling = useRef(false);
  const [introSkipped, setIntroSkipped] = useState(false);

  const finish = useCallback(
    (outcome: OnboardingOutcome) => {
      dispatch({ type: "onboarding_finished", outcome });
    },
    [dispatch],
  );

  const pick = useCallback(
    (choice: "local" | "cloud" | "custom") => {
      if (choice === "cloud") {
        dispatch({
          type: "providers_wizard_opened",
          wizard: createProvidersWizardState("add"),
        });
        dispatch({ type: "onboarding_step_set", step: "cloud" });
        return;
      }
      if (choice === "custom") {
        dispatch({ type: "onboarding_step_set", step: "custom_chat_url" });
        return;
      }
      // Managed mode is recorded now so a Ctrl+C mid-download does not
      // lose the choice; the model id follows when the pull completes.
      persistUserLocalModelsConfig({ mode: "managed" });
      dispatch({ type: "onboarding_step_set", step: "local_pick" });
    },
    [dispatch, finish],
  );

  useInput(
    (input, key) => {
      const result = handleOnboardingKey(input, key, onboarding);
      if (!result.handled) return;
      for (const action of result.actions) dispatch(action);
      const intent = result.intent;
      if (!intent) return;
      if (intent.kind === "intro_key") {
        // First key finishes the reveal, second moves on: a splash that
        // cannot be hurried is a wait, and one that vanishes on the key
        // that was meant to hurry it is a screen nobody ever reads.
        if (!introSkipped) {
          setIntroSkipped(true);
          return;
        }
        // Recorded as it is dismissed, not at the end of the flow: an
        // operator who quits at the backend choice has still seen the
        // splash, and a later release may want to know that.
        persistOnboardingState({ introSeenAt: new Date().toISOString() });
        dispatch({ type: "onboarding_step_set", step: "choose" });
        return;
      }
      if (intent.kind === "skip") finish("skipped");
      else pick(intent.choice);
    },
    { isActive: onboarding.step === "choose" || onboarding.step === "intro" },
  );

  const picks = useMemo(
    () => orderLocalModelPicks(buildLocalModelPicks(ramGb)),
    [ramGb],
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        dispatch({ type: "onboarding_step_set", step: "choose" });
        return;
      }
      if (key.upArrow || input === "k") {
        dispatch({ type: "onboarding_cursor_moved", delta: -1, length: picks.length });
        return;
      }
      if (key.downArrow || input === "j") {
        dispatch({ type: "onboarding_cursor_moved", delta: 1, length: picks.length });
        return;
      }
      if (key.return) {
        const pick = picks[onboarding.cursor % Math.max(1, picks.length)];
        if (!pick) return;
        dispatch({ type: "onboarding_local_model_picked", modelId: pick.id });
        callbacks.onLocalModelsPullRequested?.(pick.id as LocalModelId);
      }
    },
    { isActive: onboarding.step === "local_pick" },
  );

  // The cloud step *is* the providers wizard — same keys, same
  // verification, same hot-swap — so it routes through the panel's own
  // handler rather than a second implementation of it.
  const wizardState = props.state.providersPanel.wizard;
  useInput(
    (input, key) => {
      if (!wizardState) return;
      routeProvidersWizardKey(input, key, wizardState, {
        dispatch,
        onSubmit: (wizard) => callbacks.onProvidersWizardSubmit?.(wizard),
        onSubmitCancel: () => callbacks.onProvidersWizardSubmitCancel?.(),
      });
    },
    { isActive: onboarding.step === "cloud" && wizardState !== null },
  );

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
        });
        if (!health.reachable) {
          dispatch({
            type: "onboarding_error_set",
            error: health.error ?? "health check failed",
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
        });
        if (!health.reachable) {
          dispatch({
            type: "onboarding_error_set",
            error: health.error ?? "health check failed",
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

  // Closing down runs once. The stamp is what stops the flow reopening
  // on the next launch, so it is written before the surface unmounts.
  useEffect(() => {
    if (onboarding.step !== "finished" || settling.current) return;
    settling.current = true;
    const now = new Date().toISOString();
    persistOnboardingState(
      onboarding.outcome === "skipped" ? { skippedAt: now } : { completedAt: now },
    );
    callbacks.onOnboardingFinished?.(onboarding.outcome ?? "skipped");
    dispatch({ type: "onboarding_set", onboarding: null });
  }, [callbacks, dispatch, onboarding.outcome, onboarding.step]);

  return (
    <Box flexDirection="column" flexGrow={1} paddingTop={1}>
      {onboarding.step === "intro" ? null : (
        <OnboardingHeader subtitle={SUBTITLES[onboarding.step]} mark={fit.mark} />
      )}
      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        {onboarding.step === "intro" ? (
          <OnboardingIntroStep
            columns={Math.max(20, size.columns - 4)}
            rows={size.rows}
            fit={fit}
            skipAnimation={introSkipped}
          />
        ) : null}
        {onboarding.step === "choose" ? (
          <OnboardingChooseStep cursor={onboarding.cursor} fit={fit} />
        ) : null}
        {onboarding.step === "local_pick" ? (
          <OnboardingLocalPickStep
            picks={picks}
            cursor={onboarding.cursor % Math.max(1, picks.length)}
            ramGb={ramGb}
            fit={fit}
          />
        ) : null}
        {onboarding.step === "local_download" ? (
          <OnboardingDownloadStep
            pull={props.state.localModelsPanel.pull}
            modelLabel={onboarding.localModelId ?? "the model"}
          />
        ) : null}
        {onboarding.step === "cloud" && wizardState ? (
          <ProvidersWizard wizard={wizardState} />
        ) : null}
        {onboarding.step === "custom_chat_url" ? (
          <OnboardingUrlStep
            kind="chat"
            value={onboarding.chatUrl}
            busy={onboarding.busy}
            error={onboarding.error}
            onChange={(value) =>
              dispatch({ type: "onboarding_url_changed", field: "chat", value })
            }
            onSubmit={(value) => void probeAndAdvance(value)}
            onBack={() => dispatch({ type: "onboarding_step_set", step: "choose" })}
          />
        ) : null}
        {onboarding.step === "custom_embedding_url" ? (
          <OnboardingUrlStep
            kind="embedding"
            value={onboarding.embeddingUrl}
            busy={onboarding.busy}
            error={onboarding.error}
            onChange={(value) =>
              dispatch({ type: "onboarding_url_changed", field: "embedding", value })
            }
            onSubmit={(value) => void saveEmbeddingUrl(value)}
            onBack={() =>
              dispatch({ type: "onboarding_step_set", step: "custom_chat_url" })
            }
          />
        ) : null}
      </Box>
      {/*
        The spacer is what pins the hints to the true bottom: the root Box
        is sized to the terminal, so everything above is pushed up and the
        strip lands on the last row instead of trailing the content.
      */}
      <Box flexGrow={1} />
      <Box flexShrink={0}>
        <Text color={theme.colors.muted} wrap="truncate">
          {footerFor(onboarding)}
          {fit.sizeAdvice ? `   ·   ${ONBOARDING_SIZE_ADVICE}` : ""}
        </Text>
      </Box>
    </Box>
  );
}

function footerFor(onboarding: OnboardingUiState): string {
  switch (onboarding.step) {
    case "choose":
      return "↑/↓ move   enter select   1–3 jump   esc skip   ctrl+c quit";
    case "cloud":
      return "↑/↓ move   enter select   esc back   ctrl+c quit";
    case "custom_chat_url":
      return "enter test & continue   esc back   ctrl+c quit";
    case "custom_embedding_url":
      return "enter test & save   empty enter skips embeddings   esc back   ctrl+c quit";
    case "local_pick":
      return "↑/↓ move   enter download   esc back   ctrl+c quit";
    case "local_download":
      return "ctrl+c quit";
    case "finished":
      return "";
    case "intro":
      return "ctrl+c quit";
  }
}
