import { isListPhase } from "../providers/providers-wizard-phases.js";
import type { ProvidersWizardState } from "../providers/providers-wizard-state.js";
import type { OnboardingStep, OnboardingUiState } from "./onboarding-state.js";

/**
 * The chrome around each step's content: the header subtitle and the
 * key-hint footer. Pure data on `OnboardingUiState`, split out of
 * `OnboardingScreen` because every slice that adds a step edits these
 * two tables — in their own module the additions stop colliding with
 * the screen's render and input regions.
 */

export const ONBOARDING_SUBTITLES: Record<OnboardingStep, string> = {
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

export function onboardingFooterFor(
  onboarding: OnboardingUiState,
  ctrlCArmed: boolean,
  wizard: ProvidersWizardState | null,
): string {
  // Same flip the chat hint strip's ctrl+c chip makes while armed (see
  // hotkey-hint.tsx) — the flow replaces that strip, not its semantics.
  const quit = ctrlCArmed ? "ctrl+c press again to quit" : "ctrl+c quit";
  switch (onboarding.step) {
    case "choose":
      return `↑/↓ move   enter select   1–3 jump   esc skip   ${quit}`;
    case "cloud":
      // "/ search" tracks the wizard phase, not the onboarding step: on
      // the key/URL/model text screens `/` is just a typed character.
      return wizard !== null && isListPhase(wizard.phase)
        ? `↑/↓ move   / search   enter select   esc back   ${quit}`
        : `↑/↓ move   enter select   esc back   ${quit}`;
    case "custom_chat_url":
      return `enter test & continue   esc back   ${quit}`;
    case "custom_embedding_url":
      return `enter test & save   empty enter skips embeddings   esc back   ${quit}`;
    case "local_pick":
      return `↑/↓ move   enter select   esc back   ${quit}`;
    case "local_hf_ref": {
      // While the lookup runs, esc is the only live key — say so.
      if (onboarding.busy) return `esc cancel the lookup   ${quit}`;
      // Advertised only while there is something to clear, exactly like
      // the on-screen `[ clear ]` control it names the chord for.
      const clear = onboarding.hfReference.length > 0 ? "ctrl+l clear   " : "";
      return `enter look it up   ${clear}esc back   ${quit}`;
    }
    case "local_hf_pick":
      return `↑/↓ move   enter download   esc back   ${quit}`;
    case "local_download":
      return `c set up cloud meanwhile   ${quit}`;
    case "propose_second":
      return `↑/↓ move   enter select   esc skip   ${quit}`;
    case "wait_or_jump":
      return `↑/↓ move   enter start or add a provider   ${quit}`;
    case "finished":
      return "";
    case "intro":
      return quit;
  }
}
