import type { DetectedLocalServer } from "../../llm/provider/presets/detect-local-servers.js";
import { clampCursor, visibleKindRows } from "./providers-wizard-phases.js";
import type { ProvidersWizardState } from "./providers-wizard-state.js";

/**
 * The wizard with the local-server check's answer folded in (ATO-2013).
 *
 * On the provider list the rows move: the found servers jump to the top.
 * A cursor still on the first row stays there, so the recommended server
 * is the one Enter picks. A cursor the operator already moved keeps
 * pointing at the row it was on, so the answer landing mid-keystroke
 * never swaps the row under the highlight.
 */
export function withDetectedLocal(
  wizard: ProvidersWizardState,
  servers: readonly DetectedLocalServer[],
): ProvidersWizardState {
  if (servers.length === 0) return wizard;
  const next: ProvidersWizardState = { ...wizard, detectedLocal: servers };
  if (wizard.phase !== "pick_kind" || wizard.cursor === 0) return next;
  const before = visibleKindRows(wizard.search, wizard.detectedLocal);
  const was = before[clampCursor(wizard.cursor, before.length)]?.row;
  if (was === undefined) return next;
  const after = visibleKindRows(next.search, servers);
  const idx = after.findIndex((option) => option.row === was);
  return idx >= 0 ? { ...next, cursor: idx } : next;
}
