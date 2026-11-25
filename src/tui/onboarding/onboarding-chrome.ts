import { isListPhase } from "../providers/providers-wizard-phases.js";
import type { ProvidersWizardState } from "../providers/providers-wizard-state.js";
import { t, type MessageKey } from "../../i18n/index.js";
import type { OnboardingStep, OnboardingUiState } from "./onboarding-state.js";

/**
 * The chrome around each step's content: the header subtitle and the
 * key-hint footer. Pure data on `OnboardingUiState`, split out of
 * `OnboardingScreen` because every slice that adds a step edits these
 * two tables — in their own module the additions stop colliding with
 * the screen's render and input regions.
 */

/** Message keys of the header subtitles; `intro` has none. */
const ONBOARDING_SUBTITLE_KEYS: Record<OnboardingStep, MessageKey | null> = {
  intro: null,
  choose: "onboarding.subtitle.choose",
  local_pick: "onboarding.subtitle.localPick",
  local_hf_ref: "onboarding.subtitle.localHfRef",
  local_hf_pick: "onboarding.subtitle.localHfPick",
  local_download: "onboarding.subtitle.localDownload",
  propose_second: "onboarding.subtitle.proposeSecond",
  wait_or_jump: "onboarding.subtitle.waitOrJump",
  import_pick: "onboarding.subtitle.importPick",
  import_done: "onboarding.subtitle.importDone",
  cloud: "onboarding.subtitle.cloud",
  custom_chat_url: "onboarding.subtitle.customChatUrl",
  custom_embedding_url: "onboarding.subtitle.customEmbeddingUrl",
  finished: "onboarding.subtitle.finished",
};

/** The header subtitle of a step, in the interface language (ATO-571). */
export function onboardingSubtitleFor(step: OnboardingStep): string {
  const key = ONBOARDING_SUBTITLE_KEYS[step];
  return key === null ? "" : t(key);
}

export function onboardingFooterFor(
  onboarding: OnboardingUiState,
  ctrlCArmed: boolean,
  wizard: ProvidersWizardState | null,
): string {
  // Same flip the chat hint strip's ctrl+c chip makes while armed (see
  // hotkey-hint.tsx) — the flow replaces that strip, not its semantics.
  const quit = t(ctrlCArmed ? "onboarding.footer.quitArmed" : "onboarding.footer.quit");
  switch (onboarding.step) {
    case "choose":
      return t("onboarding.footer.choose", { quit });
    case "cloud":
      // "/ search" tracks the wizard phase, not the onboarding step: on
      // the key/URL/model text screens `/` is just a typed character.
      return wizard !== null && isListPhase(wizard.phase)
        ? t("onboarding.footer.listSearch", { quit })
        : t("onboarding.footer.list", { quit });
    case "custom_chat_url":
      return t("onboarding.footer.customChatUrl", { quit });
    case "custom_embedding_url":
      return t("onboarding.footer.customEmbeddingUrl", { quit });
    case "local_pick":
      return t("onboarding.footer.list", { quit });
    case "local_hf_ref": {
      // While the lookup runs, esc is the only live key — say so.
      if (onboarding.busy) return t("onboarding.footer.hfLookupBusy", { quit });
      // Advertised only while there is something to clear, exactly like
      // the on-screen `[ clear ]` control it names the chord for.
      const clear = onboarding.hfReference.length > 0 ? `${t("onboarding.footer.hfClear")}   ` : "";
      return t("onboarding.footer.hfRef", { clear, quit });
    }
    case "local_hf_pick":
      return t("onboarding.footer.hfPick", { quit });
    case "local_download":
      // `s skip` matches the on-screen row; the wait_or_jump screen is
      // a different surface with its own rows and does not take `s`.
      return t("onboarding.footer.localDownload", { quit });
    case "propose_second":
      return t("onboarding.footer.proposeSecond", { quit });
    case "import_pick":
      // While the run is out with the importers, Enter would double-run.
      return onboarding.busy
        ? t("onboarding.footer.importBusy", { quit })
        : t("onboarding.footer.importPick", { quit });
    case "import_done":
      return t("onboarding.footer.importDone", { quit });
    case "wait_or_jump":
      return t("onboarding.footer.waitOrJump", { quit });
    case "finished":
      return "";
    case "intro":
      return quit;
  }
}
