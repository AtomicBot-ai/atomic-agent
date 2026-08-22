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

export function onboardingFooterFor(onboarding: OnboardingUiState): string {
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
      // While the lookup runs, esc is the only live key — say so.
      return onboarding.busy
        ? "esc cancel the lookup   ctrl+c quit"
        : "enter look it up   esc back   ctrl+c quit";
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
