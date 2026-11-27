import { useEffect } from "react";
import { useMouseCommands } from "../mouse/mouse-context.js";
import type { ProvidersWizardState } from "./providers-wizard-state.js";

/**
 * ATO-2013: when the add-provider list opens, ask once whether Ollama,
 * LM Studio or the Llama app already runs on this computer, and hand the
 * answer to the store wizard (`providers_wizard_local_detected`), which
 * puts those rows first.
 *
 * The probe comes from the host (`onDetectLocalServers`, wired in
 * `tui-command.ts`), not from an import here: component tests and the
 * standalone wizard have no host callback, so they never touch the
 * network and render exactly as before. The dispatch reaches the
 * store through the same context click handlers use.
 */
export function useLocalServerDetection(wizard: ProvidersWizardState): void {
  const mouse = useMouseCommands();
  const detect = mouse?.callbacks.onDetectLocalServers;
  const wanted =
    wizard.mode === "add" &&
    wizard.phase === "pick_kind" &&
    wizard.detectedLocal === undefined;
  useEffect(() => {
    if (!wanted || !detect || !mouse) return;
    let alive = true;
    detect().then(
      (servers) => {
        if (!alive || servers.length === 0) return;
        mouse.dispatch({ type: "providers_wizard_local_detected", servers });
      },
      () => {
        /* no hint beats a wrong one; the list stays as it was */
      },
    );
    return () => {
      alive = false;
    };
    // Once per opened list: `mouse` is memoised by its provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, detect]);
}
