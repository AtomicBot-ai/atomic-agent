import type { TuiState } from "../tui-state.js";
import { selectComposerBackend } from "./composer-switch-rows.js";

/**
 * The composer's third control on the managed-local route: the daemon's
 * status word plus what it currently costs in RAM — `healthy · 4.4 GB`.
 * The word is load-bearing (colour is never the only carrier), the RAM
 * segment is best-effort and simply absent when there is nothing to
 * measure. Clicking the control deep-links to the local models pane;
 * switching and downloading both live on the model control next to it.
 */
export interface ComposerLocalStatus {
  readonly word: "starting" | "healthy" | "down";
  /** Pre-formatted RSS (`"4.4 GB"`), or `null` for no RAM segment. */
  readonly ramLabel: string | null;
}

/**
 * `null` hides the control: off the managed-local route it has no
 * subject, and an `unknown` probe renders nothing rather than a grey
 * dot — silence is the honest statement before the first result.
 *
 * The mapping mixes two slices deliberately. `daemonPhase` /
 * `daemon.loading` only refresh while the Models tab is open, but they
 * are the *optimistic* half — the operator just pressed start — while
 * `llmHealth` is the always-fresh probe the home screen can trust.
 * "starting" therefore listens to both, and the terminal words come
 * from `llmHealth` alone.
 */
export function selectComposerLocalStatus(
  state: TuiState,
): ComposerLocalStatus | null {
  if (selectComposerBackend(state) !== "local") return null;
  const ramLabel =
    state.llmHealth.daemonRssBytes === null
      ? null
      : formatRssGb(state.llmHealth.daemonRssBytes);
  if (
    state.localModelsPanel.daemonPhase === "starting" ||
    state.localModelsPanel.daemon.loading ||
    state.llmHealth.status === "probing"
  ) {
    return { word: "starting", ramLabel };
  }
  if (state.llmHealth.status === "healthy") return { word: "healthy", ramLabel };
  if (
    state.llmHealth.status === "unreachable" ||
    state.llmHealth.status === "error"
  ) {
    return { word: "down", ramLabel };
  }
  return null;
}

/**
 * Decimal GB with one decimal, matching the catalog's `fileSizeGb` /
 * `totalRamGb` vocabulary rather than introducing GiB next to them.
 */
export function formatRssGb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}
