import { Box, Text, useInput } from "ink";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { getConfig } from "../../config/index.js";
import { checkLlamaServer } from "../../llm/llama-server-health.js";
import {
  isCloudTextProviderReady,
  isLocalBackendConfigured,
} from "../local-backend-readiness.js";
import { useOnboardingHuggingFace } from "../hooks/use-onboarding-huggingface.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import {
  buildLocalModelPicks,
  buildLocalPickRows,
  describeDownloadingModel,
  hostRamGb,
  orderLocalModelPicks,
} from "../onboarding/local-model-picks.js";
import {
  computeOnboardingFit,
  ONBOARDING_SIZE_ADVICE,
} from "../onboarding/onboarding-fit.js";
import { handleOnboardingKey } from "../onboarding/onboarding-key-bindings.js";
import { decideSecondBackendOffer } from "../onboarding/propose-second-backend.js";
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
import { OnboardingHuggingFacePickStep } from "./onboarding-hf-pick-step.js";
import { OnboardingHuggingFaceRefStep } from "./onboarding-hf-ref-step.js";
import { OnboardingIntroStep } from "./onboarding-intro-step.js";
import { OnboardingLocalPickStep } from "./onboarding-local-pick-step.js";
import { OnboardingProposeStep } from "./onboarding-propose-step.js";
import { OnboardingWaitOrJumpStep } from "./onboarding-wait-or-jump-step.js";
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
  local_hf_ref: "local models · hugging face",
  local_hf_pick: "local models · choose a file",
  local_download: "local models · downloading",
  propose_second: "one more thing",
  wait_or_jump: "almost there",
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
  // Read once per step change rather than per render: it only moves when
  // the flow itself writes config.
  const cloudAlreadyConfigured = useMemo(
    () => isCloudTextProviderReady(),
    [onboarding.step],
  );
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
  const pickRows = useMemo(() => buildLocalPickRows(picks), [picks]);

  useInput(
    (input, key) => {
      if (key.escape) {
        dispatch({ type: "onboarding_step_set", step: "choose" });
        return;
      }
      if (key.upArrow || input === "k") {
        dispatch({ type: "onboarding_cursor_moved", delta: -1, length: pickRows.length });
        return;
      }
      if (key.downArrow || input === "j") {
        dispatch({ type: "onboarding_cursor_moved", delta: 1, length: pickRows.length });
        return;
      }
      if (key.return) {
        const row = pickRows[onboarding.cursor % Math.max(1, pickRows.length)];
        if (!row) return;
        if (row.kind === "hugging_face") {
          dispatch({ type: "onboarding_step_set", step: "local_hf_ref" });
          return;
        }
        dispatch({ type: "onboarding_local_model_picked", modelId: row.pick.id });
        callbacks.onLocalModelsPullRequested?.(row.pick.id);
      }
    },
    { isActive: onboarding.step === "local_pick" },
  );

  const hfChoices = onboarding.hfRepo?.choices ?? [];
  const huggingFace = useOnboardingHuggingFace({
    onboarding,
    dispatch,
    onPullRequested: callbacks.onLocalModelsPullRequested,
  });

  useInput(
    (input, key) => {
      if (input === "c" && !key.ctrl) {
        dispatch({
          type: "providers_wizard_opened",
          wizard: createProvidersWizardState("add"),
        });
        dispatch({ type: "onboarding_cloud_meanwhile_opened" });
      }
    },
    { isActive: onboarding.step === "local_download" },
  );

  useInput(
    (input, key) => {
      if (key.upArrow || key.downArrow || input === "j" || input === "k") {
        dispatch({
          type: "onboarding_cursor_moved",
          delta: key.upArrow || input === "k" ? -1 : 1,
          length: 2,
        });
        return;
      }
      if (key.return) {
        if (onboarding.cursor % 2 === 0) finish(onboarding.outcome ?? "cloud");
        else dispatch({ type: "onboarding_step_set", step: "local_download" });
      }
    },
    { isActive: onboarding.step === "wait_or_jump" },
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        finish(onboarding.outcome ?? "skipped");
        return;
      }
      if (key.upArrow || key.downArrow || input === "j" || input === "k") {
        dispatch({
          type: "onboarding_cursor_moved",
          delta: key.upArrow || input === "k" ? -1 : 1,
          length: 2,
        });
        return;
      }
      if (key.return) {
        if (onboarding.cursor !== 0) {
          finish(onboarding.outcome ?? "skipped");
          return;
        }
        if (onboarding.offer === "local") {
          persistUserLocalModelsConfig({ mode: "managed" });
          dispatch({ type: "onboarding_step_set", step: "local_pick" });
          return;
        }
        dispatch({
          type: "providers_wizard_opened",
          wizard: createProvidersWizardState("add"),
        });
        dispatch({ type: "onboarding_step_set", step: "cloud" });
      }
    },
    { isActive: onboarding.step === "propose_second" },
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
    const outcome = onboarding.outcome ?? "skipped";
    const config = getConfig();
    const offer = decideSecondBackendOffer({
      outcome,
      cloudReady: isCloudTextProviderReady(),
      localReady: isLocalBackendConfigured(),
      alreadyProposed: config.tui.onboarding.proposedSecondBackendAt !== null,
    });
    if (offer) {
      // Recorded when it is shown, not when it is answered: the offer
      // was made either way, and a declined offer must not come back.
      persistOnboardingState({ proposedSecondBackendAt: new Date().toISOString() });
      dispatch({ type: "onboarding_second_backend_offered", offer });
      return;
    }
    settling.current = true;
    const now = new Date().toISOString();
    persistOnboardingState(outcome === "skipped" ? { skippedAt: now } : { completedAt: now });
    callbacks.onOnboardingFinished?.(outcome);
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
            cursor={onboarding.cursor % Math.max(1, pickRows.length)}
            ramGb={ramGb}
            fit={fit}
          />
        ) : null}
        {onboarding.step === "local_hf_ref" ? (
          <OnboardingHuggingFaceRefStep
            value={onboarding.hfReference}
            busy={onboarding.busy}
            error={onboarding.error}
            onChange={(value) =>
              dispatch({ type: "onboarding_hf_reference_changed", value })
            }
            onSubmit={huggingFace.resolveReference}
            onBack={() => dispatch({ type: "onboarding_step_set", step: "local_pick" })}
          />
        ) : null}
        {onboarding.step === "local_hf_pick" && onboarding.hfRepo ? (
          <OnboardingHuggingFacePickStep
            repo={onboarding.hfRepo}
            cursor={onboarding.cursor % Math.max(1, hfChoices.length)}
            ramGb={ramGb}
            error={onboarding.error}
          />
        ) : null}
        {onboarding.step === "propose_second" && onboarding.offer ? (
          <OnboardingProposeStep
            offer={onboarding.offer}
            configuredLabel={configuredLabel(onboarding.outcome)}
            cursor={onboarding.cursor % 2}
          />
        ) : null}
        {onboarding.step === "wait_or_jump" ? (
          <OnboardingWaitOrJumpStep
            pull={props.state.localModelsPanel.pull}
            cloudLabel="Cloud model ready"
            cursor={onboarding.cursor % 2}
          />
        ) : null}
        {onboarding.step === "local_download" ? (
          <OnboardingDownloadStep
            pull={props.state.localModelsPanel.pull}
            modelLabel={describeDownloadingModel(onboarding.localModelId)}
            offerCloudMeanwhile={!cloudAlreadyConfigured}
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

/** What the flow just finished setting up, named on the offer screen. */
function configuredLabel(outcome: OnboardingOutcome | null): string {
  if (outcome === "local") return "Local model ready";
  if (outcome === "cloud") return "Cloud model ready";
  return "Backend ready";
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
      return "↑/↓ move   enter select   esc back   ctrl+c quit";
    case "local_hf_ref":
      return "enter look it up   esc back   ctrl+c quit";
    case "local_hf_pick":
      return "↑/↓ move   enter download   esc back   ctrl+c quit";
    case "local_download":
      return "c set up cloud meanwhile   ctrl+c quit";
    case "propose_second":
      return "↑/↓ move   enter select   esc skip   ctrl+c quit";
    case "wait_or_jump":
      return "↑/↓ move   enter select   ctrl+c quit";
    case "finished":
      return "";
    case "intro":
      return "ctrl+c quit";
  }
}
