import { useEffect } from "react";
import type { DetectedLocalServer } from "../../llm/provider/presets/detect-local-servers.js";
import type { TuiAction } from "../tui-action.js";
import type { OnboardingUiState } from "./onboarding-state.js";

/**
 * ATO-2013: look for Ollama, LM Studio and the Llama app while the splash
 * and the choice screen are up, once per flow, and hand what answered to
 * the reducer (`onboarding_local_servers_detected`). Starting on the
 * splash means the answer is usually in before the choice screen draws.
 *
 * `detect` is the host's probe (`onDetectLocalServers`, wired in
 * `tui-command.ts`); tests that do not pass one never touch the network.
 */
export function useOnboardingLocalDetection(args: {
  onboarding: OnboardingUiState;
  dispatch(action: TuiAction): void;
  detect?: () => Promise<readonly DetectedLocalServer[]>;
}): void {
  const { onboarding, dispatch, detect } = args;
  const wanted =
    (onboarding.step === "intro" || onboarding.step === "choose") &&
    onboarding.detectedLocal === undefined;
  useEffect(() => {
    if (!wanted || !detect) return;
    let alive = true;
    detect().then(
      (servers) => {
        if (!alive || servers.length === 0) return;
        dispatch({ type: "onboarding_local_servers_detected", servers });
      },
      () => {
        /* nothing found is the same as nothing running */
      },
    );
    return () => {
      alive = false;
    };
    // Once: re-running on intro -> choose would probe twice for one screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted && detect !== undefined]);
}
