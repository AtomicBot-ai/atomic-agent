import { describe, expect, it } from "vitest";
import { reduceTuiState } from "../agent-event-reducer.js";
import { createInitialTuiState } from "../tui-state.js";
import type { TuiState } from "../tui-state.js";
import { createProvidersWizardState } from "../providers/providers-wizard-state.js";
import { createOnboardingState } from "./onboarding-state.js";
import { fakeSession } from "../test-fixtures.js";

function withFlow(
  step:
    | "choose"
    | "cloud"
    | "local_pick"
    | "local_download"
    | "wait_or_jump" = "choose",
): TuiState {
  // `createOnboardingState` opens on the splash; every case here is
  // about what happens after it.
  const state = createInitialTuiState(fakeSession(), 50, {
    onboarding: createOnboardingState("http://127.0.0.1:8080"),
  });
  return reduceTuiState(state, { type: "onboarding_step_set", step });
}

describe("onboarding reducer", () => {
  it("opens on the splash, and closes on `onboarding_set`", () => {
    const fresh = createInitialTuiState(fakeSession(), 50, {
      onboarding: createOnboardingState("http://127.0.0.1:8080"),
    });
    expect(fresh.onboarding?.step).toBe("intro");
    const opened = withFlow();
    expect(opened.onboarding?.step).toBe("choose");
    const closed = reduceTuiState(opened, { type: "onboarding_set", onboarding: null });
    expect(closed.onboarding).toBeNull();
  });

  it("wraps the cursor at both ends", () => {
    let state = withFlow();
    state = reduceTuiState(state, { type: "onboarding_cursor_moved", delta: -1 });
    expect(state.onboarding?.cursor).toBe(2);
    state = reduceTuiState(state, { type: "onboarding_cursor_moved", delta: 1 });
    expect(state.onboarding?.cursor).toBe(0);
  });

  it("clears a stale error when the step changes", () => {
    let state = withFlow();
    state = reduceTuiState(state, { type: "onboarding_error_set", error: "fetch failed" });
    state = reduceTuiState(state, { type: "onboarding_step_set", step: "custom_chat_url" });
    expect(state.onboarding?.error).toBeNull();
  });

  it("ignores every action but `onboarding_set` while the flow is closed", () => {
    const state = createInitialTuiState(fakeSession(), 50);
    const next = reduceTuiState(state, { type: "onboarding_cursor_moved", delta: 1 });
    expect(next.onboarding).toBeNull();
  });

  it("finishes with the outcome the host has to act on", () => {
    const state = reduceTuiState(withFlow(), { type: "onboarding_finished", outcome: "local" });
    expect(state.onboarding).toMatchObject({ step: "finished", outcome: "local" });
  });

  describe("local branch ↔ the model orchestrator", () => {
    it("moves to the download and remembers the model", () => {
      const state = reduceTuiState(withFlow("local_pick"), {
        type: "onboarding_local_model_picked",
        modelId: "gemma-4-e4b",
      });
      expect(state.onboarding).toMatchObject({
        step: "local_download",
        localModelId: "gemma-4-e4b",
      });
    });

    it("finishes when the chat pull completes", () => {
      const state = reduceTuiState(withFlow("local_download"), {
        type: "local_models_pull_finished",
        kind: "chat",
      });
      expect(state.onboarding).toMatchObject({ step: "finished", outcome: "local" });
      expect(state.localModelsPanel.pull).toBeNull();
    });

    it("ignores a finished pull of some other kind", () => {
      const state = reduceTuiState(withFlow("local_download"), {
        type: "local_models_pull_finished",
        kind: "embedding",
      });
      expect(state.onboarding?.step).toBe("local_download");
    });

    it("keeps the embedding offer out of the first run", () => {
      const state = reduceTuiState(withFlow("local_download"), {
        type: "local_models_embedding_onboarding_opened",
        modelId: "embeddinggemma-300m",
        name: "EmbeddingGemma 300M",
        sizeLabel: "~84 MB",
      });
      expect(state.localModelsPanel.embeddingOnboardingPrompt).toBeNull();
      expect(state.onboarding?.step).toBe("local_download");
    });

    it("still lets the panel show that offer when the flow is closed", () => {
      const base = createInitialTuiState(fakeSession(), 50);
      const state = reduceTuiState(base, {
        type: "local_models_embedding_onboarding_opened",
        modelId: "embeddinggemma-300m",
        name: "EmbeddingGemma 300M",
        sizeLabel: "~84 MB",
      });
      expect(state.localModelsPanel.embeddingOnboardingPrompt).not.toBeNull();
    });

    it("resets the cursor when a new list takes the screen", () => {
      let state = reduceTuiState(withFlow("choose"), {
        type: "onboarding_cursor_moved",
        delta: 2,
      });
      expect(state.onboarding?.cursor).toBe(2);
      state = reduceTuiState(state, { type: "onboarding_step_set", step: "local_pick" });
      expect(state.onboarding?.cursor).toBe(0);
    });
  });

  describe("cloud while the model downloads", () => {
    const pulling = (state: TuiState): TuiState =>
      reduceTuiState(state, {
        type: "local_models_pull_started",
        pull: {
          kind: "chat",
          modelId: "gemma-4-e4b",
          label: "Gemma 4 E4B",
          percent: 38,
          transferredBytes: 1_600_000_000,
          totalBytes: 4_220_000_000,
          error: null,
        },
      });

    it("opens the wizard and remembers where it came from", () => {
      const state = reduceTuiState(pulling(withFlow("local_download")), {
        type: "onboarding_cloud_meanwhile_opened",
      });
      expect(state.onboarding).toMatchObject({ step: "cloud", resumeAfterCloud: true });
    });

    it("asks wait-or-jump when the key lands while the pull is still running", () => {
      let state = reduceTuiState(pulling(withFlow("local_download")), {
        type: "onboarding_cloud_meanwhile_opened",
      });
      state = reduceTuiState(state, {
        type: "providers_wizard_opened",
        wizard: createProvidersWizardState("add"),
      });
      state = reduceTuiState(state, { type: "providers_wizard_succeeded" });
      expect(state.onboarding).toMatchObject({
        step: "wait_or_jump",
        outcome: "cloud",
        resumeAfterCloud: false,
      });
    });

    it("finishes instead when the pull already landed", () => {
      let state = reduceTuiState(withFlow("local_download"), {
        type: "onboarding_cloud_meanwhile_opened",
      });
      state = reduceTuiState(state, { type: "providers_wizard_succeeded" });
      expect(state.onboarding?.step).toBe("finished");
    });

    it("backs out to the download, not to a choice already made", () => {
      let state = reduceTuiState(pulling(withFlow("local_download")), {
        type: "onboarding_cloud_meanwhile_opened",
      });
      state = reduceTuiState(state, { type: "providers_wizard_closed" });
      expect(state.onboarding).toMatchObject({
        step: "local_download",
        resumeAfterCloud: false,
      });
    });

    it("closes the flow when the pull lands while wait-or-jump is up", () => {
      let state = pulling(withFlow("wait_or_jump"));
      state = reduceTuiState(state, {
        type: "onboarding_finished",
        outcome: "cloud",
      });
      // (a finished outcome is what the jump row dispatches; the wait
      //  row leaves the flow open until the pull reports in)
      expect(state.onboarding?.step).toBe("finished");

      let waiting = pulling(withFlow("wait_or_jump"));
      waiting = reduceTuiState(waiting, {
        type: "local_models_pull_finished",
        kind: "chat",
      });
      expect(waiting.onboarding?.step).toBe("finished");
      expect(waiting.localModelsPanel.pull).toBeNull();
    });
  });

  describe("cloud step ↔ providers wizard", () => {
    it("finishes the flow when the wizard saves, and clears the panel's wizard", () => {
      let state = withFlow("cloud");
      state = reduceTuiState(state, {
        type: "providers_wizard_opened",
        wizard: createProvidersWizardState("add"),
      });
      state = reduceTuiState(state, { type: "providers_wizard_succeeded" });
      expect(state.onboarding).toMatchObject({ step: "finished", outcome: "cloud" });
      expect(state.providersPanel.wizard).toBeNull();
    });

    it("returns to the choice when the wizard is backed out of", () => {
      let state = withFlow("cloud");
      state = reduceTuiState(state, {
        type: "providers_wizard_opened",
        wizard: createProvidersWizardState("add"),
      });
      state = reduceTuiState(state, { type: "providers_wizard_closed" });
      expect(state.onboarding?.step).toBe("choose");
      expect(state.providersPanel.wizard).toBeNull();
    });

    it("leaves the panel alone when the flow is not on its cloud step", () => {
      let state = createInitialTuiState(fakeSession(), 50);
      state = reduceTuiState(state, {
        type: "providers_wizard_opened",
        wizard: createProvidersWizardState("add"),
      });
      state = reduceTuiState(state, { type: "providers_wizard_succeeded" });
      expect(state.onboarding).toBeNull();
      expect(state.providersPanel.wizard).toBeNull();
    });
  });
});
