import type { TuiState } from "../tui-state.js";

/**
 * Why Fusion cannot be switched on right now, as the one line the
 * operator sees — or `null` when it can.
 *
 * Pure and read off the TUI's own mirrors, so the switch row's detail
 * column and the activation path agree by construction: the row that
 * says "needs a cloud provider" is the row whose Enter says the same.
 * The orchestrator re-checks from config on the way to writing it
 * (`describeRunModeDegradation`), so a stale mirror can only refuse
 * early, never write a mode that would immediately degrade.
 *
 * Abstains on the local-model check until the first snapshot lands,
 * for the reason `selectComposerNeedsModelDownload` does: an empty
 * `rows` is indistinguishable from "nothing downloaded" before then.
 */
export function describeFusionBlocker(state: TuiState): string | null {
  const cloudReady = state.providersPanel.rows.some(
    (row) => row.kind !== "llama-server" && row.hasApiKey,
  );
  if (!cloudReady) {
    return "needs a cloud provider with a key — Manage › LLM › Cloud";
  }
  const local = state.localModelsPanel;
  if (local.lastRefreshedAt !== null && !local.rows.some((row) => row.downloaded)) {
    return "needs a downloaded local model — Manage › LLM › Local";
  }
  return null;
}
